// SPDX-License-Identifier: GPL-3.0-or-later
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HeliosAlerts} from './lib/ui/alerts.js';
import {HeliosIndicator} from './lib/ui/indicator.js';

export default class HeliosPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._placementIds = ['changed::panel-position', 'changed::panel-index']
            .map(signal => this._settings.connect(signal, () => this._place()));
        this._place();
        this._alerts = new HeliosAlerts(this._settings);
    }

    disable() {
        this._alerts?.destroy();
        this._alerts = null;
        for (const id of this._placementIds ?? [])
            this._settings.disconnect(id);
        this._placementIds = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    /** (Re)creates the indicator where the settings say it belongs. */
    _place() {
        this._indicator?.destroy();
        this._indicator = new HeliosIndicator(this);
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }
}
