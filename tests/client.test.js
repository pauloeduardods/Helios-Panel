// SPDX-License-Identifier: GPL-3.0-or-later
// HeliosClient against the fake bus in tests/gi-stubs/Gio.mjs.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';

import GLib from './gi-stubs/GLib.mjs';

const {HeliosClient, BUS_NAME} = await import('../extension/lib/client.js');

const IFACE = 'io.github.pauloeduardods.Helios1';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    globalThis.FAKE_BUS = {
        props: {
            [`${IFACE}.Daemon`]: {Version: '0.2.0'},
            [`${IFACE}.Sensors`]: {
                Cpu: ['hwmon:coretemp/Package id 0', true, 61],
                Gpu: ['nvidia-smi', 'off', false, 0],
                Fans: [['Fan 1', 2350]],
                Temperatures: [],
                GpuPower: [false, 0],
                CpuPower: [true, 12.3],
                CpuUsage: [true, 23],
                CpuFrequency: [true, 1.4, 3.8],
                GpuUsage: [false, 0],
                Devices: [['storage', 'CT500P2SSD8', 44.9]],
                PowerSource: 'ac',
                Battery: ['BAT1', 'not-charging', 80, 0, 92, 0, -1],
            },
            [`${IFACE}.Profile`]: {
                Available: true, Active: 'balanced', Choices: ['quiet', 'balanced'], Driver: 'acer-wmi',
            },
        },
        proxies: {},
        calls: [],
        callError: null,
        failProxies: false,
        unwatched: [],
    };
});

function start() {
    let changes = 0;
    const client = new HeliosClient(() => changes++);
    return {client, changes: () => changes};
}

test('watches the system bus name with auto-start', () => {
    start();
    const {watch} = globalThis.FAKE_BUS;
    assert.equal(watch.type, 'system');
    assert.equal(watch.name, BUS_NAME);
    assert.equal(watch.flags, 1);
});

test('starts connecting, with nothing to show', () => {
    const {client} = start();
    const snap = client.snapshot();
    assert.equal(snap.state, 'connecting');
    assert.equal(snap.sensors.cpu.celsius, null);
    assert.equal(snap.power.battery, null);
    assert.equal(snap.profile.available, false);
});

test('daemon not running: name vanished', () => {
    const {client, changes} = start();
    globalThis.FAKE_BUS.vanish();
    assert.equal(client.state, 'not-running');
    assert.equal(changes(), 1);
    assert.equal(client.snapshot().profile.available, false);
});

test('daemon not running: name appeared but the proxies failed', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.failProxies = true;
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(client.state, 'not-running');
});

test('running: properties come from the proxies', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const snap = client.snapshot();
    assert.equal(snap.state, 'running');
    assert.equal(snap.version, '0.2.0');
    assert.deepEqual(snap.sensors.cpu, {sensor: 'hwmon:coretemp/Package id 0', celsius: 61});
    assert.equal(snap.sensors.gpu.state, 'off');
    assert.equal(snap.power.source, 'ac');
    assert.equal(snap.power.battery.health, 92);
    assert.equal(snap.power.cpuWatts, 12.3);
    assert.deepEqual(snap.usage, {cpu: 23, gpu: null, averageGhz: 1.4, maxGhz: 3.8});
    assert.equal(snap.sensors.devices[0].name, 'CT500P2SSD8');
    assert.equal(snap.profile.current, 'balanced');
});

test('property changes notify the indicator', async () => {
    const {changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const before = changes();
    globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`].emit('g-properties-changed');
    assert.equal(changes(), before + 1);
});

test('recovers when heliosd comes back, and drops signals when it goes', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.vanish();
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(client.state, 'running');

    const sensors = globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`];
    globalThis.FAKE_BUS.vanish();
    assert.equal(client.state, 'not-running');
    assert.equal(sensors.handlers.size, 0, 'old proxy signals disconnected');
});

test('a late appearance after vanishing is ignored', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    globalThis.FAKE_BUS.vanish(); // before the proxies resolve
    await tick();
    assert.equal(client.state, 'not-running');
});

test('setProfile calls SetProfile with a long timeout for polkit', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    await client.setProfile('quiet');
    const call = globalThis.FAKE_BUS.calls.find(c => c.method === 'SetProfile');
    assert.equal(call.iface, `${IFACE}.Profile`);
    assert.equal(call.method, 'SetProfile');
    assert.equal(call.params.type, '(s)');
    assert.deepEqual(call.params.value, ['quiet']);
    assert.ok(call.timeout >= 60000);
});

test('setProfile errors carry the heliosd error name', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    globalThis.FAKE_BUS.callError = new GLib.Error(
        'GDBus.Error:io.github.pauloeduardods.Helios1.Error.NotAuthorized: not authorized',
        'io.github.pauloeduardods.Helios1.Error.NotAuthorized');
    await assert.rejects(client.setProfile('quiet'), {name: 'NotAuthorized', message: 'not authorized'});

    globalThis.FAKE_BUS.callError = new GLib.Error('Timeout was reached');
    await assert.rejects(client.setProfile('quiet'), {name: 'Failed'});
});

test('setProfile while heliosd is not running fails without a call', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.vanish();
    await assert.rejects(client.setProfile('quiet'), {name: 'NotRunning'});
    assert.equal(globalThis.FAKE_BUS.calls.length, 0);
});

test('destroy unwatches the name and silences callbacks', async () => {
    const {client, changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const sensors = globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`];
    const before = changes();
    client.destroy();
    assert.deepEqual(globalThis.FAKE_BUS.unwatched, [globalThis.FAKE_BUS.watch.id]);
    assert.equal(sensors.handlers.size, 0);
    globalThis.FAKE_BUS.vanish();
    assert.equal(changes(), before, 'no callbacks after destroy');
});

test('the history is loaded once on connect, then grows with every Sensors update', async () => {
    globalThis.FAKE_NOW_S = 1000;
    globalThis.FAKE_BUS.replies = {GetHistory: [[2, 0], [['cpu-celsius', [true, true], [60, 61]]]]};
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.deepEqual(globalThis.FAKE_BUS.calls.map(c => c.method), ['GetHistory']);
    assert.deepEqual(client.historyView().series['cpu-celsius'], [60, 61]);

    globalThis.FAKE_NOW_S = 1002;
    globalThis.FAKE_BUS.props[`${IFACE}.Sensors`].Cpu = ['hwmon:coretemp/Package id 0', true, 65];
    globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`].emit('g-properties-changed');
    const view = client.historyView();
    assert.deepEqual(view.ages, [4, 2, 0]);
    assert.deepEqual(view.series['cpu-celsius'], [60, 61, 65]);
    assert.deepEqual(view.series['cpu-usage'], [null, null, 23]);

    globalThis.FAKE_BUS.proxies[`${IFACE}.Profile`].emit('g-properties-changed');
    assert.equal(client.historyView().ages.length, 3, 'only Sensors updates add a sample');
    assert.equal(globalThis.FAKE_BUS.calls.length, 1, 'no further calls');
});

test('an older heliosd without GetHistory starts with an empty history', async () => {
    globalThis.FAKE_BUS.callError = new GLib.Error('Unknown method GetHistory');
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.equal(client.state, 'running');
    assert.deepEqual(client.historyView().ages, []);
});

test('history: false skips GetHistory and keeps no samples, but still reports changes', async () => {
    globalThis.FAKE_NOW_S = 1000;
    globalThis.FAKE_BUS.replies = {GetHistory: [[0], [['cpu-celsius', [true], [60]]]]};
    let changes = 0;
    const client = new HeliosClient(() => changes++, {history: false});
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.equal(client.state, 'running');
    assert.deepEqual(globalThis.FAKE_BUS.calls, []);

    const before = changes;
    globalThis.FAKE_BUS.props[`${IFACE}.Sensors`].Cpu = ['hwmon:coretemp/Package id 0', true, 65];
    globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`].emit('g-properties-changed');
    assert.equal(changes, before + 1);
    assert.equal(client.snapshot().sensors.cpu.celsius, 65);
    assert.deepEqual(client.historyView().ages, []);
});

// ---------------------------------------------------------------- lighting

function withLighting() {
    globalThis.FAKE_BUS.props[`${IFACE}.Lighting`] = {
        Effects: ['breathing', 'neon', 'wave', 'shifting', 'zoom'],
        Directions: ['left', 'right'],
        LogoModes: ['static', 'breathing', 'cycle'],
        Keyboard: ['zoom', 4, 80, 'right', '#ff00ff'],
        Logo: [true, 100, '#00ff00', 'breathing'],
    };
}

test('lighting comes from the Lighting proxy', async () => {
    withLighting();
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const {lighting} = client.snapshot();
    assert.equal(lighting.available, true);
    assert.equal(lighting.keyboard.effect, 'zoom');
    assert.deepEqual(lighting.logo, {on: true, brightness: 100, color: '#00ff00', mode: 'breathing'});
    assert.deepEqual(lighting.logoModes, ['static', 'breathing', 'cycle']);
});

test('without the module (or an older heliosd) lighting is unavailable, the rest works', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const snap = client.snapshot();
    assert.equal(snap.state, 'running');
    assert.equal(snap.lighting.available, false);
    assert.equal(snap.profile.current, 'balanced');
});

test('lighting changes notify the indicator', async () => {
    withLighting();
    const {changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const before = changes();
    globalThis.FAKE_BUS.proxies[`${IFACE}.Lighting`].emit('g-properties-changed');
    assert.equal(changes(), before + 1);
});

test('setKeyboardEffect and setLogo call heliosd with the exact signatures', async () => {
    withLighting();
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    await client.setKeyboardEffect(['wave', 4, 80, 'left', '#ff0000']);
    await client.setLogo([true, 70, '#00ff00', 'cycle']);
    const [kb, logo] = globalThis.FAKE_BUS.calls.filter(c => c.iface === `${IFACE}.Lighting`);
    assert.equal(kb.method, 'SetKeyboardEffect');
    assert.equal(kb.params.type, '(suuss)');
    assert.deepEqual(kb.params.value, ['wave', 4, 80, 'left', '#ff0000']);
    assert.ok(kb.timeout >= 60000, 'polkit may prompt');
    assert.equal(logo.method, 'SetLogo');
    assert.equal(logo.params.type, '(buss)');
    assert.deepEqual(logo.params.value, [true, 70, '#00ff00', 'cycle']);
});

test('lighting errors carry the heliosd error name', async () => {
    withLighting();
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    globalThis.FAKE_BUS.callError = new GLib.Error(
        'GDBus.Error:io.github.pauloeduardods.Helios1.Error.InvalidArgument: speed 10 is not 0 to 9',
        'io.github.pauloeduardods.Helios1.Error.InvalidArgument');
    await assert.rejects(client.setKeyboardEffect(['wave', 10, 80, 'left', '#ff0000']),
        {name: 'InvalidArgument', message: 'speed 10 is not 0 to 9'});
});

test('lighting writes while heliosd is not running fail without a call', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.vanish();
    await assert.rejects(client.setLogo([true, 100, '#ffffff', 'static']), {name: 'NotRunning'});
    await assert.rejects(client.setKeyboardEffect(['wave', 4, 80, 'left', '#ff0000']), {name: 'NotRunning'});
    assert.equal(globalThis.FAKE_BUS.calls.length, 0);
});

test('the snapshot is built once per change and shared', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const first = client.snapshot();
    assert.equal(client.snapshot(), first, 'same object until something changes');

    globalThis.FAKE_BUS.props[`${IFACE}.Sensors`].Cpu = ['hwmon:coretemp/Package id 0', true, 70];
    globalThis.FAKE_BUS.proxies[`${IFACE}.Sensors`].emit('g-properties-changed');
    const second = client.snapshot();
    assert.notEqual(second, first);
    assert.equal(second.sensors.cpu.celsius, 70);

    globalThis.FAKE_BUS.vanish();
    await tick();
    assert.equal(client.snapshot().state, 'not-running');
});
