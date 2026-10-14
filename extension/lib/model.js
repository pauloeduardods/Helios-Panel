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
export function sensorsFromDbus({Cpu, Gpu, Fans, Temperatures} = {}) {
    const [cpuId = '', cpuValid = false, cpuC = 0] = Cpu ?? [];
    const [gpuSource = '', gpuState = 'none', gpuValid = false, gpuC = 0] = Gpu ?? [];
    return {
        cpu: {sensor: cpuId || null, celsius: cpuValid ? cpuC : null},
        gpu: {source: gpuSource || null, state: gpuState, celsius: gpuValid ? gpuC : null},
        fans: (Fans ?? []).map(([label, rpm]) => ({label, rpm: rpm < 0 ? null : rpm})),
        temperatures: (Temperatures ?? []).map(([id, chip, label, celsius]) => ({id, chip, label, celsius})),
    };
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
