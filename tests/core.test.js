import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Level, formatRpm, formatTemp, gpuQueryInterval, milliToCelsius,
    parseNvidiaSmiTemp, sanitizeThresholds, tempLevel, clampInt,
} from '../extension/lib/core/format.js';
import {
    parseChoices, ppdForPlatform, profileColor, profileLabel, sortChoices,
} from '../extension/lib/core/profiles.js';
import {
    findNvidiaPciDir, listTemperatureSensors, parseSensorId, resolveAmdGpuSensor,
    resolveCpuSensor, resolveFans, scanHwmon, sensorId,
} from '../extension/lib/core/hwmon.js';
import {
    LEGACY_CHOICES, LEGACY_PROFILE, readProfileState, writableProfilePath,
} from '../extension/lib/core/platformProfile.js';

// ---- a fake sysfs -------------------------------------------------------

function fakeFs(files, writable = []) {
    const dirs = new Map();
    for (const path of Object.keys(files)) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/') || '/';
            if (!dirs.has(dir))
                dirs.set(dir, new Set());
            dirs.get(dir).add(parts[i]);
        }
    }
    return {
        readText: p => (p in files ? String(files[p]).trim() : null),
        listDir: p => [...(dirs.get(p) ?? [])].sort(),
        exists: p => p in files || dirs.has(p),
        isWritable: p => writable.includes(p),
    };
}

// Roughly what a PHN16-72 (i9-14900HX + RTX 4070) with acer_wmi looks like.
const HELIOS = {
    '/sys/class/hwmon/hwmon0/name': 'acpitz',
    '/sys/class/hwmon/hwmon0/temp1_input': '45000',
    '/sys/class/hwmon/hwmon3/name': 'acer',
    '/sys/class/hwmon/hwmon3/fan1_input': '2350',
    '/sys/class/hwmon/hwmon3/fan2_input': '2600',
    '/sys/class/hwmon/hwmon3/temp1_input': '52000',
    '/sys/class/hwmon/hwmon5/name': 'coretemp',
    '/sys/class/hwmon/hwmon5/temp1_input': '61000',
    '/sys/class/hwmon/hwmon5/temp1_label': 'Package id 0',
    '/sys/class/hwmon/hwmon5/temp2_input': '58000',
    '/sys/class/hwmon/hwmon5/temp2_label': 'Core 0',
    '/sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086',
    '/sys/bus/pci/devices/0000:00:02.0/class': '0x030000',
    '/sys/bus/pci/devices/0000:01:00.1/vendor': '0x10de',
    '/sys/bus/pci/devices/0000:01:00.1/class': '0x040300',
    '/sys/bus/pci/devices/0000:01:00.0/vendor': '0x10de',
    '/sys/bus/pci/devices/0000:01:00.0/class': '0x030000',
    [LEGACY_PROFILE]: 'balanced',
    [LEGACY_CHOICES]: 'performance quiet balanced-performance low-power balanced',
    '/sys/class/platform-profile/platform-profile-0/name': 'acer-wmi',
    '/sys/class/platform-profile/platform-profile-0/profile': 'balanced',
    '/sys/class/platform-profile/platform-profile-0/choices': 'low-power quiet balanced balanced-performance performance',
};

// ---- format ---------------------------------------------------------------

test('millidegrees and nvidia-smi parsing', () => {
    assert.equal(milliToCelsius(61000), 61);
    assert.equal(milliToCelsius(null), null);
    assert.equal(parseNvidiaSmiTemp('48\n'), 48);
    assert.equal(parseNvidiaSmiTemp('[N/A]'), null);
    assert.equal(parseNvidiaSmiTemp('No devices were found'), null);
    assert.equal(parseNvidiaSmiTemp(''), null);
});

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
    assert.equal(clampInt('7', 1, 5), 5);
    assert.equal(clampInt('x', 1, 5), 1);
});

test('GPU query interval never undercuts the autosuspend delay', () => {
    assert.equal(gpuQueryInterval(2, 10, undefined), 10);
    assert.equal(gpuQueryInterval(2, 3, 5000), 11);
    assert.equal(gpuQueryInterval(30, 10, 5000), 30);
});

// ---- profiles -------------------------------------------------------------

test('profile names and ordering', () => {
    assert.equal(profileLabel('balanced-performance'), 'Performance');
    assert.equal(profileLabel('performance'), 'Turbo');
    assert.equal(profileLabel('performance', 'portuguese'), 'Turbo');
    assert.equal(profileLabel('quiet', 'linux'), 'quiet');
    assert.equal(profileLabel('weird-new-one'), 'weird-new-one');
    assert.deepEqual(
        sortChoices(parseChoices('performance quiet balanced-performance low-power balanced')),
        ['low-power', 'quiet', 'balanced', 'balanced-performance', 'performance']);
    assert.equal(ppdForPlatform('balanced-performance'), 'performance');
    assert.equal(ppdForPlatform('quiet'), 'power-saver');
    assert.equal(profileColor('balanced'), null);
    assert.equal(typeof profileColor('performance'), 'string');
});

// ---- hwmon discovery ------------------------------------------------------

test('Helios: CPU package, Acer fans, NVIDIA PCI device', () => {
    const fs = fakeFs(HELIOS);
    const chips = scanHwmon(fs);
    assert.deepEqual(resolveCpuSensor(chips), {
        chip: 'coretemp', label: 'Package id 0', path: '/sys/class/hwmon/hwmon5/temp1_input',
    });
    assert.deepEqual(resolveFans(chips).map(f => f.label), ['Fan 1', 'Fan 2']);
    assert.equal(findNvidiaPciDir(fs), '/sys/bus/pci/devices/0000:01:00.0');
    assert.equal(resolveAmdGpuSensor(chips), null);
});

test('explicit sensor id wins, falls back to auto when it vanished', () => {
    const chips = scanHwmon(fakeFs(HELIOS));
    assert.equal(resolveCpuSensor(chips, sensorId('coretemp', 'Core 0')).label, 'Core 0');
    assert.equal(resolveCpuSensor(chips, sensorId('gone', 'x')).label, 'Package id 0');
    assert.deepEqual(parseSensorId('hwmon:acer/temp1'), {chip: 'acer', label: 'temp1'});
    assert.equal(parseSensorId('nvidia-smi'), null);
    assert.ok(listTemperatureSensors(fakeFs(HELIOS)).some(s => s.id === 'hwmon:acer/temp1'));
});

test('AMD desktop: Ryzen Tctl and the discrete Radeon over the iGPU', () => {
    const fs = fakeFs({
        '/sys/class/hwmon/hwmon1/name': 'k10temp',
        '/sys/class/hwmon/hwmon1/temp1_input': '55000',
        '/sys/class/hwmon/hwmon1/temp1_label': 'Tctl',
        '/sys/class/hwmon/hwmon2/name': 'amdgpu', // iGPU
        '/sys/class/hwmon/hwmon2/temp1_input': '40000',
        '/sys/class/hwmon/hwmon2/temp1_label': 'edge',
        '/sys/class/hwmon/hwmon4/name': 'amdgpu', // RX 7800 XT
        '/sys/class/hwmon/hwmon4/temp1_input': '50000',
        '/sys/class/hwmon/hwmon4/temp1_label': 'edge',
        '/sys/class/hwmon/hwmon4/temp2_input': '60000',
        '/sys/class/hwmon/hwmon4/temp2_label': 'junction',
    });
    const chips = scanHwmon(fs);
    assert.equal(resolveCpuSensor(chips).label, 'Tctl');
    assert.equal(resolveAmdGpuSensor(chips).path, '/sys/class/hwmon/hwmon4/temp1_input');
    assert.deepEqual(resolveFans(chips), []);
});

// ---- platform profile -----------------------------------------------------

test('platform profile state and write path', () => {
    const fs = fakeFs(HELIOS);
    const state = readProfileState(fs);
    assert.equal(state.available, true);
    assert.equal(state.current, 'balanced');
    assert.equal(state.driver, 'acer-wmi');
    assert.equal(state.choices.at(-1), 'performance');
    assert.equal(writableProfilePath(fs), null);

    const udev = fakeFs(HELIOS, ['/sys/class/platform-profile/platform-profile-0/profile']);
    assert.equal(writableProfilePath(udev), '/sys/class/platform-profile/platform-profile-0/profile');
});

test('no platform profile at all (acer_wmi blacklisted)', () => {
    const fs = fakeFs({'/sys/class/hwmon/hwmon0/name': 'acpitz'});
    assert.deepEqual(readProfileState(fs), {available: false, current: null, choices: [], driver: null});
});
