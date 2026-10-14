// SPDX-License-Identifier: GPL-3.0-or-later
// Live sensor readers built on the pure discovery logic in core/hwmon.js.

import {
    milliToCelsius, parseSensorId, resolveAmdGpuSensor, resolveCpuSensor,
    resolveFans, scanHwmon, findTemp, listTemperatureSensors as listFromFs,
} from '../core/index.js';
import {NvidiaGpu} from './nvidia.js';
import {readInt, sysfs} from './sysfs.js';

export const NVIDIA_SMI_ID = 'nvidia-smi';

/** Used by the preferences window to fill the sensor dropdowns. */
export function listTemperatureSensors() {
    return listFromFs(sysfs);
}

/** Re-resolves after a failed read: hwmon numbering can change on resume. */
class HwmonTemp {
    constructor(resolve) {
        this._resolve = resolve;
        this.sensor = resolve(scanHwmon(sysfs));
    }

    read() {
        let milli = this.sensor ? readInt(this.sensor.path) : null;
        if (milli === null) {
            this.sensor = this._resolve(scanHwmon(sysfs));
            milli = this.sensor ? readInt(this.sensor.path) : null;
        }
        return milliToCelsius(milli);
    }

    describe() {
        return this.sensor ? `${this.sensor.chip} / ${this.sensor.label}` : 'none';
    }
}

export class CpuSensor {
    constructor(id = '') {
        this._temp = new HwmonTemp(chips => resolveCpuSensor(chips, id));
    }

    read() {
        return this._temp.read();
    }

    describe() {
        return this._temp.describe();
    }
}

/**
 * GPU temperature from, in order: the sensor the user picked, an AMD hwmon
 * sensor, or the NVIDIA GPU through nvidia-smi (power-aware).
 */
export class GpuSensor {
    constructor({id = '', allowWake = false, refreshSec = 2, minIntervalSec = 10} = {}) {
        this._hw = null;
        this._nvidia = null;
        const nvidiaOptions = {allowWake, refreshSec, minIntervalSec};

        const wanted = parseSensorId(id);
        if (wanted) {
            this._hw = new HwmonTemp(chips => findTemp(chips, wanted.chip, wanted.label));
        } else if (id === NVIDIA_SMI_ID) {
            this._nvidia = NvidiaGpu.detect(nvidiaOptions);
        } else {
            const amd = new HwmonTemp(resolveAmdGpuSensor);
            if (amd.sensor)
                this._hw = amd;
            else
                this._nvidia = NvidiaGpu.detect(nvidiaOptions);
        }
    }

    get available() {
        return this._hw !== null || this._nvidia !== null;
    }

    /** @returns {Promise<{state: 'on'|'off'|'none', celsius: number|null}>} */
    async read(cancellable) {
        if (this._hw)
            return {state: 'on', celsius: this._hw.read()};
        if (this._nvidia)
            return this._nvidia.read(cancellable);
        return {state: 'none', celsius: null};
    }

    describe() {
        if (this._hw)
            return this._hw.describe();
        if (this._nvidia)
            return `nvidia-smi (every ${this._nvidia.queryIntervalSec}s, ${this._nvidia.powerStatus() ?? '?'})`;
        return 'none';
    }

    destroy() {
        this._nvidia?.destroy();
    }
}

export class FanSensor {
    constructor() {
        this._fans = resolveFans(scanHwmon(sysfs));
    }

    /** @returns {{label: string, rpm: number|null}[]} */
    read() {
        return this._fans.map(f => ({label: f.label, rpm: readInt(f.path)}));
    }

    get available() {
        return this._fans.length > 0;
    }
}
