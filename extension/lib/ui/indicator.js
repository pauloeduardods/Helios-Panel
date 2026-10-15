// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: the segments of the user's layout in the panel (see
// lib/layout.js), details and the profile switcher in its menu. Everything
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

import {HeliosClient} from '../client.js';
import {
    loadLayout, readOptions, readStyle, renderLayout, segmentColor, segmentMarkup, serializeLayout,
    seriesLevelOf,
} from '../layout.js';
import {
    Level, barPieces, batteryStateLabel, daemonMessage, formatClock, formatDuration, formatPercent,
    formatTemp, formatWatts, parseColor, pickCpu, pickGpu, profileLabel, setProfileError,
    sparklinePieces, tempLevel,
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

/** Draws bars from barPieces on a DrawingArea; `rgbOf(level)` as in drawPieces. */
function drawBars(area, bars, rgbOf) {
    const cr = area.get_context();
    for (const {x, y, width, height, level} of bars) {
        const [r, g, b] = rgbOf(level);
        cr.setSourceRGBA(r, g, b, 1);
        cr.rectangle(x, y, width, height);
        cr.fill();
    }
    cr.$dispose();
}

/**
 * Draws sparkline pieces on a DrawingArea. `rgbOf(level)` gives a piece's
 * color as [r, g, b] (0–1); `area` fills under the line.
 */
function drawPieces(area, pieces, rgbOf, {fill = false, alpha = 1} = {}) {
    const cr = area.get_context();
    const [, height] = area.get_surface_size();
    cr.setLineWidth(1.5);
    for (const {points, level} of pieces) {
        const [r, g, b] = rgbOf(level);
        const [[x0, y0], ...rest] = points;
        if (rest.length === 0) {
            cr.setSourceRGBA(r, g, b, alpha);
            cr.rectangle(x0 - 1, y0 - 1, 2, 2); // a lone reading between gaps
            cr.fill();
            continue;
        }
        if (fill) {
            cr.setSourceRGBA(r, g, b, alpha * 0.35);
            cr.moveTo(x0, height);
            for (const [x, y] of points)
                cr.lineTo(x, y);
            cr.lineTo(points[points.length - 1][0], height);
            cr.closePath();
            cr.fill();
        }
        cr.setSourceRGBA(r, g, b, alpha);
        cr.moveTo(x0, y0);
        for (const [x, y] of rest)
            cr.lineTo(x, y);
        cr.stroke();
    }
    cr.$dispose();
}

function makeInfoRow(title) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const name = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const value = new St.Label({
        text: '--', style_class: 'helios-menu-value', y_align: Clutter.ActorAlign.CENTER,
    });
    item.add_child(name);
    item.add_child(value);
    return {item, name, value};
}

/** A small graph under a menu row; `draw(area)` paints it. */
function makeSparkline(draw) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false, can_focus: false, style_class: 'helios-sparkline-item',
    });
    const area = new St.DrawingArea({style_class: 'helios-sparkline', x_expand: true});
    area.connect('repaint', () => draw(area));
    item.add_child(area);
    return {item, area};
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
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._renderSparklines();
        });

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

        this._readingsSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Temperatures'));
        this._rowCpu = makeInfoRow('CPU');
        this._rowGpu = makeInfoRow('GPU');
        this._readingsSection.addMenuItem(this._rowCpu.item);
        this._addSparkline(this._readingsSection, 'cpu-celsius', this._rowCpu);
        this._readingsSection.addMenuItem(this._rowGpu.item);
        this._addSparkline(this._readingsSection, 'gpu-celsius', this._rowGpu);
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(this._deviceSection);
        this._fanSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(this._fanSection);
        this.menu.addMenuItem(this._readingsSection);

        this._usageSection = new PopupMenu.PopupMenuSection();
        this._usageSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Usage'));
        this._usageRows = {
            cpu: makeInfoRow('CPU'),
            clock: makeInfoRow('CPU clock'),
            gpu: makeInfoRow('GPU'),
        };
        const usageSeries = {cpu: 'cpu-usage', gpu: 'gpu-usage'};
        for (const [key, row] of Object.entries(this._usageRows)) {
            this._usageSection.addMenuItem(row.item);
            if (usageSeries[key])
                this._addSparkline(this._usageSection, usageSeries[key], row);
        }
        this.menu.addMenuItem(this._usageSection);

        this._powerSection = new PopupMenu.PopupMenuSection();
        this._powerSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Power'));
        this._powerRows = {
            source: makeInfoRow('Source'),
            battery: makeInfoRow('Battery'),
            draw: makeInfoRow('Draw'),
            timeLeft: makeInfoRow('Time left'),
            cpu: makeInfoRow('CPU draw'),
            gpu: makeInfoRow('GPU draw'),
            health: makeInfoRow('Battery health'),
        };
        const powerSeries = {draw: 'battery-watts', cpu: 'cpu-watts'};
        for (const [key, row] of Object.entries(this._powerRows)) {
            this._powerSection.addMenuItem(row.item);
            if (powerSeries[key])
                this._addSparkline(this._powerSection, powerSeries[key], row);
        }
        this.menu.addMenuItem(this._powerSection);

        this._profileHeader = new PopupMenu.PopupSeparatorMenuItem('Power Profile');
        this.menu.addMenuItem(this._profileHeader);
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    _addSparkline(section, series, row) {
        const spark = makeSparkline(area => {
            const [width, height] = area.get_surface_size();
            const pieces = sparklinePieces(this._history, series, width, height,
                {levelOf: this._levelOf(series)});
            drawPieces(area, pieces, level => this._rgbFor(area, level), {alpha: 0.8});
        });
        spark.item.visible = false;
        section.addMenuItem(spark.item);
        this._sparks.push({...spark, series, row});
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
            seg.box.opacity = r.dim ? 128 : 255;
            if (r.icon !== seg.iconName) {
                seg.iconName = r.icon;
                seg.icon.gicon = r.icon ? Gio.icon_new_for_string(this._iconPath(r.icon)) : null;
            }
            seg.icon.visible = r.icon !== null;
            const color = segmentColor(r, style);
            seg.icon.set_style(color ? `color: ${color};` : null);
            seg.label.visible = r.showText;
            seg.label.clutter_text.set_markup(segmentMarkup(r, style));
            seg.spec = r.graph;
            seg.graph.visible = r.graph !== null;
            if (r.graph) {
                seg.graph.set_width(r.graph.width);
                seg.graph.queue_repaint();
            }
        });
    }

    /** A menu graph shows under its row once it has two readings to join. */
    _renderSparklines() {
        for (const {item, area, series, row} of this._sparks) {
            const values = this._history?.series[series] ?? [];
            const known = values.filter(v => v !== null).length;
            item.visible = row.item.visible && known >= 2;
            if (item.visible && this.menu.isOpen)
                area.queue_repaint();
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
        this._usageSection.actor.visible = message === null;
        this._powerSection.actor.visible = message === null;
        if (message) {
            for (const seg of this._segs)
                seg.box.visible = false;
            this._statusSeg.label.text = message.panel;
            this._statusRow.name.text = message.menu;
            this._statusHint.name.text = message.hint;
            this._statusHint.item.visible = message.hint !== '';
            this._renderProfile({available: false, current: null, choices: []});
            return;
        }

        this._history = this._client.historyView();
        const {sensors, usage, power, profile} = snap;
        this._renderCpu(pickCpu(sensors, this._settings.get_string('cpu-sensor')));
        this._renderGpu(pickGpu(sensors, this._settings.get_string('gpu-sensor')));
        this._renderDevices(sensors.devices);
        this._renderFans(sensors.fans);
        this._renderUsage(usage);
        this._renderPower(power);
        this._renderProfile(profile);
        this._renderSegments(snap);
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
        this._usageSection.actor.visible = Object.values(rows).some(r => r.item.visible);
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
        this._powerSection.actor.visible = Object.values(rows).some(r => r.item.visible);
    }

    _renderProfile(state) {
        const style = this._settings.get_string('profile-names');

        this._profileHeader.visible = state.available;
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
