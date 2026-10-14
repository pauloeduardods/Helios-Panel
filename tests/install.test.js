// SPDX-License-Identifier: GPL-3.0-or-later
// install.sh in a throwaway tree. PATH holds only basic tools plus fakes of
// sudo, systemctl, busctl, gnome-extensions and glib-compile-schemas, so a
// test can never reach the real ones. Run via: npm test
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'install.sh');
const UUID = 'helios-panel@paulo';
const BASIC_TOOLS = [
    'bash', 'env', 'install', 'mkdir', 'rmdir', 'rm', 'find', 'sort', 'dirname',
    'mktemp', 'grep', 'sed', 'cat', 'touch', 'printf',
];

let t; // per-test paths

function write(file, content, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content, {mode});
}

function fake(name, body) {
    write(path.join(t.fakes, name), `#!/bin/bash\necho "${name} $*" >> "${t.log}"\n${body}\n`, 0o755);
}

beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'helios-install-'));
    t = {
        base,
        root: path.join(base, 'root'),
        home: path.join(base, 'home'),
        fakes: path.join(base, 'fakes'),
        tools: path.join(base, 'tools'),
        bins: path.join(base, 'bins'),
        log: path.join(base, 'calls.log'),
    };
    t.dataHome = path.join(t.home, '.local/share');
    t.extDir = path.join(t.dataHome, 'gnome-shell/extensions', UUID);
    t.manifest = path.join(t.root, 'usr/local/share/helios-panel/install-manifest');

    // A system that already has the usual directories, plus unrelated files
    // that must survive. /usr/local/libexec and the user's extensions
    // directory do not exist yet, so install has to create (and later remove) them.
    for (const dir of ['etc/systemd/system', 'usr/share/dbus-1/system.d', 'usr/share/dbus-1/system-services',
        'usr/share/polkit-1/actions', 'usr/local/bin', 'usr/local/share'])
        fs.mkdirSync(path.join(t.root, dir), {recursive: true});
    write(path.join(t.root, 'usr/share/dbus-1/system.d/org.other.conf'), '<busconfig/>\n');
    write(path.join(t.root, 'usr/local/bin/other-tool'), '#!/bin/sh\n', 0o755);
    write(path.join(t.dataHome, 'other-app/data'), 'keep me\n');

    write(path.join(t.bins, 'heliosd'), '#!/bin/sh\necho heliosd\n', 0o755);
    write(path.join(t.bins, 'heliosctl'), '#!/bin/sh\necho heliosctl\n', 0o755);

    fs.mkdirSync(t.tools);
    for (const tool of BASIC_TOOLS)
        fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`]).toString().trim(), path.join(t.tools, tool));

    fake('sudo', '[[ "$1" == -v ]] && exit 0; exec "$@"');
    fake('systemctl', 'exit 0');
    fake('busctl', '[[ "$1" == --system ]] && echo \'s "0.2.0"\'; exit 0');
    fake('gnome-extensions', 'exit 0');
    fake('glib-compile-schemas', 'touch "$1/gschemas.compiled"');
    fake('cargo', 'exit 1');
});

afterEach(() => fs.rmSync(t.base, {recursive: true, force: true}));

function run(args = [], {sudo = '', env = {}} = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
            PATH: `${t.fakes}:${t.tools}`,
            HOME: t.home,
            XDG_DATA_HOME: t.dataHome,
            HELIOS_ROOT: t.root,
            HELIOS_BIN_DIR: t.bins,
            ...(sudo === null ? {} : {HELIOS_SUDO: sudo}),
            ...env,
        },
    });
    return {...result, calls: fs.existsSync(t.log) ? fs.readFileSync(t.log, 'utf8').trim().split('\n') : []};
}

/** Every path under base with its type, mode and content. */
function snapshot() {
    const out = {};
    const walk = dir => {
        for (const name of fs.readdirSync(dir).sort()) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            const key = path.relative(t.base, p);
            if (st.isDirectory()) {
                out[key] = `dir ${(st.mode & 0o777).toString(8)}`;
                walk(p);
            } else {
                out[key] = `file ${(st.mode & 0o777).toString(8)} ${fs.readFileSync(p, 'utf8')}`;
            }
        }
    };
    walk(t.root);
    walk(t.home);
    return out;
}

const mode = p => (fs.statSync(p).mode & 0o777).toString(8);

test('install puts every file in place with the right modes', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(path.join(t.root, 'usr/local/libexec/heliosd')), '755');
    assert.equal(mode(path.join(t.root, 'usr/local/bin/heliosctl')), '755');
    assert.equal(mode(path.join(t.root, 'etc/systemd/system/heliosd.service')), '644');
    assert.equal(
        fs.readFileSync(path.join(t.root, 'usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy'), 'utf8'),
        fs.readFileSync(path.join(REPO, 'data/io.github.pauloeduardods.helios.policy'), 'utf8'));
    assert.ok(fs.existsSync(path.join(t.root, 'usr/share/dbus-1/system.d/io.github.pauloeduardods.Helios1.conf')));
    assert.ok(fs.existsSync(path.join(t.root,
        'usr/share/dbus-1/system-services/io.github.pauloeduardods.Helios1.service')));
    assert.ok(fs.existsSync(path.join(t.extDir, 'metadata.json')));
    assert.ok(fs.existsSync(path.join(t.extDir, 'lib/client.js')));
    assert.ok(fs.existsSync(path.join(t.extDir, 'schemas/gschemas.compiled')));
    assert.equal(mode(path.join(t.extDir, 'extension.js')), '644');
    assert.match(r.stdout, /heliosd is running/);
});

test('install reloads systemd and D-Bus, restarts an old daemon and enables the extension', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.includes('systemctl daemon-reload'));
    assert.ok(r.calls.some(c => c.startsWith('busctl call org.freedesktop.DBus') && c.endsWith('ReloadConfig')));
    assert.ok(r.calls.includes('systemctl try-restart heliosd.service'));
    assert.ok(r.calls.includes(`gnome-extensions enable ${UUID}`));
    assert.ok(!r.calls.some(c => c.startsWith('cargo')), 'prebuilt binaries were used');
});

test('uninstall restores the tree exactly', () => {
    const before = snapshot();
    assert.equal(run().status, 0);
    assert.notDeepEqual(snapshot(), before);
    const r = run(['--uninstall']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(), before);
    assert.ok(r.calls.includes('systemctl stop heliosd.service'));
    assert.ok(r.calls.includes(`gnome-extensions disable ${UUID}`));
});

test('installing twice upgrades in place, and uninstall still restores the tree', () => {
    const before = snapshot();
    assert.equal(run().status, 0);
    const first = snapshot();
    assert.equal(run().status, 0);
    assert.deepEqual(snapshot(), first, 'a reinstall gives the same tree');
    assert.equal(run(['--uninstall']).status, 0);
    assert.deepEqual(snapshot(), before);
});

test('the system part goes through sudo and the user part does not', () => {
    const r = run([], {sudo: null}); // HELIOS_SUDO unset: the real default, "sudo"
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.includes('sudo -v'), 'one password prompt up front');
    assert.ok(r.calls.some(c => c.startsWith('sudo install -m 755') && c.endsWith('usr/local/libexec/heliosd')));
    assert.ok(r.calls.includes('sudo systemctl daemon-reload'));
    assert.ok(!r.calls.some(c => c.startsWith('sudo') && c.includes(t.home)), 'never sudo in the home directory');
    assert.equal(fs.statSync(path.join(t.extDir, 'extension.js')).uid, process.getuid());
});

test('a file that install did not put there blocks the install, with nothing changed', () => {
    write(path.join(t.root, 'usr/local/bin/heliosctl'), 'someone else\n', 0o755);
    const before = snapshot();
    const r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usr\/local\/bin\/heliosctl already exists and was not installed by this script/);
    assert.deepEqual(snapshot(), before);
});

test('an earlier extension-only install is replaced', () => {
    write(path.join(t.extDir, 'metadata.json'), `{\n  "uuid": "${UUID}",\n  "name": "old"\n}\n`);
    write(path.join(t.extDir, 'lib/core/format.js'), 'old\n');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(t.extDir, 'lib/core')), 'old files are gone');
    assert.ok(fs.existsSync(path.join(t.extDir, 'lib/client.js')));
});

test('an unrelated extension directory under the same name is not taken over', () => {
    write(path.join(t.extDir, 'metadata.json'), '{\n  "uuid": "someone-else@example"\n}\n');
    const before = snapshot();
    const r = run();
    assert.notEqual(r.status, 0);
    assert.deepEqual(snapshot(), before);
});

test('a missing prerequisite stops before any change and prints the command', () => {
    fs.rmSync(path.join(t.fakes, 'glib-compile-schemas'));
    const before = snapshot();
    const r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /glib-compile-schemas is missing. Install it with: sudo apt install libglib2.0-bin/);
    assert.deepEqual(snapshot(), before);
});

test('without prebuilt binaries and without cargo, it says how to get Rust', () => {
    fs.rmSync(path.join(t.fakes, 'cargo'));
    const before = snapshot();
    const r = run([], {env: {HELIOS_BIN_DIR: ''}});
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cargo is missing. Install Rust with: curl/);
    assert.deepEqual(snapshot(), before);
});

test('uninstall with no manifest removes nothing', () => {
    write(path.join(t.extDir, 'metadata.json'), `{"uuid": "${UUID}"}\n`);
    const before = snapshot();
    const r = run(['--uninstall']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing to uninstall/);
    assert.deepEqual(snapshot(), before);
});

test('uninstall keeps files the user added and the directories holding them', () => {
    assert.equal(run().status, 0);
    const mine = path.join(t.root, 'usr/local/libexec/my-own-tool');
    write(mine, 'mine\n');
    const r = run(['--uninstall']);
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(mine));
    assert.ok(!fs.existsSync(path.join(t.root, 'usr/local/libexec/heliosd')));
    assert.match(r.stderr, /kept .*usr\/local\/libexec \(not empty\)/);
});

test('install.sh never touches kernel modules, boot configuration or /sys', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8')
        .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
    for (const forbidden of ['modprobe', 'insmod', 'rmmod', 'initramfs', 'grub', 'sysctl', '/sys/', '/etc/modprobe'])
        assert.ok(!script.includes(forbidden), `install.sh mentions ${forbidden}`);
});
