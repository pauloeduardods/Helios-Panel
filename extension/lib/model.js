// SPDX-License-Identifier: GPL-3.0-or-later
// Pure view logic: turns what heliosd publishes into what the panel shows.
// No GNOME imports, so it is unit-tested with node (tests/model.test.js).

export const Level = Object.freeze({
    UNKNOWN: 'unknown',
    NORMAL: 'normal',
    WARM: 'warm',
    HOT: 'hot',
});

/** Keeps warm < hot no matter what the user typed. */
export function sanitizeThresholds(warm, hot) {
    let w = Number.isFinite(warm) ? warm : 75;
    const h = Number.isFinite(hot) ? hot : 90;
    if (w >= h)
        w = h - 1;
    return {warm: w, hot: h};
}

export function tempLevel(celsius, warm, hot) {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius))
        return Level.UNKNOWN;
    const t = sanitizeThresholds(warm, hot);
    if (celsius >= t.hot)
        return Level.HOT;
    if (celsius >= t.warm)
        return Level.WARM;
    return Level.NORMAL;
}

export function formatTemp(celsius, showUnit = true) {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius))
        return '--';
    return `${Math.round(celsius)}${showUnit ? '°C' : '°'}`;
}

/** 2350 -> "2.4k", 800 -> "800", 0 -> "0". */
export function formatRpm(rpm) {
    if (rpm === null || rpm === undefined || !Number.isFinite(rpm))
        return '--';
    if (rpm < 1000)
        return `${Math.round(rpm)}`;
    return `${(rpm / 1000).toFixed(1)}k`;
}

// ---- platform profiles ----------------------------------------------------

// Kernel names, and what PredatorSense calls them on Acer Predator laptops
// (acer-wmi with predator_v4=1). tier: 0 = most economical ... 5 = most powerful.
export const PROFILE_INFO = Object.freeze({
    'low-power': {predator: 'Eco', pt: 'Economia', tier: 0},
    'cool': {predator: 'Cool', pt: 'Frio', tier: 1},
    'quiet': {predator: 'Quiet', pt: 'Silencioso', tier: 1},
    'balanced': {predator: 'Balanced', pt: 'Equilibrado', tier: 2},
    'balanced-performance': {predator: 'Performance', pt: 'Desempenho', tier: 3},
    'performance': {predator: 'Turbo', pt: 'Turbo', tier: 4},
    'max-power': {predator: 'Max', pt: 'Máximo', tier: 5},
    'custom': {predator: 'Custom', pt: 'Personalizado', tier: 2},
});

export function profileLabel(id, style = 'predator') {
    if (!id)
        return '--';
    const info = PROFILE_INFO[id];
    if (!info || style === 'linux')
        return id;
    return style === 'portuguese' ? info.pt : info.predator;
}

/** Default colour per tier; null = theme colour. */
const TIER_COLORS = Object.freeze([
    '#62a0ea', // 0 eco
    '#8ff0a4', // 1 quiet
    null, //      2 balanced
    '#ffbe6f', // 3 performance
    '#f66151', // 4 turbo
    '#f66151', // 5 max
]);

export function profileColor(id) {
    const tier = PROFILE_INFO[id]?.tier;
    return tier === undefined ? null : TIER_COLORS[tier];
}

// ---- heliosd properties ---------------------------------------------------

/**
 * Unpacked D-Bus properties (see docs/ARCHITECTURE.md, API v1) to plain
 * objects. Missing properties give empty values, never exceptions.
 */
export function sensorsFromDbus({Cpu, Gpu, Fans, Temperatures, Devices} = {}) {
    const [cpuId = '', cpuValid = false, cpuC = 0] = Cpu ?? [];
    const [gpuSource = '', gpuState = 'none', gpuValid = false, gpuC = 0] = Gpu ?? [];
    return {
        cpu: {sensor: cpuId || null, celsius: cpuValid ? cpuC : null},
        gpu: {source: gpuSource || null, state: gpuState, celsius: gpuValid ? gpuC : null},
        fans: (Fans ?? []).map(([label, rpm]) => ({label, rpm: rpm < 0 ? null : rpm})),
        temperatures: (Temperatures ?? []).map(([id, chip, label, celsius]) => ({id, chip, label, celsius})),
        // Drives and network cards (API v4), already sorted by heliosd.
        devices: (Devices ?? []).map(([kind, name, celsius]) => ({kind, name, celsius})),
    };
}

/**
 * CPU and GPU usage and the CPU clock (API v4); null when unknown or when
 * heliosd is older.
 */
export function usageFromDbus({CpuUsage, CpuFrequency, GpuUsage} = {}) {
    const [cpuValid = false, cpu = 0] = CpuUsage ?? [];
    const [freqValid = false, averageGhz = 0, maxGhz = 0] = CpuFrequency ?? [];
    const [gpuValid = false, gpu = 0] = GpuUsage ?? [];
    return {
        cpu: cpuValid ? cpu : null,
        gpu: gpuValid ? gpu : null,
        averageGhz: freqValid ? averageGhz : null,
        maxGhz: freqValid ? maxGhz : null,
    };
}

// ---- history --------------------------------------------------------------

/** How far back heliosd keeps readings, in seconds. */
export const HISTORY_SPAN_S = 300;

/**
 * GetHistory's reply (API v5) as {ages, series}: ages in seconds before now,
 * oldest first, and per series name the values aligned with them (null where
 * there was no reading).
 */
export function historyFromDbus(reply) {
    const [ages = [], series = []] = reply ?? [];
    const out = {ages, series: {}};
    for (const [name, valid, values] of series)
        out.series[name] = values.map((v, i) => (valid[i] ? v : null));
    return out;
}

/**
 * The smallest range a sparkline spans, per series, so a 0.1 °C wobble is
 * not drawn as a cliff.
 */
const SPARKLINE_MIN_RANGE = Object.freeze({
    'cpu-celsius': 10,
    'gpu-celsius': 10,
    'cpu-usage': 20,
    'gpu-usage': 20,
    'cpu-watts': 5,
    'battery-watts': 5,
});

/** The series heliosd keeps, in its order. */
export const HISTORY_SERIES = Object.freeze([
    'cpu-celsius', 'gpu-celsius', 'cpu-usage', 'gpu-usage', 'cpu-watts', 'battery-watts',
]);

/** heliosd keeps 150 samples; so does the local copy. */
const HISTORY_CAPACITY = 150;

/**
 * The extension's copy of the history: loaded once from GetHistory, then
 * kept up to date from the values heliosd already sends, so the graphs
 * cost no extra D-Bus calls. Times are monotonic seconds.
 */
export class HistoryBuffer {
    constructor() {
        this.clear();
    }

    clear() {
        this.times = [];
        this.series = Object.fromEntries(HISTORY_SERIES.map(name => [name, []]));
    }

    /** Replaces everything with a GetHistory reply received at `now`. */
    load(reply, now) {
        const {ages, series} = historyFromDbus(reply);
        this.times = ages.map(age => now - age);
        for (const name of HISTORY_SERIES)
            this.series[name] = series[name] ?? this.times.map(() => null);
    }

    /** Adds one sample: `values` maps a series name to a reading or null. */
    push(now, values) {
        this.times.push(now);
        for (const name of HISTORY_SERIES)
            this.series[name].push(values[name] ?? null);
        const drop = this.times.findIndex(t => now - t <= HISTORY_SPAN_S);
        const excess = Math.max(this.times.length - HISTORY_CAPACITY, drop < 0 ? this.times.length : drop);
        if (excess > 0) {
            this.times.splice(0, excess);
            for (const name of HISTORY_SERIES)
                this.series[name].splice(0, excess);
        }
    }

    /** {ages, series} as of `now`, the shape the sparklines draw. */
    view(now) {
        return {ages: this.times.map(t => now - t), series: this.series};
    }
}

/** One history sample from a client snapshot. */
export function historySample({sensors, usage, power}) {
    const battery = power.battery;
    return {
        'cpu-celsius': sensors.cpu.celsius,
        'gpu-celsius': sensors.gpu.celsius,
        'cpu-usage': usage.cpu,
        'gpu-usage': usage.gpu,
        'cpu-watts': power.cpuWatts,
        'battery-watts': battery?.state === 'discharging' ? battery.watts : null,
    };
}

/**
 * Pieces of a sparkline in a width × height box (y grows down): the newest
 * sample at the right edge, `windowS` seconds ago at the left. A piece is a
 * run of [x, y] points without gaps and with one `level` (from `levelOf`,
 * applied to the value each step ends on), so a line can change color where
 * the reading crosses a threshold. Empty when there is nothing to draw.
 */
export function sparklinePieces(history, name, width, height,
    {windowS = HISTORY_SPAN_S, levelOf = () => Level.NORMAL} = {}) {
    const values = history?.series[name] ?? [];
    const inWindow = i => history.ages[i] <= windowS;
    const known = values.filter((v, i) => v !== null && inWindow(i));
    if (known.length === 0)
        return [];
    let low = Math.min(...known);
    let high = Math.max(...known);
    const minRange = SPARKLINE_MIN_RANGE[name] ?? 0;
    if (high - low < minRange) {
        const mid = (high + low) / 2;
        low = mid - minRange / 2;
        high = mid + minRange / 2;
    }
    const pad = 1;
    const y = v => (high > low
        ? pad + (1 - (v - low) / (high - low)) * (height - 2 * pad)
        : height / 2);
    const x = age => (1 - Math.min(age, windowS) / windowS) * width;

    const runs = [];
    let run = [];
    values.forEach((v, i) => {
        if (!inWindow(i))
            return;
        if (v === null) {
            if (run.length)
                runs.push(run);
            run = [];
        } else {
            run.push({point: [x(history.ages[i]), y(v)], level: levelOf(v)});
        }
    });
    if (run.length)
        runs.push(run);

    const pieces = [];
    for (const r of runs) {
        if (r.length === 1) {
            pieces.push({points: [r[0].point], level: r[0].level});
            continue;
        }
        let piece = {points: [r[0].point], level: r[1].level};
        for (let i = 1; i < r.length; i++) {
            if (r[i].level !== piece.level) {
                pieces.push(piece);
                piece = {points: [r[i - 1].point], level: r[i].level};
            }
            piece.points.push(r[i].point);
        }
        pieces.push(piece);
    }
    return pieces;
}

/** Series in percent: their bars always span 0–100 %. */
const PERCENT_SERIES = Object.freeze(['cpu-usage', 'gpu-usage']);

/**
 * A bar graph in a width × height box (y grows down): the window is split
 * into slots of `barWidth` pixels plus a `gap`, newest at the right, and
 * each slot draws the highest reading it holds as one bar with its `level`.
 * Usage spans 0–100 %; anything else spans its readings like a sparkline,
 * with some room below so the lowest bar is still visible. Empty slots draw
 * nothing.
 */
export function barPieces(history, name, width, height,
    {windowS = HISTORY_SPAN_S, levelOf = () => Level.NORMAL, barWidth = 3, gap = 1} = {}) {
    const values = history?.series[name] ?? [];
    const step = barWidth + gap;
    const slots = Math.max(1, Math.floor((width + gap) / step));
    const peaks = new Array(slots).fill(null);
    values.forEach((v, i) => {
        const age = history.ages[i];
        if (v === null || age > windowS)
            return;
        const slot = slots - 1 - Math.min(slots - 1, Math.floor(age / (windowS / slots)));
        if (peaks[slot] === null || v > peaks[slot])
            peaks[slot] = v;
    });
    const known = peaks.filter(v => v !== null);
    if (known.length === 0)
        return [];
    let low, high;
    if (PERCENT_SERIES.includes(name)) {
        [low, high] = [0, 100];
    } else {
        low = Math.min(...known);
        high = Math.max(...known);
        const minRange = SPARKLINE_MIN_RANGE[name] ?? 1;
        if (high - low < minRange) {
            const mid = (high + low) / 2;
            low = mid - minRange / 2;
            high = mid + minRange / 2;
        }
        low -= (high - low) / 3;
    }
    const left = width - slots * step + gap;
    const bars = [];
    peaks.forEach((v, slot) => {
        if (v === null)
            return;
        const fraction = Math.max(0, Math.min(1, (v - low) / (high - low)));
        const h = Math.max(1, Math.round(fraction * height));
        bars.push({x: left + slot * step, y: height - h, width: barWidth, height: h, level: levelOf(v)});
    });
    return bars;
}

/** The point runs of a single-color sparkline over the whole span. */
export function sparklineSegments(history, name, width, height) {
    return sparklinePieces(history, name, width, height).map(p => p.points);
}

// ---- panel layout -----------------------------------------------------------

/**
 * Everything the top bar can show, in the default order. `series` is the
 * history a segment can draw as a graph; `show` its on/off setting.
 */
export const PANEL_ITEMS = Object.freeze([
    {id: 'cpu', label: 'CPU temperature', show: 'show-cpu', series: 'cpu-celsius'},
    {id: 'gpu', label: 'GPU temperature', show: 'show-gpu', series: 'gpu-celsius'},
    {id: 'cpu-usage', label: 'CPU usage', show: 'show-cpu-usage', series: 'cpu-usage'},
    {id: 'gpu-usage', label: 'GPU usage', show: 'show-gpu-usage', series: 'gpu-usage'},
    {id: 'fan', label: 'Fan speed', show: 'show-fans', series: null},
    {id: 'power', label: 'Power draw', show: 'show-power', series: 'battery-watts'},
    {id: 'profile', label: 'Power profile', show: 'show-profile', series: null},
]);

/** Every known item once, in the stored order, unknown ids dropped, new ones last. */
export function normalizeOrder(stored) {
    const ids = PANEL_ITEMS.map(item => item.id);
    const kept = [...new Set(stored ?? [])].filter(id => ids.includes(id));
    return [...kept, ...ids.filter(id => !kept.includes(id))];
}

/** `order` with `id` moved by `delta` places (clamped). */
export function moveItem(order, id, delta) {
    const out = normalizeOrder(order);
    const from = out.indexOf(id);
    if (from < 0)
        return out;
    const to = Math.max(0, Math.min(out.length - 1, from + delta));
    out.splice(to, 0, ...out.splice(from, 1));
    return out;
}

/**
 * A color setting ("#rgb", "#rrggbb", "rgb(…)", "rgba(…)") as [r, g, b] in
 * 0–1 for Cairo; null when empty or unreadable (use the theme color).
 */
export function parseColor(text) {
    const value = (text ?? '').trim().toLowerCase();
    let m = value.match(/^#([0-9a-f]{3})$/);
    if (m)
        return [...m[1]].map(c => parseInt(c + c, 16) / 255);
    m = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (m)
        return m.slice(1).map(h => parseInt(h, 16) / 255);
    m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,[^)]*)?\)$/);
    if (m)
        return m.slice(1, 4).map(n => Math.min(255, Number(n)) / 255);
    return null;
}

/** Bar graph widths in pixels. */
export const GRAPH_WIDTHS = Object.freeze({narrow: 30, medium: 45, wide: 70});

export function formatPercent(percent) {
    if (percent === null || percent === undefined || !Number.isFinite(percent))
        return '--';
    return `${Math.round(percent)}%`;
}

/** "1.4 GHz · max 3.8 GHz", or null without a reading. */
export function formatClock(usage) {
    if (usage.averageGhz === null || usage.maxGhz === null)
        return null;
    return `${usage.averageGhz.toFixed(1)} GHz · max ${usage.maxGhz.toFixed(1)} GHz`;
}

/** -1 (heliosd's "unknown") and garbage become null. */
function known(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Power source, battery and GPU draw (API v2), CPU draw (API v3). An older
 * heliosd lacks some or all of these: missing draws are null, the source is
 * 'unknown' and there is no battery.
 */
export function powerFromDbus({GpuPower, CpuPower, PowerSource, Battery} = {}) {
    const [gpuValid = false, gpuWatts = 0] = GpuPower ?? [];
    const [cpuValid = false, cpuWatts = 0] = CpuPower ?? [];
    const [name = '', state = 'unknown', percent, watts, health, cycles, minutesLeft] = Battery ?? [];
    return {
        source: PowerSource || 'unknown',
        gpuWatts: gpuValid ? known(gpuWatts) : null,
        cpuWatts: cpuValid ? known(cpuWatts) : null,
        battery: name ? {
            name,
            state,
            percent: known(percent),
            watts: known(watts),
            health: known(health),
            // Many firmwares report 0 forever, which says nothing.
            cycles: cycles > 0 ? cycles : null,
            minutesLeft: known(minutesLeft),
        } : null,
    };
}

/** 24.46 -> "24.5 W", 112.4 -> "112 W". */
export function formatWatts(watts) {
    if (watts === null || watts === undefined || !Number.isFinite(watts))
        return '--';
    return watts < 100 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
}

/** 172 -> "2 h 52 min", 45 -> "45 min". */
export function formatDuration(minutes) {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0)
        return '--';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')} min`;
}

const BATTERY_STATES = Object.freeze({
    'charging': 'Charging',
    'discharging': 'Discharging',
    'full': 'Full',
    'not-charging': 'Not charging',
});

export function batteryStateLabel(state) {
    return BATTERY_STATES[state] ?? 'Unknown';
}

/**
 * Panel text: the draw on battery, "AC" on mains, null when the machine
 * reports no power source (nothing to show).
 */
export function powerPanelText(power) {
    switch (power.source) {
    case 'battery':
        return formatWatts(power.battery?.watts ?? null);
    case 'ac':
        return 'AC';
    default:
        return null;
    }
}

/** The title of the collapsed Usage menu: "Usage · CPU 23% · GPU 4%". */
export function usageSummary(usage) {
    const parts = ['Usage'];
    if (usage.cpu !== null)
        parts.push(`CPU ${formatPercent(usage.cpu)}`);
    if (usage.gpu !== null)
        parts.push(`GPU ${formatPercent(usage.gpu)}`);
    return parts.join(' · ');
}

/** The title of the collapsed Power menu: "Power · AC · 80%" or "Power · 64% · 18.2 W". */
export function powerSummary(power) {
    const parts = ['Power'];
    const battery = power.battery;
    if (power.source === 'ac')
        parts.push('AC');
    if (battery?.percent !== null && battery?.percent !== undefined)
        parts.push(`${Math.round(battery.percent)}%`);
    if (power.source === 'battery' && battery?.watts !== null && battery?.watts !== undefined)
        parts.push(formatWatts(battery.watts));
    return parts.join(' · ');
}

export function profileFromDbus({Available, Active, Choices, Driver} = {}) {
    return {
        available: Available === true,
        current: Active || null,
        choices: Choices ?? [],
        driver: Driver || null,
    };
}

/** The CPU reading: the user's sensor if it still exists, else heliosd's pick. */
export function pickCpu(sensors, overrideId) {
    const hit = overrideId ? sensors.temperatures.find(t => t.id === overrideId) : null;
    return hit ? hit.celsius : sensors.cpu.celsius;
}

/**
 * The GPU reading as {state: 'on'|'off'|'none', celsius}. An override is a
 * hwmon id from Temperatures; anything else (including the old
 * 'nvidia-smi' value) means heliosd's own choice.
 */
export function pickGpu(sensors, overrideId) {
    const hit = overrideId ? sensors.temperatures.find(t => t.id === overrideId) : null;
    if (hit)
        return {state: 'on', celsius: hit.celsius};
    return {state: sensors.gpu.state, celsius: sensors.gpu.celsius};
}

/** Text for the states where there is nothing to show. */
export function daemonMessage(state) {
    switch (state) {
    case 'not-running':
        return {
            panel: 'helios off',
            menu: 'heliosd is not running',
            hint: 'Find out why with: heliosctl doctor',
        };
    case 'connecting':
        return {panel: '--', menu: 'Connecting to heliosd…', hint: ''};
    default:
        return null;
    }
}

/** User-facing text for a SetProfile failure (error name without prefix). */
export function setProfileError(name, message) {
    switch (name) {
    case 'NotAuthorized':
        return 'Not authorized to change the profile';
    case 'InvalidArgument':
        return 'The firmware does not offer that profile';
    case 'Unavailable':
        return 'This machine has no platform profile';
    case 'NotRunning':
        return 'heliosd is not running';
    default:
        return message || 'Could not change the profile';
    }
}

// ---------------------------------------------------------------- lighting

/** Colour presets offered for the keyboard and the logo, in menu order. */
export const LIGHT_COLORS = Object.freeze([
    {name: 'Red', color: '#ff0000'},
    {name: 'Orange', color: '#ff6000'},
    {name: 'Yellow', color: '#ffd000'},
    {name: 'Green', color: '#00ff00'},
    {name: 'Cyan', color: '#00ffff'},
    {name: 'Blue', color: '#0000ff'},
    {name: 'Purple', color: '#8000ff'},
    {name: 'Pink', color: '#ff00a0'},
    {name: 'White', color: '#ffffff'},
]);

const EFFECT_LABELS = Object.freeze({
    breathing: 'Breathing',
    neon: 'Neon',
    wave: 'Wave',
    shifting: 'Shifting',
    zoom: 'Zoom',
    static: 'Static',
});

/** Effects whose colour the keyboard shows (neon and wave cycle colours). */
export const EFFECTS_WITH_COLOR = Object.freeze(['breathing', 'shifting', 'zoom']);
/** Effects that move in a direction. */
export const EFFECTS_WITH_DIRECTION = Object.freeze(['wave', 'shifting']);

/** The effects heliosd can set (its Effects property says the same). */
export const KEYBOARD_EFFECTS = Object.freeze(['breathing', 'neon', 'wave', 'shifting', 'zoom']);

/** Used when the keyboard shows something Helios cannot set. */
const KEYBOARD_DEFAULT = Object.freeze({
    effect: 'wave', speed: 4, brightness: 100, direction: 'right', color: '#ffffff',
});

export function effectLabel(id) {
    return EFFECT_LABELS[id] ?? 'Other';
}

/** The Lighting interface; `available` is false without the module or on an older heliosd. */
export function lightingFromDbus({Effects, Directions, Keyboard, Logo} = {}) {
    if (!Array.isArray(Keyboard) || !Array.isArray(Logo))
        return {available: false, effects: [], directions: [], keyboard: null, logo: null};
    const [effect, speed, brightness, direction, color] = Keyboard;
    const [on, logoBrightness, logoColor] = Logo;
    return {
        available: true,
        effects: Effects ?? [],
        directions: Directions ?? [],
        keyboard: {effect, speed, brightness, direction, color},
        logo: {on, brightness: logoBrightness, color: logoColor},
    };
}

function clamp(value, max) {
    return Math.max(0, Math.min(max, Math.round(value)));
}

/**
 * The SetKeyboardEffect arguments for changing `change` on top of the
 * current state. Anything the current state cannot provide (an effect
 * Helios cannot set, an unknown direction) falls back to a default.
 */
export function keyboardRequest(current, change, effects = KEYBOARD_EFFECTS) {
    const base = {...KEYBOARD_DEFAULT};
    if (current) {
        // The speed of an effect Helios cannot set means nothing for ours.
        if (effects.includes(current.effect)) {
            base.effect = current.effect;
            if (Number.isFinite(current.speed))
                base.speed = clamp(current.speed, 9);
        }
        if (Number.isFinite(current.brightness))
            base.brightness = clamp(current.brightness, 100);
        if (current.direction === 'left' || current.direction === 'right')
            base.direction = current.direction;
        if (/^#[0-9a-f]{6}$/i.test(current.color ?? '') && current.color !== '#000000')
            base.color = current.color;
    }
    const next = {...base, ...change};
    return [next.effect, clamp(next.speed, 9), clamp(next.brightness, 100), next.direction, next.color];
}

/**
 * The SetLogo arguments. Turning the logo on at brightness 0, or in black,
 * would show nothing, so those become full brightness and white.
 */
export function logoRequest(current, change) {
    const next = {on: false, brightness: 100, color: '#ffffff', ...current, ...change};
    let brightness = clamp(next.brightness, 100);
    let color = /^#[0-9a-f]{6}$/i.test(next.color ?? '') ? next.color : '#ffffff';
    if (next.on && brightness === 0)
        brightness = 100;
    if (next.on && color === '#000000')
        color = '#ffffff';
    return [next.on === true, brightness, color];
}

export function lightingError(name, message) {
    switch (name) {
    case 'NotAuthorized':
        return 'Not authorized to change the lighting';
    case 'InvalidArgument':
        return 'The keyboard does not accept that setting';
    case 'Unavailable':
        return 'Keyboard lighting is not available (see: heliosctl doctor)';
    case 'NotRunning':
        return 'heliosd is not running';
    default:
        return message || 'Could not change the lighting';
    }
}
