// Exercises the GLib-side code (sysfs adapter, NVIDIA power gating, sensors,
// profile writes) against a fake /sys tree. Run via: npm test
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {NvidiaGpu} = await import('../extension/lib/sys/nvidia.js');
const {CpuSensor, FanSensor, GpuSensor, NVIDIA_SMI_ID} = await import('../extension/lib/sys/sensors.js');
const sysfsMod = await import('../extension/lib/sys/sysfs.js');
const {readProfileState, writableProfilePath} = await import('../extension/lib/core/index.js');

const GPU = '/sys/bus/pci/devices/0000:01:00.0';

function makeTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakesys-'));
    for (const [p, v] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(root + p), {recursive: true});
        fs.writeFileSync(root + p, `${v}\n`);
    }
    globalThis.FAKE_SYS_ROOT = root;
    return root;
}

beforeEach(() => {
    globalThis.FAKE_SPAWNS = 0;
    globalThis.FAKE_NOW_SEC = 100;
    globalThis.FAKE_PROGRAMS = {'nvidia-smi': '/usr/bin/nvidia-smi'};
    globalThis.FAKE_SMI_OUTPUT = '47\n';
    globalThis.FAKE_WRITABLE = [];
    makeTree({
        '/sys/class/hwmon/hwmon3/name': 'acer',
        '/sys/class/hwmon/hwmon3/fan1_input': '2350',
        '/sys/class/hwmon/hwmon3/fan2_input': '2600',
        '/sys/class/hwmon/hwmon5/name': 'coretemp',
        '/sys/class/hwmon/hwmon5/temp1_input': '61000',
        '/sys/class/hwmon/hwmon5/temp1_label': 'Package id 0',
        [`${GPU}/vendor`]: '0x10de',
        [`${GPU}/class`]: '0x030000',
        [`${GPU}/power/runtime_status`]: 'suspended',
        [`${GPU}/power/autosuspend_delay_ms`]: '5000',
        '/sys/firmware/acpi/platform_profile': 'balanced',
        '/sys/firmware/acpi/platform_profile_choices': 'low-power quiet balanced balanced-performance performance',
        '/sys/class/platform-profile/platform-profile-0/name': 'acer-wmi',
        '/sys/class/platform-profile/platform-profile-0/profile': 'balanced',
        '/sys/class/platform-profile/platform-profile-0/choices': 'low-power quiet balanced balanced-performance performance',
    });
});

const setGpuStatus = s => fs.writeFileSync(`${globalThis.FAKE_SYS_ROOT}${GPU}/power/runtime_status`, s);

test('CPU and fans read through the GLib adapter', () => {
    assert.equal(new CpuSensor().read(), 61);
    assert.deepEqual(new FanSensor().read().map(f => f.rpm), [2350, 2600]);
});

test('suspended NVIDIA GPU is reported off and never woken', async () => {
    const gpu = NvidiaGpu.detect({allowWake: false, refreshSec: 2, minIntervalSec: 3});
    assert.ok(gpu);
    assert.equal(gpu.queryIntervalSec, 11, 'autosuspend 5 s -> at least 11 s between queries');
    assert.deepEqual(await gpu.read(null), {state: 'off', celsius: null});
    assert.equal(globalThis.FAKE_SPAWNS, 0);
});

test('active GPU is queried, then rate-limited', async () => {
    setGpuStatus('active');
    const gpu = NvidiaGpu.detect({allowWake: false, refreshSec: 2, minIntervalSec: 10});
    assert.deepEqual(await gpu.read(null), {state: 'on', celsius: 47});
    globalThis.FAKE_NOW_SEC += 2;
    assert.deepEqual(await gpu.read(null), {state: 'on', celsius: 47});
    assert.equal(globalThis.FAKE_SPAWNS, 1, 'second read within the interval used the cache');
    globalThis.FAKE_NOW_SEC += 20;
    globalThis.FAKE_SMI_OUTPUT = '[N/A]';
    assert.deepEqual(await gpu.read(null), {state: 'on', celsius: null});
    assert.equal(globalThis.FAKE_SPAWNS, 2);
});

test('allow-wake queries even a suspended GPU', async () => {
    const gpu = NvidiaGpu.detect({allowWake: true});
    assert.deepEqual(await gpu.read(null), {state: 'on', celsius: 47});
});

test('GpuSensor: auto picks NVIDIA; no nvidia-smi means none', async () => {
    setGpuStatus('active');
    assert.equal((await new GpuSensor({}).read(null)).celsius, 47);
    assert.equal((await new GpuSensor({id: NVIDIA_SMI_ID}).read(null)).state, 'on');
    globalThis.FAKE_PROGRAMS = {};
    const none = new GpuSensor({});
    assert.equal(none.available, false);
    assert.deepEqual(await none.read(null), {state: 'none', celsius: null});
});

test('profile: read-only by default, direct write once udev made it writable', () => {
    const fsAdapter = sysfsMod.sysfs;
    assert.equal(readProfileState(fsAdapter).current, 'balanced');
    assert.equal(writableProfilePath(fsAdapter), null);

    const p = '/sys/class/platform-profile/platform-profile-0/profile';
    globalThis.FAKE_WRITABLE = [p];
    assert.equal(writableProfilePath(fsAdapter), p);
    sysfsMod.writeText(p, 'performance');
    assert.equal(sysfsMod.readText(p), 'performance');
});

test('PlatformProfileBackend validates before writing', async () => {
    const {PlatformProfileBackend, SwitchMode} = await import('../extension/lib/backends/platform.js');
    const backend = new PlatformProfileBackend();
    assert.throws(() => backend.setPlatformProfile('performance'), /gravável/);
    const p = '/sys/class/platform-profile/platform-profile-0/profile';
    globalThis.FAKE_WRITABLE = [p];
    assert.equal(await backend.switchMode(), SwitchMode.DIRECT);
    assert.throws(() => backend.setPlatformProfile('max-power'), /não é suportado/);
    backend.setPlatformProfile('quiet');
    assert.equal(sysfsMod.readText(p), 'quiet');
});
