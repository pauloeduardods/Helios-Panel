// SPDX-License-Identifier: GPL-3.0-or-later
// Alerts and the automatic profile, as pure logic: no GNOME imports, no
// timers. AlertEngine.update() takes a HeliosClient snapshot, the
// monotonic time in seconds and the settings, and returns actions:
//   {notify: {title, body}}   show a notification
//   {setProfile: id}          ask heliosd to switch the profile
// Time only moves when heliosd sends a change (about every 2 s), so a
// condition "held for N seconds" is measured between those updates.

import {pickCpu, pickGpu, profileLabel} from './model.js';

/** Profiles worth leaving when the battery runs low. */
export const HIGH_POWER_PROFILES = Object.freeze(['performance', 'balanced-performance', 'max-power']);

/** A heat alert re-arms only once the reading is this far below the threshold. */
export const HEAT_HYSTERESIS_C = 3;

/** Tried in order when the on-battery profile is "Automatic" (''). */
export const QUIET_PROFILES = Object.freeze(['low-power', 'quiet', 'cool']);

export const DEFAULT_ALERT_SETTINGS = Object.freeze({
    heatEnabled: true,
    heatCelsius: 95,
    heatSeconds: 30,
    batteryEnabled: true,
    batteryPercent: 20,
    acSwitchEnabled: false,
    batteryProfile: '',
    cpuSensor: '',
    gpuSensor: '',
    profileNames: 'predator',
});

/**
 * The profile to use on battery: the chosen one if the firmware offers it,
 * else (Automatic) the first of QUIET_PROFILES it offers, else null.
 */
export function batteryProfileFor(choice, choices) {
    if (choice)
        return choices.includes(choice) ? choice : null;
    return QUIET_PROFILES.find(id => choices.includes(id)) ?? null;
}

/** True while the machine runs on its battery. */
export function isDischarging(power) {
    if (power.battery?.state === 'charging' || power.battery?.state === 'full')
        return false;
    return power.source === 'battery' || power.battery?.state === 'discharging';
}

/**
 * One heat watch (CPU or GPU). An episode starts when the reading reaches
 * the threshold, fires once after it held for the set time and ends only
 * when the reading drops below threshold - HEAT_HYSTERESIS_C.
 */
export class HeatWatch {
    constructor() {
        this.reset();
    }

    reset() {
        this.since = null; // when the reading reached the threshold
        this.fired = false; // notified in this episode
    }

    /** Returns true when the alert should fire now. */
    update(celsius, now, threshold, seconds) {
        if (celsius === null || celsius === undefined) {
            // No reading (e.g. a sleeping GPU): the streak is broken, but the
            // episode only ends on a reading below the hysteresis band.
            this.since = null;
            return false;
        }
        if (celsius < threshold) {
            this.since = null;
            if (celsius < threshold - HEAT_HYSTERESIS_C)
                this.fired = false;
            return false;
        }
        this.since ??= now;
        if (this.fired || now - this.since < seconds)
            return false;
        this.fired = true;
        return true;
    }
}

export class AlertEngine {
    constructor() {
        this._heat = {cpu: new HeatWatch(), gpu: new HeatWatch()};
        this._batteryFired = false;
        this._lastSource = null;
        this._plan = null;
    }

    /** The profile switch planned for the return to AC, for tests. */
    get plan() {
        return this._plan;
    }

    /**
     * @param snapshot a HeliosClient.snapshot()
     * @param now monotonic seconds
     * @param settings see DEFAULT_ALERT_SETTINGS
     * @returns {Array<{notify: {title: string, body: string}} | {setProfile: string}>}
     */
    update(snapshot, now, settings = DEFAULT_ALERT_SETTINGS) {
        const s = {...DEFAULT_ALERT_SETTINGS, ...settings};
        if (snapshot.state !== 'running') {
            // Start over on the next connection: its first snapshot is no
            // transition, and old streaks say nothing about the new data.
            this._heat.cpu.reset();
            this._heat.gpu.reset();
            this._batteryFired = false;
            this._lastSource = null;
            this._plan = null;
            return [];
        }
        return [
            ...this._heatActions(snapshot, now, s),
            ...this._batteryActions(snapshot, s),
            ...this._sourceActions(snapshot, s),
        ];
    }

    /** SetProfile failed (e.g. polkit said no): forget the planned restore. */
    profileSetFailed() {
        this._plan = null;
    }

    _heatActions({sensors}, now, s) {
        if (!s.heatEnabled) {
            this._heat.cpu.reset();
            this._heat.gpu.reset();
            return [];
        }
        const readings = {
            cpu: pickCpu(sensors, s.cpuSensor),
            gpu: pickGpu(sensors, s.gpuSensor).celsius,
        };
        const actions = [];
        for (const [key, name] of [['cpu', 'CPU'], ['gpu', 'GPU']]) {
            const celsius = readings[key];
            if (this._heat[key].update(celsius, now, s.heatCelsius, s.heatSeconds)) {
                actions.push({
                    notify: {
                        title: `${name} is running hot`,
                        body: `${name} at ${Math.round(celsius)} °C for over ${s.heatSeconds} s ` +
                            `(alert from ${s.heatCelsius} °C).`,
                    },
                });
            }
        }
        return actions;
    }

    _batteryActions({power, profile}, s) {
        if (!isDischarging(power)) {
            this._batteryFired = false;
            return [];
        }
        const percent = power.battery?.percent;
        if (!s.batteryEnabled || this._batteryFired || percent === null || percent === undefined ||
            percent > s.batteryPercent || !HIGH_POWER_PROFILES.includes(profile.current))
            return [];
        this._batteryFired = true;
        const quiet = batteryProfileFor(s.batteryProfile, profile.choices);
        const suggestion = quiet
            ? `Switching to ${profileLabel(quiet, s.profileNames)} makes it last longer.`
            : 'A quieter profile makes it last longer.';
        return [{
            notify: {
                title: 'Battery is running low',
                body: `Battery at ${Math.round(percent)} % on the ` +
                    `${profileLabel(profile.current, s.profileNames)} profile. ${suggestion}`,
            },
        }];
    }

    _sourceActions({power, profile}, s) {
        const source = power.source;
        const current = profile.available ? profile.current : null;
        if (!s.acSwitchEnabled)
            this._plan = null;
        else
            this._watchManualChange(current);

        if (source !== 'ac' && source !== 'battery')
            return []; // 'unknown' says nothing: keep the last known source
        const previous = this._lastSource;
        this._lastSource = source;
        if (!s.acSwitchEnabled || previous === null || previous === source || !current)
            return [];

        if (source === 'battery') {
            const target = batteryProfileFor(s.batteryProfile, profile.choices);
            if (!target || target === current) {
                this._plan = null;
                return [];
            }
            this._plan = {restore: current, target, seen: false};
            return [{setProfile: target}];
        }

        // Back on AC.
        const plan = this._plan;
        this._plan = null;
        if (plan && current === plan.target && profile.choices.includes(plan.restore))
            return [{setProfile: plan.restore}];
        return [];
    }

    /**
     * Drops the planned restore once the profile changes to anything but
     * what we asked for: that change was made by the user (or another
     * tool), and their choice wins.
     */
    _watchManualChange(current) {
        const plan = this._plan;
        if (!plan || !current)
            return;
        if (current === plan.target) {
            plan.seen = true;
        } else if (plan.seen || current !== plan.restore) {
            // Left the target after reaching it, or went somewhere else
            // while our switch was still on its way.
            this._plan = null;
        }
    }
}
