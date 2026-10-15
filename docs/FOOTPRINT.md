# Footprint audit

Milestone 6: what Helios costs on the machine it watches, and what was done about it. Measured on the PHN16-72 (i9-14900HX, 32 threads, RTX 4070, GNOME on X11) on 2026-10-15 with [`tools/footprint.sh`](../tools/footprint.sh). The budgets that came out of it are in [ARCHITECTURE.md](ARCHITECTURE.md#footprint-budgets).

## Results

| What | Before | After | Budget |
|---|---|---|---|
| heliosd CPU, own (bench, 6 × 90 s rounds, alternating) | 0.27 % of one core | **0.16 %** | < 0.2 % |
| Files opened per poll (strace, real sysfs) | ≈171, plus 36 directory listings | **≈85**, 1 listing (plus a full rescan every 30 s) | CI: ≤ 32 reads and 1 listing on the fixture |
| Syscalls per poll | ≈790 | **≈430** | |
| Wall time of one poll | ≈25 ms | **≈4 ms** (the drives are read on 1 poll in 15) | |
| NVMe SMART reads | 4 every 2 s | **2 every 30 s** | one per drive per 30 s |
| heliosd resident memory | 5.3 MB, flat | **4.8 MB**, flat | < 8 MB, flat |
| heliosd binary | 4.5 MB | **2.3 MB** (heliosctl 0.6 MB) | |
| D-Bus signals | 1 per 2 s tick | 1 per 2 s tick | ≤ 1 per tick, only on change |
| nvidia-smi | every 10 s while the GPU is awake, ≈25 ms CPU each (≈0.25 %) | unchanged | never wakes the GPU; ≤ 1 per 10 s |
| gnome-shell CPU with the extension vs without | +0.68 % of one core | not measured: see below | |

`bench` CPU numbers vary by about ±0.05 % between rounds (CPU frequency, other load); that is why the rounds alternate the two builds. Syscall and file counts are exact.

### The installed build, live

`tools/footprint.sh live 120` after installing this branch, with the desktop in use:

| What | Over 120 s |
|---|---|
| heliosd CPU, own | 0.29 s (0.24 %) |
| heliosd CPU, nvidia-smi runs | 0.39 s (0.33 %) |
| heliosd resident memory | 4.9 → 5.0 MB |
| heliosd context switches | 1.0/s |
| D-Bus PropertiesChanged signals | 0.49/s |
| NVIDIA GPU awake | 120 of 120 s (held by Xorg and another app, not heliosd) |

Live own CPU is above the bench figure because the installed daemon runs as root and also reads RAPL and the Acer EC, which the bench copy cannot; it was 0.40 % live before this branch.

The extension's cost after the change could not be measured: the on/off run (`tools/footprint.sh extension 60`) came out at −1.2 % because gnome-shell was busy with other work at the time (≈7 % overall against ≈0.5–1 % idle), far more noise than the extension's share. The extension changes only remove work (fewer restyles, no menu updates while closed); re-run the measurement on an idle desktop to put a number on it.

## What was found

1. **heliosd rediscovered every sensor every 2 s.** Each poll listed `/sys/class/hwmon` and every chip, read each chip's `name` and every `*_label`, the drives' `model`, the type of every power supply, and listed the RAPL and cpufreq directories. None of that changes between polls.
2. **The two NVMe drives were the slowest thing read.** A drive's temperature is a SMART log page: a command to the drive that takes 1.7–8 ms and brings it out of its low-power state (APST). Four of them every 2 s also kept the SSDs from idling, which costs battery.
3. **Some inputs were read twice per poll** (the CPU sensor and the drives are also in the full temperature list).
4. **Every file read asked for its size first** (`statx`), which sysfs does not know anyway.
5. **The Acer EC (WMI) is the expensive cheap read:** ≈0.12 ms of CPU per value, five values per poll. They stay at 2 s: the fans and an EC sensor picked as the GPU must stay fresh. This is most of the remaining heliosd cost.
6. **The NVIDIA GPU never sleeps on this machine, but not because of Helios:** on X11 the Xorg server keeps `/dev/nvidia*` open. heliosd's rule (never wake a sleeping GPU) holds; because the card is always awake, it runs nvidia-smi every 10 s, and those runs cost more CPU than heliosd itself. Under Wayland, or with the display on the iGPU only, the card sleeps and nvidia-smi is not run.
7. **The extension redrew everything on every update:** markup and style on every top-bar segment, and every label of the menu while the menu was closed. Setting a style or markup makes gnome-shell restyle and lay out the actor again, even when the value is the same.

## What changed

- **Discovery is cached** (`helios-core/src/status.rs`): found once, found again every 30 s (`RESCAN_INTERVAL`), or on the next poll when an input that read before stops reading (a driver reload, hwmon renumbering). Inputs that never read (some drivers return EIO for good) do not trigger rescans. The battery, AC adapter, RAPL packages and cpufreq policies are cached the same way.
- **Drive temperatures are read every 30 s** (`STORAGE_READ_INTERVAL`), keeping the last value in between.
- **Each input is read once per poll.**
- **Reads skip the size probe** (`helios-sys`): one syscall fewer per file.
- **Release builds use LTO, one codegen unit and strip.**
- **The extension** applies only what changed to the top bar (style, markup, graph width), does not update the menu while it is closed (opening it renders it first), and builds the D-Bus snapshot once per change instead of once per caller.
- **CI guards** (`cargo test`): a steady poll lists one directory, reads no discovery file and no file twice, and stays within 32 reads on the PHN16-72 fixture; drive temperatures are read once per 30 s; a vanished sensor triggers a rescan and a dead one does not; the extension's snapshot is shared until something changes.

## Not done

- **Exit when nobody listens** (D-Bus activation would start heliosd again on demand). The extension is always connected while you are logged in, so it would save nothing in normal use.
- **Polling less often on battery or while locked.** The extension is disabled on the lock screen anyway; a slower battery interval is a reasonable next step if battery tests show heliosd matters.
- **NVML instead of nvidia-smi.** Keeping NVML open holds `/dev/nvidia*` and would stop the GPU from sleeping (the reason nvidia-smi is run fresh each time); opening it per query costs about the same as nvidia-smi.

## How to measure

```bash
tools/footprint.sh live 120                   # the installed heliosd and gnome-shell, read-only
tools/footprint.sh bench target/release/heliosd 120   # a copy on a private session bus, own CPU only
tools/footprint.sh extension 60               # gnome-shell with the extension on, then off (the panel disappears for a minute)
```
