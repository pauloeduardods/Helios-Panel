// SPDX-License-Identifier: GPL-3.0-or-later
// A fake system bus for lib/client.js. Tests drive it through
// globalThis.FAKE_BUS (see tests/client.test.js):
//   appear() / vanish()        heliosd claims or loses its name
//   props[iface][name]          cached property values
//   proxies[iface]              the proxies the client created
//   calls                       method calls made through any proxy
//   callError                   GLib.Error the next call fails with
//   failProxies                 make proxy creation fail
import GLib from './GLib.mjs';

class FakeProxy {
    constructor(iface) {
        this.iface = iface;
        this.handlers = new Map();
        this.nextId = 1;
    }

    get_cached_property(name) {
        const value = globalThis.FAKE_BUS.props[this.iface]?.[name];
        return value === undefined ? null : new GLib.Variant('?', value);
    }

    connect(signal, handler) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, handler});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    emit(signal) {
        for (const h of this.handlers.values()) {
            if (h.signal === signal)
                h.handler();
        }
    }

    call(method, params, _flags, timeout, _cancellable, callback) {
        const bus = globalThis.FAKE_BUS;
        bus.calls.push({iface: this.iface, method, params, timeout});
        const error = bus.callError;
        bus.callError = null;
        queueMicrotask(() => callback(this, {error}));
    }

    call_finish(result) {
        if (result.error)
            throw result.error;
        return null;
    }
}

let nextWatch = 1;

const Gio = {
    BusType: {SYSTEM: 'system'},
    BusNameWatcherFlags: {AUTO_START: 1},
    DBusProxyFlags: {NONE: 0},
    DBusCallFlags: {NONE: 0},
    Cancellable: class {
        cancel() {
            this.cancelled = true;
        }
    },
    DBusNodeInfo: {
        new_for_xml: () => ({lookup_interface: name => ({name})}),
    },
    DBusProxy: {
        new(_conn, _flags, info, _name, _path, iface, _cancellable, callback) {
            queueMicrotask(() => {
                const bus = globalThis.FAKE_BUS;
                if (bus.failProxies) {
                    callback(null, {error: new GLib.Error('no such interface')});
                    return;
                }
                const proxy = new FakeProxy(iface);
                bus.proxies[iface] = proxy;
                callback(null, {proxy, info});
            });
        },
        new_finish(result) {
            if (result.error)
                throw result.error;
            return result.proxy;
        },
    },
    DBusError: {
        get_remote_error: e => e.remoteName ?? null,
        strip_remote_error(e) {
            e.message = e.message.replace(/^GDBus\.Error:[^:]+:\s*/, '');
        },
    },
    bus_watch_name(type, name, flags, onAppeared, onVanished) {
        const id = nextWatch++;
        Object.assign(globalThis.FAKE_BUS, {
            watch: {id, type, name, flags},
            appear: () => onAppeared({fake: 'connection'}, name, ':1.1'),
            vanish: () => onVanished(null, name),
        });
        return id;
    },
    bus_unwatch_name(id) {
        globalThis.FAKE_BUS.unwatched.push(id);
    },
};
export default Gio;
