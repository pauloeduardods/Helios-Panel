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

const GLib = {Error: GLibError, Variant, VariantType: class {}};
export default GLib;
