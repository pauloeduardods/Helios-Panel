// SPDX-License-Identifier: GPL-3.0-or-later
// Just enough of GLib for lib/client.js.
class GLibError extends Error {
    constructor(message, remoteName = null) {
        super(message);
        this.remoteName = remoteName;
    }
}

class Variant {
    constructor(type, value) {
        this.type = type;
        this.value = value;
    }

    deepUnpack() {
        return this.value;
    }
}

const GLib = {
    Error: GLibError,
    Variant,
    VariantType: class {},
    // Tests set globalThis.FAKE_NOW_S to control time.
    get_monotonic_time: () => (globalThis.FAKE_NOW_S ?? 0) * 1e6,
};
export default GLib;
