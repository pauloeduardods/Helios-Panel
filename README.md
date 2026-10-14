# Helios Panel

A GNOME Shell extension that shows, in the top bar next to Wi-Fi and the keyboard layout:

- the **CPU** and **GPU** temperature, changing color as they heat up;
- the current **power profile** (Eco, Quiet, Balanced, Performance, Turbo);
- optionally, the **fan** speed.

The menu shows the details and lets you switch profiles. It was built for the Acer Predator Helios Neo 16 (PHN16-72), but it works on any PC with sensors in `/sys/class/hwmon`, including Ryzen CPUs and Radeon GPUs.

```
 [▣ 61°] [▤ off] [◔ Balanced]   ← panel
```

## Requirements

- GNOME Shell 46 to 50 (Ubuntu 24.04 or newer).
- For the power profile: the `acer_wmi` driver loaded with `predator_v4=1`.
- For the NVIDIA temperature: the proprietary driver (which ships `nvidia-smi`).

## Install

```bash
./install.sh
```

On Wayland, GNOME only loads new extensions after you **log out and back in**. Then:

```bash
gnome-extensions enable helios-panel@paulo
```

To configure it, open the extension menu → **Settings**, or run `gnome-extensions prefs helios-panel@paulo`.

To remove it: `./install.sh --uninstall`.

## Where each reading comes from

| Item | Source | Needs root? |
|---|---|---|
| CPU | `coretemp` "Package id 0" (Intel) or `k10temp` "Tctl" (AMD) | no |
| NVIDIA GPU | `nvidia-smi`, **only if the card is already powered on** | no |
| AMD GPU | `amdgpu` hwmon (prefers the discrete one) | no |
| Fans | `acer` hwmon (from `acer_wmi`) | no |
| Profile | `/sys/firmware/acpi/platform_profile` | not to read |

### The NVIDIA GPU shows "off"

That means it is powered off to save battery (on-demand mode). Reading the temperature with `nvidia-smi` would wake the card, so the extension does not do it. It also spaces out its readings so it does not keep the card from going back to sleep. If you always want the temperature, enable **Sensors → Wake the GPU**, knowing that it drains the battery.

## Switching profiles from the menu

- **With no extra setup**, switching goes through `power-profiles-daemon`, the same service behind Ubuntu's "Power Mode". It only knows 3 modes: Power Saver, Balanced and Performance (which maps to Turbo).
- **To get every firmware profile in the menu**, install the optional udev rule in `extras/99-helios-platform-profile.rules`. The instructions and the risk are described in the file itself.

The keyboard mode key keeps working in both cases.

## Development

```bash
npm test          # logic tests (node, no GNOME needed)
npm run check     # syntax check of every module

# test in a nested session, without leaving your own session:
dbus-run-session gnome-shell --devkit            # GNOME 49+
dbus-run-session gnome-shell --nested --wayland  # GNOME 46-48

# extension errors:
journalctl -f -o cat /usr/bin/gnome-shell | grep -i helios
```

The code layout and the plan for adding lighting control are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); see [CONTRIBUTING.md](CONTRIBUTING.md).
