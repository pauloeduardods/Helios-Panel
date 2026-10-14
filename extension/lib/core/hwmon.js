// SPDX-License-Identifier: GPL-3.0-or-later
// Sensor discovery over /sys/class/hwmon. Pure: every filesystem access goes
// through an injected adapter `fs` = {readText(path), listDir(path)} so it can
// be tested against a fake tree in node and run against GLib in the shell.

export const HWMON_ROOT = '/sys/class/hwmon';

/** Stable id that survives reboots (hwmonN numbers do not). */
export function sensorId(chip, label) {
    return `hwmon:${chip}/${label}`;
}

export function parseSensorId(id) {
    const m = /^hwmon:([^/]+)\/(.+)$/.exec(id ?? '');
    return m ? {chip: m[1], label: m[2]} : null;
}

/**
 * Lists every hwmon chip with its temperature and fan inputs.
 * @returns {{dir: string, chip: string, temps: {label: string, path: string}[], fans: {label: string, path: string}[]}[]}
 */
export function scanHwmon(fs, root = HWMON_ROOT) {
    const chips = [];
    for (const entry of fs.listDir(root)) {
        const dir = `${root}/${entry}`;
        const chip = fs.readText(`${dir}/name`);
        if (!chip)
            continue;
        const files = fs.listDir(dir);
        const temps = [];
        const fans = [];
        for (const file of files) {
            let m = /^temp(\d+)_input$/.exec(file);
            if (m) {
                const label = fs.readText(`${dir}/temp${m[1]}_label`) || `temp${m[1]}`;
                temps.push({label, path: `${dir}/${file}`, index: Number(m[1])});
                continue;
            }
            m = /^fan(\d+)_input$/.exec(file);
            if (m) {
                const label = fs.readText(`${dir}/fan${m[1]}_label`) || `Fan ${m[1]}`;
                fans.push({label, path: `${dir}/${file}`, index: Number(m[1])});
            }
        }
        temps.sort((a, b) => a.index - b.index);
        fans.sort((a, b) => a.index - b.index);
        chips.push({dir, chip, temps, fans});
    }
    return chips;
}

/** Flat list for the preferences dropdown. */
export function listTemperatureSensors(fs, root = HWMON_ROOT) {
    const out = [];
    for (const c of scanHwmon(fs, root)) {
        for (const t of c.temps)
            out.push({id: sensorId(c.chip, t.label), chip: c.chip, label: t.label, path: t.path});
    }
    return out;
}

export function findTemp(chips, chip, label) {
    for (const c of chips) {
        if (c.chip !== chip)
            continue;
        const t = label === null ? c.temps[0] : c.temps.find(x => x.label === label);
        if (t)
            return {chip: c.chip, label: t.label, path: t.path};
    }
    return null;
}

// Preferred CPU package sensors, most specific first.
const CPU_CANDIDATES = [
    ['coretemp', 'Package id 0'], // Intel
    ['k10temp', 'Tctl'], //         AMD Ryzen
    ['k10temp', 'Tdie'],
    ['zenpower', 'Tdie'],
    ['coretemp', null],
    ['k10temp', null],
    ['acpitz', null], //            last resort: ACPI thermal zone
];

/** Resolves the CPU sensor: an explicit id, else the first known candidate. */
export function resolveCpuSensor(chips, id = '') {
    const wanted = parseSensorId(id);
    if (wanted) {
        const hit = findTemp(chips, wanted.chip, wanted.label);
        if (hit)
            return hit;
    }
    for (const [chip, label] of CPU_CANDIDATES) {
        const hit = findTemp(chips, chip, label);
        if (hit)
            return hit;
    }
    return null;
}

/**
 * AMD GPUs expose hwmon directly. With an AMD iGPU *and* dGPU both are
 * "amdgpu"; only the discrete card reports a "junction" sensor, so it wins.
 */
export function resolveAmdGpuSensor(chips) {
    const amd = chips.filter(c => c.chip === 'amdgpu' && c.temps.length > 0);
    if (amd.length === 0)
        return null;
    const discrete = amd.find(c => c.temps.some(t => t.label === 'junction')) ?? amd[0];
    const edge = discrete.temps.find(t => t.label === 'edge') ?? discrete.temps[0];
    return {chip: discrete.chip, label: edge.label, path: edge.path};
}

/** Fans: the Acer chip first (acer-wmi), else any chip that has fan inputs. */
export function resolveFans(chips) {
    const acer = chips.find(c => c.chip === 'acer' && c.fans.length > 0);
    if (acer)
        return acer.fans.map(f => ({label: f.label, path: f.path}));
    const any = chips.find(c => c.fans.length > 0);
    return any ? any.fans.map(f => ({label: f.label, path: f.path})) : [];
}

/** Finds the NVIDIA display controller's PCI directory, if any. */
export function findNvidiaPciDir(fs, root = '/sys/bus/pci/devices') {
    for (const entry of fs.listDir(root)) {
        const dir = `${root}/${entry}`;
        const vendor = fs.readText(`${dir}/vendor`);
        const cls = fs.readText(`${dir}/class`);
        // 0x0300xx = VGA controller, 0x0302xx = 3D controller
        if (vendor === '0x10de' && cls && /^0x030[02]/.test(cls))
            return dir;
    }
    return null;
}
