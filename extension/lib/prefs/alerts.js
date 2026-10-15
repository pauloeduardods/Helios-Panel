// SPDX-License-Identifier: GPL-3.0-or-later
// The "Alerts" page of the preferences window.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {BUS_NAME, OBJECT_PATH} from '../client.js';
import {PROFILE_INFO, profileFromDbus, profileLabel} from '../model.js';

/** Builds the Adw.PreferencesPage for the alert settings. */
export function alertsPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Alerts', icon_name: 'preferences-system-notifications-symbolic'});

    const heat = new Adw.PreferencesGroup({
        title: 'Heat alert',
        description: 'A notification when the CPU or GPU stays hot. Once per episode: it can ' +
            'come again only after the reading drops a few degrees below the limit.',
    });
    heat.add(switchRow(settings, 'heat-alert', 'Notify when hot'));
    heat.add(spinRow(settings, 'heat-alert-celsius', 'From (°C)', null, 50, 110));
    heat.add(spinRow(settings, 'heat-alert-seconds', 'For at least (seconds)', null, 2, 600));
    page.add(heat);

    const battery = new Adw.PreferencesGroup({
        title: 'Low battery',
        description: 'A hint, once per discharge, when the battery is low and a high-power ' +
            'profile (Performance, Turbo, Max) is active. It never switches by itself.',
    });
    battery.add(switchRow(settings, 'battery-hint', 'Suggest a quieter profile'));
    battery.add(spinRow(settings, 'battery-hint-percent', 'At or below (%)', null, 5, 80));
    page.add(battery);

    const ac = new Adw.PreferencesGroup({
        title: 'Profile when unplugged',
        description: 'Switches to the profile below when the charger is unplugged and restores ' +
            'the previous one when it is plugged back in, unless you changed the profile meanwhile.',
    });
    ac.add(switchRow(settings, 'profile-on-battery', 'Switch profile on battery'));
    const style = settings.get_string('profile-names');
    const choices = readChoices() ?? Object.keys(PROFILE_INFO);
    ac.add(comboRow(settings, 'battery-profile', 'Profile on battery', [
        ['', 'Automatic (Eco, else Quiet)'],
        ...choices.map(id => [id, profileLabel(id, style)]),
    ]));
    page.add(ac);
    return page;
}

/** The profiles the firmware offers, or null when heliosd is unreachable. */
function readChoices() {
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        const props = bus.call_sync(
            BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['io.github.pauloeduardods.Helios1.Profile']),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, null,
        ).recursiveUnpack()[0];
        const {available, choices} = profileFromDbus(props);
        return available && choices.length ? choices : null;
    } catch (e) {
        console.warn(`[helios-panel] heliosd unavailable: ${e.message}`);
        return null;
    }
}

// Copies of the prefs.js row helpers, kept here so prefs.js stays as is.

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
        options = [...options, [current, `${current} (not offered)`]];
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    row.selected = options.findIndex(([value]) => value === current);
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option)
            settings.set_string(key, option[0]);
    });
    return row;
}
