// SPDX-License-Identifier: GPL-3.0-or-later
// Pure helpers: no GNOME imports, so they can be unit-tested with node.

export const Level = Object.freeze({
    UNKNOWN: 'unknown',
    NORMAL: 'normal',
    WARM: 'warm',
    HOT: 'hot',
});

/** hwmon reports millidegrees Celsius. */
export function milliToCelsius(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return null;
    return value / 1000;
}

/** First line of `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`. */
export function parseNvidiaSmiTemp(output) {
    const line = String(output ?? '').trim().split('\n')[0]?.trim() ?? '';
    if (!/^-?\d+(\.\d+)?$/.test(line))
        return null;
    return Number.parseFloat(line);
}

/** Keeps warm < hot no matter what the user typed. */
export function sanitizeThresholds(warm, hot) {
    let w = Number.isFinite(warm) ? warm : 75;
    let h = Number.isFinite(hot) ? hot : 90;
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

/**
 * How often the NVIDIA GPU may be queried. Every `nvidia-smi` call resets the
 * GPU's runtime-PM idle timer, so polling faster than the autosuspend delay
 * would keep a sleeping-capable GPU awake forever. The interval is therefore
 * at least twice that delay (plus a second), and never below the user's own
 * minimum or the panel refresh rate.
 */
export function gpuQueryInterval(refreshSec, userMinSec, autosuspendMs) {
    const fromDelay = Number.isFinite(autosuspendMs) && autosuspendMs > 0
        ? Math.ceil((autosuspendMs * 2) / 1000) + 1
        : 0;
    return Math.max(refreshSec || 1, userMinSec || 1, fromDelay);
}

export function clampInt(value, min, max) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n))
        return min;
    return Math.min(max, Math.max(min, n));
}
