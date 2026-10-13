import fs from 'node:fs';
const map = p => (globalThis.FAKE_SYS_ROOT ?? '') + p;
const Gio = {
    _promisify() {},
    SubprocessFlags: {STDOUT_PIPE: 1, STDERR_SILENCE: 2},
    FileQueryInfoFlags: {NONE: 0},
    Subprocess: {
        new(argv) {
            globalThis.FAKE_SPAWNS = (globalThis.FAKE_SPAWNS ?? 0) + 1;
            return {
                communicate_utf8_async: async () => [globalThis.FAKE_SMI_OUTPUT ?? '', ''],
                force_exit() {},
            };
        },
    },
    File: {new_for_path(p) {
        return {
            query_info() { return {get_attribute_boolean: () => (globalThis.FAKE_WRITABLE ?? []).includes(p)}; },
            open_readwrite() {
                return {get_output_stream: () => ({write_all: b => fs.writeFileSync(map(p), b)}), close() {}};
            },
        };
    }},
};
Gio.Subprocess.prototype = {};
Gio.DBusConnection = {prototype: {}};
export default Gio;
