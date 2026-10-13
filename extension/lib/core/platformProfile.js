// Reading the ACPI platform profile and deciding how it can be changed.
// Pure: filesystem access goes through the injected adapter
// `fs` = {readText(path), listDir(path), exists(path), isWritable(path)}.

import {parseChoices, sortChoices} from './profiles.js';

export const LEGACY_PROFILE = '/sys/firmware/acpi/platform_profile';
export const LEGACY_CHOICES = '/sys/firmware/acpi/platform_profile_choices';
export const CLASS_ROOT = '/sys/class/platform-profile';

/**
 * Kernel 6.14+ also exposes one device per driver under
 * /sys/class/platform-profile/platform-profile-N/{name,choices,profile}.
 * Prefer the Acer one when there are several.
 */
export function findClassDevice(fs, root = CLASS_ROOT) {
    const devices = fs.listDir(root)
        .map(entry => ({dir: `${root}/${entry}`, name: fs.readText(`${root}/${entry}/name`) ?? ''}))
        .filter(d => fs.exists(`${d.dir}/profile`));
    if (devices.length === 0)
        return null;
    return devices.find(d => /acer/i.test(d.name)) ?? devices[0];
}

export function readProfileState(fs) {
    const device = findClassDevice(fs);
    const current = fs.readText(LEGACY_PROFILE) ?? (device ? fs.readText(`${device.dir}/profile`) : null);
    const choicesText = fs.readText(LEGACY_CHOICES) ?? (device ? fs.readText(`${device.dir}/choices`) : null);
    return {
        available: current !== null,
        current,
        choices: sortChoices(parseChoices(choicesText)),
        driver: device?.name ?? null,
    };
}

/**
 * A path this user may write directly (only after the optional udev rule from
 * the README), or null - then switching goes through power-profiles-daemon.
 */
export function writableProfilePath(fs) {
    const device = findClassDevice(fs);
    if (device && fs.isWritable(`${device.dir}/profile`))
        return `${device.dir}/profile`;
    if (fs.exists(LEGACY_PROFILE) && fs.isWritable(LEGACY_PROFILE))
        return LEGACY_PROFILE;
    return null;
}
