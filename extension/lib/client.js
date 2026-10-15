// SPDX-License-Identifier: GPL-3.0-or-later
// HeliosClient: the extension's only link to the hardware. It watches
// heliosd on the system bus, keeps proxies for its interfaces and reports
// one of three states: 'connecting', 'running' or 'not-running'. It also
// keeps the recent history: one GetHistory call on connect, then every
// Sensors update is appended.
// No timers, no sysfs, no subprocesses, never root.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    HistoryBuffer, historySample, powerFromDbus, profileFromDbus, sensorsFromDbus, usageFromDbus,
} from './model.js';

export const BUS_NAME = 'io.github.pauloeduardods.Helios1';
export const OBJECT_PATH = '/io/github/pauloeduardods/Helios1';
const IFACE = 'io.github.pauloeduardods.Helios1';
const ERROR_PREFIX = `${IFACE}.Error.`;

/** Polkit may show a password prompt, so this call can take a while. */
const SET_PROFILE_TIMEOUT_MS = 120000;

/** GetHistory only copies memory; anything slower is a stuck daemon. */
const HISTORY_TIMEOUT_MS = 2000;

const INTROSPECTION = `
<node>
  <interface name="${IFACE}.Daemon">
    <property name="Version" type="s" access="read"/>
    <property name="ApiVersion" type="u" access="read"/>
  </interface>
  <interface name="${IFACE}.Sensors">
    <property name="Cpu" type="(sbd)" access="read"/>
    <property name="Gpu" type="(ssbd)" access="read"/>
    <property name="Fans" type="a(si)" access="read"/>
    <property name="Temperatures" type="a(sssd)" access="read"/>
    <property name="GpuPower" type="(bd)" access="read"/>
    <property name="CpuPower" type="(bd)" access="read"/>
    <property name="CpuUsage" type="(bd)" access="read"/>
    <property name="CpuFrequency" type="(bdd)" access="read"/>
    <property name="GpuUsage" type="(bd)" access="read"/>
    <property name="Devices" type="a(ssd)" access="read"/>
    <method name="GetHistory">
      <arg name="ages" type="ad" direction="out"/>
      <arg name="series" type="a(sabad)" direction="out"/>
    </method>
    <property name="PowerSource" type="s" access="read"/>
    <property name="Battery" type="(ssdddii)" access="read"/>
  </interface>
  <interface name="${IFACE}.Profile">
    <property name="Available" type="b" access="read"/>
    <property name="Active" type="s" access="read"/>
    <property name="Choices" type="as" access="read"/>
    <property name="Driver" type="s" access="read"/>
    <method name="SetProfile">
      <arg name="profile" type="s" direction="in"/>
    </method>
  </interface>
</node>`;

const PROXIES = Object.freeze({daemon: 'Daemon', sensors: 'Sensors', profile: 'Profile'});

let nodeInfo = null;
function interfaceInfo(name) {
    nodeInfo ??= Gio.DBusNodeInfo.new_for_xml(INTROSPECTION);
    return nodeInfo.lookup_interface(`${IFACE}.${name}`);
}

function newProxy(connection, name, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new(
            connection, Gio.DBusProxyFlags.NONE, interfaceInfo(name),
            BUS_NAME, OBJECT_PATH, `${IFACE}.${name}`, cancellable,
            (_source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** Monotonic seconds. */
function now() {
    return GLib.get_monotonic_time() / 1e6;
}

function cachedProps(proxy, names) {
    const out = {};
    for (const name of names)
        out[name] = proxy?.get_cached_property(name)?.deepUnpack();
    return out;
}

/** A failed SetProfile: `name` is the heliosd error without its prefix. */
export class HeliosError extends Error {
    constructor(name, message) {
        super(message);
        this.name = name;
    }
}

function toHeliosError(e) {
    const remote = e instanceof GLib.Error ? Gio.DBusError.get_remote_error(e) : null;
    if (remote?.startsWith(ERROR_PREFIX)) {
        Gio.DBusError.strip_remote_error(e);
        return new HeliosError(remote.slice(ERROR_PREFIX.length), e.message);
    }
    return new HeliosError('Failed', e.message);
}

export class HeliosClient {
    /** @param {() => void} onChange called on every state or property change */
    constructor(onChange) {
        this._onChange = onChange;
        this._state = 'connecting';
        this._proxies = null;
        this._signalIds = [];
        this._generation = 0;
        this._history = new HistoryBuffer();
        this._cancellable = new Gio.Cancellable();
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SYSTEM, BUS_NAME, Gio.BusNameWatcherFlags.AUTO_START,
            connection => this._onAppeared(connection),
            () => this._onVanished());
    }

    get state() {
        return this._state;
    }

    /** Everything heliosd currently publishes, as plain objects. */
    snapshot() {
        const p = this._proxies;
        return {
            state: this._state,
            version: p ? cachedProps(p.daemon, ['Version']).Version ?? null : null,
            sensors: sensorsFromDbus(p ? cachedProps(p.sensors, ['Cpu', 'Gpu', 'Fans', 'Temperatures', 'Devices']) : {}),
            usage: usageFromDbus(p ? cachedProps(p.sensors, ['CpuUsage', 'CpuFrequency', 'GpuUsage']) : {}),
            power: powerFromDbus(p ? cachedProps(p.sensors, ['GpuPower', 'CpuPower', 'PowerSource', 'Battery']) : {}),
            profile: profileFromDbus(p ? cachedProps(p.profile, ['Available', 'Active', 'Choices', 'Driver']) : {}),
        };
    }

    _call(proxy, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, timeoutMs, this._cancellable,
                (_proxy, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /** Rejects with a HeliosError. */
    async setProfile(id) {
        const proxy = this._proxies?.profile;
        if (!proxy)
            throw new HeliosError('NotRunning', 'heliosd is not running');
        try {
            await this._call(proxy, 'SetProfile', new GLib.Variant('(s)', [id]), SET_PROFILE_TIMEOUT_MS);
        } catch (e) {
            throw toHeliosError(e);
        }
    }

    /** The recent history as {ages, series} (see HistoryBuffer.view). */
    historyView() {
        return this._history.view(now());
    }

    /**
     * Fills the history from heliosd. An older heliosd (before API v5) has
     * no GetHistory: the history then starts empty and grows from here.
     */
    async _loadHistory(proxy, generation) {
        try {
            const reply = await this._call(proxy, 'GetHistory', null, HISTORY_TIMEOUT_MS);
            if (generation === this._generation) {
                this._history.load(reply?.deepUnpack(), now());
                this._onChange();
            }
        } catch {
            // Keep what was appended meanwhile.
        }
    }

    async _onAppeared(connection) {
        const generation = ++this._generation;
        try {
            const entries = await Promise.all(Object.entries(PROXIES).map(
                async ([key, name]) => [key, await newProxy(connection, name, this._cancellable)]));
            if (generation !== this._generation)
                return; // vanished or destroyed meanwhile
            this._dropProxies();
            this._proxies = Object.fromEntries(entries);
            for (const [key, proxy] of Object.entries(this._proxies)) {
                const id = proxy.connect('g-properties-changed', () => {
                    if (key === 'sensors')
                        this._history.push(now(), historySample(this.snapshot()));
                    this._onChange();
                });
                this._signalIds.push([proxy, id]);
            }
            this._history.clear();
            this._setState('running');
            this._loadHistory(this._proxies.sensors, generation);
        } catch (e) {
            if (generation !== this._generation)
                return;
            console.error('[helios-panel] could not connect to heliosd:', e.message);
            this._dropProxies();
            this._setState('not-running');
        }
    }

    _onVanished() {
        this._generation++;
        this._history.clear();
        this._dropProxies();
        this._setState('not-running');
    }

    _setState(state) {
        this._state = state;
        this._onChange();
    }

    _dropProxies() {
        for (const [proxy, id] of this._signalIds)
            proxy.disconnect(id);
        this._signalIds = [];
        this._proxies = null;
    }

    destroy() {
        this._generation++;
        this._cancellable.cancel();
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._dropProxies();
        this._onChange = () => {};
    }
}
