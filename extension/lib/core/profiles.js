// Platform-profile names as the Linux kernel exposes them, and how they map to
// what PredatorSense calls them on Acer Predator laptops (acer-wmi with
// predator_v4=1). Pure module: no GNOME imports.

/** tier: 0 = most economical ... 5 = most powerful (drives the colour). */
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

/** Naming styles offered in the preferences. */
export const NAME_STYLES = ['predator', 'portuguese', 'linux'];

export function profileLabel(id, style = 'predator') {
    if (!id)
        return '--';
    const info = PROFILE_INFO[id];
    if (!info || style === 'linux')
        return id;
    return style === 'portuguese' ? info.pt : info.predator;
}

export function profileTier(id) {
    return PROFILE_INFO[id]?.tier ?? null;
}

/** Default colour per tier; null = theme colour. */
export const TIER_COLORS = Object.freeze([
    '#62a0ea', // 0 eco
    '#8ff0a4', // 1 quiet
    null, //      2 balanced
    '#ffbe6f', // 3 performance
    '#f66151', // 4 turbo
    '#f66151', // 5 max
]);

export function profileColor(id) {
    const tier = profileTier(id);
    return tier === null ? null : TIER_COLORS[tier] ?? null;
}

/** Parses the space-separated `platform_profile_choices` file. */
export function parseChoices(text) {
    if (!text)
        return [];
    return text.trim().split(/\s+/).filter(Boolean);
}

/** Sorts choices from most economical to most powerful (unknown ones last). */
export function sortChoices(choices) {
    return [...choices].sort((a, b) => (profileTier(a) ?? 99) - (profileTier(b) ?? 99));
}

// power-profiles-daemon (the "Power mode" switch in Ubuntu Settings) only
// knows three profiles. These are what it can reach without root.
export const PPD_PROFILES = Object.freeze(['power-saver', 'balanced', 'performance']);

export const PPD_LABELS = Object.freeze({
    'power-saver': 'Power Saver',
    'balanced': 'Balanced',
    'performance': 'Performance',
});

/** Which PPD profile a platform profile belongs to (for the menu check mark). */
export function ppdForPlatform(id) {
    switch (id) {
    case 'low-power':
    case 'cool':
    case 'quiet':
        return 'power-saver';
    case 'balanced':
    case 'custom':
        return 'balanced';
    case 'balanced-performance':
    case 'performance':
    case 'max-power':
        return 'performance';
    default:
        return null;
    }
}
