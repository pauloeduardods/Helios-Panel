// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
    GRAPH_READINGS, PRESETS, READINGS, addItem, addSegment, colorHex, defaultLayout, effectiveTemplate,
    exportLayout, loadLayout, makeResolver, migrateLegacy, moveItemTo, moveSegment, parseLayout,
    parseTemplate, presetLayout, readOptions, readStyle, removeFromTemplate, removeItem, removeSegment,
    renderLayout, renderSegment, renderTemplate, sampleHistory, sampleSnapshot, sanitizeLayout,
    segmentColor, segmentMarkup, serializeLayout, setSegment, setTemplate, templateReadings,
} from '../extension/lib/layout.js';
import {
    Level, barPieces, powerFromDbus, profileFromDbus, sensorsFromDbus, usageFromDbus,
} from '../extension/lib/model.js';

// ---- helpers ------------------------------------------------------------------

/** The schema's defaults, read from the XML so the tests follow it. */
function schemaDefaults() {
    const xml = readFileSync(new URL('../extension/schemas/org.gnome.shell.extensions.helios-panel.gschema.xml',
        import.meta.url), 'utf8');
    const out = {};
    for (const m of xml.matchAll(/<key name="([^"]+)" type="([^"]+)">[\s\S]*?<default>([\s\S]*?)<\/default>/g)) {
        const [, name, type, raw] = m;
        if (type === 'b')
            out[name] = raw === 'true';
        else if (type === 'i')
            out[name] = Number(raw);
        else if (type === 'as')
            out[name] = JSON.parse(raw.replace(/'/g, '"'));
        else
            out[name] = raw.replace(/^'|'$/g, '');
    }
    return out;
}

function fakeSettings(overrides = {}) {
    const values = {...schemaDefaults(), ...overrides};
    const get = key => {
        assert.ok(key in values, `unknown key ${key}`);
        return values[key];
    };
    return {
        values,
        get_boolean: get, get_int: get, get_string: get, get_strv: get,
    };
}

function snapshot({gpu = ['nvidia-smi', 'on', true, 47], source = 'battery', battery = null,
    profile = 'performance', fans = [['Fan 1', 2350], ['Fan 2', 1900]], usage = {}} = {}) {
    return {
        state: 'running',
        sensors: sensorsFromDbus({Cpu: ['cpu', true, 61.4], Gpu: gpu, Fans: fans, Temperatures: []}),
        usage: usageFromDbus({CpuUsage: [true, 23], CpuFrequency: [true, 1.44, 3.8], GpuUsage: [true, 9], ...usage}),
        power: powerFromDbus({
            GpuPower: [true, 6.25], CpuPower: [true, 12.3], PowerSource: source,
            Battery: battery ?? ['BAT1', source === 'battery' ? 'discharging' : 'not-charging', 80, 24.46, 92, 0, 172],
        }),
        profile: profileFromDbus(profile
            ? {Available: true, Active: profile, Choices: [profile], Driver: 'acer-wmi'}
            : {}),
    };
}

const text = (template, snap = snapshot(), options = {}) =>
    renderTemplate(template, makeResolver(snap, options)).map(p => p.text).join('');

const STYLE = {normal: '', warm: '#f8e45c', hot: '#f66151', bold: true};

// ---- templates ------------------------------------------------------------------

test('templates parse into text and placeholders', () => {
    assert.deepEqual(parseTemplate('{cpu}°/{gpu:1}°').tokens, [
        {name: 'cpu', decimals: null}, {text: '°/'}, {name: 'gpu', decimals: 1}, {text: '°'},
    ]);
    assert.deepEqual(parseTemplate('{{x}} {fan2}').tokens, [{text: '{x} '}, {name: 'fan2', decimals: null}]);
    assert.deepEqual(parseTemplate('{cpu:9}').tokens, [{name: 'cpu', decimals: 2}], 'at most 2 decimals');
    assert.deepEqual(parseTemplate('').tokens, []);
    assert.deepEqual(parseTemplate(null).tokens, []);
    assert.deepEqual(templateReadings('{fan1}/{fan2} {cpu} {fan}'), ['fan', 'cpu']);
});

test('template mistakes are reported, never thrown', () => {
    assert.deepEqual(parseTemplate('{nope} {cpu').errors, ['unknown placeholder {nope}', '"{cpu" has no closing }']);
    assert.deepEqual(parseTemplate('{}').errors, ['empty placeholder {}']);
    assert.deepEqual(parseTemplate('{fan0}{CPU}').errors.length, 2);
    assert.deepEqual(parseTemplate('a } b').errors, [], 'a lone } is text');
    assert.equal(parseTemplate('x'.repeat(500)).tokens[0].text.length, 200, 'long templates are cut');
});

test('every reading renders, with simple decimals', () => {
    assert.equal(text('{cpu}°/{gpu}°'), '61°/47°');
    assert.equal(text('{cpu:1}'), '61.4');
    assert.equal(text('{cpu-usage}% {gpu-usage}%'), '23% 9%');
    assert.equal(text('{cpu-watts} W · {gpu-watts:0} W'), '12.3 W · 6 W');
    assert.equal(text('{watts} W · {battery}%'), '24.5 W · 80%');
    assert.equal(text('{power}'), '24.5 W');
    assert.equal(text('{time-left}'), '2:52');
    assert.equal(text('{profile}'), 'Turbo');
    assert.equal(text('{profile}', snapshot(), {profileNames: 'linux'}), 'performance');
    assert.equal(text('{clock} GHz / {clock-max:2}'), '1.4 GHz / 3.80');
    assert.equal(text('{fan} {fan1} {fan2} {fan3}'), '2.4k/1.9k 2.4k 1.9k --');
    assert.equal(text('{{cpu}} = {cpu}'), '{cpu} = 61');
});

test('a bad template part shows "--" and the rest still renders', () => {
    assert.equal(text('{nope} · {cpu}°'), '-- · 61°');
    assert.equal(text('{cpu}° {gpu'), '61° --');
    assert.equal(text('{}'), '--');
});

test('units glued to a reading with no value are left out', () => {
    const ac = snapshot({source: 'ac'});
    assert.equal(text('{watts} W · {battery}%', ac), '-- · 80%');
    assert.equal(text('{power}', ac), 'AC');
    assert.equal(text('{cpu}°/{gpu}°', snapshot({gpu: ['nvidia-smi', 'off', false, 0]})), '61°/off');
    assert.equal(text('{time-left}', ac), '--');
});

test('readings say when the machine does not have them', () => {
    const resolve = makeResolver(snapshot({gpu: ['', 'none', false, 0], source: 'unknown', battery: ['', '', -1, -1, -1, -1, -1],
        profile: null, fans: [], usage: {GpuUsage: [false, 0]}}));
    for (const id of ['gpu', 'gpu-usage', 'fan', 'power', 'watts', 'battery', 'time-left', 'profile'])
        assert.equal(resolve(id).absent, true, id);
    assert.equal(resolve('cpu').absent, false, 'the CPU is always shown');
    const off = makeResolver(snapshot({gpu: ['nvidia-smi', 'off', false, 0]}), {hideGpuWhenOff: true});
    assert.equal(off('gpu').absent, true);
    assert.equal(off('gpu').text, 'off');
});

test('removing a reading from a template takes its unit and separator too', () => {
    assert.equal(removeFromTemplate('{cpu}°/{gpu}°', 'gpu'), '{cpu}°');
    assert.equal(removeFromTemplate('{power} · {battery}% · {time-left}', 'battery'), '{power} · {time-left}');
    assert.equal(removeFromTemplate('{watts} W · {cpu}°', 'watts'), '{cpu}°');
    assert.equal(removeFromTemplate('{fan1}/{fan2} | {cpu}', 'fan'), '{cpu}');
    assert.equal(removeFromTemplate('{{ {cpu}', 'gpu'), '{{ {cpu}', 'escapes survive');
    assert.equal(removeFromTemplate('{cpu}°/{gpu}°/{fan}', 'gpu'), '{cpu}°/{fan}');
});

// ---- layout parsing --------------------------------------------------------------

test('a layout that cannot be read falls back to the default layout', () => {
    for (const bad of ['', 'nope', '[]', '{"segments": 3}', 'null', '42']) {
        const r = parseLayout(bad);
        assert.equal(r.ok, false, bad);
        assert.deepEqual(r.layout, defaultLayout(), bad);
        assert.ok(r.errors.length > 0);
    }
});

test('a layout is cleaned up: unknown readings, empty segments and bad graphs go away', () => {
    const r = parseLayout(JSON.stringify({
        version: 99,
        segments: [
            {items: ['cpu', 'cpu', 'bogus', 'gpu'], icon: 'rocket'},
            {items: []},
            'garbage',
            {items: ['profile'], icon: false, graph: {reading: 'profile'}},
            {items: ['cpu-usage'], graph: {reading: 'cpu-usage', kind: 'pie', window: 9999, width: 'huge', color: 'nope', only: 'yes'}},
            {template: '{cpu}° {nope}', items: ['gpu']},
        ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.layout.segments, [
        {items: ['cpu', 'gpu'], template: '', icon: 'auto', graph: null},
        {items: ['profile'], template: '', icon: 'none', graph: null},
        {items: ['cpu-usage'], template: '', icon: 'auto',
            graph: {reading: 'cpu-usage', kind: 'line', only: false, width: 'medium', window: 300, color: 'follow'}},
        {items: ['cpu'], template: '{cpu}° {nope}', icon: 'auto', graph: null},
    ]);
    assert.deepEqual(r.errors, ['segment 4: unknown placeholder {nope}']);
    assert.equal(r.layout.version, 1);
});

test('limits keep a layout small', () => {
    const many = {segments: Array.from({length: 40}, () => ({items: READINGS.map(x => x.id)}))};
    const layout = sanitizeLayout(many);
    assert.equal(layout.segments.length, 12);
    assert.equal(layout.segments[0].items.length, 8);
});

test('layouts round-trip through JSON and the export file', () => {
    for (const preset of PRESETS) {
        const layout = presetLayout(preset.id);
        assert.deepEqual(parseLayout(serializeLayout(layout)).layout, layout, preset.id);
        assert.deepEqual(parseLayout(exportLayout(layout)).layout, layout, preset.id);
        assert.deepEqual(parseLayout(exportLayout(layout)).errors, [], preset.id);
    }
    assert.match(exportLayout(defaultLayout()), /\n {2}"segments"/, 'the export is readable');
});

test('presets: minimal, default, gaming with CPU and GPU graphs, battery', () => {
    assert.deepEqual(PRESETS.map(p => p.id), ['minimal', 'default', 'gaming', 'battery']);
    assert.deepEqual(presetLayout('default'), defaultLayout());
    assert.deepEqual(presetLayout('unknown'), defaultLayout());
    const gaming = presetLayout('gaming');
    assert.deepEqual(gaming.segments.filter(s => s.graph).map(s => s.graph.reading), ['cpu', 'gpu', 'cpu-usage']);
    assert.ok(gaming.segments.some(s => s.graph?.kind === 'bars'));
    const shown = renderLayout(presetLayout('battery'), snapshot()).map(s => s.text);
    assert.deepEqual(shown, ['24.5 W · 80% · 2:52', '61°', 'Turbo']);
    assert.deepEqual(renderLayout(presetLayout('minimal'), snapshot()).map(s => s.text), ['61°/47°']);
});

// ---- migration ------------------------------------------------------------------------

test('a fresh install migrates to the default layout', () => {
    assert.deepEqual(migrateLegacy(fakeSettings()), defaultLayout());
});

test('migration keeps what the user set up in part 1', () => {
    const settings = fakeSettings({
        'show-cpu': true, 'show-gpu': false, 'show-cpu-usage': true, 'show-power': true, 'show-profile': true,
        'show-icons': false, 'show-unit': true,
        'panel-order': ['profile', 'power', 'cpu'],
        'graph-items': ['cpu', 'power', 'profile'], 'graph-only': ['power'],
        'graph-window': 300, 'graph-width': 'wide', 'graph-style': 'area',
        'graph-color-mode': 'fixed', 'graph-color': 'rgb(1,2,3)',
    });
    const look = {kind: 'area', width: 'wide', window: 300, color: 'rgb(1,2,3)'};
    assert.deepEqual(migrateLegacy(settings).segments, [
        {items: ['profile'], template: '', icon: 'none', graph: null},
        {items: ['power'], template: '', icon: 'none', graph: {reading: 'power', only: true, ...look}},
        {items: ['cpu'], template: '{cpu}°C', icon: 'none', graph: {reading: 'cpu', only: false, ...look}},
        {items: ['cpu-usage'], template: '', icon: 'none', graph: null},
    ]);
});

test('the migration runs once: only while panel-layout is empty', () => {
    const settings = fakeSettings({'show-fans': true});
    const first = loadLayout(settings);
    assert.ok(first.migrated, 'empty layout: migrate');
    assert.deepEqual(first.layout.segments.map(s => s.items), [['cpu'], ['gpu'], ['fan'], ['profile']]);
    settings.values['panel-layout'] = first.migrated;
    settings.values['show-fans'] = false;
    const second = loadLayout(settings);
    assert.equal(second.migrated, null);
    assert.deepEqual(second.layout, first.layout, 'old keys are not read again');

    settings.values['panel-layout'] = '{broken';
    assert.deepEqual(loadLayout(settings), {layout: defaultLayout(), migrated: null});
});

// ---- editing ---------------------------------------------------------------------------

test('readings merge into a segment and split out of it', () => {
    let layout = defaultLayout(); // [cpu] [gpu] [profile]
    layout = moveItemTo(layout, 1, 'gpu', 0);
    assert.deepEqual(layout.segments.map(s => s.items), [['cpu', 'gpu'], ['profile']]);
    assert.deepEqual(renderLayout(layout, snapshot()).map(s => s.text), ['61° · 47°', 'Turbo']);

    layout = moveItemTo(layout, 1, 'profile', 0);
    assert.deepEqual(layout.segments.map(s => s.items), [['cpu', 'gpu', 'profile']]);

    layout = moveItemTo(layout, 0, 'gpu', 'new');
    assert.deepEqual(layout.segments.map(s => s.items), [['cpu', 'profile'], ['gpu']]);

    layout = moveItemTo(layout, 1, 'gpu', 'new');
    assert.deepEqual(layout.segments.map(s => s.items), [['cpu', 'profile'], ['gpu']], 'alone already');

    assert.deepEqual(moveItemTo(layout, 0, 'nope', 1), layout);
    assert.deepEqual(moveItemTo(layout, 7, 'cpu', 1), layout);
    assert.deepEqual(moveItemTo(layout, 0, 'cpu', 9), layout);
});

test('a graph moves with its reading', () => {
    let layout = setSegment(defaultLayout(), 1, {graph: {reading: 'gpu', kind: 'bars'}});
    layout = moveItemTo(layout, 1, 'gpu', 0);
    assert.equal(layout.segments[0].graph.reading, 'gpu');
    assert.equal(layout.segments[0].graph.kind, 'bars');
    layout = moveItemTo(layout, 0, 'gpu', 'new');
    assert.equal(layout.segments[0].graph, null);
    assert.equal(layout.segments[1].graph.reading, 'gpu');
});

test('adding and removing readings keeps a custom template in step', () => {
    let layout = setTemplate(defaultLayout(), 0, '{cpu}°C');
    layout = addItem(layout, 0, 'cpu-usage');
    assert.equal(layout.segments[0].template, '{cpu}°C · {cpu-usage}%');
    assert.deepEqual(layout.segments[0].items, ['cpu', 'cpu-usage']);
    assert.deepEqual(addItem(layout, 0, 'cpu'), layout, 'no duplicates');
    assert.deepEqual(addItem(layout, 0, 'bogus'), layout);
    layout = removeItem(layout, 0, 'cpu');
    assert.equal(layout.segments[0].template, '{cpu-usage}%');
    layout = removeItem(layout, 0, 'cpu-usage');
    assert.deepEqual(layout.segments.map(s => s.items), [['gpu'], ['profile']], 'an empty segment goes away');
});

test('a template decides the readings; clearing it joins them again', () => {
    let layout = setTemplate(defaultLayout(), 0, '{cpu}/{gpu} {watts}');
    assert.deepEqual(layout.segments[0].items, ['cpu', 'gpu', 'watts']);
    layout = setTemplate(layout, 0, '');
    assert.equal(layout.segments[0].template, '');
    assert.equal(effectiveTemplate(layout.segments[0]), '{cpu}° · {gpu}° · {watts} W');
    layout = setTemplate(layout, 0, 'HELIOS');
    assert.deepEqual(layout.segments[0], {items: [], template: 'HELIOS', icon: 'auto', graph: null});
    assert.deepEqual(renderLayout(layout, snapshot())[0].text, 'HELIOS');
});

test('segments are added, moved and removed', () => {
    let layout = addSegment(defaultLayout());
    assert.deepEqual(layout.segments[3].items, ['cpu-usage'], 'the first reading not shown yet');
    layout = addSegment(layout, 'fan');
    assert.deepEqual(layout.segments[4].items, ['fan']);
    layout = moveSegment(layout, 4, -10);
    assert.deepEqual(layout.segments.map(s => s.items[0]), ['fan', 'cpu', 'gpu', 'profile', 'cpu-usage']);
    layout = removeSegment(layout, 0);
    layout = removeSegment(layout, 99);
    assert.deepEqual(layout.segments.map(s => s.items[0]), ['cpu', 'gpu', 'profile', 'cpu-usage']);
    let full = defaultLayout();
    for (let i = 0; i < 20; i++)
        full = addSegment(full);
    assert.equal(full.segments.length, 12);
});

test('segment icon and graph settings', () => {
    let layout = setSegment(defaultLayout(), 0, {icon: 'fan'});
    assert.equal(layout.segments[0].icon, 'fan');
    layout = setSegment(layout, 0, {graph: {}});
    assert.deepEqual(layout.segments[0].graph,
        {reading: 'cpu', kind: 'line', only: false, width: 'medium', window: 120, color: 'follow'});
    layout = setSegment(layout, 0, {graph: {kind: 'bars', only: true, color: '#ff0000'}});
    assert.equal(layout.segments[0].graph.kind, 'bars');
    assert.equal(layout.segments[0].graph.color, '#ff0000');
    layout = setSegment(layout, 0, {graph: null});
    assert.equal(layout.segments[0].graph, null);
    assert.deepEqual(GRAPH_READINGS, ['cpu', 'gpu', 'cpu-usage', 'gpu-usage', 'cpu-watts', 'power', 'watts']);
});

// ---- rendering ------------------------------------------------------------------------------

test('a merged segment hides readings the machine lacks, unless its template names them', () => {
    const noGpu = snapshot({gpu: ['', 'none', false, 0]});
    const merged = {items: ['cpu', 'gpu'], template: '', icon: 'auto', graph: null};
    assert.equal(renderSegment(merged, makeResolver(noGpu)).text, '61°');
    assert.equal(renderSegment({...merged, template: '{cpu}°/{gpu}°'}, makeResolver(noGpu)).text, '61°/--');

    const gpuOnly = {items: ['gpu'], template: '', icon: 'auto', graph: null};
    assert.equal(renderSegment(gpuOnly, makeResolver(noGpu)).visible, false);
    assert.equal(renderSegment(gpuOnly, makeResolver(snapshot())).visible, true);
    const profileOnly = {items: ['profile'], template: '', icon: 'auto', graph: null};
    assert.equal(renderSegment(profileOnly, makeResolver(snapshot({profile: null}))).visible, false);
});

test('segment level, dimming and icon', () => {
    const resolve = makeResolver(snapshot({gpu: ['nvidia-smi', 'on', true, 88]}), {gpuWarm: 75, gpuHot: 85});
    const seg = renderSegment({items: ['cpu', 'gpu', 'profile'], template: '', icon: 'auto', graph: null}, resolve);
    assert.equal(seg.level, Level.HOT);
    assert.equal(seg.icon, 'cpu');
    assert.equal(seg.tint, '#f66151', 'Turbo');
    assert.equal(seg.dim, false);

    const ac = renderSegment({items: ['power'], template: '', icon: 'none', graph: null}, makeResolver(snapshot({source: 'ac'})));
    assert.equal(ac.dim, true, 'AC is dimmed');
    assert.equal(ac.icon, null);
    assert.equal(ac.text, 'AC');
});

test('markup colors each reading and escapes text', () => {
    const resolve = makeResolver(snapshot({gpu: ['nvidia-smi', 'off', false, 0]}), {cpuWarm: 60, cpuHot: 90});
    const seg = renderSegment({items: [], template: '<{cpu}°> & {gpu}° {profile}', icon: 'auto', graph: null}, resolve);
    assert.equal(segmentMarkup(seg, STYLE),
        '&lt;<span foreground="#f8e45c">61°</span>&gt; &amp; <span alpha="50%">off</span> <span foreground="#f66151">Turbo</span>');
    assert.equal(segmentColor(seg, STYLE), '#f8e45c', 'the warm CPU colors the icon');

    const hot = renderSegment({items: ['cpu'], template: '', icon: 'auto', graph: null},
        makeResolver(snapshot(), {cpuWarm: 50, cpuHot: 60}));
    assert.equal(segmentMarkup(hot, STYLE), '<span foreground="#f66151" weight="bold">61°</span>');
    assert.equal(segmentMarkup(hot, {...STYLE, bold: false, hot: ''}), '61°');
    assert.equal(segmentMarkup(hot, {...STYLE, normal: 'rgb(255,255,255)'}),
        '<span foreground="#ffffff"><span foreground="#f66151" weight="bold">61°</span></span>');

    const plain = renderSegment({items: ['cpu-usage'], template: '', icon: 'auto', graph: null}, resolve);
    assert.equal(segmentMarkup(plain, STYLE), '23%');
    assert.equal(segmentColor(plain, STYLE), null);
    assert.equal(colorHex('rgb(98,160,234)'), '#62a0ea');
    assert.equal(colorHex('tomato'), null);
});

test('graphs: graph-only segments and their spec', () => {
    const layout = setSegment(setSegment(defaultLayout(), 0, {graph: {kind: 'area', only: true, width: 'wide', window: 60}}),
        2, {graph: {reading: 'gpu'}});
    const [cpu, , profile] = renderLayout(layout, snapshot(), {cpuWarm: 50, cpuHot: 60});
    assert.equal(cpu.showText, false);
    assert.equal(cpu.graph.series, 'cpu-celsius');
    assert.equal(cpu.graph.kind, 'area');
    assert.equal(cpu.graph.width, 70);
    assert.equal(cpu.graph.window, 60);
    assert.equal(cpu.graph.levelOf(65), Level.HOT);
    assert.equal(profile.graph.series, 'gpu-celsius', 'a segment may graph a reading it does not show');
    assert.equal(profile.showText, true);
});

test('long text is cut so it never floods the bar', () => {
    const seg = renderSegment({items: [], template: 'x'.repeat(200), icon: 'auto', graph: null}, makeResolver(snapshot()));
    assert.equal(seg.text.length, 120);
});

test('settings are read into render options', () => {
    const settings = fakeSettings();
    assert.deepEqual(readOptions(settings), {
        cpuSensor: '', gpuSensor: '', cpuWarm: 80, cpuHot: 92, gpuWarm: 75, gpuHot: 85,
        hideGpuWhenOff: false, profileNames: 'predator', colorProfile: true,
    });
    assert.deepEqual(readStyle(settings), {normal: '', warm: '#f8e45c', hot: '#f66151', bold: true});
});

test('the preview has sample values and history', () => {
    const shown = renderLayout(presetLayout('gaming'), sampleSnapshot()).map(s => s.text);
    assert.deepEqual(shown, ['61°', '47°', '23%/9%', '2.4k/2.1k', 'Turbo']);
    const history = sampleHistory();
    assert.equal(history.ages.length, 150);
    for (const values of Object.values(history.series))
        assert.equal(values.length, 150);
    assert.ok(barPieces(history, 'cpu-usage', 45, 16).length > 0);
});

// ---- bars --------------------------------------------------------------------------

test('bars: one per slot, newest at the right, usage spans 0–100 %', () => {
    const history = {ages: [100, 10, 9, 0], series: {'cpu-usage': [50, 20, 100, null]}};
    const bars = barPieces(history, 'cpu-usage', 16, 10, {windowS: 40});
    // 4 slots of 10 s, 3 px + 1 px gap each; age 100 is outside the window.
    assert.deepEqual(bars, [
        {x: 9, y: 8, width: 3, height: 2, level: Level.NORMAL},
        {x: 13, y: 0, width: 3, height: 10, level: Level.NORMAL},
    ]);
    assert.deepEqual(barPieces(history, 'gpu-usage', 16, 10), []);
    assert.deepEqual(barPieces(null, 'cpu-usage', 16, 10), []);
});

test('bars keep a visible floor and take their level from the value', () => {
    const history = {ages: [3, 1], series: {'cpu-celsius': [60, 95]}};
    const levelOf = v => (v >= 90 ? Level.HOT : Level.NORMAL);
    const bars = barPieces(history, 'cpu-celsius', 8, 12, {windowS: 4, levelOf});
    assert.equal(bars.length, 2);
    assert.ok(bars[0].height >= 1 && bars[0].height < bars[1].height);
    assert.equal(bars[1].height, 12);
    assert.deepEqual(bars.map(b => b.level), [Level.NORMAL, Level.HOT]);
    assert.ok(bars.every(b => b.y + b.height === 12), 'bars stand on the bottom');
});
