// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Level, batteryStateLabel, daemonMessage, formatClock, formatMemory, formatDuration, formatPercent, formatRpm,
    formatTemp, formatWatts, pickCpu, pickGpu, powerFromDbus, powerPanelText, profileColor,
    profileFromDbus, profileLabel, sanitizeThresholds, sensorsFromDbus, setProfileError, tempLevel,
    usageFromDbus, historyFromDbus, sparklineSegments, sparklinePieces, HistoryBuffer,
    historySample, normalizeOrder, moveItem, PANEL_ITEMS, parseColor,
    KEYBOARD_EFFECTS, LIGHT_COLORS, effectLabel, keyboardRequest, lightingError, lightingFromDbus,
    LOGO_MODES, logoModeLabel, logoRequest, powerSummary, usageSummary,
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
    assert.deepEqual(s.devices, []);
});

test('drives and the Wi-Fi card become plain objects', () => {
    const s = sensorsFromDbus({Devices: [['storage', 'CT500P2SSD8', 44.9], ['wifi', 'Wi-Fi', 52]]});
    assert.deepEqual(s.devices, [
        {kind: 'storage', name: 'CT500P2SSD8', celsius: 44.9},
        {kind: 'wifi', name: 'Wi-Fi', celsius: 52},
    ]);
});

test('usage and clock', () => {
    const u = usageFromDbus({
        CpuUsage: [true, 23], CpuFrequency: [true, 1.4, 3.8], GpuUsage: [false, 0], Memory: [true, 40, 12.4, 31.1],
    });
    assert.deepEqual(u, {cpu: 23, gpu: null, averageGhz: 1.4, maxGhz: 3.8, ram: 40, ramUsedGib: 12.4, ramTotalGib: 31.1});
    assert.equal(formatMemory(u), '12.4 / 31.1 GiB · 40%');
    assert.equal(formatPercent(u.cpu), '23%');
    assert.equal(formatPercent(u.gpu), '--');
    assert.equal(formatClock(u), '1.4 GHz · max 3.8 GHz');

    const older = usageFromDbus({});
    assert.deepEqual(older, {
        cpu: null, gpu: null, averageGhz: null, maxGhz: null, ram: null, ramUsedGib: null, ramTotalGib: null,
    }, 'API v3 heliosd');
    assert.equal(formatClock(older), null);
    assert.equal(formatMemory(older), null);
    assert.equal(usageFromDbus({Memory: [false, 0, 0, 0]}).ram, null);
    assert.deepEqual(usageFromDbus(), older);
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

test('GetHistory becomes plain arrays with nulls for gaps', () => {
    const h = historyFromDbus([[4, 2, 0], [['cpu-celsius', [true, false, true], [60, 0, 70]]]]);
    assert.deepEqual(h, {ages: [4, 2, 0], series: {'cpu-celsius': [60, null, 70]}});
    assert.deepEqual(historyFromDbus(undefined), {ages: [], series: {}});
});

test('sparklines span the window, split at gaps and never exaggerate noise', () => {
    const history = {
        ages: [300, 150, 2, 0],
        series: {
            'cpu-usage': [0, 100, null, 50],
            'cpu-celsius': [61, 61.2, 61.1, 61],
            'gpu-celsius': [null, null, null, null],
        },
    };
    assert.deepEqual(sparklineSegments(history, 'cpu-usage', 100, 22), [
        [[0, 21], [50, 1]],
        [[100, 11]],
    ]);
    // 0.2 °C of noise is drawn within a 10 °C range: nearly flat in the middle.
    const flat = sparklineSegments(history, 'cpu-celsius', 100, 22)[0].map(([, y]) => y);
    assert.ok(flat.every(y => Math.abs(y - 11) < 0.5), String(flat));
    assert.deepEqual(sparklineSegments(history, 'gpu-celsius', 100, 22), []);
    assert.deepEqual(sparklineSegments(null, 'cpu-usage', 100, 22), []);
});

test('the local history loads GetHistory, then grows and trims to five minutes', () => {
    const h = new HistoryBuffer();
    h.load([[4, 2], [['cpu-celsius', [true, true], [60, 61]]]], 1000);
    assert.deepEqual(h.view(1000).ages, [4, 2]);
    assert.deepEqual(h.series['cpu-celsius'], [60, 61]);
    assert.deepEqual(h.series['gpu-usage'], [null, null], 'series heliosd did not send are empty');

    h.push(1002, {'cpu-celsius': 62, 'gpu-usage': 5});
    assert.deepEqual(h.view(1002).ages, [6, 4, 0]);
    assert.deepEqual(h.series['cpu-celsius'], [60, 61, 62]);
    assert.deepEqual(h.series['gpu-usage'], [null, null, 5]);

    h.push(1300, {'cpu-celsius': 70});
    assert.deepEqual(h.view(1300).ages, [298, 0], 'older than 300 s is dropped');
    assert.deepEqual(h.series['cpu-celsius'], [62, 70]);

    for (let t = 1302; t < 1302 + 2 * 200; t += 2)
        h.push(t, {});
    assert.equal(h.times.length, 150, 'never more than heliosd keeps');
});

test('a history sample takes the battery draw only while discharging', () => {
    const snapshot = discharging => ({
        sensors: {cpu: {celsius: 61}, gpu: {celsius: null}},
        usage: {cpu: 23, gpu: null, ram: 40},
        power: {cpuWatts: 12.3, battery: {state: discharging ? 'discharging' : 'charging', watts: 24.5}},
    });
    assert.deepEqual(historySample(snapshot(true)), {
        'cpu-celsius': 61, 'gpu-celsius': null, 'cpu-usage': 23, 'gpu-usage': null,
        'cpu-watts': 12.3, 'battery-watts': 24.5, 'memory-usage': 40,
    });
    assert.equal(historySample(snapshot(false))['battery-watts'], null);
});

test('sparkline pieces change color where the reading crosses a threshold', () => {
    const history = {ages: [6, 4, 2, 0], series: {'cpu-celsius': [70, 80, 95, 96]}};
    const levelOf = v => (v >= 90 ? 'hot' : 'normal');
    const pieces = sparklinePieces(history, 'cpu-celsius', 60, 20, {windowS: 6, levelOf});
    assert.deepEqual(pieces.map(p => [p.level, p.points.map(([x]) => Math.round(x))]), [
        ['normal', [0, 20]],
        ['hot', [20, 40, 60]],
    ]);
});

test('sparkline pieces only draw what is inside the window', () => {
    const history = {ages: [200, 60, 0], series: {'cpu-usage': [100, 0, 50]}};
    const pieces = sparklinePieces(history, 'cpu-usage', 100, 22, {windowS: 60});
    assert.deepEqual(pieces[0].points.map(([x]) => x), [0, 100]);
    assert.deepEqual(pieces[0].points.map(([, y]) => y), [21, 1], 'scaled to the visible 0–50');
});

test('the panel order keeps every item once', () => {
    const ids = PANEL_ITEMS.map(i => i.id);
    assert.deepEqual(normalizeOrder(undefined), ids);
    assert.deepEqual(normalizeOrder(['profile', 'bogus', 'profile', 'cpu']),
        ['profile', 'cpu', ...ids.filter(id => id !== 'profile' && id !== 'cpu')]);
    assert.deepEqual(moveItem(ids, 'gpu', -1).slice(0, 2), ['gpu', 'cpu']);
    assert.deepEqual(moveItem(ids, 'cpu', -1), ids, 'already first');
    assert.deepEqual(moveItem(ids, 'profile', 5), ids, 'already last');
    assert.deepEqual(moveItem(ids, 'nope', 1), ids);
});

test('color settings parse for Cairo', () => {
    assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
    assert.deepEqual(parseColor('#0f0'), [0, 1, 0]);
    assert.deepEqual(parseColor('rgb(98,160,234)').map(c => Math.round(c * 255)), [98, 160, 234]);
    assert.deepEqual(parseColor('rgba(0, 0, 255, 0.5)'), [0, 0, 1]);
    assert.equal(parseColor(''), null, 'empty = theme color');
    assert.equal(parseColor('tomato'), null);
    assert.equal(parseColor(undefined), null);
});

// ---------------------------------------------------------------- lighting

test('lightingFromDbus: unavailable without the module or on an older heliosd', () => {
    assert.deepEqual(lightingFromDbus({}),
        {available: false, effects: [], directions: [], logoModes: [], keyboard: null, logo: null});
    assert.equal(lightingFromDbus({Keyboard: ['wave', 5, 100, 'left', '#000000']}).available, false);
    // heliosd before API 7: the logo has no mode, and SetLogo takes three arguments.
    assert.equal(lightingFromDbus({
        Keyboard: ['wave', 5, 100, 'left', '#000000'], Logo: [true, 100, '#00ff00'],
    }).available, false);
});

test('lightingFromDbus: the keyboard and the logo', () => {
    const l = lightingFromDbus({
        Effects: ['breathing', 'neon', 'wave', 'shifting', 'zoom'],
        Directions: ['left', 'right'],
        LogoModes: ['static', 'breathing', 'cycle'],
        Keyboard: ['zoom', 4, 80, 'right', '#ff00ff'],
        Logo: [true, 100, '#00ff00', 'cycle'],
    });
    assert.equal(l.available, true);
    assert.deepEqual(l.keyboard, {effect: 'zoom', speed: 4, brightness: 80, direction: 'right', color: '#ff00ff'});
    assert.deepEqual(l.logo, {on: true, brightness: 100, color: '#00ff00', mode: 'cycle'});
    assert.deepEqual(l.logoModes, ['static', 'breathing', 'cycle']);
    assert.deepEqual(l.directions, ['left', 'right']);
});

test('keyboardRequest changes one thing and keeps the rest', () => {
    const current = {effect: 'zoom', speed: 4, brightness: 80, direction: 'right', color: '#ff00ff'};
    assert.deepEqual(keyboardRequest(current, {effect: 'breathing'}), ['breathing', 4, 80, 'right', '#ff00ff']);
    assert.deepEqual(keyboardRequest(current, {brightness: 33.4}), ['zoom', 4, 33, 'right', '#ff00ff']);
    assert.deepEqual(keyboardRequest(current, {speed: 9 * 0.5}), ['zoom', 5, 80, 'right', '#ff00ff']);
    assert.deepEqual(keyboardRequest(current, {direction: 'left'}), ['zoom', 4, 80, 'left', '#ff00ff']);
    assert.deepEqual(keyboardRequest(current, {color: '#00ffff'}), ['zoom', 4, 80, 'right', '#00ffff']);
});

test('keyboardRequest never sends what heliosd would reject', () => {
    // Static, or an effect set by another tool, falls back to defaults.
    const odd = {effect: 'static', speed: 0, brightness: 100, direction: 'unknown', color: '#000000'};
    assert.deepEqual(keyboardRequest(odd, {brightness: 50}), ['wave', 4, 50, 'right', '#ffffff']);
    assert.deepEqual(keyboardRequest(null, {effect: 'neon'}), ['neon', 4, 100, 'right', '#ffffff']);
    // Out-of-range slider values are clamped.
    const current = {effect: 'wave', speed: 4, brightness: 80, direction: 'left', color: '#ff0000'};
    assert.deepEqual(keyboardRequest(current, {brightness: 140, speed: -3}), ['wave', 0, 100, 'left', '#ff0000']);
    for (const [effect, speed, brightness, direction, color] of [
        keyboardRequest(odd, {}), keyboardRequest(current, {speed: 99}), keyboardRequest(undefined, {}),
    ]) {
        assert.ok(KEYBOARD_EFFECTS.includes(effect));
        assert.ok(Number.isInteger(speed) && speed >= 0 && speed <= 9);
        assert.ok(Number.isInteger(brightness) && brightness >= 0 && brightness <= 100);
        assert.ok(direction === 'left' || direction === 'right');
        assert.match(color, /^#[0-9a-f]{6}$/);
    }
});

test('logoRequest: turning the logo on always shows something', () => {
    const green = {on: true, brightness: 70, color: '#00ff00', mode: 'breathing'};
    assert.deepEqual(logoRequest({on: false, brightness: 0, color: '#000000', mode: 'static'}, {on: true}),
        [true, 100, '#ffffff', 'static']);
    assert.deepEqual(logoRequest(green, {on: false}), [false, 70, '#00ff00', 'breathing']);
    assert.deepEqual(logoRequest(green, {color: '#ff0000'}), [true, 70, '#ff0000', 'breathing']);
    assert.deepEqual(logoRequest(green, {brightness: 250}), [true, 100, '#00ff00', 'breathing']);
    assert.deepEqual(logoRequest(null, {on: true}), [true, 100, '#ffffff', 'static']);
});

test('logoRequest: the mode is kept, changed, or falls back to static', () => {
    const logo = {on: true, brightness: 70, color: '#00ff00', mode: 'cycle'};
    assert.deepEqual(logoRequest(logo, {brightness: 40}), [true, 40, '#00ff00', 'cycle']);
    for (const mode of LOGO_MODES)
        assert.deepEqual(logoRequest(logo, {mode}), [true, 70, '#00ff00', mode]);
    // A value set by another tool reads back as unknown; it is never sent.
    assert.deepEqual(logoRequest({...logo, mode: 'unknown'}, {}), [true, 70, '#00ff00', 'static']);
    assert.deepEqual(logoRequest(logo, {mode: 'rainbow'}), [true, 70, '#00ff00', 'static']);
});

test('lighting labels and errors', () => {
    assert.equal(effectLabel('shifting'), 'Shifting');
    assert.equal(effectLabel('static'), 'Static');
    assert.equal(logoModeLabel('cycle'), 'Color cycle');
    assert.equal(logoModeLabel('breathing'), 'Breathing');
    assert.equal(logoModeLabel('unknown'), 'Other');
    assert.equal(effectLabel('unknown'), 'Other');
    assert.equal(lightingError('NotAuthorized'), 'Not authorized to change the lighting');
    assert.match(lightingError('Unavailable'), /heliosctl doctor/);
    assert.equal(lightingError('Failed', 'Timeout was reached'), 'Timeout was reached');
    assert.equal(LIGHT_COLORS.length, 9);
    for (const {color} of LIGHT_COLORS)
        assert.match(color, /^#[0-9a-f]{6}$/);
});

test('collapsed menu titles summarize their section', () => {
    assert.equal(usageSummary({cpu: 23.4, gpu: 4, averageGhz: null, maxGhz: null}), 'Usage · CPU 23% · GPU 4%');
    assert.equal(usageSummary({cpu: 23, gpu: null, ram: 40}), 'Usage · CPU 23% · RAM 40%');
    assert.equal(usageSummary({cpu: null, gpu: null}), 'Usage');
    assert.equal(powerSummary({source: 'ac', battery: {percent: 80, watts: 0}}), 'Power · AC · 80%');
    assert.equal(powerSummary({source: 'battery', battery: {percent: 64.4, watts: 18.2}}), 'Power · 64% · 18.2 W');
    assert.equal(powerSummary({source: null, battery: null}), 'Power');
});
