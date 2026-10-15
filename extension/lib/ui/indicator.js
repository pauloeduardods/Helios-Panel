// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: compact readings in the panel, details and the profile
// switcher in its menu. Everything comes from heliosd through HeliosClient;
// this file only renders. It has no timers: it redraws when heliosd reports
// a change or a setting changes.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {HeliosClient} from '../client.js';
import {
    Level, batteryStateLabel, daemonMessage, formatDuration, formatRpm, formatTemp, formatWatts,
    pickCpu, pickGpu, powerPanelText, profileColor, profileLabel, setProfileError, tempLevel,
} from '../model.js';

function makeSegment(iconPath) {
    const box = new St.BoxLayout({style_class: 'helios-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        style_class: 'system-status-icon helios-icon',
    });
    const label = new St.Label({text: '--', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(icon);
    box.add_child(label);
    return {box, icon, label};
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

export const HeliosIndicator = GObject.registerClass(
class HeliosIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Helios Panel', false);

        this._ext = extension;
        this._settings = extension.getSettings();
        this._profileMenuKey = '';
        this._fanKey = '';
        this._fanRows = [];

        this._buildPanel();
        this._buildMenu();

        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key === 'profile-names')
                this._profileMenuKey = '';
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
        this._seg = {
            cpu: makeSegment(icon('cpu')),
            gpu: makeSegment(icon('gpu')),
            fan: makeSegment(icon('fan')),
            power: makeSegment(icon('power')),
            profile: makeSegment(icon('profile')),
        };
        for (const key of ['cpu', 'gpu', 'fan', 'power', 'profile'])
            this._box.add_child(this._seg[key].box);

        // Shown instead of the readings while heliosd is unavailable.
        this._statusSeg = makeSegment(icon('cpu'));
        this._statusSeg.box.opacity = 128;
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
        this._readingsSection.addMenuItem(this._rowGpu.item);
        this._fanSection = new PopupMenu.PopupMenuSection();
        this._readingsSection.addMenuItem(this._fanSection);
        this.menu.addMenuItem(this._readingsSection);

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
        for (const row of Object.values(this._powerRows))
            this._powerSection.addMenuItem(row.item);
        this.menu.addMenuItem(this._powerSection);

        this._profileHeader = new PopupMenu.PopupSeparatorMenuItem('Power Profile');
        this.menu.addMenuItem(this._profileHeader);
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
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

        const {sensors, power, profile} = snap;
        this._renderCpu(pickCpu(sensors, this._settings.get_string('cpu-sensor')));
        this._renderGpu(pickGpu(sensors, this._settings.get_string('gpu-sensor')));
        this._renderFans(sensors.fans);
        this._renderPower(power);
        this._renderProfile(profile);
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
