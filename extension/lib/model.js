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

/**
 * Polylines for one series in a width × height box (y grows down): the
 * newest sample on the right edge, the span's start on the left, one run of
 * [x, y] points per stretch without gaps. Empty when there is no reading.
 */
export function sparklineSegments(history, name, width, height) {
    const values = history?.series[name] ?? [];
    const known = values.filter(v => v !== null);
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
    const x = age => (1 - Math.min(age, HISTORY_SPAN_S) / HISTORY_SPAN_S) * width;

    const segments = [];
    let run = [];
    values.forEach((v, i) => {
        if (v === null) {
            if (run.length)
                segments.push(run);
            run = [];
        } else {
            run.push([x(history.ages[i]), y(v)]);
        }
    });
    if (run.length)
        segments.push(run);
    return segments;
}

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
