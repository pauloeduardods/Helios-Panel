// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar layout: which segments the bar shows, what each one says and
// whether it draws a graph. Stored as JSON in the `panel-layout` setting.
// Pure: no GNOME imports, so it is unit-tested with node
// (tests/layout.test.js). The indicator and the preview in Settings both
// render through it, so what Settings shows is what the bar shows.
//
// Nothing here may throw on bad input: a bad template or an unknown
// placeholder renders as "--", and a layout that cannot be read at all
// becomes the default layout.

import {
    GRAPH_WIDTHS, Level, PANEL_ITEMS, formatRpm, normalizeOrder, parseColor, pickCpu, pickGpu,
    powerFromDbus, profileColor, profileFromDbus, profileLabel, sensorsFromDbus, tempLevel,
    usageFromDbus,
} from './model.js';

export const LAYOUT_VERSION = 1;

/** What a segment can draw its history as. */
export const GRAPH_KINDS = Object.freeze(['line', 'area', 'bars']);

/** Icons a segment can show ('auto' = its first reading's, 'none' = no icon). */
export const ICONS = Object.freeze(['cpu', 'gpu', 'fan', 'power', 'profile']);

/** The longest template kept, and the most segments and readings. */
export const MAX_TEMPLATE = 200;
export const MAX_SEGMENTS = 12;
export const MAX_ITEMS = 8;
const MAX_TEXT = 120;

/** Placed between readings when a segment has no template of its own. */
export const SEPARATOR = ' · ';

/**
 * Everything a segment can show. `template` is how a reading shows when the
 * segment has no template of its own; `series` the history its graph draws.
 */
export const READINGS = Object.freeze([
    {id: 'cpu', label: 'CPU temperature', icon: 'cpu', series: 'cpu-celsius', template: '{cpu}°'},
    {id: 'gpu', label: 'GPU temperature', icon: 'gpu', series: 'gpu-celsius', template: '{gpu}°'},
    {id: 'cpu-usage', label: 'CPU usage', icon: 'cpu', series: 'cpu-usage', template: '{cpu-usage}%'},
    {id: 'gpu-usage', label: 'GPU usage', icon: 'gpu', series: 'gpu-usage', template: '{gpu-usage}%'},
    {id: 'cpu-watts', label: 'CPU draw', icon: 'cpu', series: 'cpu-watts', template: '{cpu-watts} W'},
    {id: 'gpu-watts', label: 'GPU draw', icon: 'gpu', series: null, template: '{gpu-watts} W'},
    {id: 'fan', label: 'Fan speed', icon: 'fan', series: null, template: '{fan}'},
    {id: 'power', label: 'Power draw or AC', icon: 'power', series: 'battery-watts', template: '{power}'},
    {id: 'watts', label: 'Battery draw', icon: 'power', series: 'battery-watts', template: '{watts} W'},
    {id: 'battery', label: 'Battery charge', icon: 'power', series: null, template: '{battery}%'},
    {id: 'time-left', label: 'Battery time left', icon: 'power', series: null, template: '{time-left}'},
    {id: 'profile', label: 'Power profile', icon: 'profile', series: null, template: '{profile}'},
    {id: 'clock', label: 'CPU clock', icon: 'cpu', series: null, template: '{clock} GHz'},
    {id: 'clock-max', label: 'CPU clock, fastest core', icon: 'cpu', series: null, template: '{clock-max} GHz'},
]);

const READING = Object.freeze(Object.fromEntries(READINGS.map(r => [r.id, r])));

export function readingInfo(id) {
    return READING[id] ?? null;
}

/** Readings that can draw a graph. */
export const GRAPH_READINGS = Object.freeze(READINGS.filter(r => r.series).map(r => r.id));

/** "fan2" -> {reading: 'fan', index: 1}; a known reading -> {reading}; else null. */
function placeholderInfo(name) {
    if (READING[name])
        return {reading: name, index: null};
    const m = /^fan([1-9])$/.exec(name);
    return m ? {reading: 'fan', index: Number(m[1]) - 1} : null;
}

/** Every placeholder a template may use, for the help text. */
export const PLACEHOLDERS = Object.freeze([...READINGS.map(r => r.id), 'fan1', 'fan2']);

// ---- templates --------------------------------------------------------------

/**
 * A template as tokens: {text} for literal text, {name, decimals} for a
 * placeholder, {bad} for something unreadable. "{{" and "}}" are literal
 * braces; "{cpu:1}" asks for one decimal (0 to 2). Never throws.
 */
export function parseTemplate(template) {
    const s = String(template ?? '').slice(0, MAX_TEMPLATE);
    const tokens = [];
    const errors = [];
    let text = '';
    const flush = () => {
        if (text)
            tokens.push({text});
        text = '';
    };
    for (let i = 0; i < s.length;) {
        const c = s[i];
        if ((c === '{' || c === '}') && s[i + 1] === c) {
            text += c;
            i += 2;
            continue;
        }
        if (c !== '{') {
            text += c;
            i++;
            continue;
        }
        flush();
        const end = s.indexOf('}', i);
        if (end < 0) {
            errors.push(`"${s.slice(i)}" has no closing }`);
            tokens.push({bad: s.slice(i)});
            break;
        }
        const body = s.slice(i + 1, end).trim();
        const m = /^([a-z0-9-]+)(?::([0-9]))?$/.exec(body);
        if (m && placeholderInfo(m[1])) {
            tokens.push({name: m[1], decimals: m[2] === undefined ? null : Math.min(2, Number(m[2]))});
        } else {
            errors.push(body ? `unknown placeholder {${body}}` : 'empty placeholder {}');
            tokens.push({bad: body});
        }
        i = end + 1;
    }
    flush();
    return {tokens, errors};
}

/** The readings a template uses, in order, once each ("fan2" counts as fan). */
export function templateReadings(template) {
    const out = [];
    for (const t of parseTemplate(template).tokens) {
        const reading = t.name ? placeholderInfo(t.name).reading : null;
        if (reading && !out.includes(reading))
            out.push(reading);
    }
    return out;
}

function escapeTemplate(text) {
    return text.replace(/[{}]/g, c => c + c);
}

function tokensToTemplate(tokens) {
    return tokens.map(t => {
        if (t.text !== undefined)
            return escapeTemplate(t.text);
        if (t.name !== undefined)
            return `{${t.name}${t.decimals === null ? '' : `:${t.decimals}`}}`;
        return `{${t.bad}`;
    }).join('');
}

/** A unit right after a placeholder: "°", "%", " W", "°C". */
const GLUED = /^ ?[^\s·/|,;:()[\]{}<>&]+/;
const SEPARATORS = /^[\s·/|,;-]+|[\s·/|,;-]+$/g;

/** Tidies a template after a placeholder was cut out of it. */
function tidyTemplate(text) {
    return text
        .replace(/(\s*)([·/|,;])(\s*)(?:[·/|,;]\s*)+/g, (_m, a, c, b) => `${a ? ' ' : ''}${c}${b ? ' ' : ''}`)
        .replace(SEPARATORS, '');
}

/** `template` without `reading` (and fanN for fan) and its unit. */
export function removeFromTemplate(template, reading) {
    const {tokens} = parseTemplate(template);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.name && placeholderInfo(t.name).reading === reading) {
            const next = tokens[i + 1];
            if (next?.text !== undefined) {
                const glued = GLUED.exec(next.text);
                if (glued)
                    tokens[i + 1] = {text: next.text.slice(glued[0].length)};
            }
            continue;
        }
        out.push(t);
    }
    return tidyTemplate(tokensToTemplate(out));
}

// ---- layout -----------------------------------------------------------------

function segment(items, extra = {}) {
    return {items, template: '', icon: 'auto', graph: null, ...extra};
}

function graph(reading, extra = {}) {
    return {reading, kind: 'line', only: false, width: 'medium', window: 120, color: 'follow', ...extra};
}

/** The default layout: what a fresh install showed before layouts existed. */
export function defaultLayout() {
    return {version: LAYOUT_VERSION, segments: [segment(['cpu']), segment(['gpu']), segment(['profile'])]};
}

/** Ready-made layouts for the Settings page. */
export const PRESETS = Object.freeze([
    {
        id: 'minimal',
        label: 'Minimal',
        description: 'Both temperatures in one segment',
        layout: () => ({
            version: LAYOUT_VERSION,
            segments: [segment(['cpu', 'gpu'], {template: '{cpu}°/{gpu}°'})],
        }),
    },
    {
        id: 'default',
        label: 'Default',
        description: 'CPU, GPU and the power profile',
        layout: defaultLayout,
    },
    {
        id: 'gaming',
        label: 'Gaming',
        description: 'Temperatures with graphs, usage as bars, fans and profile',
        layout: () => ({
            version: LAYOUT_VERSION,
            segments: [
                segment(['cpu'], {graph: graph('cpu', {kind: 'area'})}),
                segment(['gpu'], {graph: graph('gpu', {kind: 'area'})}),
                segment(['cpu-usage', 'gpu-usage'], {
                    template: '{cpu-usage}%/{gpu-usage}%',
                    graph: graph('cpu-usage', {kind: 'bars', width: 'narrow'}),
                }),
                segment(['fan']),
                segment(['profile']),
            ],
        }),
    },
    {
        id: 'battery',
        label: 'Battery',
        description: 'Draw, charge and time left, then CPU and profile',
        layout: () => ({
            version: LAYOUT_VERSION,
            segments: [
                segment(['power', 'battery', 'time-left'], {template: '{power} · {battery}% · {time-left}'}),
                segment(['cpu']),
                segment(['profile']),
            ],
        }),
    },
]);

export function presetLayout(id) {
    const preset = PRESETS.find(p => p.id === id);
    return sanitizeLayout(preset ? preset.layout() : defaultLayout());
}

function sanitizeGraph(raw) {
    if (!raw || typeof raw !== 'object' || !GRAPH_READINGS.includes(raw.reading))
        return null;
    const window = Number.isFinite(raw.window) ? Math.round(raw.window) : 120;
    const color = typeof raw.color === 'string' && parseColor(raw.color) ? raw.color.trim() : 'follow';
    return {
        reading: raw.reading,
        kind: GRAPH_KINDS.includes(raw.kind) ? raw.kind : 'line',
        only: raw.only === true,
        width: Object.hasOwn(GRAPH_WIDTHS, raw.width) ? raw.width : 'medium',
        window: Math.max(60, Math.min(300, window)),
        color,
    };
}

function sanitizeIcon(icon) {
    if (icon === false || icon === 'none')
        return 'none';
    return ICONS.includes(icon) ? icon : 'auto';
}

/** One segment, cleaned up; null when it shows nothing. */
function sanitizeSegment(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    let template = typeof raw.template === 'string' ? raw.template.slice(0, MAX_TEMPLATE) : '';
    if (template.trim() === '')
        template = '';
    let items;
    if (template) {
        // A template is the truth: its readings are the segment's.
        items = templateReadings(template).slice(0, MAX_ITEMS);
    } else {
        const ids = Array.isArray(raw.items) ? raw.items : [];
        items = [...new Set(ids)].filter(id => READING[id]).slice(0, MAX_ITEMS);
    }
    const graphSpec = sanitizeGraph(raw.graph);
    if (items.length === 0 && !template && !graphSpec)
        return null;
    return {items, template, icon: sanitizeIcon(raw.icon), graph: graphSpec};
}

/** Any value to a valid layout. Unknown readings and empty segments are dropped. */
export function sanitizeLayout(raw) {
    const segments = Array.isArray(raw?.segments) ? raw.segments : [];
    return {
        version: LAYOUT_VERSION,
        segments: segments.map(sanitizeSegment).filter(Boolean).slice(0, MAX_SEGMENTS),
    };
}

/**
 * The `panel-layout` text as {ok, layout, errors}. Text that is not a layout
 * at all gives ok = false and the default layout; template mistakes are
 * listed in `errors` but the layout is still used (they render as "--").
 */
export function parseLayout(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return {ok: false, layout: defaultLayout(), errors: [`not JSON: ${e.message}`]};
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments))
        return {ok: false, layout: defaultLayout(), errors: ['not a Helios Panel layout (no "segments" list)']};
    const layout = sanitizeLayout(raw);
    const errors = [];
    layout.segments.forEach((s, i) => {
        for (const e of parseTemplate(s.template).errors)
            errors.push(`segment ${i + 1}: ${e}`);
    });
    return {ok: true, layout, errors};
}

export function serializeLayout(layout) {
    return JSON.stringify(sanitizeLayout(layout));
}

/** The layout as a file to back up or share. */
export function exportLayout(layout) {
    return `${JSON.stringify(sanitizeLayout(layout), null, 2)}\n`;
}

// ---- migration from the part-1 settings ---------------------------------------

/**
 * The layout the old show-*, panel-order, show-icons, show-unit and graph-*
 * settings described: one segment per shown item, in their order.
 * `settings` is anything with get_boolean/get_strv/get_int/get_string.
 */
export function migrateLegacy(settings) {
    const icons = settings.get_boolean('show-icons');
    const unit = settings.get_boolean('show-unit');
    const graphs = settings.get_strv('graph-items');
    const only = settings.get_strv('graph-only');
    const look = {
        kind: settings.get_string('graph-style') === 'area' ? 'area' : 'line',
        width: settings.get_string('graph-width'),
        window: settings.get_int('graph-window'),
        color: settings.get_string('graph-color-mode') === 'fixed' ? settings.get_string('graph-color') : 'follow',
    };
    const segments = normalizeOrder(settings.get_strv('panel-order'))
        .map(id => PANEL_ITEMS.find(item => item.id === id))
        .filter(item => settings.get_boolean(item.show))
        .map(item => segment([item.id], {
            template: unit && (item.id === 'cpu' || item.id === 'gpu') ? `{${item.id}}°C` : '',
            icon: icons ? 'auto' : 'none',
            graph: item.series && graphs.includes(item.id)
                ? graph(item.id, {...look, only: only.includes(item.id)})
                : null,
        }));
    return sanitizeLayout({segments});
}

/**
 * The layout in `settings`. On first run `panel-layout` is empty: the layout
 * then comes from the old settings and `migrated` is the text to store, so
 * the migration happens once.
 */
export function loadLayout(settings) {
    const stored = settings.get_string('panel-layout');
    if (stored.trim() === '') {
        const layout = migrateLegacy(settings);
        return {layout, migrated: serializeLayout(layout)};
    }
    return {layout: parseLayout(stored).layout, migrated: null};
}

// ---- editing (Settings) ---------------------------------------------------------

function clone(layout) {
    return JSON.parse(JSON.stringify(sanitizeLayout(layout)));
}

function inRange(layout, index) {
    return Number.isInteger(index) && index >= 0 && index < layout.segments.length;
}

/** Adds a reading to segment `index`, at the end of its template if it has one. */
export function addItem(layout, index, id) {
    const out = clone(layout);
    const s = out.segments[index];
    if (!s || !READING[id] || s.items.includes(id) || s.items.length >= MAX_ITEMS)
        return out;
    if (s.template)
        s.template = s.template.trim() ? `${s.template}${SEPARATOR}${READING[id].template}` : READING[id].template;
    s.items.push(id);
    return sanitizeLayout(out);
}

/** Removes a reading from segment `index`; a segment left empty goes away. */
export function removeItem(layout, index, id) {
    const out = clone(layout);
    const s = out.segments[index];
    if (!s)
        return out;
    s.items = s.items.filter(x => x !== id);
    if (s.template) {
        s.template = removeFromTemplate(s.template, id);
        if (templateReadings(s.template).length === 0)
            s.template = '';
    }
    if (s.graph?.reading === id)
        s.graph = null;
    return sanitizeLayout(out);
}

/**
 * Moves a reading from segment `from` into segment `to` (merging it), or
 * into a new segment right after `from` when `to` is 'new' (splitting it).
 */
export function moveItemTo(layout, from, id, to) {
    if (!inRange(layout, from) || !layout.segments[from].items.includes(id))
        return clone(layout);
    let out = clone(layout);
    const graphSpec = out.segments[from].graph?.reading === id ? out.segments[from].graph : null;
    const before = out.segments.length;
    out = removeItem(out, from, id);
    const removed = out.segments.length < before;
    if (to === 'new') {
        out.segments.splice(removed ? from : from + 1, 0, segment([id], {graph: graphSpec}));
        return sanitizeLayout(out);
    }
    if (!Number.isInteger(to) || to === from)
        return clone(layout);
    const target = removed && to > from ? to - 1 : to;
    if (!inRange(out, target))
        return clone(layout);
    out = addItem(out, target, id);
    if (graphSpec && !out.segments[target].graph)
        out.segments[target].graph = graphSpec;
    return sanitizeLayout(out);
}

export function moveSegment(layout, index, delta) {
    const out = clone(layout);
    if (!inRange(out, index))
        return out;
    const to = Math.max(0, Math.min(out.segments.length - 1, index + delta));
    out.segments.splice(to, 0, ...out.segments.splice(index, 1));
    return out;
}

/** Adds a segment with one reading at the end (or the first one not shown yet). */
export function addSegment(layout, id = null) {
    const out = clone(layout);
    if (out.segments.length >= MAX_SEGMENTS)
        return out;
    const shown = new Set(out.segments.flatMap(s => s.items));
    const pick = READING[id] ? id : (READINGS.find(r => !shown.has(r.id)) ?? READINGS[0]).id;
    out.segments.push(segment([pick]));
    return out;
}

export function removeSegment(layout, index) {
    const out = clone(layout);
    if (inRange(out, index))
        out.segments.splice(index, 1);
    return out;
}

/**
 * Sets segment `index`'s template; '' goes back to the readings joined by
 * " · ". A template that uses no reading keeps the segment's readings out.
 */
export function setTemplate(layout, index, template) {
    const out = clone(layout);
    if (!inRange(out, index))
        return out;
    const s = out.segments[index];
    s.template = String(template ?? '').slice(0, MAX_TEMPLATE);
    const next = sanitizeSegment(s);
    if (next)
        out.segments[index] = next;
    return out;
}

/** Changes `icon` or `graph` of segment `index` (graph: null turns it off). */
export function setSegment(layout, index, patch) {
    const out = clone(layout);
    if (!inRange(out, index))
        return out;
    const s = {...out.segments[index]};
    if ('icon' in patch)
        s.icon = patch.icon;
    if ('graph' in patch)
        s.graph = patch.graph === null ? null : {...(s.graph ?? graph(GRAPH_READINGS.find(r => s.items.includes(r)) ?? 'cpu')), ...patch.graph};
    out.segments[index] = sanitizeSegment(s) ?? out.segments[index];
    return out;
}

/** The template a segment uses: its own, or its readings joined. */
export function effectiveTemplate(seg) {
    return seg.template || seg.items.map(id => READING[id].template).join(SEPARATOR);
}

// ---- rendering --------------------------------------------------------------------

/** The display settings rendering needs, from a GSettings-like object. */
export function readOptions(settings) {
    return {
        cpuSensor: settings.get_string('cpu-sensor'),
        gpuSensor: settings.get_string('gpu-sensor'),
        cpuWarm: settings.get_int('cpu-warm'),
        cpuHot: settings.get_int('cpu-hot'),
        gpuWarm: settings.get_int('gpu-warm'),
        gpuHot: settings.get_int('gpu-hot'),
        hideGpuWhenOff: settings.get_boolean('hide-gpu-when-off'),
        profileNames: settings.get_string('profile-names'),
        colorProfile: settings.get_boolean('color-profile'),
    };
}

/** The colors rendering uses, from a GSettings-like object. */
export function readStyle(settings) {
    return {
        normal: settings.get_string('color-normal'),
        warm: settings.get_string('color-warm'),
        hot: settings.get_string('color-hot'),
        bold: settings.get_boolean('bold-when-hot'),
    };
}

const DEFAULT_OPTIONS = Object.freeze({
    cpuSensor: '', gpuSensor: '', cpuWarm: 80, cpuHot: 92, gpuWarm: 75, gpuHot: 85,
    hideGpuWhenOff: false, profileNames: 'predator', colorProfile: true,
});

function fixed(value, decimals) {
    return value.toFixed(decimals);
}

/** 172 -> "2:52". */
function compactDuration(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * A function from a placeholder (name, decimals) to what it shows:
 * {text, level, tint, dim, absent, hasValue}. `absent` means the machine
 * has no such reading right now (no battery, no GPU, on AC…); `hasValue`
 * is false for "--" and "off", whose units are then left out.
 */
export function makeResolver(snapshot, options = {}) {
    const opt = {...DEFAULT_OPTIONS, ...options};
    const {sensors, usage, power, profile} = snapshot;
    const battery = power.battery;
    const discharging = battery?.state === 'discharging';
    const none = {text: '--', level: Level.NORMAL, tint: null, dim: false, absent: true, hasValue: false};
    const number = (v, decimals, fallback, extra = {}) => (v === null || v === undefined || !Number.isFinite(v)
        ? {...none, ...extra}
        : {...none, absent: false, hasValue: true, text: fixed(v, decimals ?? fallback), ...extra});
    const watts = v => (v !== null && v >= 100 ? 0 : 1);

    const cpu = pickCpu(sensors, opt.cpuSensor);
    const gpu = pickGpu(sensors, opt.gpuSensor);

    const values = {
        'cpu': d => number(cpu, d, 0, {absent: false, level: tempLevel(cpu, opt.cpuWarm, opt.cpuHot)}),
        'gpu': d => {
            if (gpu.state === 'none')
                return none;
            if (gpu.state === 'off')
                return {...none, text: 'off', dim: true, absent: opt.hideGpuWhenOff};
            return number(gpu.celsius, d, 0, {absent: false, level: tempLevel(gpu.celsius, opt.gpuWarm, opt.gpuHot)});
        },
        'cpu-usage': d => number(usage.cpu, d, 0),
        'gpu-usage': d => number(usage.gpu, d, 0),
        'cpu-watts': d => number(power.cpuWatts, d, watts(power.cpuWatts)),
        'gpu-watts': d => number(power.gpuWatts, d, watts(power.gpuWatts)),
        'fan': () => (sensors.fans.length === 0
            ? none
            : {...none, absent: false, hasValue: true, text: sensors.fans.map(f => formatRpm(f.rpm)).join('/')}),
        'power': d => {
            if (power.source === 'battery') {
                const w = battery?.watts ?? null;
                return w === null ? {...none, absent: false} : {...number(w, d, watts(w)), text: `${fixed(w, d ?? watts(w))} W`};
            }
            if (power.source === 'ac')
                return {...none, text: 'AC', dim: true, absent: false};
            return none;
        },
        'watts': d => (discharging ? number(battery.watts, d, watts(battery.watts)) : none),
        'battery': d => number(battery?.percent ?? null, d, 0),
        'time-left': () => (discharging && battery.minutesLeft !== null
            ? {...none, absent: false, hasValue: true, text: compactDuration(battery.minutesLeft)}
            : none),
        'profile': () => (profile.available
            ? {
                ...none, absent: false, hasValue: profile.current !== null,
                text: profileLabel(profile.current, opt.profileNames),
                tint: opt.colorProfile ? profileColor(profile.current) : null,
            }
            : none),
        'clock': d => number(usage.averageGhz, d, 1),
        'clock-max': d => number(usage.maxGhz, d, 1),
    };

    return (name, decimals = null) => {
        const info = placeholderInfo(name);
        if (!info)
            return none;
        if (info.index !== null) {
            const fan = sensors.fans[info.index];
            return fan ? {...none, absent: false, hasValue: fan.rpm !== null, text: formatRpm(fan.rpm)} : none;
        }
        return values[info.reading](decimals);
    };
}

/**
 * The text parts of a template: [{text, reading, level, tint, dim}].
 * A unit glued to a placeholder ("°", "%", " W") takes its color and is
 * left out when the reading shows "--" or "off".
 */
export function renderTemplate(template, resolve) {
    const {tokens} = parseTemplate(template);
    const parts = [];
    let last = null;
    for (const t of tokens) {
        if (t.text !== undefined) {
            let text = t.text;
            const glued = last ? GLUED.exec(text) : null;
            if (glued) {
                if (last.hasValue)
                    last.part.text += glued[0];
                text = text.slice(glued[0].length);
            }
            if (text)
                parts.push({text, reading: null, level: Level.NORMAL, tint: null, dim: false});
            last = null;
        } else if (t.name !== undefined) {
            const v = resolve(t.name, t.decimals);
            const part = {text: v.text, reading: placeholderInfo(t.name).reading, level: v.level, tint: v.tint, dim: v.dim};
            parts.push(part);
            last = {part, hasValue: v.hasValue};
        } else {
            parts.push({text: '--', reading: null, level: Level.NORMAL, tint: null, dim: false});
            last = null;
        }
    }
    const out = [];
    let room = MAX_TEXT;
    for (const p of parts) {
        if (room <= 0)
            break;
        out.push({...p, text: p.text.slice(0, room)});
        room -= p.text.length;
    }
    return out;
}

const LEVEL_RANK = Object.freeze({[Level.UNKNOWN]: 0, [Level.NORMAL]: 0, [Level.WARM]: 1, [Level.HOT]: 2});

/** The temperature series and their threshold options. */
const SERIES_THRESHOLDS = Object.freeze({
    'cpu-celsius': ['cpuWarm', 'cpuHot'],
    'gpu-celsius': ['gpuWarm', 'gpuHot'],
});

/** Level of each value of a series: temperatures by threshold, the rest normal. */
export function seriesLevelOf(series, options = {}) {
    const opt = {...DEFAULT_OPTIONS, ...options};
    const keys = SERIES_THRESHOLDS[series];
    if (!keys)
        return () => Level.NORMAL;
    return v => tempLevel(v, opt[keys[0]], opt[keys[1]]);
}

/**
 * One segment ready to draw: {visible, icon, parts, dim, level, tint,
 * showText, graph}. `graph` is null or {series, kind, width (px), window,
 * color ('follow' or a color), levelOf}.
 */
export function renderSegment(seg, resolve, options = {}) {
    let template = seg.template;
    if (!template) {
        const present = seg.items.filter(id => !resolve(id).absent);
        template = (present.length ? present : seg.items).map(id => READING[id].template).join(SEPARATOR);
    }
    const used = templateReadings(template);
    const graphReading = seg.graph?.reading ?? null;
    const watched = [...used, ...(graphReading ? [graphReading] : [])];
    const visible = watched.length === 0 || watched.some(id => !resolve(id).absent);

    const parts = renderTemplate(template, resolve);
    const valued = parts.filter(p => p.reading);
    const dim = valued.length > 0 && valued.every(p => p.dim);
    let level = Level.NORMAL;
    for (const p of valued) {
        if (LEVEL_RANK[p.level] > LEVEL_RANK[level])
            level = p.level;
    }
    const tint = valued.find(p => p.tint)?.tint ?? null;

    let icon = seg.icon;
    if (icon === 'auto')
        icon = READING[seg.items[0] ?? graphReading]?.icon ?? null;
    if (icon === 'none')
        icon = null;

    const graphSpec = seg.graph ? {
        series: READING[graphReading].series,
        kind: seg.graph.kind,
        width: GRAPH_WIDTHS[seg.graph.width] ?? GRAPH_WIDTHS.medium,
        window: seg.graph.window,
        color: seg.graph.color,
        levelOf: seriesLevelOf(READING[graphReading].series, options),
    } : null;

    return {
        visible,
        icon,
        parts,
        text: parts.map(p => p.text).join(''),
        dim,
        level,
        tint,
        showText: !(graphSpec && seg.graph.only) && parts.length > 0,
        graph: graphSpec,
    };
}

/** Every segment of `layout` rendered from a client snapshot. */
export function renderLayout(layout, snapshot, options = {}) {
    const resolve = makeResolver(snapshot, options);
    return layout.segments.map(seg => renderSegment(seg, resolve, options));
}

/** A color setting as "#rrggbb" for Pango, or null (theme color). */
export function colorHex(text) {
    const rgb = parseColor(text);
    if (!rgb)
        return null;
    return `#${rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The color setting for a level, or '' for the theme color. */
export function levelColor(level, style) {
    if (level === Level.HOT)
        return style.hot ?? '';
    if (level === Level.WARM)
        return style.warm ?? '';
    return style.normal ?? '';
}

function escapeMarkup(text) {
    return text.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[c]);
}

/**
 * A rendered segment's text as Pango markup: each reading in its own color
 * (profile color, or the temperature color for its level), bold when hot,
 * half transparent when dimmed (unless the whole segment is dimmed, which
 * the caller does with opacity). `style` comes from readStyle().
 */
export function segmentMarkup(rendered, style) {
    const body = rendered.parts.map(p => {
        const text = escapeMarkup(p.text);
        if (!p.reading)
            return text;
        const attrs = [];
        const color = colorHex(p.tint ?? levelColor(p.level, style));
        if (color && (p.tint || p.level !== Level.NORMAL))
            attrs.push(`foreground="${color}"`);
        if (p.level === Level.HOT && style.bold)
            attrs.push('weight="bold"');
        if (p.dim && !rendered.dim)
            attrs.push('alpha="50%"');
        return attrs.length ? `<span ${attrs.join(' ')}>${text}</span>` : text;
    }).join('');
    const normal = colorHex(style.normal);
    return normal ? `<span foreground="${normal}">${body}</span>` : body;
}

/** The icon's color: the hottest reading's when warm or hot, else the tint, else normal. */
export function segmentColor(rendered, style) {
    if (rendered.level === Level.WARM || rendered.level === Level.HOT)
        return colorHex(levelColor(rendered.level, style));
    return colorHex(rendered.tint ?? style.normal);
}

// ---- sample data for the preview ----------------------------------------------

/** What the preview shows when heliosd does not answer. */
export function sampleSnapshot() {
    return {
        state: 'running',
        version: null,
        sensors: sensorsFromDbus({
            Cpu: ['sample', true, 61],
            Gpu: ['sample', 'on', true, 47],
            Fans: [['Fan 1', 2350], ['Fan 2', 2100]],
            Temperatures: [],
        }),
        usage: usageFromDbus({CpuUsage: [true, 23], CpuFrequency: [true, 1.4, 3.8], GpuUsage: [true, 9]}),
        power: powerFromDbus({
            GpuPower: [true, 6.2],
            CpuPower: [true, 12.3],
            PowerSource: 'battery',
            Battery: ['BAT1', 'discharging', 80, 24.5, 92, 0, 172],
        }),
        profile: profileFromDbus({
            Available: true, Active: 'performance', Choices: ['quiet', 'balanced', 'performance'], Driver: 'sample',
        }),
    };
}

/** Five minutes of made-up history for the preview's graphs. */
export function sampleHistory() {
    const count = 150;
    const ages = Array.from({length: count}, (_, i) => (count - 1 - i) * 2);
    const wave = (base, amp, period, phase = 0) =>
        ages.map((_, i) => Math.round((base + amp * Math.sin(i / period + phase) + amp / 3 * Math.sin(i / 3.1)) * 10) / 10);
    return {
        ages,
        series: {
            'cpu-celsius': wave(68, 14, 9),
            'gpu-celsius': wave(55, 9, 13, 1),
            'cpu-usage': wave(35, 25, 5, 2).map(v => Math.max(0, Math.min(100, v))),
            'gpu-usage': wave(20, 18, 7, 3).map(v => Math.max(0, Math.min(100, v))),
            'cpu-watts': wave(14, 6, 6),
            'battery-watts': wave(24, 6, 11),
        },
    };
}
