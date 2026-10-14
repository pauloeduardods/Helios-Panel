# Architecture

The code has one central rule: **the UI only draws**. Whatever talks to the hardware lives in separate layers, so new features (such as lighting) can be added without touching the panel.

```
extension/
├── extension.js            lifecycle: creates/removes the indicator and places it
├── prefs.js                settings window (libadwaita)
├── schemas/                settings (GSettings)
├── icons/                  symbolic panel icons
└── lib/
    ├── core/               PURE LOGIC - no GNOME imports at all
    │   ├── format.js         temperature levels, formatting, GPU interval
    │   ├── profiles.js       profile names, colors, mapping to PPD
    │   ├── hwmon.js          sensor discovery in /sys/class/hwmon
    │   └── platformProfile.js reading the profile and deciding how to switch it
    ├── sys/                SYSTEM ACCESS (GLib/Gio)
    │   ├── sysfs.js          file adapter used by core
    │   ├── sensors.js        CpuSensor, GpuSensor, FanSensor
    │   └── nvidia.js         nvidia-smi without waking the card
    ├── backends/           LAPTOP FEATURES
    │   ├── platform.js       power profile (direct sysfs or power-profiles-daemon)
    │   └── lighting.js       lighting extension point (still empty)
    └── ui/
        └── indicator.js      panel button and menu
```

## Why `core/` is pure

The `core/` modules take the filesystem as a parameter (`fs = {readText, listDir, exists, isWritable}`). In GNOME, that parameter is `sysfs.js`. In the tests, it is a fake in-memory tree that mimics a PHN16-72 or an AMD desktop. That way, the logic that decides which sensor to use runs under `npm test`, without GNOME or the laptop.

`tests/system.test.js` goes one step further: it replaces `gi://GLib` and `gi://Gio` with stubs and tests the `sys/` code against a fake `/sys` folder. That is what guarantees a suspended NVIDIA GPU is never woken up.

## Rules for code that runs inside gnome-shell

- **Nothing that blocks.** Reading sysfs files is instant and may be synchronous. Processes (such as `nvidia-smi`) and D-Bus calls must be asynchronous, with a timeout.
- **No root.** The extension runs inside your graphical session's process. Anything that needs privileges goes to a separate helper (see below).
- **Clean everything up in `disable()`:** timers, signals, processes. The indicator does this in `_cleanup`.

## Adding lighting (future)

On the PHN16-72, the keyboard RGB and the lid logo go through Acer's gaming WMI interface. This model has neither the ENEK5130 chip nor the Sunrex USB keyboard, so the direct `/dev/hidraw` path does not exist. Writing to that interface requires root. That is why the path has three parts:

```
indicator ──D-Bus──▶ privileged helper ──▶ WMI/ACPI or kernel module
(lighting.js)        (system service
                      + polkit rule)
```

### 1. Figure out the protocol

Before opening a disassembler, look at what already exists:
- `facer.c` from the [predator-sense](https://github.com/cleyton1986/predator-sense) project already implements the 4-zone keyboard over WMI (`ACER_CAP_GAMINGKB`, devices `/dev/acer-gkbbl*`). It is marked as tested on the PHN16-72. It is GPL-3: if code is copied, the extension must be GPL-3 too.
- Same method: Linuwu-Sense.

For whatever is missing (for example, the lid logo):
- **Dynamic (easier):** on Windows, with PredatorSense open, capture the WMI calls (ETW "WMI-Activity" tracing in Event Viewer) while changing colors. You see the method and the bytes sent.
- **Static:** open the PredatorSense lighting DLLs in Ghidra, directly or via REA, and look for the Acer WMI GUIDs (`7A4DDFE7-…`) and method numbers. The ACPI tables (`acpidump` + `iasl -d`) show what the firmware accepts.
- Always start testing with **reads**, and one write at a time.

### 2. The privileged helper

A small system service (Python or Rust) on the system D-Bus, with:
- a **closed** list of actions (`SetKeyboard(zones, effect, brightness)`, `SetLogo(...)`), with every value validated;
- its own polkit action. For lighting, `allow_active=yes` is acceptable, because the worst case is a wrong color. For fans, EC or the MUX switch, use `auth_admin`.
- **no** generic write ("write X to path Y") and no raw EC access. Those were predator-sense's weak points.

### 3. The backend in the extension

Create `lib/backends/acerWmiGaming.js` extending `LightingBackend`:
- `probe()`: is the helper on D-Bus and is the model supported?
- `capabilities()`: targets, zones, effects.
- `apply(state)`: calls the helper.

Register the class in the `BACKENDS` array in `lighting.js`. The indicator already calls `detectLightingBackend()` and creates the "Lighting" section in the menu when a backend responds. From there, it is just a matter of replacing the placeholder in `_updateLightingSection()` with real controls.
