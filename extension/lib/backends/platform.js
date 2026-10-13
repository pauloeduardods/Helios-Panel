// Platform (thermal/power) profile backend.
//
// Reading is always unprivileged. Changing it works two ways, best first:
//  1. direct sysfs write, only if the optional udev rule from the README made
//     the profile file writable for this user - gives all firmware profiles;
//  2. power-profiles-daemon over D-Bus, which any active local user may use
//     without a password - but it only knows power-saver/balanced/performance.
// The extension never asks for root itself.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {PPD_PROFILES, readProfileState, writableProfilePath} from '../core/index.js';
import {sysfs, writeText} from '../sys/sysfs.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const PPD_SERVICES = [
    {name: 'org.freedesktop.UPower.PowerProfiles', path: '/org/freedesktop/UPower/PowerProfiles',
        iface: 'org.freedesktop.UPower.PowerProfiles'},
    {name: 'net.hadess.PowerProfiles', path: '/net/hadess/PowerProfiles',
        iface: 'net.hadess.PowerProfiles'},
];

export const SwitchMode = Object.freeze({
    DIRECT: 'direct', // all firmware profiles
    PPD: 'ppd', //       the three power-profiles-daemon profiles
    NONE: 'none',
});

export class PlatformProfileBackend {
    constructor() {
        this._ppd = null; // resolved service, or false once known absent
    }

    /** {available, current, choices, driver} - cheap, call on every refresh. */
    state() {
        return readProfileState(sysfs);
    }

    /** Decides how the menu can switch profiles right now. */
    async switchMode() {
        if (writableProfilePath(sysfs))
            return SwitchMode.DIRECT;
        return (await this._findPpd()) ? SwitchMode.PPD : SwitchMode.NONE;
    }

    /** Sets a firmware profile directly (DIRECT mode only). */
    setPlatformProfile(profile) {
        const path = writableProfilePath(sysfs);
        if (!path)
            throw new Error('o arquivo do perfil não é gravável (veja a regra udev no README)');
        if (!this.state().choices.includes(profile))
            throw new Error(`perfil "${profile}" não é suportado pelo firmware`);
        writeText(path, profile);
    }

    /** Sets one of the three power-profiles-daemon profiles (PPD mode). */
    async setPpdProfile(profile) {
        if (!PPD_PROFILES.includes(profile))
            throw new Error(`perfil "${profile}" desconhecido`);
        const svc = await this._findPpd();
        if (!svc)
            throw new Error('power-profiles-daemon não está rodando');
        await Gio.DBus.system.call(
            svc.name, svc.path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [svc.iface, 'ActiveProfile', new GLib.Variant('s', profile)]),
            null, Gio.DBusCallFlags.NONE, 3000, null);
    }

    async _findPpd() {
        if (this._ppd !== null)
            return this._ppd || null;
        for (const svc of PPD_SERVICES) {
            try {
                const reply = await Gio.DBus.system.call(
                    'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                    'NameHasOwner', new GLib.Variant('(s)', [svc.name]),
                    new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 2000, null);
                if (reply.deepUnpack()[0]) {
                    this._ppd = svc;
                    return svc;
                }
            } catch (e) {
                console.warn(`[helios-panel] D-Bus lookup of ${svc.name} failed: ${e.message}`);
            }
        }
        this._ppd = false;
        return null;
    }
}
