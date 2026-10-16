# Hardware compatibility

Helios Panel was built on one laptop, the **Acer Predator Helios Neo 16
(PHN16-72)**, but most of it is not tied to that model. This page lists what
works where, so you can tell before you install.

In short:

| Your machine | What you get |
|---|---|
| Acer Predator Helios Neo 16 **PHN16-72** | everything, including the keyboard and lid logo lighting |
| Another **Acer Predator or Nitro** that mainline `acer_wmi` supports with `predator_v4=1` | sensors, fans and profile switching; no lighting yet |
| Any other laptop whose kernel driver exposes a **platform profile** (many Lenovo, ThinkPad, ASUS, HP, Dell…) | sensors and profile switching; no fan speeds |
| Any other Linux PC, desktop included | sensors only |

Only the PHN16-72 has been tested on real hardware. The other rows follow
from how each feature reads the hardware (below), not from tests; if you try
one, please [report it](#report-your-machine).

## Software

| Requirement | Supported |
|---|---|
| Desktop | GNOME Shell 46, 47, 48, 49 and 50, on X11 or Wayland |
| Distribution | developed on Ubuntu 24.04 and newer. Any distribution with systemd, D-Bus and polkit should work; `install.sh` only suggests `apt` packages when something is missing |
| Kernel | any recent kernel. The platform profile is read from the old single file and from the per-driver devices added in 6.14 |
| Other desktops | heliosd and `heliosctl` work without GNOME; only the top-bar extension needs it |

## Feature by feature

### Temperatures and usage (any PC)

These come from standard kernel interfaces, so they work on any vendor's
laptop or desktop.

| Reading | Works with | Not supported yet |
|---|---|---|
| CPU temperature | Intel (`coretemp`), AMD Ryzen (`k10temp`, `zenpower`); falls back to the ACPI thermal zone (`acpitz`) | ARM CPUs other than through `acpitz` |
| GPU temperature and usage | NVIDIA with the proprietary driver (`nvidia-smi`); AMD Radeon (`amdgpu`, the discrete card preferred) | Intel graphics (integrated or Arc); NVIDIA with nouveau |
| NVIDIA GPU draw | proprietary driver | |
| CPU usage, CPU clock, RAM | every Linux machine (`/proc`, `cpufreq`) | |
| CPU package draw | Intel and AMD (RAPL, read by heliosd as root) | |
| Drive temperatures | NVMe (`nvme`) and SATA drives (`drivetemp` module loaded) | |
| Wi-Fi card temperature | Intel cards (`iwlwifi`) | other Wi-Fi vendors |
| Battery, charge, time left, health, draw on battery | any laptop with a standard `/sys/class/power_supply` battery | |

A reading the machine lacks is simply left out of the menu and the top bar.

### Fan speeds (Acer gaming laptops)

The fan RPMs come from the `acer` hwmon chip that `acer_wmi` creates with
`predator_v4=1`. Other vendors' fan sensors (ThinkPad, ASUS, Dell…) are not
read yet. Helios only reads fans; it never controls them.

### Power profile switching (most modern laptops)

The menu switches the kernel's **platform profile**, which many laptop
drivers expose: `acer_wmi`, `thinkpad_acpi`, `ideapad_laptop`, `asus_wmi`,
`hp_wmi`, `dell_pc` and others. Check yours:

```bash
cat /sys/firmware/acpi/platform_profile_choices
```

If that prints a list, profile switching should work. The menu shows exactly
the profiles your firmware lists, nothing more. The names follow
PredatorSense (`low-power` is Eco, `performance` is Turbo…); on a non-Acer
machine you can switch the labels to the kernel names in Settings.

On Acer Predator and Nitro laptops the gaming profiles (Eco, Quiet,
Balanced, Performance, Turbo) only appear when `acer_wmi` is loaded with
`predator_v4=1`, and only on models that option supports in your kernel.
`heliosctl doctor` checks this and prints the commands to set it up.

If something else changes the profile (GNOME's power mode menu through
power-profiles-daemon, or a mode key on the keyboard), Helios shows the new
one within 2 seconds.

### Keyboard and lid logo lighting (PHN16-72 only)

The lighting needs the optional `helios-acer-lighting` kernel module, which
refuses to load on any machine but the **Predator PHN16-72** (a DMI
allow-list). Without it, the lighting section is hidden and everything else
works. See [LIGHTING.md](LIGHTING.md) for how it works and how to install it.

With Secure Boot on, the module has to be signed. If your machine has no
Machine Owner Key (MOK) enrolled yet, installing it takes a one-time step:
`mokutil` asks you to choose a password, and on the next boot a blue "MOK
management" screen asks for it to enroll the key. After that the module
loads by itself on every boot, including after kernel updates, and the
password is never needed again. With Secure Boot off, or with a key already
enrolled (for example by `nvidia-dkms` or VirtualBox), there is no extra
step. The enrolment can be undone with `mokutil --delete`; the steps are in
[LIGHTING.md](LIGHTING.md#installing-it).

Sibling models (other Helios Neo 16 or Helios 16 generations) may share the
same firmware interface, but the module is not enabled for them until
someone tests it on one. Opening an issue with your model is the way to
start that.

## Tested machines

| Machine | BIOS | Kernel | GNOME | Status |
|---|---|---|---|---|
| Acer Predator Helios Neo 16 PHN16-72 (Intel, NVIDIA) | V1.20 | 7.0 (Ubuntu 24.04) | 46 | everything works, except the **static** keyboard effect, which leaves the keyboard dark ([details](LIGHTING.md#hardware-test-results)) |

## Check your machine

Without installing anything system-wide, build and run the command-line
client from the source tree. It reads the sensors directly, needs no root,
and never wakes a sleeping NVIDIA GPU:

```bash
cargo run --release -p heliosctl -- status
cargo run --release -p heliosctl -- doctor
```

`status` shows every reading Helios finds on your machine. `doctor` tells
whether the platform profile is available and, on an Acer, whether
`acer_wmi` is set up for the gaming profiles. Both only read: when
something can be fixed, `doctor` prints the commands for you to run.

## Report your machine

Whether it works or not, a report helps the next person with the same
laptop. Open an issue with the **Hardware report** template and paste:

```bash
cat /sys/class/dmi/id/{sys_vendor,product_name,product_family,bios_version}
uname -r
gnome-shell --version
heliosctl status --json
heliosctl doctor
```

Working models are added to the [tested machines](#tested-machines) table.
