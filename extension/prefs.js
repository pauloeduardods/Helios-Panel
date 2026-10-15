// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BUS_NAME, OBJECT_PATH} from './lib/client.js';
import {profileFromDbus, sensorsFromDbus} from './lib/model.js';
import {LayoutPage} from './lib/prefs/layoutPage.js';
import {alertsPage} from './lib/prefs/alerts.js';

export default class HeliosPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.add(new LayoutPage(settings, window, this.path).page);
        window.add(this._panelPage(settings));
        window.add(this._temperaturePage(settings));
        window.add(this._sensorPage(settings));
        window.add(alertsPage(settings));
    }

    // ------------------------------------------------------------ pages

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Panel', icon_name: 'video-display-symbolic'});

        const show = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'What each segment shows, its template, icon and graph are on the Layout page.',
        });
        show.add(switchRow(settings, 'hide-gpu-when-off', 'Hide the GPU when it is off',
            'Otherwise shows a dimmed "off"'));
        page.add(show);

        const profile = new Adw.PreferencesGroup({title: 'Profile'});
        profile.add(comboRow(settings, 'profile-names', 'Profile names', [
            ['predator', 'PredatorSense (Quiet, Balanced, Turbo…)'],
            ['portuguese', 'Portuguese (Silencioso, Equilibrado…)'],
            ['linux', 'Linux (quiet, balanced, performance…)'],
        ]));
        profile.add(switchRow(settings, 'color-profile', 'Color by power level',
            'Blue for power saving, orange for Performance, red for Turbo'));
        page.add(profile);

        const place = new Adw.PreferencesGroup({title: 'Position'});
        place.add(comboRow(settings, 'panel-position', 'Top bar area', [
            ['left', 'Left'], ['center', 'Center'], ['right', 'Right (next to Wi-Fi)'],
        ]));
        place.add(spinRow(settings, 'panel-index', 'Order within the area', '0 = leftmost', 0, 20));
        page.add(place);
        return page;
    }

    _temperaturePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Colors', icon_name: 'applications-graphics-symbolic'});

        const cpu = new Adw.PreferencesGroup({title: 'CPU thresholds (°C)'});
        cpu.add(spinRow(settings, 'cpu-warm', 'Warm from', null, 30, 110));
        cpu.add(spinRow(settings, 'cpu-hot', 'Hot from', null, 30, 110));
        page.add(cpu);

        const gpu = new Adw.PreferencesGroup({title: 'GPU thresholds (°C)'});
        gpu.add(spinRow(settings, 'gpu-warm', 'Warm from', null, 30, 110));
        gpu.add(spinRow(settings, 'gpu-hot', 'Hot from', null, 30, 110));
        page.add(gpu);

        const colors = new Adw.PreferencesGroup({
            title: 'Colors',
            description: 'Used by the readings and, unless a segment picks a fixed color, by the graphs.',
        });
        colors.add(colorRow(settings, 'color-normal', 'Normal', 'Empty = theme color'));
        colors.add(colorRow(settings, 'color-warm', 'Warm', null));
        colors.add(colorRow(settings, 'color-hot', 'Hot', null));
        colors.add(switchRow(settings, 'bold-when-hot', 'Bold when hot'));
        page.add(colors);
        return page;
    }

    _sensorPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Sensors', icon_name: 'utilities-system-monitor-symbolic'});
        const daemon = readDaemon();
        const sensors = daemon?.sensors.temperatures ?? [];
        const sensorOptions = sensors.map(s => [s.id, `${s.chip} / ${s.label}`]);

        const pick = new Adw.PreferencesGroup({
            title: 'Reading sources',
            description: 'Automatic uses what heliosd picks: the CPU package (coretemp/k10temp) ' +
                'and the discrete GPU. An NVIDIA GPU that is asleep is never woken.',
        });
        pick.add(comboRow(settings, 'cpu-sensor', 'CPU sensor',
            [['', 'Automatic'], ...sensorOptions]));
        pick.add(comboRow(settings, 'gpu-sensor', 'GPU sensor',
            [['', 'Automatic'], ...sensorOptions]));
        page.add(pick);

        const diag = new Adw.PreferencesGroup({title: 'Diagnostics'});
        if (!daemon) {
            diag.add(infoRow('heliosd', 'not running — find out why with: heliosctl doctor'));
        } else {
            const {profile} = daemon;
            diag.add(infoRow('heliosd', `running, version ${daemon.version ?? '?'}`));
            diag.add(infoRow('Power profile', profile.available
                ? `${profile.current} (driver: ${profile.driver ?? 'acpi'})`
                : 'unavailable — run: heliosctl status'));
            diag.add(infoRow('Firmware profiles', profile.choices.join(', ') || '—'));
            diag.add(infoRow('GPU', daemon.sensors.gpu.source
                ? `${daemon.sensors.gpu.source} (${daemon.sensors.gpu.state})`
                : 'no sensor found'));
            diag.add(infoRow('Temperature sensors', `${sensors.length} found`));
        }
        page.add(diag);
        return page;
    }
}

/** One synchronous read of everything heliosd publishes, or null. */
function readDaemon() {
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const getAll = iface => bus.call_sync(
            BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [`io.github.pauloeduardods.Helios1.${iface}`]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, null,
        ).recursiveUnpack()[0];
        return {
            version: getAll('Daemon').Version ?? null,
            sensors: sensorsFromDbus(getAll('Sensors')),
            profile: profileFromDbus(getAll('Profile')),
        };
    } catch (e) {
        console.warn(`[helios-panel] heliosd unavailable: ${e.message}`);
        return null;
    }
}

// ------------------------------------------------------------ row helpers

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    return row;
}

/** options: [value, label][] for a string key. Unknown stored values are kept. */
function comboRow(settings, key, title, options) {
    const current = settings.get_string(key);
    if (!options.some(([value]) => value === current))
        options = [...options, [current, `${current} (not found)`]];
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    // Set after construction so it cannot be applied before the model.
    row.selected = options.findIndex(([value]) => value === current);
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option)
            settings.set_string(key, option[0]);
    });
    return row;
}

function colorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title});
    if (subtitle)
        row.subtitle = subtitle;

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const rgba = new Gdk.RGBA();
    if (rgba.parse(settings.get_string(key) || '#ffffff'))
        button.rgba = rgba;
    button.connect('notify::rgba', () => settings.set_string(key, button.rgba.to_string()));
    row.add_suffix(button);

    const reset = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: 'Restore default',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    return row;
}

function infoRow(title, value) {
    const row = new Adw.ActionRow({title, subtitle: value});
    row.add_css_class('property');
    return row;
}
