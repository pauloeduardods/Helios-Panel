// SPDX-License-Identifier: GPL-3.0-or-later
// HeliosAlerts: the GNOME side of lib/alerts.js. It owns its own
// HeliosClient (without history), feeds every heliosd change to an
// AlertEngine with the monotonic time and the settings, and carries out
// the actions: a notification, or a SetProfile call (polkit decides).
// No timers: it only runs when heliosd reports a change.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AlertEngine} from '../alerts.js';
import {HeliosClient} from '../client.js';
import {profileLabel, setProfileError} from '../model.js';

/** The settings the engine reads, from GSettings. */
function readSettings(settings) {
    return {
        heatEnabled: settings.get_boolean('heat-alert'),
        heatCelsius: settings.get_int('heat-alert-celsius'),
        heatSeconds: settings.get_int('heat-alert-seconds'),
        batteryEnabled: settings.get_boolean('battery-hint'),
        batteryPercent: settings.get_int('battery-hint-percent'),
        acSwitchEnabled: settings.get_boolean('profile-on-battery'),
        batteryProfile: settings.get_string('battery-profile'),
        cpuSensor: settings.get_string('cpu-sensor'),
        gpuSensor: settings.get_string('gpu-sensor'),
        profileNames: settings.get_string('profile-names'),
    };
}

export class HeliosAlerts {
    constructor(settings) {
        this._settings = settings;
        this._engine = new AlertEngine();
        this._client = new HeliosClient(() => this._update(), {history: false});
    }

    _update() {
        if (!this._client)
            return;
        const now = GLib.get_monotonic_time() / 1e6;
        const actions = this._engine.update(this._client.snapshot(), now, readSettings(this._settings));
        for (const action of actions) {
            if (action.notify)
                Main.notify(action.notify.title, action.notify.body);
            else if (action.setProfile)
                this._setProfile(action.setProfile);
        }
    }

    async _setProfile(id) {
        try {
            await this._client?.setProfile(id);
        } catch (e) {
            if (!this._client)
                return;
            this._engine.profileSetFailed();
            const name = profileLabel(id, this._settings.get_string('profile-names'));
            Main.notify(`Could not switch to ${name}`, setProfileError(e.name, e.message));
        }
    }

    destroy() {
        this._client?.destroy();
        this._client = null;
        this._engine = null;
        this._settings = null;
    }
}
