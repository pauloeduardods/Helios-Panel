// SPDX-License-Identifier: GPL-3.0-or-later
// GLib implementation of the filesystem adapter the pure core modules expect.
// sysfs files are tiny and served from memory, so synchronous reads are fine
// even inside gnome-shell; anything slow (processes, D-Bus) is async elsewhere.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

export function readInt(path) {
    const text = readText(path);
    if (text === null)
        return null;
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) ? n : null;
}

export function listDir(path) {
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return [];
    }
    const names = [];
    let name;
    while ((name = dir.read_name()) !== null)
        names.push(name);
    dir.close();
    return names.sort();
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

export function isWritable(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'access::can-write', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_boolean('access::can-write');
    } catch {
        return false;
    }
}

/**
 * Writes a sysfs attribute in place. Not GLib.file_set_contents or
 * Gio.File.replace_contents: those write a temp file and rename it, which
 * sysfs does not allow. Errors from the driver (e.g. -EINVAL) are thrown.
 */
export function writeText(path, text) {
    const stream = Gio.File.new_for_path(path).open_readwrite(null);
    try {
        stream.get_output_stream().write_all(encoder.encode(text), null);
    } finally {
        stream.close(null);
    }
}

/** The adapter object the core modules take. */
export const sysfs = Object.freeze({readText, listDir, exists, isWritable});
