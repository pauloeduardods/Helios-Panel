// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: compact readings in the panel, details and the profile
// switcher in its menu. Everything comes from heliosd through HeliosClient;
// this file only renders. It has no timers: it redraws when heliosd reports
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
    GRAPH_WIDTHS, Level, PANEL_ITEMS, batteryStateLabel, daemonMessage, formatClock,
    formatDuration, formatPercent, formatRpm, formatTemp, formatWatts, normalizeOrder, parseColor,
    pickCpu, pickGpu, powerPanelText, profileColor, profileLabel, setProfileError, sparklinePieces,
    tempLevel,
} from '../model.js';

/** Which icon each top-bar item uses. */
const ITEM_ICONS = Object.freeze({
    'cpu': 'cpu', 'gpu': 'gpu', 'cpu-usage': 'cpu', 'gpu-usage': 'gpu',
    'fan': 'fan', 'power': 'power', 'profile': 'profile',
});

/** Temperature series and their threshold settings. */
const TEMP_THRESHOLDS = Object.freeze({
    'cpu-celsius': ['cpu-warm', 'cpu-hot'],
    'gpu-celsius': ['gpu-warm', 'gpu-hot'],
});

function makeSegment(iconPath) {
    const box = new St.BoxLayout({style_class: 'helios-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        style_class: 'system-status-icon helios-icon',
    });
    const label = new St.Label({text: '--', y_align: Clutter.ActorAlign.CENTER});
    const graph = new St.DrawingArea({
        style_class: 'helios-bar-graph', y_align: Clutter.ActorAlign.CENTER, visible: false,
    });
    box.add_child(icon);
    box.add_child(label);
    box.add_child(graph);
    return {box, icon, label, graph};
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
            if (key === 'panel-order')
                this._applyOrder();
            this._render();
        });
        // Not named _onDestroy: PanelMenu.ButtonBox already connects 'destroy' to
        // this._onDestroy, and overriding it would skip destroying the menu.
        this.connect('destroy', () => this._cleanup());

        this._client = new HeliosClient(() => this._render());
        this._render();
    }

    // ---------------------------------------------------------------- build

    _buildPanel() {
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box helios-panel-box'});
        this.add_child(this._box);
        const icon = name => `${this._ext.path}/icons/${name}-symbolic.svg`;
        this._seg = {};
        for (const item of PANEL_ITEMS) {
            const seg = makeSegment(icon(ITEM_ICONS[item.id]));
            if (item.series)
                seg.graph.connect('repaint', () => this._drawBarGraph(item, seg));
            this._seg[item.id] = seg;
        }

        // Shown instead of the readings while heliosd is unavailable.
        this._statusSeg = makeSegment(icon('cpu'));
        this._statusSeg.box.opacity = 128;
        this._applyOrder();
    }

    /** Puts the segments in the order from Settings. */
    _applyOrder() {
        this._box.remove_all_children();
        for (const id of normalizeOrder(this._settings.get_strv('panel-order')))
            this._box.add_child(this._seg[id].box);
        this._box.add_child(this._statusSeg.box);
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
            drawPieces(area, pieces, level => this._rgbFor(area, level, true), {alpha: 0.8});
        });
        spark.item.visible = false;
        section.addMenuItem(spark.item);
        this._sparks.push({...spark, series, row});
    }

    // ---------------------------------------------------------------- graphs

    /** Temperatures get a level per value (their colors); the rest stay normal. */
    _levelOf(series) {
        const keys = TEMP_THRESHOLDS[series];
        if (!keys)
            return () => Level.NORMAL;
        const [warm, hot] = keys.map(k => this._settings.get_int(k));
        return v => tempLevel(v, warm, hot);
    }

    /**
     * A graph color as [r, g, b]: the fixed graph color when chosen (bar
     * graphs only), else the temperature color for the level, else the
     * theme's text color.
     */
    _rgbFor(area, level, inMenu) {
        if (!inMenu && this._settings.get_string('graph-color-mode') === 'fixed') {
            const fixed = parseColor(this._settings.get_string('graph-color'));
            if (fixed)
                return fixed;
        }
        const rgb = parseColor(this._colorFor(level));
        if (rgb)
            return rgb;
        const c = area.get_theme_node().get_foreground_color();
        return [c.red / 255, c.green / 255, c.blue / 255];
    }

    _drawBarGraph(item, seg) {
        const [width, height] = seg.graph.get_surface_size();
        const pieces = sparklinePieces(this._history, item.series, width, height, {
            windowS: this._settings.get_int('graph-window'),
            levelOf: this._levelOf(item.series),
        });
        drawPieces(seg.graph, pieces, level => this._rgbFor(seg.graph, level, false),
            {fill: this._settings.get_string('graph-style') === 'area'});
    }

    /** Shows, sizes and redraws the graphs in the top bar. */
    _renderBarGraphs() {
        const graphs = this._settings.get_strv('graph-items');
        const only = this._settings.get_strv('graph-only');
        const width = GRAPH_WIDTHS[this._settings.get_string('graph-width')] ?? GRAPH_WIDTHS.medium;
        for (const item of PANEL_ITEMS) {
            if (!item.series)
                continue;
            const seg = this._seg[item.id];
            const on = graphs.includes(item.id);
            seg.graph.visible = on;
            seg.label.visible = !(on && only.includes(item.id));
            if (on) {
                seg.graph.set_width(width);
                seg.graph.queue_repaint();
            }
        }
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
        const icons = this._settings.get_boolean('show-icons');

        this._statusSeg.box.visible = message !== null;
        this._statusSeg.icon.visible = icons;
        this._statusSection.actor.visible = message !== null;
        this._readingsSection.actor.visible = message === null;
        this._usageSection.actor.visible = message === null;
        this._powerSection.actor.visible = message === null;
        if (message) {
            for (const seg of Object.values(this._seg))
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
        this._renderBarGraphs();
        this._renderSparklines();
    }

    _colorFor(level) {
        if (level === Level.HOT)
            return this._settings.get_string('color-hot') || null;
        if (level === Level.WARM)
            return this._settings.get_string('color-warm') || null;
        return this._settings.get_string('color-normal') || null;
    }

    _paint(seg, color, hot) {
        seg.box.set_style(color ? `color: ${color};` : null);
        if (hot && this._settings.get_boolean('bold-when-hot'))
            seg.box.add_style_class_name('helios-hot');
        else
            seg.box.remove_style_class_name('helios-hot');
    }

    _renderTemp(seg, row, celsius, warmKey, hotKey) {
        const level = tempLevel(celsius, this._settings.get_int(warmKey), this._settings.get_int(hotKey));
        const color = this._colorFor(level);
        seg.label.text = formatTemp(celsius, this._settings.get_boolean('show-unit'));
        seg.box.opacity = 255;
        this._paint(seg, color, level === Level.HOT);
        row.value.text = formatTemp(celsius, true);
        row.value.set_style(color ? `color: ${color};` : null);
    }

    _renderCpu(celsius) {
        const seg = this._seg.cpu;
        seg.icon.visible = this._settings.get_boolean('show-icons');
        seg.box.visible = this._settings.get_boolean('show-cpu');
        this._renderTemp(seg, this._rowCpu, celsius, 'cpu-warm', 'cpu-hot');
        if (celsius === null)
            this._rowCpu.value.text = 'sensor not found';
    }

    _renderGpu({state, celsius}) {
        const seg = this._seg.gpu;
        seg.icon.visible = this._settings.get_boolean('show-icons');
        const wanted = this._settings.get_boolean('show-gpu');

        if (state === 'none') {
            seg.box.visible = false;
            this._rowGpu.value.text = 'not found';
            this._rowGpu.value.set_style(null);
            return;
        }
        if (state === 'off') {
            seg.box.visible = wanted && !this._settings.get_boolean('hide-gpu-when-off');
            seg.label.text = 'off';
            seg.box.opacity = 128;
            this._paint(seg, null, false);
            this._rowGpu.value.text = 'off (power saving)';
            this._rowGpu.value.set_style(null);
            return;
        }
        seg.box.visible = wanted;
        this._renderTemp(seg, this._rowGpu, celsius, 'gpu-warm', 'gpu-hot');
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
        const seg = this._seg.fan;
        seg.icon.visible = this._settings.get_boolean('show-icons');
        seg.box.visible = this._settings.get_boolean('show-fans') && fans.length > 0;
        seg.label.text = fans.map(f => formatRpm(f.rpm)).join('/');
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
        const icons = this._settings.get_boolean('show-icons');
        for (const [id, value] of [['cpu-usage', usage.cpu], ['gpu-usage', usage.gpu]]) {
            const seg = this._seg[id];
            seg.icon.visible = icons;
            seg.box.visible = this._settings.get_boolean(`show-${id}`) && value !== null;
            seg.label.text = formatPercent(value);
        }

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
        const seg = this._seg.power;
        const text = powerPanelText(power);
        seg.icon.visible = this._settings.get_boolean('show-icons');
        seg.box.visible = this._settings.get_boolean('show-power') && text !== null;
        seg.label.text = text ?? '';
        // Dimmed on AC: the draw is only known on battery.
        seg.box.opacity = power.source === 'battery' ? 255 : 128;

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
        const seg = this._seg.profile;
        const style = this._settings.get_string('profile-names');
        seg.icon.visible = this._settings.get_boolean('show-icons');
        seg.box.visible = this._settings.get_boolean('show-profile') && state.available;
        seg.label.text = profileLabel(state.current, style);
        const color = this._settings.get_boolean('color-profile') ? profileColor(state.current) : null;
        seg.box.set_style(color ? `color: ${color};` : null);

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
