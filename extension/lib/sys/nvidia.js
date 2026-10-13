// NVIDIA temperature without defeating runtime power management.
//
// The proprietary driver does not export hwmon temperatures, so the only
// source is `nvidia-smi` - and every call powers the GPU up if it was asleep
// (RTD3 / D3cold). So: look at the PCI runtime-PM status first, never call
// nvidia-smi on a suspended GPU unless the user allowed it, and space the
// calls further apart than the autosuspend delay so our own polling cannot
// keep the card awake.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {findNvidiaPciDir, gpuQueryInterval, parseNvidiaSmiTemp} from '../core/index.js';
import {readInt, readText, sysfs} from './sysfs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const QUERY_TIMEOUT_SEC = 4;

export class NvidiaGpu {
    /** Returns null when there is no NVIDIA GPU or no nvidia-smi. */
    static detect(options) {
        const pciDir = findNvidiaPciDir(sysfs);
        const smi = GLib.find_program_in_path('nvidia-smi');
        if (!pciDir || !smi)
            return null;
        return new NvidiaGpu(pciDir, smi, options);
    }

    constructor(pciDir, smi, {allowWake = false, refreshSec = 2, minIntervalSec = 10} = {}) {
        this.pciDir = pciDir;
        this._smi = smi;
        this._allowWake = allowWake;
        const autosuspendMs = readInt(`${pciDir}/power/autosuspend_delay_ms`);
        this.queryIntervalSec = gpuQueryInterval(refreshSec, minIntervalSec, autosuspendMs ?? undefined);
        this._lastQuery = -Infinity;
        this._lastTemp = null;
        this._proc = null;
    }

    /** 'active' | 'suspended' | 'suspending' | 'resuming' | 'unsupported' | null */
    powerStatus() {
        return readText(`${this.pciDir}/power/runtime_status`);
    }

    isAsleep() {
        const s = this.powerStatus();
        return s === 'suspended' || s === 'suspending' || s === 'resuming';
    }

    /** @returns {Promise<{state: 'on'|'off', celsius: number|null}>} */
    async read(cancellable) {
        if (this.isAsleep() && !this._allowWake) {
            this._lastTemp = null;
            return {state: 'off', celsius: null};
        }
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._proc || now - this._lastQuery < this.queryIntervalSec)
            return {state: 'on', celsius: this._lastTemp};

        this._lastQuery = now;
        this._lastTemp = await this._query(cancellable);
        return {state: 'on', celsius: this._lastTemp};
    }

    async _query(cancellable) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                [this._smi, '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`[helios-panel] nvidia-smi failed to start: ${e.message}`);
            return null;
        }
        this._proc = proc;
        let timedOut = false;
        let timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, QUERY_TIMEOUT_SEC, () => {
            timedOut = true;
            timerId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const [stdout] = await proc.communicate_utf8_async(null, cancellable);
            return timedOut ? null : parseNvidiaSmiTemp(stdout);
        } finally {
            if (timerId)
                GLib.source_remove(timerId);
            this._proc = null;
        }
    }

    destroy() {
        this._proc?.force_exit();
        this._proc = null;
    }
}
