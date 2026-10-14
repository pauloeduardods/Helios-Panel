# Helios Panel

Laptop sensors and the platform profile for Linux, with a GNOME Shell top-bar extension. It shows, next to Wi-Fi and the keyboard layout:

- the **CPU** and **GPU** temperature, changing color as they heat up;
- the current **power profile** (Eco, Quiet, Balanced, Performance, Turbo), switchable from the menu;
- optionally, the **fan** speed.

It was built for the Acer Predator Helios Neo 16 (PHN16-72), but it works on any PC with sensors in `/sys/class/hwmon`, including Ryzen CPUs and Radeon GPUs.

```
 [▣ 61°] [▤ off] [◔ Balanced]   ← panel
```

## How it fits together

- **heliosd**: a small system service. It reads the sensors, publishes them on the system D-Bus and is the only part that changes the platform profile, and only after polkit allows it. It runs sandboxed by systemd, with no capabilities.
- **heliosctl**: a command-line client (`heliosctl status`).
- **The GNOME extension**: draws what heliosd publishes. It never runs anything as root, never reads `/sys` and never spawns processes. Without heliosd it shows `helios off`.

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- GNOME Shell 46 to 50 (Ubuntu 24.04 or newer).
- systemd, D-Bus and polkit (standard on Ubuntu).
- For the power profile: the `acer_wmi` driver loaded with `predator_v4=1`.
- For the NVIDIA temperature: the proprietary driver (which ships `nvidia-smi`).
- To build: a Rust toolchain ([rustup](https://rustup.rs)).

## Install

`install.sh` currently installs the extension only. Until it also installs the daemon, install heliosd by hand from a checkout:

```bash
cargo build --release
sudo install -Dm755 target/release/heliosd   /usr/local/libexec/heliosd
sudo install -Dm755 target/release/heliosctl /usr/local/bin/heliosctl
sudo install -Dm644 data/heliosd.service /etc/systemd/system/heliosd.service
sudo install -Dm644 data/io.github.pauloeduardods.Helios1.conf    /usr/share/dbus-1/system.d/io.github.pauloeduardods.Helios1.conf
sudo install -Dm644 data/io.github.pauloeduardods.Helios1.service /usr/share/dbus-1/system-services/io.github.pauloeduardods.Helios1.service
sudo install -Dm644 data/io.github.pauloeduardods.helios.policy   /usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy
sudo systemctl daemon-reload
```

heliosd starts on demand the first time a client asks for it. To check it:

```bash
busctl --system introspect io.github.pauloeduardods.Helios1 /io/github/pauloeduardods/Helios1
systemctl status heliosd
```

Then install the extension:

```bash
./install.sh
```

On Wayland, GNOME only loads new extensions after you **log out and back in**. On X11, press Alt+F2, type `r` and press Enter. Then:

```bash
gnome-extensions enable helios-panel@paulo
```

To configure it, open the extension menu → **Settings**, or run `gnome-extensions prefs helios-panel@paulo`.

To remove the extension: `./install.sh --uninstall`.

## Where each reading comes from

| Item | Source |
|---|---|
| CPU | `coretemp` "Package id 0" (Intel) or `k10temp` "Tctl" (AMD) |
| NVIDIA GPU | `nvidia-smi`, **only while the card is awake** |
| AMD GPU | `amdgpu` hwmon (prefers the discrete one) |
| Fans | `acer` hwmon (from `acer_wmi`) |
| Profile | `/sys/firmware/acpi/platform_profile` |

Reading never needs root. heliosd reads everything once every 2 seconds for all clients, and clients are told only when something changes.

### The NVIDIA GPU shows "off"

That means it is powered off to save battery (on-demand mode). Reading the temperature with `nvidia-smi` would wake the card, so heliosd never queries a card that is asleep, and spaces out its queries so it does not keep the card from going back to sleep.

## Switching profiles

The menu lists every profile the firmware offers (`platform_profile_choices`). Switching goes through heliosd, which accepts only those values and asks polkit first. By default, any user in the active local session may switch without a password, like the keyboard mode key, which keeps working too.

From a terminal:

```bash
busctl --system call io.github.pauloeduardods.Helios1 /io/github/pauloeduardods/Helios1 \
    io.github.pauloeduardods.Helios1.Profile SetProfile s quiet
```

## Command line

```bash
heliosctl status          # human-readable
heliosctl status --json   # machine-readable
```

`heliosctl` reads the sensors directly and works without heliosd or root. An NVIDIA GPU that is asleep is reported as `off` and never woken.

## Development

```bash
cargo test --workspace                                    # Rust tests (fake sysfs, private D-Bus, never the real ones)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
npm test          # extension tests (node, fake D-Bus, no GNOME needed)
npm run check     # syntax check of every module

# test in a nested session, without leaving your own session:
dbus-run-session gnome-shell --devkit            # GNOME 49+
dbus-run-session gnome-shell --nested --wayland  # GNOME 46-48

# logs:
journalctl -f -o cat /usr/bin/gnome-shell | grep -i helios
journalctl -f -u heliosd
```

The heliosd integration tests need `dbus-daemon` (package `dbus-daemon` on Ubuntu); each test starts its own private bus.

Helios Panel is licensed under the [GNU GPL v3.0 or later](LICENSE).

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); see [CONTRIBUTING.md](CONTRIBUTING.md).
