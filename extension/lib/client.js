// SPDX-License-Identifier: GPL-3.0-or-later
// HeliosClient: the extension's only link to the hardware. It watches
// heliosd on the system bus, keeps proxies for its interfaces and reports
// one of three states: 'connecting', 'running' or 'not-running'.
// No timers, no sysfs, no subprocesses, never root.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {powerFromDbus, profileFromDbus, sensorsFromDbus} from './model.js';

export const BUS_NAME = 'io.github.pauloeduardods.Helios1';
export const OBJECT_PATH = '/io/github/pauloeduardods/Helios1';
const IFACE = 'io.github.pauloeduardods.Helios1';
const ERROR_PREFIX = `${IFACE}.Error.`;

/** Polkit may show a password prompt, so this call can take a while. */
const SET_PROFILE_TIMEOUT_MS = 120000;

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
            sensors: sensorsFromDbus(p ? cachedProps(p.sensors, ['Cpu', 'Gpu', 'Fans', 'Temperatures']) : {}),
            power: powerFromDbus(p ? cachedProps(p.sensors, ['GpuPower', 'CpuPower', 'PowerSource', 'Battery']) : {}),
            profile: profileFromDbus(p ? cachedProps(p.profile, ['Available', 'Active', 'Choices', 'Driver']) : {}),
        };
    }

    /** Rejects with a HeliosError. */
    async setProfile(id) {
        const proxy = this._proxies?.profile;
        if (!proxy)
            throw new HeliosError('NotRunning', 'heliosd is not running');
        try {
            await new Promise((resolve, reject) => {
                proxy.call('SetProfile', new GLib.Variant('(s)', [id]), Gio.DBusCallFlags.NONE,
                    SET_PROFILE_TIMEOUT_MS, this._cancellable, (_proxy, result) => {
                        try {
                            resolve(proxy.call_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
        } catch (e) {
            throw toHeliosError(e);
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
            for (const proxy of Object.values(this._proxies)) {
                const id = proxy.connect('g-properties-changed', () => this._onChange());
                this._signalIds.push([proxy, id]);
            }
            this._setState('running');
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
