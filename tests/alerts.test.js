// SPDX-License-Identifier: GPL-3.0-or-later
// The alert and automatic-profile decisions in lib/alerts.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    AlertEngine, DEFAULT_ALERT_SETTINGS, HEAT_HYSTERESIS_C, HeatWatch, batteryProfileFor, isDischarging,
} from '../extension/lib/alerts.js';

/** A HeliosClient snapshot with only the parts the engine reads. */
function snap({
    state = 'running', cpu = 60, gpu = null, gpuState = gpu === null ? 'off' : 'on',
    source = 'ac', batteryState = source === 'battery' ? 'discharging' : 'charging', percent = 80,
    profile = 'balanced', choices = ['low-power', 'quiet', 'balanced', 'balanced-performance', 'performance'],
    available = true, temperatures = [],
} = {}) {
    return {
        state,
        sensors: {
            cpu: {sensor: 'hwmon:coretemp/Package id 0', celsius: cpu},
            gpu: {source: 'nvidia-smi', state: gpuState, celsius: gpu},
            fans: [], temperatures, devices: [],
        },
        power: {
            source,
            battery: percent === null ? null : {name: 'BAT1', state: batteryState, percent},
        },
        profile: {available, current: profile, choices, driver: 'acer-wmi'},
    };
}

const quietSettings = {...DEFAULT_ALERT_SETTINGS, batteryEnabled: false};
const notes = actions => actions.filter(a => a.notify).map(a => a.notify);
const switches = actions => actions.filter(a => a.setProfile).map(a => a.setProfile);

/** Feeds snapshots 2 s apart and collects every action. */
function run(engine, snapshots, settings = quietSettings, start = 0) {
    const all = [];
    snapshots.forEach((s, i) => all.push(...engine.update(s, start + i * 2, settings)));
    return all;
}

// ---- heat ------------------------------------------------------------------

test('heat: fires once the reading held the threshold for the set time', () => {
    const w = new HeatWatch();
    assert.equal(w.update(95, 0, 95, 30), false);
    assert.equal(w.update(97, 29, 95, 30), false);
    assert.equal(w.update(96, 30, 95, 30), true);
});

test('heat: fires only once per episode', () => {
    const w = new HeatWatch();
    w.update(99, 0, 95, 30);
    assert.equal(w.update(99, 30, 95, 30), true);
    assert.equal(w.update(99, 32, 95, 30), false);
    assert.equal(w.update(99, 300, 95, 30), false);
});

test('heat: a dip below the threshold restarts the streak', () => {
    const w = new HeatWatch();
    w.update(96, 0, 95, 30);
    w.update(94, 20, 95, 30);
    assert.equal(w.update(96, 22, 95, 30), false);
    assert.equal(w.update(96, 50, 95, 30), false);
    assert.equal(w.update(96, 52, 95, 30), true);
});

test('heat: re-arms only below the hysteresis band', () => {
    const w = new HeatWatch();
    w.update(96, 0, 95, 30);
    assert.equal(w.update(96, 30, 95, 30), true);
    // Within the band: still the same episode.
    w.update(95 - HEAT_HYSTERESIS_C, 32, 95, 30);
    w.update(96, 34, 95, 30);
    assert.equal(w.update(96, 100, 95, 30), false);
    // Below the band: a new episode can fire again.
    w.update(95 - HEAT_HYSTERESIS_C - 0.5, 102, 95, 30);
    w.update(96, 104, 95, 30);
    assert.equal(w.update(96, 134, 95, 30), true);
});

test('heat: a missing reading breaks the streak but does not re-arm', () => {
    const w = new HeatWatch();
    w.update(96, 0, 95, 30);
    w.update(null, 10, 95, 30);
    assert.equal(w.update(96, 30, 95, 30), false);
    assert.equal(w.update(96, 60, 95, 30), true);
    w.update(null, 62, 95, 30);
    w.update(96, 64, 95, 30);
    assert.equal(w.update(96, 200, 95, 30), false);
});

test('engine: CPU heat alert with its reading and settings', () => {
    const e = new AlertEngine();
    const hot = Array.from({length: 16}, () => snap({cpu: 96.4}));
    const got = notes(run(e, hot));
    assert.equal(got.length, 1);
    assert.equal(got[0].title, 'CPU is running hot');
    assert.match(got[0].body, /96 °C for over 30 s/);
    assert.match(got[0].body, /alert from 95 °C/);
});

test('engine: GPU has its own episode and respects the GPU threshold', () => {
    const e = new AlertEngine();
    const settings = {...quietSettings, heatCelsius: 80, heatSeconds: 4};
    const got = notes(run(e, [snap({cpu: 85, gpu: 82}), snap({cpu: 85, gpu: 82}), snap({cpu: 85, gpu: 83})], settings));
    assert.deepEqual(got.map(n => n.title), ['CPU is running hot', 'GPU is running hot']);
});

test('engine: heat alert off sends nothing and forgets the streak', () => {
    const e = new AlertEngine();
    const off = {...quietSettings, heatEnabled: false};
    assert.deepEqual(run(e, Array.from({length: 20}, () => snap({cpu: 99})), off), []);
    // Turned on again: the streak starts now, not 40 s ago.
    assert.deepEqual(e.update(snap({cpu: 99}), 40, quietSettings), []);
    assert.equal(notes(e.update(snap({cpu: 99}), 70, quietSettings)).length, 1);
});

test('engine: uses the CPU sensor chosen in Settings', () => {
    const e = new AlertEngine();
    const temperatures = [{id: 'hwmon:acpitz/temp1', chip: 'acpitz', label: 'temp1', celsius: 99}];
    const settings = {...quietSettings, cpuSensor: 'hwmon:acpitz/temp1', heatSeconds: 2};
    const got = notes(run(e, [snap({cpu: 50, temperatures}), snap({cpu: 50, temperatures})], settings));
    assert.equal(got.length, 1);
    assert.match(got[0].body, /99 °C/);
});

test('engine: losing heliosd resets the heat streak', () => {
    const e = new AlertEngine();
    e.update(snap({cpu: 99}), 0, quietSettings);
    e.update(snap({state: 'not-running'}), 10, quietSettings);
    assert.deepEqual(e.update(snap({cpu: 99}), 31, quietSettings), []);
});

// ---- battery hint ------------------------------------------------------------

const hintSettings = {...DEFAULT_ALERT_SETTINGS, heatEnabled: false};

test('isDischarging: battery source or a discharging battery', () => {
    assert.equal(isDischarging({source: 'battery', battery: {state: 'discharging'}}), true);
    assert.equal(isDischarging({source: 'unknown', battery: {state: 'discharging'}}), true);
    assert.equal(isDischarging({source: 'battery', battery: null}), true);
    assert.equal(isDischarging({source: 'ac', battery: {state: 'charging'}}), false);
    assert.equal(isDischarging({source: 'battery', battery: {state: 'full'}}), false);
    assert.equal(isDischarging({source: 'ac', battery: null}), false);
});

test('battery hint: low battery on a high-power profile, once per discharge', () => {
    const e = new AlertEngine();
    const low = {source: 'battery', percent: 19, profile: 'performance'};
    const got = notes(run(e, [snap({...low, percent: 25}), snap(low), snap(low), snap({...low, percent: 12})], hintSettings));
    assert.equal(got.length, 1);
    assert.equal(got[0].title, 'Battery is running low');
    assert.equal(got[0].body, 'Battery at 19 % on the Turbo profile. Switching to Eco makes it last longer.');
});

test('battery hint: fires at exactly the set percent', () => {
    const e = new AlertEngine();
    assert.equal(notes(e.update(snap({source: 'battery', percent: 20, profile: 'max-power'}), 0, hintSettings)).length, 1);
});

test('battery hint: not on a quiet profile, but later if the user picks a loud one', () => {
    const e = new AlertEngine();
    const base = {source: 'battery', percent: 15};
    assert.deepEqual(run(e, [snap({...base, profile: 'balanced'}), snap({...base, profile: 'low-power'})], hintSettings), []);
    assert.equal(notes(e.update(snap({...base, profile: 'balanced-performance'}), 10, hintSettings)).length, 1);
});

test('battery hint: re-arms after charging, not while still discharging', () => {
    const e = new AlertEngine();
    const low = snap({source: 'battery', percent: 10, profile: 'performance'});
    assert.equal(notes(run(e, [low, low])).length, 0); // hint off in quietSettings
    const e2 = new AlertEngine();
    assert.equal(notes(run(e2, [low, low, snap({source: 'ac', percent: 11, profile: 'performance'}), low], hintSettings)).length, 2);
});

test('battery hint: never on AC, never without a percent, never switches', () => {
    const e = new AlertEngine();
    const actions = run(e, [
        snap({source: 'ac', batteryState: 'charging', percent: 5, profile: 'performance'}),
        snap({source: 'battery', percent: null, profile: 'performance'}),
    ], hintSettings);
    assert.deepEqual(actions, []);
    const e2 = new AlertEngine();
    assert.deepEqual(switches(run(e2, [snap({source: 'battery', percent: 5, profile: 'performance'})], hintSettings)), []);
});

test('battery hint: generic suggestion when no quiet profile exists', () => {
    const e = new AlertEngine();
    const got = notes(e.update(snap({source: 'battery', percent: 5, profile: 'performance', choices: ['balanced', 'performance']}), 0, hintSettings));
    assert.match(got[0].body, /A quieter profile makes it last longer\.$/);
});

test('battery hint: uses the chosen profile names', () => {
    const e = new AlertEngine();
    const got = notes(e.update(snap({source: 'battery', percent: 5, profile: 'performance'}), 0, {...hintSettings, profileNames: 'linux'}));
    assert.equal(got[0].body, 'Battery at 5 % on the performance profile. Switching to low-power makes it last longer.');
});

// ---- profile on AC change -------------------------------------------------------

const acSettings = {...DEFAULT_ALERT_SETTINGS, heatEnabled: false, batteryEnabled: false, acSwitchEnabled: true};

test('batteryProfileFor: automatic picks the quietest offered profile', () => {
    assert.equal(batteryProfileFor('', ['quiet', 'balanced', 'low-power']), 'low-power');
    assert.equal(batteryProfileFor('', ['quiet', 'balanced']), 'quiet');
    assert.equal(batteryProfileFor('', ['balanced', 'performance']), null);
    assert.equal(batteryProfileFor('balanced', ['quiet', 'balanced']), 'balanced');
    assert.equal(batteryProfileFor('low-power', ['quiet', 'balanced']), null);
});

test('ac switch: off by default', () => {
    const e = new AlertEngine();
    const settings = {...DEFAULT_ALERT_SETTINGS, heatEnabled: false, batteryEnabled: false};
    assert.deepEqual(run(e, [snap({source: 'ac'}), snap({source: 'battery'}), snap({source: 'ac'})], settings), []);
});

test('ac switch: unplugging switches, plugging back restores', () => {
    const e = new AlertEngine();
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'performance'}), 0, acSettings), []);
    assert.deepEqual(e.update(snap({source: 'battery', profile: 'performance'}), 2, acSettings), [{setProfile: 'low-power'}]);
    assert.deepEqual(e.update(snap({source: 'battery', profile: 'low-power'}), 4, acSettings), []);
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'low-power'}), 6, acSettings), [{setProfile: 'performance'}]);
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'performance'}), 8, acSettings), []);
});

test('ac switch: no restore when our switch never took effect', () => {
    // Plugged back before heliosd reported the new profile: nothing to undo.
    const e = new AlertEngine();
    e.update(snap({source: 'ac', profile: 'balanced'}), 0, acSettings);
    e.update(snap({source: 'battery', profile: 'balanced'}), 2, acSettings);
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'balanced'}), 4, acSettings), []);
});

test('ac switch: the first snapshot after connecting is no transition', () => {
    const e = new AlertEngine();
    assert.deepEqual(e.update(snap({source: 'battery'}), 0, acSettings), []);
    const e2 = new AlertEngine();
    e2.update(snap({source: 'ac'}), 0, acSettings);
    e2.update(snap({state: 'not-running'}), 2, acSettings);
    assert.deepEqual(e2.update(snap({source: 'battery'}), 4, acSettings), []);
});

test('ac switch: unknown is ignored and keeps the last known source', () => {
    const e = new AlertEngine();
    assert.deepEqual(run(e, [snap({source: 'unknown'}), snap({source: 'unknown'})], acSettings), []);
    const e2 = new AlertEngine();
    const got = run(e2, [snap({source: 'ac'}), snap({source: 'unknown'}), snap({source: 'battery'})], acSettings);
    assert.deepEqual(switches(got), ['low-power']);
});

test('ac switch: a manual change on battery cancels the restore', () => {
    const e = new AlertEngine();
    const got = run(e, [
        snap({source: 'ac', profile: 'performance'}),
        snap({source: 'battery', profile: 'performance'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'battery', profile: 'balanced'}), // the user
        snap({source: 'ac', profile: 'balanced'}),
    ], acSettings);
    assert.deepEqual(switches(got), ['low-power']);
});

test('ac switch: a manual change back to the target still counts as manual', () => {
    const e = new AlertEngine();
    const got = run(e, [
        snap({source: 'ac', profile: 'performance'}),
        snap({source: 'battery', profile: 'performance'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'battery', profile: 'balanced'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'ac', profile: 'low-power'}),
    ], acSettings);
    assert.deepEqual(switches(got), ['low-power']);
});

test('ac switch: a manual change before ours lands cancels the restore', () => {
    const e = new AlertEngine();
    const got = run(e, [
        snap({source: 'ac', profile: 'performance'}),
        snap({source: 'battery', profile: 'performance'}),
        snap({source: 'battery', profile: 'balanced'}),
        snap({source: 'ac', profile: 'balanced'}),
    ], acSettings);
    assert.deepEqual(switches(got), ['low-power']);
    assert.equal(e.plan, null);
});

test('ac switch: a failed switch forgets the restore', () => {
    const e = new AlertEngine();
    run(e, [snap({source: 'ac', profile: 'performance'}), snap({source: 'battery', profile: 'performance'})], acSettings);
    assert.notEqual(e.plan, null);
    e.profileSetFailed();
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'performance'}), 10, acSettings), []);
});

test('ac switch: nothing to do when already on the battery profile', () => {
    const e = new AlertEngine();
    const got = run(e, [
        snap({source: 'ac', profile: 'low-power'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'ac', profile: 'low-power'}),
    ], acSettings);
    assert.deepEqual(got, []);
});

test('ac switch: a chosen profile the firmware lacks is not used', () => {
    const e = new AlertEngine();
    const settings = {...acSettings, batteryProfile: 'cool'};
    assert.deepEqual(run(e, [snap({source: 'ac'}), snap({source: 'battery'})], settings), []);
    const e2 = new AlertEngine();
    const quiet = {...acSettings, batteryProfile: 'quiet'};
    assert.deepEqual(switches(run(e2, [snap({source: 'ac'}), snap({source: 'battery'})], quiet)), ['quiet']);
});

test('ac switch: no profile support means no switch', () => {
    const e = new AlertEngine();
    const none = {available: false, profile: null, choices: []};
    assert.deepEqual(run(e, [snap({source: 'ac', ...none}), snap({source: 'battery', ...none})], acSettings), []);
});

test('ac switch: turned off on battery drops the restore', () => {
    const e = new AlertEngine();
    run(e, [snap({source: 'ac', profile: 'performance'}), snap({source: 'battery', profile: 'performance'}),
        snap({source: 'battery', profile: 'low-power'})], acSettings);
    e.update(snap({source: 'battery', profile: 'low-power'}), 10, {...acSettings, acSwitchEnabled: false});
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'low-power'}), 12, acSettings), []);
});

test('ac switch: a restore target the firmware no longer offers is skipped', () => {
    const e = new AlertEngine();
    run(e, [snap({source: 'ac', profile: 'performance'}), snap({source: 'battery', profile: 'performance'}),
        snap({source: 'battery', profile: 'low-power'})], acSettings);
    assert.deepEqual(e.update(snap({source: 'ac', profile: 'low-power', choices: ['low-power', 'balanced']}), 10, acSettings), []);
});

test('ac switch: repeated unplugs each switch and restore', () => {
    const e = new AlertEngine();
    const got = run(e, [
        snap({source: 'ac', profile: 'balanced'}),
        snap({source: 'battery', profile: 'balanced'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'ac', profile: 'low-power'}),
        snap({source: 'ac', profile: 'balanced'}),
        snap({source: 'battery', profile: 'balanced'}),
        snap({source: 'battery', profile: 'low-power'}),
        snap({source: 'ac', profile: 'low-power'}),
    ], acSettings);
    assert.deepEqual(switches(got), ['low-power', 'balanced', 'low-power', 'balanced']);
});
