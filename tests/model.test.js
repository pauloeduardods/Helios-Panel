// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Level, batteryStateLabel, daemonMessage, formatDuration, formatRpm, formatTemp, formatWatts,
    pickCpu, pickGpu, powerFromDbus, powerPanelText, profileColor, profileFromDbus, profileLabel,
    sanitizeThresholds, sensorsFromDbus, setProfileError, tempLevel,
} from '../extension/lib/model.js';

// What heliosd publishes on a PHN16-72 with the NVIDIA GPU asleep.
const SENSORS = {
    Cpu: ['hwmon:coretemp/Package id 0', true, 61],
    Gpu: ['nvidia-smi', 'off', false, 0],
    Fans: [['Fan 1', 2350], ['Fan 2', -1]],
    Temperatures: [
        ['hwmon:coretemp/Package id 0', 'coretemp', 'Package id 0', 61],
        ['hwmon:coretemp/Core 0', 'coretemp', 'Core 0', 58],
        ['hwmon:acer/temp1', 'acer', 'temp1', 52],
    ],
};

test('temperature levels respect thresholds, even inverted ones', () => {
    assert.equal(tempLevel(60, 75, 90), Level.NORMAL);
    assert.equal(tempLevel(75, 75, 90), Level.WARM);
    assert.equal(tempLevel(95, 75, 90), Level.HOT);
    assert.equal(tempLevel(null, 75, 90), Level.UNKNOWN);
    assert.deepEqual(sanitizeThresholds(95, 90), {warm: 89, hot: 90});
    assert.equal(tempLevel(89.5, 95, 90), Level.WARM);
});

test('formatting', () => {
    assert.equal(formatTemp(61.6), '62°C');
    assert.equal(formatTemp(61.4, false), '61°');
    assert.equal(formatTemp(null), '--');
    assert.equal(formatRpm(2350), '2.4k');
    assert.equal(formatRpm(800), '800');
    assert.equal(formatRpm(null), '--');
});

test('profile names and colors', () => {
    assert.equal(profileLabel('balanced-performance'), 'Performance');
    assert.equal(profileLabel('performance'), 'Turbo');
    assert.equal(profileLabel('quiet', 'portuguese'), 'Silencioso');
    assert.equal(profileLabel('quiet', 'linux'), 'quiet');
    assert.equal(profileLabel('weird-new-one'), 'weird-new-one');
    assert.equal(profileLabel(null), '--');
    assert.equal(profileColor('balanced'), null);
    assert.equal(profileColor('performance'), '#f66151');
    assert.equal(profileColor('unknown'), null);
});

test('power formatting', () => {
    assert.equal(formatWatts(24.46), '24.5 W');
    assert.equal(formatWatts(0), '0.0 W');
    assert.equal(formatWatts(112.4), '112 W');
    assert.equal(formatWatts(null), '--');
    assert.equal(formatDuration(172), '2 h 52 min');
    assert.equal(formatDuration(60), '1 h 00 min');
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatDuration(null), '--');
    assert.equal(formatDuration(-1), '--');
    assert.equal(batteryStateLabel('not-charging'), 'Not charging');
    assert.equal(batteryStateLabel('weird'), 'Unknown');
});

test('heliosd power becomes a plain object', () => {
    // A PHN16-72 on AC with the battery held at 80%.
    const ac = powerFromDbus({
        GpuPower: [true, 1.9],
        CpuPower: [true, 12.3],
        PowerSource: 'ac',
        Battery: ['BAT1', 'not-charging', 80, 0, 92, 0, -1],
    });
    assert.deepEqual(ac, {
        source: 'ac',
        gpuWatts: 1.9,
        cpuWatts: 12.3,
        battery: {
            name: 'BAT1', state: 'not-charging', percent: 80, watts: 0,
            health: 92, cycles: null, minutesLeft: null,
        },
    });
    assert.equal(powerPanelText(ac), 'AC');

    const onBattery = powerFromDbus({
        GpuPower: [false, 0],
        PowerSource: 'battery',
        Battery: ['BAT1', 'discharging', 80, 24.5, 92, 312, 172],
    });
    assert.equal(onBattery.gpuWatts, null);
    assert.equal(onBattery.cpuWatts, null, 'API v2: no CpuPower');
    assert.equal(onBattery.battery.cycles, 312);
    assert.equal(onBattery.battery.minutesLeft, 172);
    assert.equal(powerPanelText(onBattery), '24.5 W');

    const unknownDraw = powerFromDbus({PowerSource: 'battery', Battery: ['BAT0', 'discharging', -1, -1, -1, -1, -1]});
    assert.equal(powerPanelText(unknownDraw), '--');
    assert.equal(unknownDraw.battery.percent, null);
});

test('an older heliosd without power properties shows nothing', () => {
    const none = powerFromDbus({});
    assert.deepEqual(none, {source: 'unknown', gpuWatts: null, cpuWatts: null, battery: null});
    assert.equal(powerPanelText(none), null);
    assert.deepEqual(powerFromDbus(), none);
    assert.equal(powerFromDbus({Battery: ['', 'unknown', -1, -1, -1, -1, -1]}).battery, null);
});

test('heliosd sensors become plain objects', () => {
    const s = sensorsFromDbus(SENSORS);
    assert.deepEqual(s.cpu, {sensor: 'hwmon:coretemp/Package id 0', celsius: 61});
    assert.deepEqual(s.gpu, {source: 'nvidia-smi', state: 'off', celsius: null});
    assert.deepEqual(s.fans, [{label: 'Fan 1', rpm: 2350}, {label: 'Fan 2', rpm: null}]);
    assert.equal(s.temperatures.length, 3);
});

test('missing properties never throw', () => {
    const s = sensorsFromDbus({});
    assert.deepEqual(s.cpu, {sensor: null, celsius: null});
    assert.equal(s.gpu.state, 'none');
    assert.deepEqual(s.fans, []);
    assert.deepEqual(profileFromDbus({}), {available: false, current: null, choices: [], driver: null});
    assert.deepEqual(sensorsFromDbus(), sensorsFromDbus({}));
});

test('heliosd profile becomes a plain object', () => {
    assert.deepEqual(
        profileFromDbus({Available: true, Active: 'quiet', Choices: ['low-power', 'quiet'], Driver: 'acer-wmi'}),
        {available: true, current: 'quiet', choices: ['low-power', 'quiet'], driver: 'acer-wmi'});
});

test('user sensor override wins, falls back to heliosd when it vanished', () => {
    const s = sensorsFromDbus(SENSORS);
    assert.equal(pickCpu(s, ''), 61);
    assert.equal(pickCpu(s, 'hwmon:coretemp/Core 0'), 58);
    assert.equal(pickCpu(s, 'hwmon:gone/x'), 61);

    assert.deepEqual(pickGpu(s, ''), {state: 'off', celsius: null});
    assert.deepEqual(pickGpu(s, 'hwmon:acer/temp1'), {state: 'on', celsius: 52});
    assert.deepEqual(pickGpu(s, 'nvidia-smi'), {state: 'off', celsius: null}, 'old setting means automatic');
});

test('daemon not running and connecting states have messages', () => {
    assert.deepEqual(daemonMessage('not-running'), {
        panel: 'helios off',
        menu: 'heliosd is not running',
        hint: 'Find out why with: heliosctl doctor',
    });
    assert.equal(daemonMessage('connecting').panel, '--');
    assert.equal(daemonMessage('running'), null);
});

test('SetProfile errors get readable messages', () => {
    assert.equal(setProfileError('NotAuthorized', 'x'), 'Not authorized to change the profile');
    assert.equal(setProfileError('InvalidArgument', 'x'), 'The firmware does not offer that profile');
    assert.equal(setProfileError('NotRunning', 'x'), 'heliosd is not running');
    assert.equal(setProfileError('WriteFailed', 'writing failed: EIO'), 'writing failed: EIO');
    assert.equal(setProfileError('Failed', ''), 'Could not change the profile');
});
