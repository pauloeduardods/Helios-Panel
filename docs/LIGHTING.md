# Keyboard and logo lighting: research and plan

> **Status: plan, waiting for approval.** Nothing in this document has been
> implemented, and nothing has written to the lighting hardware yet. Every
> fact below comes from reading files: the firmware's ACPI tables, and the
> source of two community drivers.

## Summary

- The PHN16-72 drives its 4-zone keyboard RGB through Acer's gaming WMI
  interface. Its ACPI firmware implements four lighting methods. The
  firmware code itself (below) is the authoritative description, and it
  corrects two details that the community drivers got wrong.
- The firmware has a **second lighting target, `LB`**, with its own effect,
  colour and brightness. It may be the lid logo, or a rear light bar from a
  sibling model that shares this firmware. It stays disabled until we
  confirm what it is.
- Linux cannot reach these methods from user space, and mainline `acer-wmi`
  (checked against the current tree) does not implement keyboard RGB. Helios
  therefore needs a kernel module. The recommendation is a **small module of
  our own** that binds only to this WMI device, calls only the four lighting
  methods, and coexists with the mainline `acer_wmi` driver, instead of
  replacing `acer_wmi` with a fork.
- heliosd gets a `Lighting` D-Bus interface behind a new polkit action, and
  the extension gets a lighting section. The decisions that need your
  approval are listed [at the end](#decisions-for-approval).

## Hardware facts (PHN16-72, BIOS V1.20)

| Fact | Value | How it was found |
|---|---|---|
| Gaming WMI device | GUID `7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56`, object `BH` (method `WMBH`), in SSDT13 | `/sys/bus/wmi/devices`, `iasl -d` |
| Driver bound to it | none: mainline `acer_wmi` calls it through the legacy API without binding | `driver` link missing in sysfs |
| Device path | `/sys/devices/pci0000:00/PNP0C14:00/wmi_bus/wmi_bus-PNP0C14:00/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56` | `readlink -f` |
| Separate RGB chips | none: no ENEK5130 I2C-HID, no Sunrex (`05af`), Darfon (`0d62`) or Chicony keyboard (`04f2:0117`); the only Chicony device is the webcam (`04f2:b76f`) | `/sys/class/hidraw`, `lsusb` |
| Keyboard zones | 4 (EC registers `KB1R`…`KB4B`) | SSDT13 + DSDT EC fields |
| Secure Boot | enabled | `mokutil --sb-state` |
| Kernel headers, DKMS | installed (7.0.0-38-generic, dkms 3.0.11) | `dpkg -l` |

## The protocol, from the firmware

`WMBH(instance, method, buffer)` dispatches on the method number. Every
lighting method writes **only** lighting registers in the embedded
controller (EC). The table lists the methods Helios would use.

### Method 20 (`0x14`): set an effect

Input: a 16-byte buffer.

| Byte | Meaning | Values (as the firmware handles them) |
|---|---|---|
| 0 | effect | 0 static, 1 breathing, 2 neon, 3 wave, 4 shifting, 5 zoom (6 meteor and 7 twinkling are seen in the Windows app only, unconfirmed). `0xFF` = keep the current value |
| 1 | speed | 0–9; `0xFF` = keep |
| 2 | brightness | 0–100; `0xFF` = keep |
| 3, 4 | direction | byte 4 is the direction (1 right-to-left, 2 left-to-right). The firmware does **not** write it when byte 3 is `0x08` and byte 4 is `0` |
| 5–7 | red, green, blue | 0–255 |
| 8 | stored state (`KLES`/`LLES`) | stored as-is and returned by method 21; its meaning is unknown |
| 9 | **target** | `1` keyboard; `2` the `LB` target; **any other value** writes the keyboard and also sets a "sync" flag (`KLSY = 1`) |
| 10–15 | unused | 0 |

Output: 4 status bytes, always 0.

### Method 21 (`0x15`): read an effect

Input: 1 (keyboard) or 2 (`LB`). Output: 16 bytes: `[0]` status, `[1]`
effect, `[2]` speed, `[3]` brightness, `[4]` `0xFF`, `[5]` direction,
`[6..8]` RGB, `[9]` the stored state from byte 8 above.

### Method 6: set one zone's static colour

Input: at least 4 bytes; the 8-byte form is read the same way.

| Byte 0 | Then |
|---|---|
| `0x01`, `0x02`, `0x04` or `0x08` | bytes 1–3 are the R, G, B of zone 1, 2, 3 or 4 |
| `0x00` and byte 4 = `1` | byte 5 = `1` or `2` sets `LB1` or `LB2` to R, G, B (the `LB` target's two colours) |
| anything else | rejected: status 1, nothing written |

Only one zone is written per call: a mask such as `0x03` is rejected. A
static per-zone layout is applied as method 20 with effect 0 (static) and
the brightness, then method 6 once per zone.

### Method 7: read the zone colours

This is the read-back counterpart of method 6, with the same zone masks.

### Corrections to the community drivers

Both predator-sense (`facer.c`, `rgb.rs`) and Linuwu-Sense (both GPL-3)
implement the same methods. Their descriptions are only partly right.

- Both treat byte 9 of method 20 as an "enable flag, must be 1". **It is the
  target selector.** Sending anything other than 1 or 2 is not rejected:
  it silently turns on keyboard sync.
- They disagree on byte 8 (3 or 0). The firmware only stores it, so both
  work. Helios will send 0 and read it back.
- They disagree on method 6's argument size (a 4-byte buffer or an 8-byte
  integer). The firmware reads the same first bytes from either.

No code from either project is used. The protocol here is described from
the firmware's own ASL.

### Methods Helios will never call

| Method | What the firmware does | Why it is excluded |
|---|---|---|
| 2 | turbo-key LED (`TKST`), keyboard on/off (`KBST`), `LB` state (`LBST`) | it overlaps with the turbo key; not needed |
| 10–13 | other `LB*` fields (`LBET`, `LBLR/G/B`, `LBLT`, `LBLF`) of unknown meaning | unknown semantics |
| 14, 16, 22 and the others | fans, misc settings | out of scope: never fans, never the EC beyond lighting |

The module will not even contain the numbers of the excluded methods. The
same EC block also holds `GPUM` (GPU MUX), which no lighting method touches.

## The `LB` target: lid logo or light bar?

Evidence so far:

- The firmware has full effect support (method 20/21 target 2) and two
  static colours (`LB1`, `LB2`) for `LB`.
- predator-sense found a rear **light bar** under similar firmware on the
  PH16-72 (the non-Neo Helios 16), and none of its lid-logo support goes
  through WMI. This firmware may simply be shared with that model.
- The EC field names do not say "logo" or "bar".

How we settle it, in order:

1. **You look** at the laptop: does the lid logo light up at all, and has it
   ever changed colour (for example under Windows with PredatorSense)? Is
   there any light strip on the back or front edge?
2. **REA on PredatorSense**, if you approve it: the Windows app's per-model
   configuration should say which lighting devices the PHN16-72 has.
3. **One supervised write**, only after your explicit approval: set `LB` to
   a single static colour through method 20 target 2 while you watch, then
   set it back. Reading (method 21) cannot settle it, because it returns the
   EC registers whether or not an LED is connected.

Until then, logo support stays out of the D-Bus API.

## Getting the calls into the kernel

| Option | What it means | Verdict |
|---|---|---|
| Mainline `acer-wmi` | has no keyboard RGB | not available |
| predator-sense `facer.ko` / `linuwu_sense.ko` | forks of the whole `acer_wmi` driver: they **replace** it (mainline must be blacklisted) and add fan, EC-raw-mode and battery code | rejected: replaces the driver behind the platform profile, far beyond our scope |
| `acpi_call` | lets user space run any ACPI method | rejected: an arbitrary-firmware-call interface |
| **New module `helios-acer-lighting`** | a WMI driver bound to `7A4DDFE7-…` that coexists with mainline `acer_wmi` and only implements methods 6, 7, 20 and 21 | **recommended** |
| Upstream (`acer-wmi` LED class) | the long-term home | later: propose upstream once ours is proven |

### The module

- About 300 lines, in `kmod/helios-acer-lighting/`, licensed
  **GPL-2.0-or-later** (kernel modules must be GPL-2-compatible, and this is
  compatible with the project's GPL-3.0-or-later).
- It binds only on the WMI GUID above **and** a DMI allow-list (to start,
  only "Predator PHN16-72"). On any other machine it does not load.
- It exposes a tiny sysfs interface on the WMI device. Each write is one
  complete, validated operation, and the kernel rejects anything else with
  `-EINVAL` without calling the firmware:

  | Attribute | Write | Firmware calls |
  |---|---|---|
  | `keyboard_effect` | `<effect> <speed> <brightness> <direction> <rrggbb>`, e.g. `breathing 4 80 right ff0000` | method 20, target 1 |
  | `keyboard_zones` | `<brightness> <rrggbb> <rrggbb> <rrggbb> <rrggbb>` | method 20 (static) + 4 × method 6 |

  Reading the same attributes returns the current state (methods 21 and 7).
  Effects 6 and 7, and the `LB` target, are not accepted until confirmed.
- The files are root-only (0644 root:root). heliosd's sandbox gets
  `ReadWritePaths` for exactly these two attribute files, the same pattern as
  the platform profile.
- **Secure Boot is on**, so the module must be signed. With DKMS that means
  a one-time Machine Owner Key enrolment: DKMS creates a key, you set a
  one-time password, and on the next boot the blue "MOK manager" screen asks
  you to confirm it. That is the only boot-time step, and it is reversible
  (`mokutil --delete`).
- Per the project rules, **Helios never loads it**. `install.sh` does not
  touch it. `heliosctl doctor` gains a check that detects whether the module
  is built, signed and loaded, and **prints** the `dkms install` / `modprobe`
  commands for you to run.

## heliosd: the `Lighting` interface

`io.github.pauloeduardods.Helios1.Lighting` is exported only when the
module's sysfs files exist.

| Member | Type | Meaning |
|---|---|---|
| `Capabilities` | `a{sv}` | `targets` `as` (`["keyboard"]`), `zones` `u` (4), `effects` `as`, `speed` `(uu)` (0, 9), `brightness` `(uu)` (0, 100), `directions` `as` |
| `Keyboard` | `a{sv}` | current state, read back from the module: `effect`, `speed`, `brightness`, `direction`, `color`, `zones` |
| `SetKeyboardEffect(s effect, u speed, u brightness, s direction, s color)` | method | one effect and colour for the whole keyboard (`color` is `#rrggbb`) |
| `SetKeyboardZones(as colors, u brightness)` | method | 4 static zone colours |

The order of checks is the same as `SetProfile`: validate first (an invalid
argument never reaches polkit), then polkit
**`io.github.pauloeduardods.helios.set-lighting`** (`allow_active=yes`,
`allow_inactive=no`, `allow_any=no`: the worst case is a wrong colour), then
one serialized write to the module, then read back and emit
`PropertiesChanged`.

The EC is expected to lose these settings on power-off (PredatorSense
re-applies them at login). heliosd saves the last applied state in its
`StateDirectory` (`/var/lib/heliosd`) and re-applies it when it starts and
after resume (logind `PrepareForSleep(false)`).

## Extension

- **Menu**: a "Lighting" section with an on/off switch, a brightness slider,
  a row of colour presets, and an effect submenu.
- **Preferences**: a "Lighting" page with the effect, speed, direction, and
  four colour buttons for the zones.
- Both appear only when `Capabilities` lists a target, and they follow the
  same daemon-not-running rules as the rest of the panel.

## Test plan

| Layer | Tests |
|---|---|
| helios-core (pure) | payload builders produce exact bytes for every effect, direction and zone; every out-of-range value is rejected; byte 9 is always 1 for the keyboard; `0xFF` ("keep") is never produced; exhaustive checks over the full input ranges |
| kernel module | built in CI against the runner's kernel headers with `-Werror`, plus `checkpatch.pl`; KUnit tests for its parser (the same accept/reject table as helios-core) |
| heliosd | private-bus integration tests with a fake sysfs tree for the module's files: valid calls write exactly the expected line; invalid ones never reach polkit; polkit denial writes nothing; the interface is absent without the module; state is restored at start |
| extension | fake proxy: section hidden without capabilities; controls call the right method with the right arguments; error messages |
| real hardware | a written protocol, run only with you present: (1) read-only state dump; (2) one zone, one colour; (3) all zones; (4) each effect; (5) the `LB` probe, only if approved. Stop at the first surprise |

## Safety summary

| Risk | Mitigation |
|---|---|
| A wrong value reaches the EC | validated in helios-core, again in heliosd and again in the kernel module; the firmware itself rejects unknown zone masks |
| Calling the wrong method | the module only contains methods 6, 7, 20 and 21; fans, misc settings, the MUX and raw EC are impossible by construction |
| Byte 9 side effect (keyboard sync) | always sent as exactly 1, enforced and tested at every layer |
| Breaking the platform profile | mainline `acer_wmi` stays untouched; the module only adds a driver for a GUID nothing else binds |
| Running on another model | DMI allow-list in the module |
| A boot problem from the module | it is an ordinary loadable module, not in the initramfs, not loaded by Helios; `sudo modprobe -r helios_acer_lighting` or `dkms remove` undoes it |

The worst realistic outcome is a wrong keyboard colour until the next write.

## Decisions for approval

1. **Kernel path**: write our own minimal `helios-acer-lighting` module
   (recommended), rather than using predator-sense/Linuwu-Sense or waiting
   for upstream.
2. **Secure Boot**: accept the one-time MOK enrolment for a DKMS-signed
   module.
3. **Scope of the first version**: the keyboard only (effects 0–5 and the 4
   static zones). `LB`/logo comes later, after it is identified.
4. **The `LB` question**: answer what you see on the laptop (step 1 above),
   and say whether to run REA on PredatorSense (step 2).
5. **D-Bus API and polkit action** as described above.
6. **First hardware write**: only through the written test protocol, with
   you present.
