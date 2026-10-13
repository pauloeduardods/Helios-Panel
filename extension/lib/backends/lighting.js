// Lighting backends: the extension point for keyboard / lid-logo RGB.
//
// Nothing here talks to hardware yet. On the PHN16-72 the keyboard RGB goes
// through Acer's gaming WMI interface (no ENEK5130 / Sunrex HID chip on this
// model), which needs root. A backend must therefore NOT write to hardware
// from gnome-shell: it should call a small privileged helper (a system D-Bus
// service with a polkit check and a fixed, validated set of actions). See
// docs/ARCHITECTURE.md for the plan and the reverse-engineering checklist.

/**
 * @typedef {object} LightingCapabilities
 * @property {('keyboard'|'logo'|'lightbar')[]} targets
 * @property {number} zones           keyboard zones (0 if per-key or none)
 * @property {string[]} effects        e.g. ['static', 'breathing', 'wave']
 * @property {boolean} brightness
 * @property {boolean} speed
 * @property {boolean} direction
 */

/**
 * @typedef {object} LightingState
 * @property {'keyboard'|'logo'|'lightbar'} target
 * @property {string} effect
 * @property {string[]} colors         '#rrggbb', one per zone (or one for all)
 * @property {number} [brightness]     0-100
 * @property {number} [speed]          0-100
 * @property {'left'|'right'} [direction]
 */

/** Base class every lighting backend extends. */
export class LightingBackend {
    /** Short id, e.g. 'acer-wmi-gaming'. */
    get id() {
        throw new Error('not implemented');
    }

    /** Name shown in the menu. */
    get displayName() {
        return this.id;
    }

    /** Resolves true when this machine has the hardware and the helper. */
    async probe() {
        return false;
    }

    /** @returns {LightingCapabilities} */
    capabilities() {
        return {targets: [], zones: 0, effects: [], brightness: false, speed: false, direction: false};
    }

    /** @param {LightingState} _state */
    async apply(_state) {
        throw new Error('not implemented');
    }

    /** Current state if the hardware can report it, else null. */
    async read(_target) {
        return null;
    }

    destroy() {}
}

/**
 * Register real backends here, most specific first, e.g.
 *   import {AcerWmiGamingBackend} from './acerWmiGaming.js';
 *   const BACKENDS = [() => new AcerWmiGamingBackend()];
 */
const BACKENDS = [];

/** First backend whose probe() succeeds, or null. */
export async function detectLightingBackend() {
    for (const make of BACKENDS) {
        const backend = make();
        try {
            if (await backend.probe())
                return backend;
        } catch (e) {
            console.warn(`[helios-panel] lighting backend ${backend.id} probe failed: ${e.message}`);
        }
        backend.destroy();
    }
    return null;
}
