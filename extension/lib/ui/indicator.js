// The top-bar button: compact readings in the panel, details and the profile
// switcher in its menu. All hardware access goes through lib/sys and
// lib/backends; this file only renders.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    Level, PPD_LABELS, PPD_PROFILES, clampInt, formatRpm, formatTemp,
    ppdForPlatform, profileColor, profileLabel, tempLevel,
} from '../core/index.js';
import {CpuSensor, FanSensor, GpuSensor} from '../sys/sensors.js';
import {PlatformProfileBackend, SwitchMode} from '../backends/platform.js';
import {detectLightingBackend} from '../backends/lighting.js';

const SENSOR_KEYS = new Set([
    'cpu-sensor', 'gpu-sensor', 'allow-wake-dgpu', 'gpu-min-interval', 'refresh-interval',
]);

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

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export const HeliosIndicator = GObject.registerClass(
class HeliosIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Helios Panel', false);

        this._ext = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._refreshing = false;
        this._timerId = 0;
        this._readbackId = 0;
        this._refreshPending = false;
        this._switchMode = SwitchMode.NONE;
        this._profileMenuKey = '';
        this._lighting = null;
        this._platform = new PlatformProfileBackend();

        this._buildPanel();
        this._buildMenu();
        this._createSensors();

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._updateSwitchMode();
                this._refresh();
            }
        });
        // Not named _onDestroy: PanelMenu.ButtonBox already connects 'destroy' to
        // this._onDestroy, and overriding it would skip destroying the menu.
        this.connect('destroy', () => this._cleanup());

        this._restartTimer();
        this._updateSwitchMode();
        this._refresh();

        detectLightingBackend().then(backend => {
            if (this._destroyed) {
                backend?.destroy();
                return;
            }
            this._lighting = backend;
            this._updateLightingSection();
        }).catch(e => console.error('[helios-panel]', e));
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
            profile: makeSegment(icon('profile')),
        };
        for (const key of ['cpu', 'gpu', 'fan', 'profile'])
            this._box.add_child(this._seg[key].box);
    }

    _buildMenu() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Temperatures'));
        this._rowCpu = makeInfoRow('CPU');
        this._rowGpu = makeInfoRow('GPU');
        this.menu.addMenuItem(this._rowCpu.item);
        this.menu.addMenuItem(this._rowGpu.item);

        this._fanSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._fanSection);
        this._fanRows = [];

        this._profileHeader = new PopupMenu.PopupSeparatorMenuItem('Power Profile');
        this.menu.addMenuItem(this._profileHeader);
        this._profileSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profileSection);
        this._profileHint = makeInfoRow('');
        this._profileHint.name.add_style_class_name('helios-menu-dim');
        this.menu.addMenuItem(this._profileHint.item);

        this._lightingSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._lightingSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    _createSensors() {
        this._gpu?.destroy();
        const refreshSec = clampInt(this._settings.get_int('refresh-interval'), 1, 60);
        this._cpu = new CpuSensor(this._settings.get_string('cpu-sensor'));
        this._gpu = new GpuSensor({
            id: this._settings.get_string('gpu-sensor'),
            allowWake: this._settings.get_boolean('allow-wake-dgpu'),
            refreshSec,
            minIntervalSec: this._settings.get_int('gpu-min-interval'),
        });
        this._fans = new FanSensor();
        this._rebuildFanRows();
    }

    _rebuildFanRows() {
        this._fanSection.removeAll();
        this._fanRows = this._fans.read().map(f => {
            const row = makeInfoRow(f.label);
            this._fanSection.addMenuItem(row.item);
            return row;
        });
    }

    // ---------------------------------------------------------------- loop

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const seconds = clampInt(this._settings.get_int('refresh-interval'), 1, 60);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._destroyed)
            return;
        if (this._refreshing) {
            // A settings change during an in-flight GPU read must not be lost.
            this._refreshPending = true;
            return;
        }
        this._refreshing = true;
        try {
            this._renderCpu(this._cpu.read());
            this._renderFans(this._fans.read());
            this._renderProfile(this._platform.state());

            const gpu = await this._gpu.read(this._cancellable);
            if (!this._destroyed)
                this._renderGpu(gpu);
        } catch (e) {
            if (!isCancelled(e))
                console.error('[helios-panel] refresh failed:', e);
        } finally {
            this._refreshing = false;
        }
        if (this._refreshPending && !this._destroyed) {
            this._refreshPending = false;
            this._refresh();
        }
    }

    async _updateSwitchMode() {
        try {
            const mode = await this._platform.switchMode();
            if (this._destroyed)
                return;
            this._switchMode = mode;
            this._renderProfile(this._platform.state());
        } catch (e) {
            console.error('[helios-panel] switch mode:', e);
        }
    }

    // ---------------------------------------------------------------- render

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
        const showUnit = this._settings.get_boolean('show-unit');
        const level = tempLevel(celsius, this._settings.get_int(warmKey), this._settings.get_int(hotKey));
        const color = this._colorFor(level);
        seg.label.text = formatTemp(celsius, showUnit);
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
        const seg = this._seg.fan;
        seg.icon.visible = this._settings.get_boolean('show-icons');
        seg.box.visible = this._settings.get_boolean('show-fans') && fans.length > 0;
        seg.label.text = fans.map(f => formatRpm(f.rpm)).join('/');
        fans.forEach((f, i) => {
            if (this._fanRows[i])
                this._fanRows[i].value.text = f.rpm === null ? '--' : `${f.rpm} RPM`;
        });
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
        this._renderProfileMenu(state, style);
    }

    _renderProfileMenu(state, style) {
        let options;
        let selected;
        let hint = '';
        if (!state.available) {
            options = [];
            hint = '';
        } else if (this._switchMode === SwitchMode.DIRECT) {
            options = state.choices.map(id => ({id, label: profileLabel(id, style)}));
            selected = state.current;
        } else if (this._switchMode === SwitchMode.PPD) {
            options = PPD_PROFILES.map(id => ({id, label: PPD_LABELS[id]}));
            selected = ppdForPlatform(state.current);
            hint = 'All profiles: mode key or udev rule (README)';
        } else {
            options = [];
            hint = 'Switching from the menu is unavailable; use the mode key';
        }

        const key = `${this._switchMode}|${style}|${options.map(o => o.id).join(',')}`;
        if (key !== this._profileMenuKey) {
            this._profileMenuKey = key;
            this._profileSection.removeAll();
            this._profileItems = new Map();
            for (const opt of options) {
                const item = new PopupMenu.PopupMenuItem(opt.label);
                item.connect('activate', () => this._setProfile(opt.id));
                this._profileSection.addMenuItem(item);
                this._profileItems.set(opt.id, item);
            }
        }
        for (const [id, item] of this._profileItems ?? [])
            item.setOrnament(id === selected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

        this._profileHint.name.text = hint;
        this._profileHint.item.visible = hint !== '';
    }

    async _setProfile(id) {
        try {
            if (this._switchMode === SwitchMode.DIRECT)
                this._platform.setPlatformProfile(id);
            else if (this._switchMode === SwitchMode.PPD)
                await this._platform.setPpdProfile(id);
        } catch (e) {
            Main.notify('Helios Panel', `Could not change the profile: ${e.message}`);
        }
        // The firmware applies the change asynchronously; read it back shortly.
        if (this._readbackId)
            GLib.source_remove(this._readbackId);
        this._readbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._readbackId = 0;
            if (!this._destroyed)
                this._renderProfile(this._platform.state());
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateLightingSection() {
        this._lightingSection.removeAll();
        if (!this._lighting)
            return;
        // Placeholder until a real backend exists: shows which one was found.
        this._lightingSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Lighting'));
        const row = makeInfoRow(this._lighting.displayName);
        row.value.text = this._lighting.capabilities().targets.join(', ');
        this._lightingSection.addMenuItem(row.item);
    }

    // ---------------------------------------------------------------- settings

    _onSettingChanged(key) {
        if (SENSOR_KEYS.has(key)) {
            this._createSensors();
            if (key === 'refresh-interval')
                this._restartTimer();
        }
        if (key === 'profile-names')
            this._profileMenuKey = '';
        this._refresh();
    }

    _cleanup() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._readbackId) {
            GLib.source_remove(this._readbackId);
            this._readbackId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._gpu?.destroy();
        this._lighting?.destroy();
        this._lighting = null;
    }
});
