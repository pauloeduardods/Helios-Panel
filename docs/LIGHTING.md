# Keyboard and logo lighting: research and plan

> **Status: plan approved on 2026-10-14** (see [the decisions](#decisions-for-approval)).
> Step 1, the kernel module, is implemented in
> [`kmod/helios-acer-lighting/`](../kmod/helios-acer-lighting/) and has not
> run on the hardware yet; the heliosd interface and the extension section
> come next. Every protocol fact below comes from reading files: the
> firmware's ACPI tables, and the source of two community drivers.

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
- **Observed on the machine** (2026-10-14): the lid logo is RGB and there is
  no light strip. On Linux the logo stays off, except that it lights up
  briefly when the platform profile changes with the lid open. That happens
  under Windows too, and there it seems to stay on and changes colour. So
  the firmware drives the logo by itself, and `LB` is very likely the logo.

How we settle it, in order:

1. ~~**You look** at the laptop.~~ Done, see above.
2. **REA on PredatorSense**, optional: the Windows app's per-model
   configuration should say which lighting devices the PHN16-72 has. The
   Windows partition on this machine is BitLocker-encrypted, so the binaries
   would come from Acer's PredatorSense installer download, analysed on
   Linux. No Windows boot is needed.
3. **One supervised write**, only after your explicit approval: set `LB` to
   a single static colour through method 20 target 2 while you watch, then
   set it back. Reading (method 21) cannot settle it on its own, because it
   returns the EC registers whether or not an LED is connected.

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

- About 500 lines in `kmod/helios-acer-lighting/`, licensed
  **GPL-2.0-or-later** (kernel modules must be GPL-2-compatible, and this is
  compatible with the project's GPL-3.0-or-later). It has two parts:
  `lighting.c`, the protocol (parsing, the exact firmware buffers,
  formatting the read-back) with no kernel dependencies, and `driver.c`, the
  WMI driver that connects it to the firmware. The protocol part only knows
  the numbers of methods 6, 7, 20 and 21, and the driver refuses any other.
- It binds only on the WMI GUID above **and** a DMI allow-list (to start,
  only "Predator PHN16-72"). On any other machine it does not load.
- It exposes a tiny sysfs interface on the WMI device. Each write is one
  complete, validated operation, and the kernel rejects anything else with
  `-EINVAL` without calling the firmware:

  | Attribute | Write | Firmware calls |
  |---|---|---|
  | `keyboard_effect` | `<effect> <speed> <brightness> <direction> <rrggbb>`, e.g. `breathing 4 80 right ff0000` | method 20, target 1 |
  | `keyboard_zones` | `<brightness> <rrggbb> <rrggbb> <rrggbb> <rrggbb>` | method 20 (static, direction kept) + method 6 for zones 1 to 4 |

  - `effect`: `static`, `breathing`, `neon`, `wave`, `shifting` or `zoom`.
  - `speed`: 0 to 9. `brightness`: 0 to 100. Plain decimal, no sign, no
    leading zeros.
  - `direction`: `left` (firmware value 1, right to left) or `right` (2,
    left to right). It is always sent, even for effects that ignore it.
  - Colours: exactly six hex digits, no `#`.
  - Words are separated by single spaces, and the line may end with one
    newline. Anything else is rejected.

  Reading the same attributes returns the current state in the same format
  (methods 21 and 7). A value Helios cannot set, such as an effect chosen
  under Windows, reads back as `unknown`. Effects 6 and 7, and the `LB`
  target, are not accepted until confirmed.
- Operations are serialized by a mutex, and a write stops at the first
  firmware error (`-EIO`).
- The files are root-only (0600 root:root). heliosd's sandbox gets
  `ReadWritePaths` for exactly these two attribute files, the same pattern as
  the platform profile.
- Nothing is sent to the firmware when the module loads; only reading or
  writing an attribute calls it.
- **Secure Boot is on**, so the module must be signed. With DKMS that means
  a one-time Machine Owner Key enrolment: DKMS creates a key, you set a
  one-time password, and on the next boot the blue "MOK manager" screen asks
  you to confirm it. That is the only boot-time step, and it is reversible
  (`mokutil --delete`). This machine has no MOK enrolled yet: its NVIDIA
  driver comes from Ubuntu's prebuilt, Canonical-signed `linux-modules-nvidia`
  packages, so nothing else has needed one.
- **Other users** fall into three groups:
  - Secure Boot off: DKMS builds the module, and no key is needed.
  - Secure Boot on, MOK already enrolled (common if they use any DKMS
    driver, such as `nvidia-dkms` or VirtualBox): DKMS signs with the
    existing key, and no extra step is needed.
  - Secure Boot on, no MOK: the same one-time enrolment as here. Ubuntu's
    DKMS asks for the password during the install.

  The module is an optional extra. Without it, Helios still works and only
  hides the lighting section. The long-term fix that removes the step for
  everyone is getting the feature into mainline `acer-wmi`, which
  distributions sign.
- Per the project rules, **Helios never installs or loads it**. `install.sh`
  does not touch it. `heliosctl doctor` has a `lighting` check that tells
  whether the module is not installed, installed but not loaded, loaded but
  not bound, or working, and **prints** the commands for you to run (the
  check is informational: a missing module is not a problem).
- Once installed with DKMS, the kernel loads it at boot by itself through
  its WMI alias, like any driver, and DKMS rebuilds and signs it for each
  new kernel.

### Installing it

From the Helios Panel source directory (`heliosctl doctor` prints the same
commands, adapted to what is missing):

```bash
sudo apt install dkms linux-headers-$(uname -r)   # if not installed yet
sudo cp -r kmod/helios-acer-lighting /usr/src/helios-acer-lighting-0.1.0
sudo dkms install helios-acer-lighting/0.1.0
```

Then, with Secure Boot **off**, or **on with the DKMS key already
enrolled**:

```bash
sudo modprobe helios_acer_lighting
```

With Secure Boot **on** and no key enrolled yet (only once per machine):

1. `sudo mokutil --import /var/lib/shim-signed/mok/MOK.der`. It asks you to
   choose a one-time password, twice. Use only lowercase letters and digits,
   because the boot screen uses a US keyboard layout.
2. Reboot. A blue "MOK management" screen appears and waits about 10
   seconds; if it times out, nothing changes, so just run step 1 again.
3. Choose **Enroll MOK**, **Continue**, **Yes**, type the password, then
   **Reboot**.
4. The module loads by itself from then on. The password is not needed
   again, and nothing appears on later boots.

To remove the module: `sudo modprobe -r helios_acer_lighting`, then
`sudo dkms remove helios-acer-lighting/0.1.0 --all` and
`sudo rm -r /usr/src/helios-acer-lighting-0.1.0`. To remove the key:
`sudo mokutil --delete /var/lib/shim-signed/mok/MOK.der`, confirmed the same
way on the next boot.

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
| helios-core (pure) | builds and parses the module's attribute lines; every out-of-range value is rejected before a line is built; exhaustive checks over the full input ranges |
| kernel module (done) | `make -C kmod/helios-acer-lighting test`, part of `npm test`: the protocol code built in userspace with AddressSanitizer and UBSan against a fake firmware that records every call. It checks the exact bytes for every effect, direction and zone; every number from 0 to 999 for speed and brightness; about 30 malformed lines that must never reach the firmware; errors stopping a write; the read-back format; and 200,000 random lines, after each of which every call made must use only methods 6, 7, 20 or 21, target byte 1, single-zone masks and zeroed logo bytes. CI also builds the module against Ubuntu's generic kernel headers with `W=1` and `-Werror`, and runs `checkpatch.pl --strict`. (KUnit was the original idea; it needs a kernel built for it, which CI cannot do cheaply, so the protocol code is kernel-independent instead.) |
| heliosd | private-bus integration tests with a fake sysfs tree for the module's files: valid calls write exactly the expected line; invalid ones never reach polkit; polkit denial writes nothing; the interface is absent without the module; state is restored at start |
| extension | fake proxy: section hidden without capabilities; controls call the right method with the right arguments; error messages |
| real hardware | the [protocol below](#hardware-test-protocol), run only with you present |

### Hardware test protocol

Run only with the owner present, one step at a time, stopping at the first
surprise (a wrong zone, a flicker that does not settle, an error, anything
in `journalctl -k`). The first two steps only read.

```bash
D=/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56
```

1. **Bound?** `ls -l $D/keyboard_effect $D/keyboard_zones` shows two root-only
   files, and `heliosctl doctor` reports `lighting` as ok.
2. **Read the current state** and keep it, to restore at the end:
   `sudo cat $D/keyboard_effect $D/keyboard_zones | tee ~/helios-lighting-before.txt`
3. **One colour**: `echo 'static 0 100 right ff0000' | sudo tee $D/keyboard_effect`.
   Expect the whole keyboard red, and the same line when read back.
4. **Brightness**: the same with `30` instead of `100`. Expect it dimmer.
5. **Zones**: `echo '100 ff0000 00ff00 0000ff ffffff' | sudo tee $D/keyboard_zones`.
   Expect red, green, blue and white from left to right, and the same line
   when read back.
6. **Effects**, one at a time, each read back:
   `breathing 4 80 right 00ffff`, `neon 4 80 right 000000`,
   `wave 4 80 left 000000`, `wave 4 80 right 000000`,
   `shifting 4 80 right 000000`, `zoom 4 80 right 000000`.
7. **Rejection**: `echo 'wave 10 80 right ff0000' | sudo tee $D/keyboard_effect`
   must fail with "Invalid argument" and change nothing.
8. **Restore** the two lines saved in step 2 (if they read `unknown`, pick
   any static colour instead).

The `LB` (logo) probe is not part of this protocol; it needs its own
approval.

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

1. **Kernel path**: write our own minimal `helios-acer-lighting` module,
   rather than using predator-sense/Linuwu-Sense or waiting for upstream.
   **Approved.**
2. **Secure Boot**: accept the one-time MOK enrolment for a DKMS-signed
   module. **Approved.**
3. **Scope of the first version**: the keyboard only (effects 0–5 and the 4
   static zones). `LB`/logo comes later, after it is identified.
   **Approved.**
4. **The `LB` question**: answered (the lid logo is RGB, and there is no
   light strip). REA on PredatorSense (step 2) is **skipped** for now; the
   supervised write settles it.
5. **D-Bus API and polkit action** as described above, including re-applying the
   last state at start and after resume. **Approved.**
6. **First hardware write**: only through the written test protocol, with
   you present. **Approved.**
