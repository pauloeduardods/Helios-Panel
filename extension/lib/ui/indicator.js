// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: the segments of the user's layout in the panel (see
// lib/layout.js), details, the profile switcher and the lighting controls in
// its menu. Everything
// comes from heliosd through HeliosClient; this file only renders. It has no timers: it redraws when heliosd reports
// a change or a setting changes. The graphs draw the history HeliosClient
// keeps, so they cost no extra D-Bus calls.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {HeliosClient} from '../client.js';
import {paintBars, paintPieces} from '../draw.js';
import {
    loadLayout, readOptions, readStyle, renderLayout, segmentColor, segmentMarkup, serializeLayout,
    seriesLevelOf,
} from '../layout.js';
import {
    EFFECTS_WITH_COLOR, EFFECTS_WITH_DIRECTION, LIGHT_COLORS, Level, barPieces, batteryStateLabel,
    daemonMessage, effectLabel, formatClock, formatDuration, formatPercent, formatTemp, formatWatts,
    keyboardRequest, lightingError, logoModeLabel, logoRequest, parseColor, pickCpu, pickGpu, powerSummary,
    profileLabel, setProfileError, sparklinePieces, tempLevel, usageSummary,
} from '../model.js';

function makeSegment(iconPath = null) {
    const box = new St.BoxLayout({style_class: 'helios-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({style_class: 'system-status-icon helios-icon'});
    if (iconPath)
        icon.gicon = Gio.icon_new_for_string(iconPath);
    const label = new St.Label({text: '--', y_align: Clutter.ActorAlign.CENTER});
    const graph = new St.DrawingArea({
        style_class: 'helios-bar-graph', y_align: Clutter.ActorAlign.CENTER, visible: false,
    });
    box.add_child(icon);
    box.add_child(label);
    box.add_child(graph);
    return {box, icon, label, graph, iconName: null, spec: null};
}

/** Draws sparkline pieces on a DrawingArea (see paintPieces). */
function drawPieces(area, pieces, rgbOf, options = {}) {
    const cr = area.get_context();
    const [, height] = area.get_surface_size();
    paintPieces(cr, height, pieces, rgbOf, options);
    cr.$dispose();
}

/** Draws bars from barPieces on a DrawingArea. */
function drawBars(area, bars, rgbOf) {
    const cr = area.get_context();
    paintBars(cr, bars, rgbOf);
    cr.$dispose();
}

/**
 * A menu row: name, then (with `draw`) a small graph on the same line, then
 * the value. `draw(area)` paints the graph.
 */
function makeInfoRow(title, draw = null) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const name = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const value = new St.Label({
        text: '--', style_class: 'helios-menu-value', y_align: Clutter.ActorAlign.CENTER,
    });
    item.add_child(name);
    let graph = null;
    if (draw) {
        graph = new St.DrawingArea({
            style_class: 'helios-inline-graph', y_align: Clutter.ActorAlign.CENTER, visible: false,
        });
        graph.connect('repaint', () => draw(graph));
        item.add_child(graph);
    }
    item.add_child(value);
    return {item, name, value, graph};
}

/**
 * A labelled slider; `onCommit(value)` runs when the user lets go of a drag,
 * or on each scroll or arrow-key step, so a drag is one write. `set(value)`
 * moves it without committing, and not while the user drags it.
 */
function makeSliderRow(title, onCommit) {
    const item = new PopupMenu.PopupBaseMenuItem({activate: false});
    const label = new St.Label({
        text: title, style_class: 'helios-slider-label', y_align: Clutter.ActorAlign.CENTER,
    });
    const slider = new Slider(0);
    slider.x_expand = true;
    let dragging = false;
    let updating = false;
    slider.connect('drag-begin', () => {
        dragging = true;
    });
    slider.connect('drag-end', () => {
        dragging = false;
        onCommit(slider.value);
    });
    slider.connect('notify::value', () => {
        if (!dragging && !updating)
            onCommit(slider.value);
    });
    const row = {
        item,
        set(value) {
            if (dragging)
                return;
            updating = true;
            slider.value = Math.max(0, Math.min(1, value));
            updating = false;
        },
    };
    item.add_child(label);
    item.add_child(slider);
    return row;
}

/** A row of colour buttons; `onPick(color)` runs on a click. */
function makeSwatchRow(onPick) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const box = new St.BoxLayout({style_class: 'helios-swatches', x_expand: true});
    const buttons = LIGHT_COLORS.map(({name, color}) => {
        const button = new St.Button({
            style_class: 'helios-swatch', accessible_name: name, can_focus: true,
            style: `background-color: ${color};`,
        });
        button.connect('clicked', () => onPick(color));
        box.add_child(button);
        return {button, color};
    });
    item.add_child(box);
    return {
        item,
        /** Marks the button of `color`, if it is a preset. */
        select(color) {
            for (const b of buttons) {
                if (b.color === color?.toLowerCase())
                    b.button.add_style_pseudo_class('checked');
                else
                    b.button.remove_style_pseudo_class('checked');
            }
        },
    };
}

export const HeliosIndicator = GObject.registerClass(
class HeliosIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Helios Panel', false);

        this._ext = extension;
        this._settings = extension.getSettings();
        this._profileMenuKey = '';
        this._fanKey = '';
        this._fanRows = [];
        this._deviceKey = '';
        this._deviceRows = [];
        this._history = null;
        this._sparks = [];

        this._buildPanel();
        this._buildMenu();
        // The menu is not kept up to date while it is closed (most of the
        // time); opening it renders it first.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._menuStale)
                this._render();
        });
        for (const menu of [this.menu, this._usageMenu.menu, this._powerMenu.menu]) {
            menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this._renderSparklines();
            });
        }

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'profile-names')
                this._profileMenuKey = '';
            if (key === 'panel-layout')
                this._loadLayout();
            this._render();
        });
        // Not named _onDestroy: PanelMenu.ButtonBox already connects 'destroy' to
        // this._onDestroy, and overriding it would skip destroying the menu.
        this.connect('destroy', () => this._cleanup());

        this._client = new HeliosClient(() => this._render());
        this._render();
    }

    // ---------------------------------------------------------------- build

    _iconPath(name) {
        return `${this._ext.path}/icons/${name}-symbolic.svg`;
    }

    _buildPanel() {
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box helios-panel-box'});
        this.add_child(this._box);
        this._segs = [];
        this._layoutKey = null;

        // Shown instead of the readings while heliosd is unavailable.
        this._statusSeg = makeSegment(this._iconPath('cpu'));
        this._statusSeg.box.opacity = 128;
        this._box.add_child(this._statusSeg.box);
        this._loadLayout();
    }

    /**
     * Reads the layout and builds one segment per entry. The first run
     * migrates the older settings into panel-layout, once.
     */
    _loadLayout() {
        const {layout, migrated} = loadLayout(this._settings);
        if (migrated !== null)
            this._settings.set_string('panel-layout', migrated);
        const key = serializeLayout(layout);
        if (key === this._layoutKey)
            return;
        this._layoutKey = key;
        this._layout = layout;
        for (const seg of this._segs)
            seg.box.destroy();
        this._segs = layout.segments.map(() => {
            const seg = makeSegment();
            seg.graph.connect('repaint', () => this._drawBarGraph(seg));
            this._box.insert_child_below(seg.box, this._statusSeg.box);
            return seg;
        });
    }

    _buildMenu() {
        this._statusSection = new PopupMenu.PopupMenuSection();
        this._statusRow = makeInfoRow('');
        this._statusRow.value.text = '';
        this._statusHint = makeInfoRow('');
        this._statusHint.value.text = '';
        this._statusHint.name.add_style_class_name('helios-menu-dim');
        this._statusSection.addMenuItem(this._statusRow.item);
        this._statusSection.addMenuItem(this._statusHint.item);
        this.menu.addMenuItem(this._statusSection);

        // Always shown: the temperatures, each with its graph on the same line.
        this._readingsSection = new PopupMenu.PopupMenuSection();
        this._rowCpu = this._graphRow('CPU', 'cpu-celsius');
        this._rowGpu = this._graphRow('GPU', 'gpu-celsius');
        this._readingsSection.addMenuItem(this._rowCpu.item);
        this._readingsSection.addMenuItem(this._rowGpu.item);
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(this._deviceSection);
        this._fanSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(this._fanSection);
        this.menu.addMenuItem(this._readingsSection);

        // The rest, collapsed until clicked (one open at a time); each title
        // carries a short summary.
        this._groupSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._groupSeparator);

        this._usageMenu = new PopupMenu.PopupSubMenuMenuItem('Usage');
        this._usageRows = {
            cpu: this._graphRow('CPU', 'cpu-usage'),
            clock: makeInfoRow('CPU clock'),
            gpu: this._graphRow('GPU', 'gpu-usage'),
        };
        for (const row of Object.values(this._usageRows))
            this._usageMenu.menu.addMenuItem(row.item);
        this.menu.addMenuItem(this._usageMenu);

        this._powerMenu = new PopupMenu.PopupSubMenuMenuItem('Power');
        this._powerRows = {
            source: makeInfoRow('Source'),
            battery: makeInfoRow('Battery'),
            draw: this._graphRow('Draw', 'battery-watts'),
            timeLeft: makeInfoRow('Time left'),
            cpu: this._graphRow('CPU draw', 'cpu-watts'),
            gpu: makeInfoRow('GPU draw'),
            health: makeInfoRow('Battery health'),
        };
        for (const row of Object.values(this._powerRows))
            this._powerMenu.menu.addMenuItem(row.item);
        this.menu.addMenuItem(this._powerMenu);

        this._profileMenu = new PopupMenu.PopupSubMenuMenuItem('Power profile');
        this._profileSection = this._profileMenu.menu;
        this.menu.addMenuItem(this._profileMenu);

        this._buildLighting();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    /**
     * Two collapsed submenus, so the menu stays short: the keyboard (effect,
     * brightness, speed, direction, colour) and the lid logo.
     */
    _buildLighting() {
        this._lighting = null;
        this._lightSection = new PopupMenu.PopupMenuSection();

        this._kbMenu = new PopupMenu.PopupSubMenuMenuItem('Keyboard');
        this._effectSection = new PopupMenu.PopupMenuSection();
        this._effectItems = new Map();
        this._effectKey = '';
        this._kbMenu.menu.addMenuItem(this._effectSection);
        const keyboard = change => this._setKeyboard(change);
        this._kbBrightness = makeSliderRow('Brightness', v => keyboard({brightness: v * 100}));
        this._kbSpeed = makeSliderRow('Speed', v => keyboard({speed: v * 9}));
        this._kbDirection = new PopupMenu.PopupMenuItem('Direction');
        this._kbDirection.connect('activate', () => {
            const current = this._lighting?.keyboard?.direction;
            keyboard({direction: current === 'left' ? 'right' : 'left'});
        });
        this._kbColors = makeSwatchRow(color => keyboard({color}));
        this._kbMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const item of [this._kbBrightness.item, this._kbSpeed.item, this._kbDirection, this._kbColors.item])
            this._kbMenu.menu.addMenuItem(item);
        this._lightSection.addMenuItem(this._kbMenu);

        this._logoMenu = new PopupMenu.PopupSubMenuMenuItem('Lid logo');
        this._logoSwitch = new PopupMenu.PopupSwitchMenuItem('On', false);
        this._logoSwitch.connect('toggled', (_item, on) => this._setLogo({on}));
        this._logoModeSection = new PopupMenu.PopupMenuSection();
        this._logoModeItems = new Map();
        this._logoModeKey = '';
        this._logoBrightness = makeSliderRow('Brightness', v => this._setLogo({on: true, brightness: v * 100}));
        this._logoColors = makeSwatchRow(color => this._setLogo({on: true, color}));
        for (const item of [this._logoSwitch, this._logoModeSection, this._logoBrightness.item, this._logoColors.item])
            this._logoMenu.menu.addMenuItem(item);
        this._lightSection.addMenuItem(this._logoMenu);

        this.menu.addMenuItem(this._lightSection);
    }

    /** A row with its history graph on the same line. */
    _graphRow(title, series) {
        const row = makeInfoRow(title, area => {
            const [width, height] = area.get_surface_size();
            const pieces = sparklinePieces(this._history, series, width, height,
                {levelOf: this._levelOf(series)});
            drawPieces(area, pieces, level => this._rgbFor(area, level), {alpha: 0.8});
        });
        this._sparks.push({row, series});
        return row;
    }

    // ---------------------------------------------------------------- graphs

    /** Temperatures get a level per value (their colors); the rest stay normal. */
    _levelOf(series) {
        return seriesLevelOf(series, readOptions(this._settings));
    }

    /**
     * A graph color as [r, g, b]: the segment's fixed color when it has one,
     * else the temperature color for the level, else the theme's text color.
     */
    _rgbFor(area, level, color = 'follow') {
        const fixed = color === 'follow' ? null : parseColor(color);
        if (fixed)
            return fixed;
        const rgb = parseColor(this._colorFor(level));
        if (rgb)
            return rgb;
        const c = area.get_theme_node().get_foreground_color();
        return [c.red / 255, c.green / 255, c.blue / 255];
    }

    /** A segment's graph: a line, a filled area or bars. */
    _drawBarGraph(seg) {
        const spec = seg.spec;
        if (!spec)
            return;
        const [width, height] = seg.graph.get_surface_size();
        const options = {windowS: spec.window, levelOf: spec.levelOf};
        const rgbOf = level => this._rgbFor(seg.graph, level, spec.color);
        if (spec.kind === 'bars')
            drawBars(seg.graph, barPieces(this._history, spec.series, width, height, options), rgbOf);
        else
            drawPieces(seg.graph, sparklinePieces(this._history, spec.series, width, height, options), rgbOf,
                {fill: spec.kind === 'area'});
    }

    /** Draws every segment of the layout from the snapshot. */
    _renderSegments(snap) {
        const rendered = renderLayout(this._layout, snap, readOptions(this._settings));
        const style = readStyle(this._settings);
        rendered.forEach((r, i) => {
            const seg = this._segs[i];
            seg.box.visible = r.visible;
            if (!r.visible)
                return;
            // Only what changed is applied: a new style or markup makes
            // gnome-shell restyle and lay out the actor again.
            seg.box.opacity = r.dim ? 128 : 255;
            if (r.icon !== seg.iconName) {
                seg.iconName = r.icon;
                seg.icon.gicon = r.icon ? Gio.icon_new_for_string(this._iconPath(r.icon)) : null;
            }
            seg.icon.visible = r.icon !== null;
            const color = segmentColor(r, style);
            const iconStyle = color ? `color: ${color};` : null;
            if (iconStyle !== seg.iconStyle) {
                seg.iconStyle = iconStyle;
                seg.icon.set_style(iconStyle);
            }
            seg.label.visible = r.showText;
            const markup = segmentMarkup(r, style);
            if (markup !== seg.markup) {
                seg.markup = markup;
                seg.label.clutter_text.set_markup(markup);
            }
            seg.spec = r.graph;
            seg.graph.visible = r.graph !== null;
            if (r.graph) {
                if (r.graph.width !== seg.graphWidth) {
                    seg.graphWidth = r.graph.width;
                    seg.graph.set_width(r.graph.width);
                }
                seg.graph.queue_repaint();
            }
        });
    }

    /** A row's graph shows once it has two readings to join. */
    _renderSparklines() {
        for (const {series, row} of this._sparks) {
            const values = this._history?.series[series] ?? [];
            const known = values.filter(v => v !== null).length;
            row.graph.visible = row.item.visible && known >= 2;
            if (row.graph.visible && this.menu.isOpen)
                row.graph.queue_repaint();
        }
    }

    // ---------------------------------------------------------------- render

    _render() {
        if (!this._client)
            return;
        const snap = this._client.snapshot();
        const message = daemonMessage(snap.state);

        this._statusSeg.box.visible = message !== null;
        this._statusSection.actor.visible = message !== null;
        this._readingsSection.actor.visible = message === null;
        this._groupSeparator.visible = message === null;
        this._usageMenu.visible = message === null;
        this._powerMenu.visible = message === null;
        if (message) {
            for (const seg of this._segs)
                seg.box.visible = false;
            this._statusSeg.label.text = message.panel;
            this._statusRow.name.text = message.menu;
            this._statusHint.name.text = message.hint;
            this._statusHint.item.visible = message.hint !== '';
            this._renderProfile({available: false, current: null, choices: []});
            this._renderLighting({available: false});
            return;
        }

        this._history = this._client.historyView();
        this._renderSegments(snap);
        this._menuStale = !this.menu.isOpen;
        if (this._menuStale)
            return;
        const {sensors, usage, power, profile} = snap;
        this._renderCpu(pickCpu(sensors, this._settings.get_string('cpu-sensor')));
        this._renderGpu(pickGpu(sensors, this._settings.get_string('gpu-sensor')));
        this._renderDevices(sensors.devices);
        this._renderFans(sensors.fans);
        this._renderUsage(usage);
        this._renderPower(power);
        this._renderProfile(profile);
        this._renderLighting(snap.lighting);
        this._renderSparklines();
    }

    _colorFor(level) {
        if (level === Level.HOT)
            return this._settings.get_string('color-hot') || null;
        if (level === Level.WARM)
            return this._settings.get_string('color-warm') || null;
        return this._settings.get_string('color-normal') || null;
    }

    _renderTemp(row, celsius, warmKey, hotKey) {
        const level = tempLevel(celsius, this._settings.get_int(warmKey), this._settings.get_int(hotKey));
        const color = this._colorFor(level);
        row.value.text = formatTemp(celsius, true);
        row.value.set_style(color ? `color: ${color};` : null);
    }

    _renderCpu(celsius) {
        this._renderTemp(this._rowCpu, celsius, 'cpu-warm', 'cpu-hot');
        if (celsius === null)
            this._rowCpu.value.text = 'sensor not found';
    }

    _renderGpu({state, celsius}) {
        if (state === 'none' || state === 'off') {
            this._rowGpu.value.text = state === 'none' ? 'not found' : 'off (power saving)';
            this._rowGpu.value.set_style(null);
            return;
        }
        this._renderTemp(this._rowGpu, celsius, 'gpu-warm', 'gpu-hot');
    }

    _renderFans(fans) {
        const key = fans.map(f => f.label).join('\n');
        if (key !== this._fanKey) {
            this._fanKey = key;
            this._fanSection.removeAll();
            this._fanRows = fans.map(f => {
                const row = makeInfoRow(f.label);
                this._fanSection.addMenuItem(row.item);
                return row;
            });
        }
        fans.forEach((f, i) => {
            this._fanRows[i].value.text = f.rpm === null ? '--' : `${f.rpm} RPM`;
        });
    }

    /** Drives and the Wi-Fi card, one menu row each; never in the panel. */
    _renderDevices(devices) {
        const key = devices.map(d => d.name).join('\n');
        if (key !== this._deviceKey) {
            this._deviceKey = key;
            this._deviceSection.removeAll();
            this._deviceRows = devices.map(d => {
                const row = makeInfoRow(d.name);
                this._deviceSection.addMenuItem(row.item);
                return row;
            });
        }
        devices.forEach((d, i) => {
            this._deviceRows[i].value.text = formatTemp(d.celsius, true);
        });
    }

    _renderUsage(usage) {
        const rows = this._usageRows;
        const show = (row, value) => {
            row.item.visible = value !== null;
            row.value.text = value ?? '';
        };
        show(rows.cpu, usage.cpu === null ? null : formatPercent(usage.cpu));
        show(rows.clock, formatClock(usage));
        show(rows.gpu, usage.gpu === null ? null : formatPercent(usage.gpu));
        this._usageMenu.visible = Object.values(rows).some(r => r.item.visible);
        this._usageMenu.label.text = usageSummary(usage);
    }

    _renderPower(power) {
        const battery = power.battery;
        const discharging = battery?.state === 'discharging';
        const rows = this._powerRows;
        const show = (row, value) => {
            row.item.visible = value !== null;
            row.value.text = value ?? '';
        };
        show(rows.source, {ac: 'AC', battery: 'Battery'}[power.source] ?? null);
        show(rows.battery, battery
            ? `${battery.percent === null ? '--' : `${Math.round(battery.percent)}%`} · ${batteryStateLabel(battery.state)}`
            : null);
        show(rows.draw, discharging ? formatWatts(battery.watts) : null);
        show(rows.timeLeft, discharging && battery.minutesLeft !== null ? formatDuration(battery.minutesLeft) : null);
        show(rows.cpu, power.cpuWatts === null ? null : formatWatts(power.cpuWatts));
        show(rows.gpu, power.gpuWatts === null ? null : formatWatts(power.gpuWatts));
        show(rows.health, battery && battery.health !== null
            ? `${Math.round(battery.health)}%${battery.cycles ? ` · ${battery.cycles} cycles` : ''}`
            : null);
        this._powerMenu.visible = Object.values(rows).some(r => r.item.visible);
        this._powerMenu.label.text = powerSummary(power);
    }

    _renderProfile(state) {
        const style = this._settings.get_string('profile-names');

        this._profileMenu.visible = state.available;
        this._profileMenu.label.text = state.current
            ? `Power profile · ${profileLabel(state.current, style)}`
            : 'Power profile';
        const choices = state.available ? state.choices : [];
        const key = `${style}|${choices.join(',')}`;
        if (key !== this._profileMenuKey) {
            this._profileMenuKey = key;
            this._profileSection.removeAll();
            this._profileItems = new Map();
            for (const id of choices) {
                const item = new PopupMenu.PopupMenuItem(profileLabel(id, style));
                item.connect('activate', () => this._setProfile(id));
                this._profileSection.addMenuItem(item);
                this._profileItems.set(id, item);
            }
        }
        // No optimistic update: the dot moves when heliosd reports the change.
        for (const [id, item] of this._profileItems ?? [])
            item.setOrnament(id === state.current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
    }

    // ---------------------------------------------------------------- lighting

    _renderLighting(lighting) {
        this._lighting = lighting.available ? lighting : null;
        this._lightSection.actor.visible = lighting.available;
        if (!lighting.available)
            return;
        const {keyboard, logo, effects} = lighting;

        // No optimistic updates: everything follows what heliosd reports.
        const key = effects.join(',');
        if (key !== this._effectKey) {
            this._effectKey = key;
            this._effectSection.removeAll();
            this._effectItems = new Map();
            for (const id of effects) {
                const item = new PopupMenu.PopupMenuItem(effectLabel(id));
                item.connect('activate', () => this._setKeyboard({effect: id}));
                this._effectSection.addMenuItem(item);
                this._effectItems.set(id, item);
            }
        }
        for (const [id, item] of this._effectItems)
            item.setOrnament(id === keyboard.effect ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._kbMenu.label.text = `Keyboard · ${effectLabel(keyboard.effect)}`;

        this._kbBrightness.set(keyboard.brightness / 100);
        this._kbSpeed.set(keyboard.speed / 9);
        this._kbSpeed.item.visible = effects.includes(keyboard.effect);
        this._kbDirection.visible = EFFECTS_WITH_DIRECTION.includes(keyboard.effect);
        this._kbDirection.label.text = `Direction: ${keyboard.direction === 'left' ? 'Left' : 'Right'}`;
        this._kbColors.item.visible = EFFECTS_WITH_COLOR.includes(keyboard.effect);
        this._kbColors.select(keyboard.color);

        const modes = lighting.logoModes.join(',');
        if (modes !== this._logoModeKey) {
            this._logoModeKey = modes;
            this._logoModeSection.removeAll();
            this._logoModeItems = new Map();
            for (const id of lighting.logoModes) {
                const item = new PopupMenu.PopupMenuItem(logoModeLabel(id));
                item.connect('activate', () => this._setLogo({on: true, mode: id}));
                this._logoModeSection.addMenuItem(item);
                this._logoModeItems.set(id, item);
            }
        }
        for (const [id, item] of this._logoModeItems)
            item.setOrnament(id === logo.mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._logoMenu.label.text = `Lid logo · ${logo.on ? logoModeLabel(logo.mode) : 'Off'}`;
        this._logoSwitch.setToggleState(logo.on);
        this._logoModeSection.actor.visible = logo.on;
        this._logoBrightness.item.visible = logo.on;
        this._logoBrightness.set(logo.brightness / 100);
        // Cycling ignores the colour.
        this._logoColors.item.visible = logo.on && logo.mode !== 'cycle';
        this._logoColors.select(logo.color);
    }

    async _setKeyboard(change) {
        const lighting = this._lighting;
        if (!lighting)
            return;
        await this._lightingWrite(() =>
            this._client.setKeyboardEffect(keyboardRequest(lighting.keyboard, change, lighting.effects)));
    }

    async _setLogo(change) {
        const lighting = this._lighting;
        if (!lighting)
            return;
        await this._lightingWrite(() => this._client.setLogo(logoRequest(lighting.logo, change)));
    }

    async _lightingWrite(call) {
        try {
            await call();
        } catch (e) {
            if (this._client) {
                Main.notify('Helios Panel', lightingError(e.name, e.message));
                this._render(); // put the controls back to what heliosd reports
            }
        }
    }

    async _setProfile(id) {
        try {
            await this._client?.setProfile(id);
        } catch (e) {
            if (this._client)
                Main.notify('Helios Panel', setProfileError(e.name, e.message));
        }
    }

    _cleanup() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._client?.destroy();
        this._client = null;
    }
});
