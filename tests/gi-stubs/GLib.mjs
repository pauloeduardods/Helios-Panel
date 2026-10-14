// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
// Every absolute path is redirected under FAKE_SYS_ROOT.
const map = p => (globalThis.FAKE_SYS_ROOT ?? '') + p;
const GLib = {
    FileTest: {EXISTS: 1},
    SOURCE_REMOVE: false, SOURCE_CONTINUE: true, PRIORITY_DEFAULT: 0,
    file_get_contents(p) { return [true, new Uint8Array(fs.readFileSync(map(p)))]; },
    file_test(p) { return fs.existsSync(map(p)); },
    find_program_in_path(name) { return globalThis.FAKE_PROGRAMS?.[name] ?? null; },
    get_monotonic_time() { return (globalThis.FAKE_NOW_SEC ?? 0) * 1e6; },
    timeout_add_seconds() { return 1; },
    timeout_add() { return 1; },
    source_remove() {},
    Dir: {open(p) {
        const names = fs.readdirSync(map(p)); let i = 0;
        return {read_name: () => (i < names.length ? names[i++] : null), close() {}};
    }},
};
class GLibError extends Error {}
GLib.Error = GLibError;
export default GLib;
