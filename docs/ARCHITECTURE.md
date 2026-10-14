# Architecture

> **Status:** helios-core, heliosctl, heliosd, the D-Bus extension and the
> installer and `heliosctl doctor` are implemented. Lighting is still
> planned (see the [migration plan](#migration-plan)).

## Goals and scope

Helios reads laptop sensors, switches the ACPI platform profile and (later)
controls the keyboard/logo lighting. Nothing else.

| In scope | Out of scope, never |
|---|---|
| CPU/GPU temperatures, fan speeds (read-only) | fan control, fan curves |
| reading the platform profile | raw EC reads or writes |
| writing the platform profile, only to a value in `platform_profile_choices` | GPU MUX switch |
| keyboard/logo lighting, validated colors/effects/brightness (task 7) | editing `/etc/modprobe.d`, kernel parameters, initramfs |
| diagnosing a missing driver and **printing** the fix | loading, unloading or reloading kernel modules |

There are exactly two kinds of hardware write: the platform profile and the
lighting. Both happen only inside `heliosd`, only through a closed list of
validated D-Bus methods, each behind its own polkit action.

## Components

```
                         system bus
┌──────────────────┐   ┌───────────────────────────────────┐   ┌────────────────────┐
│ GNOME extension  │──▶│ heliosd (root, no capabilities,   │──▶│ /sys/class/hwmon   │ read
│ (gnome-shell,    │   │ sandboxed by systemd)             │   │ /sys/bus/pci (GPU) │ read
│  user session)   │◀──│  - polls sensors every 2 s        │   │ nvidia-smi         │ only if GPU active
└──────────────────┘   │  - one central NVIDIA reader      │   │ platform_profile   │ read + write
┌──────────────────┐   │  - SetProfile / lighting methods  │   │ lighting device    │ write (task 7)
│ heliosctl        │──▶│  - polkit check per method        │   └────────────────────┘
│ (any user)       │   └───────────────────────────────────┘
└──────────────────┘            │ uses
        │ uses                  ▼
        └──────────────▶ helios-core (pure library)
                         helios-sys  (real I/O adapters for it)
```

- **helios-core**: all the logic: sensor discovery, NVIDIA power gating
  and rate limiting, profile parsing/validation, and the doctor checks. No D-Bus,
  no processes, no direct I/O. Everything goes through injected traits.
- **helios-sys**: the real implementations of the core traits: `RootedFs`
  (sysfs access under a root directory), `NvidiaSmi` (fixed argv, timeout)
  and `SystemClock`. Shared by both binaries so they do not duplicate I/O code.
- **heliosd**: the system service. It owns the bus name, keeps the current
  readings, runs `nvidia-smi` when allowed, checks polkit and performs the
  two kinds of write.
- **heliosctl**: CLI. `status [--json]` and `doctor` read directly through
  helios-core and work without the daemon or root.
- **GNOME extension**: renders what the daemon publishes and calls its
  methods. It never touches sysfs, never spawns processes and never needs root.
  KDE/Waybar frontends can later consume the same API.

## Cargo workspace

```
Cargo.toml                 [workspace], shared lints, edition 2024
crates/
├── helios-core/           lib, no D-Bus/process/IO dependencies
│   ├── src/io.rs            traits SysFs, GpuQuery, Clock
│   ├── src/fake.rs          FakeFs/FakeGpu/FakeClock + PHN16-72 and AMD fixtures ("fake" feature)
│   ├── src/hwmon.rs         scan, CPU/AMD GPU/fan resolution, sensor ids
│   ├── src/nvidia.rs        PCI lookup, runtime-PM gate, query interval
│   ├── src/power.rs         power source, laptop battery, averaged draw
│   ├── src/profile.rs       platform profile state, validation, write path
│   ├── src/status.rs        Status struct (serde) shared by CLI JSON and daemon
│   └── src/doctor.rs        read-only setup checks over the injected fs
├── helios-sys/            lib, RootedFs, NvidiaSmi, SystemClock
├── heliosd/               bin, zbus + polkit, uses helios-core + helios-sys
│   └── tests/bus.rs         integration tests on a private bus
└── heliosctl/             bin, uses helios-core + helios-sys
    └── tests/cli.rs         runs the binary against fixture trees on disk
data/
├── heliosd.service                                    systemd unit
├── io.github.pauloeduardods.Helios1.conf              D-Bus system policy
├── io.github.pauloeduardods.Helios1.service           D-Bus activation file
└── io.github.pauloeduardods.helios.policy             polkit actions
extension/                 GNOME extension (thin client)
tests/                     node tests for the extension
```

### helios-core

```rust
/// The only door to the outside world. Paths are absolute ("/sys/...").
pub trait SysFs {
    fn read_to_string(&self, path: &str) -> Option<String>; // trimmed; None on any error
    fn read_dir(&self, path: &str) -> Vec<String>;          // sorted names; empty on error
    fn exists(&self, path: &str) -> bool;
    fn write(&self, path: &str, value: &str) -> io::Result<()>; // in place, no temp+rename
}

/// Runs `nvidia-smi --query-gpu=temperature.gpu,power.draw --format=csv,noheader,nounits`.
pub trait GpuQuery {
    fn query(&self) -> Option<String>; // stdout; None if it failed or timed out
}

pub trait Clock {
    fn now(&self) -> Duration; // monotonic
}
```

- `RootedFs { root }` (in helios-sys, not in core) maps `/sys/...` to
  `root/sys/...`. Production uses `/`. Tests use a temporary directory.
- `profile::validate(requested, &state) -> Result<ProfileTarget, ProfileError>`
  accepts only a value present in the **current** `platform_profile_choices`
  (or the class device `choices`), and returns the path to write. Writes always
  go through `profile::apply(fs, target)`, which writes and reads back.
- The NVIDIA reader is a state machine over `SysFs + GpuQuery + Clock`: it reads
  `power/runtime_status` and calls `GpuQuery` only when the GPU is awake:
  `active`, or `unsupported` (runtime PM disabled, so it is always powered).
  `suspended`, `suspending`, `resuming` and a missing or unknown status all
  mean "off" and **no query**. Queries
  are at least `max(10 s, 2 × autosuspend_delay + 1 s)` apart (an unreadable
  delay, as on the PHN16-72 with fine-grained RTD3, which returns EIO, falls back
  to 10 s), so the daemon's own polling cannot keep the GPU awake.
  A GPU that is not awake is never woken. The `allow-wake-dgpu` option goes away.

### heliosd

- Async runtime: `zbus` (pure Rust, no libdbus) on its default executor.
  polkit is called directly over D-Bus (`org.freedesktop.PolicyKit1.Authority.CheckAuthorization`),
  with no extra polkit crate.
- Polls hwmon, the profile and the NVIDIA reader every 2 s and emits **one**
  `PropertiesChanged` per tick, containing only the values that changed.
  Temperatures are rounded to 0.1 °C before comparison so noise does not cause
  signals. Clients never poll.
- Hidden flags for tests only: `--bus session`, `--sysfs-root DIR`,
  `--nvidia-smi PATH`. The systemd unit passes none of them, and only root can
  change the unit.
- Logs go to stderr (journald under systemd). Every write is logged with the
  caller's unique bus name, the action, the value and the result.

### heliosctl

```
heliosctl status [--json]   readings + profile, read-only, no daemon or root needed
heliosctl doctor [--json]   diagnosis, read-only, prints suggested commands
```

`status --json` prints the shared `Status` struct:

```json
{
  "schema": 1,
  "cpu": {"sensor": "hwmon:coretemp/Package id 0", "celsius": 61.0},
  "gpu": {"source": "nvidia-smi", "state": "off", "celsius": null, "watts": null},
  "fans": [{"label": "Fan 1", "rpm": 2350}, {"label": "Fan 2", "rpm": 2600}],
  "power": {"source": "ac",
            "battery": {"name": "BAT1", "state": "not-charging", "percent": 80.0, "watts": 0.0,
                        "health_percent": 92.0, "cycles": 0, "minutes_left": null}},
  "profile": {"available": true, "active": "balanced", "driver": "acer-wmi",
              "choices": ["low-power", "quiet", "balanced", "balanced-performance", "performance"]},
  "temperatures": [{"id": "hwmon:coretemp/Package id 0", "chip": "coretemp",
                    "label": "Package id 0", "celsius": 61.0}]
}
```

`gpu.state` is `on`, `off` (asleep, not queried) or `none` (no GPU source).
`power.source` is `ac`, `battery` or `unknown`; `power.battery` is `null`
without a laptop battery. `battery.watts` is the power flowing in or out of the
battery (always positive), and `minutes_left` is only set while discharging.
heliosctl follows the same NVIDIA rule: no query unless the GPU is active.

## D-Bus API (version 2)

- **Bus:** system bus.
- **Well-known name:** `io.github.pauloeduardods.Helios1`. It is a reverse-DNS
  name under the GitHub account, and the `1` is the API major version.
- **Object:** `/io/github/pauloeduardods/Helios1`, which implements the
  interfaces below, plus the standard `Properties`, `Introspectable` and `Peer`.

All properties are read-only and emit `org.freedesktop.DBus.Properties.PropertiesChanged`.

### `io.github.pauloeduardods.Helios1.Daemon`

| Member | Type | Meaning |
|---|---|---|
| `Version` | `s` | heliosd version, e.g. `0.2.0` |
| `ApiVersion` | `u` | `2`; raised for compatible additions (2 added `GpuPower`, `PowerSource`, `Battery`) |

### `io.github.pauloeduardods.Helios1.Sensors`

| Member | Type | Meaning |
|---|---|---|
| `Cpu` | `(sbd)` | (sensor id, valid, °C), auto-selected CPU package sensor |
| `Gpu` | `(ssbd)` | (source id, state `on`/`off`/`none`, valid, °C) |
| `Fans` | `a(si)` | (label, rpm; `-1` = unreadable) |
| `Temperatures` | `a(sssd)` | every readable hwmon temperature: (id, chip, label, °C), for clients that let the user pick a sensor; unreadable sensors are left out |
| `GpuPower` | `(bd)` | (valid, W): NVIDIA board draw, from the same rate-limited `nvidia-smi` query as the temperature |
| `PowerSource` | `s` | `ac`, `battery` or `unknown` (no system `Mains` supply and the battery is not discharging) |
| `Battery` | `(ssdddii)` | (name, state `charging`/`discharging`/`full`/`not-charging`/`unknown`, %, W, health %, cycles, minutes left); name `""` = no battery, `-1` = unknown |

The `valid` flag replaces NaN sentinels, so every frontend, including JSON-based
ones, gets an explicit "no value".

### `io.github.pauloeduardods.Helios1.Profile`

| Member | Type | Meaning |
|---|---|---|
| `Available` | `b` | a platform profile exists |
| `Active` | `s` | current profile (`""` if unavailable) |
| `Choices` | `as` | from `platform_profile_choices`, sorted eco → turbo |
| `Driver` | `s` | class device name, e.g. `acer-wmi` (`""` if unknown) |
| `SetProfile(s profile)` | method → `()` | polkit `io.github.pauloeduardods.helios.set-profile` |

`SetProfile` order of checks: (1) the value is one of `Choices` re-read at call
time, else `InvalidArgument` (nothing written, no polkit prompt); (2) polkit
authorizes the caller, else `NotAuthorized` (nothing written); (3) the write
happens, serialized, with at least 250 ms between writes. The value is read
back, `Active` is updated and the signal is emitted; on a driver error the
result is `WriteFailed`.

The mode key and power-profiles-daemon can also change the profile. heliosd
picks the change up on its next tick and emits `Active`.

### `io.github.pauloeduardods.Helios1.Lighting` (provisional, task 7)

Reserved. The members are fixed only after the task 7 research and your
approval. The intended shape, with every argument validated against `Capabilities`:

| Member | Type | Meaning |
|---|---|---|
| `Capabilities` | `a{sv}` | targets, zones, effects, ranges; empty when unsupported |
| `SetKeyboard(aay colors, s effect, u brightness, u speed, s direction)` | method | polkit `io.github.pauloeduardods.helios.set-lighting` |
| `SetLogo(ay color, b on, u brightness)` | method | same action |

The interface is only exported when a supported lighting device exists.

### Errors

`io.github.pauloeduardods.Helios1.Error.InvalidArgument`, `.NotAuthorized`,
`.Unavailable` (no platform profile / no lighting device), `.WriteFailed`.

### polkit actions

| Action | `allow_any` | `allow_inactive` | `allow_active` | Why |
|---|---|---|---|---|
| `io.github.pauloeduardods.helios.set-profile` | `no` | `no` | `yes` | the mode key already does it without a password; worst case is a loud fan |
| `io.github.pauloeduardods.helios.set-lighting` (task 7, not shipped yet) | `no` | `no` | `yes` | worst case is a wrong color |

heliosd calls `CheckAuthorization` with the caller as a `system-bus-name`
subject and `AllowUserInteraction`, so an administrator can tighten either
action to `auth_admin` with a rule and get a password prompt, with no code
change. Reads need no authorization.

### D-Bus policy

Only root may own `io.github.pauloeduardods.Helios1`. Anyone may call the
`Daemon`, `Sensors` and `Profile` interfaces (task 7 adds `Lighting`) and the
standard ones. polkit, not the bus policy, decides on writes. Everything else is
denied.

## systemd service and sandboxing

heliosd is D-Bus-activated (`Type=dbus`): the first client starts it. It runs
as root only because the profile file is `root:root 0644`. It holds **no
capabilities**, and file ownership alone allows the write.

```ini
[Unit]
Description=Helios laptop sensors and platform profile daemon

[Service]
Type=dbus
BusName=io.github.pauloeduardods.Helios1
ExecStart=/usr/local/libexec/heliosd
Restart=on-failure

# root without privileges: ownership is enough for the profile file
CapabilityBoundingSet=
AmbientCapabilities=
NoNewPrivileges=yes

# filesystem: everything read-only ...
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=all
# ... except the platform profile (legacy path + class device)
ReadWritePaths=-/sys/firmware/acpi/platform_profile
ReadWritePaths=-/sys/devices/platform/acer-wmi/platform-profile
# task 7 adds the lighting device here and nothing else

# devices: only what nvidia-smi needs to read a temperature
DevicePolicy=closed
DeviceAllow=char-nvidia rw
DeviceAllow=char-nvidiactl rw

PrivateNetwork=yes
IPAddressDeny=any
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
UMask=0077
```

`systemd-analyze security --offline=true data/heliosd.service` rates this unit
**0.9 SAFE**. Unit tests (`crates/heliosd/src/service.rs`) fail if the unit gains
a capability, a writable path or a device beyond the ones below. Checked on
the PHN16-72 after installing:

- `ReadWritePaths` re-opens a path under the read-only `/sys` that
  `ProtectKernelTunables` creates (verified: `SetProfile` from the panel works). The class device path is resolved, not the
  `/sys/class/platform-profile/platform-profile-N` symlink: on the PHN16-72 it is
  `/sys/devices/platform/acer-wmi/platform-profile/platform-profile-0`. Other
  drivers get their own resolved path in the unit (the `-` prefix ignores
  missing paths).
- `/dev/nvidia*` is already `0666` for every user. The daemon gets no device
  access beyond what any logged-in user has, and it runs `nvidia-smi` with a
  fixed argv and a 4 s timeout.
- `MemoryDenyWriteExecute=yes` and `SystemCallFilter=~@privileged @resources`
  also apply to the `nvidia-smi` child. Run as root, nvidia-smi calls `chown()`
  once (syscall 92, in `@privileged`). With the default action the kernel killed
  it with SIGSYS and Ubuntu showed a crash dialog; `SystemCallErrorNumber=EPERM`
  makes the call fail instead, which nvidia-smi handles, and readings work. The
  call stays blocked: root without capabilities could not chown anyway.
- `ProtectKernelModules=yes` also guarantees the daemon itself can never load
  or unload a module.

## How the extension consumes the API

```
extension.js     lifecycle
prefs.js         settings; reads heliosd once (sensor list, diagnostics)
lib/
├── client.js    HeliosClient: Gio.bus_watch_name + Gio.DBusProxy on the system bus
├── model.js     D-Bus values → view, temperature levels, labels, colors (pure)
└── ui/indicator.js
```

- `Gio.bus_watch_name(SYSTEM, 'io.github.pauloeduardods.Helios1', AUTO_START)`
  drives two states:
  - **running**: a `Gio.DBusProxy` caches the properties. The indicator
    re-renders on `g-properties-changed`. It has no timers, no sysfs and no
    subprocesses.
  - **daemon not running**: the name has no owner and activation failed, or
    the proxies could not be created. The panel shows one dimmed segment
    (`helios off`). The menu shows "heliosd is not running" and the command to
    find out why (`heliosctl doctor`). Profile items are hidden. When the name appears,
    the client recreates the proxy and the indicator goes back to normal, with
    no reload needed.
- `SetProfile` is called asynchronously with a long timeout, because polkit may
  prompt. `NotAuthorized` / `InvalidArgument` / `WriteFailed` show a
  notification. No optimistic UI: the check mark moves when `Active` changes.
- The settings that stay are display only: what to show, colors, thresholds,
  position, profile-name style, and the user's sensor choice (picked from
  `Temperatures`).
- The settings that go away, because the daemon now owns them:
  `allow-wake-dgpu`, `gpu-min-interval`, `refresh-interval`.
- `lib/core`, `lib/sys`, `lib/backends`, the power-profiles-daemon path and
  `extras/99-helios-platform-profile.rules` were deleted in task 4. The udev
  rule only existed to let the extension write the profile itself. Their logic
  and tests live on in helios-core.

## Test strategy

Every rule in this section is enforced in CI (`checks` job).

| Layer | How | What it proves |
|---|---|---|
| helios-core | `cargo test`, in-memory `FakeFs` built from fixtures: **PHN16-72** (coretemp, acer fans, NVIDIA 0000:01:00.0, acer-wmi profile) and **AMD desktop** (k10temp Tctl, iGPU + dGPU amdgpu) | discovery, ordering, sensor ids, profile parsing |
| NVIDIA gate | `FakeFs` + counting `GpuQuery` + manual `Clock` (ported from `tests/system.test.js`) | a `suspended`/`suspending`/`resuming` GPU is **never** queried; an active one is queried, then rate-limited; EIO autosuspend delay falls back to 10 s |
| profile writes | `FakeFs` with a write log | a value in `choices` is written to the right path and read back; values not in `choices`, empty, whitespace, newline-injected or over-long strings are rejected with **no write** |
| heliosd | `cargo test -p heliosd --test bus`: each test starts its own `dbus-daemon` with a private config and runs the daemon there, `--sysfs-root` temp tree, fake `nvidia-smi` script that counts calls, fake polkit service on the same bus that answers allow/deny | properties match the tree; `PropertiesChanged` on change; `SetProfile` accepts only `Choices`; invalid values never reach polkit; polkit denial or a missing polkit → `NotAuthorized` and the tree is byte-for-byte unchanged; suspended GPU → fake `nvidia-smi` never ran; external profile changes are published |
| heliosctl | run the binary against fixture trees | `status --json` matches the schema; `doctor` writes nothing (tree hashed before/after) |
| extension | `npm test` with gi stubs, including a fake `Gio.DBusProxy` and `bus_watch_name` | rendering from properties; **daemon not running** state; recovery when the name appears; errors from `SetProfile` |
| lint | `cargo clippy --workspace --all-targets -- -D warnings`, `npm run check` | |

No test ever touches the real `/sys`, the real system bus or the real polkit.

## License

**Decision: GPL-3.0-or-later for the whole repository** (one `LICENSE`
file, `license = "GPL-3.0-or-later"` in every crate, SPDX headers).

- The repository has no license today, so nobody else can legally reuse it.
- extensions.gnome.org requires a GPL-2.0-or-later-compatible license, and
  GPL-3.0-or-later qualifies.
- The best reference for the keyboard RGB protocol (predator-sense `facer.c`,
  and Linuwu-Sense) is GPL-3. With GPL-3 we can reuse code if task 7 needs it.
  With MIT/Apache we may only reimplement from a description.
- The cost: other projects can only reuse helios-core under GPL terms. If
  that matters more, the alternative is MIT OR Apache-2.0, with the rule that
  task 7 reimplements the protocol from a written description only.

## Installed files (task 6)

| File | Destination |
|---|---|
| extension | `~/.local/share/gnome-shell/extensions/helios-panel@paulo/` (user, no root) |
| `heliosd` | `/usr/local/libexec/heliosd` |
| `heliosctl` | `/usr/local/bin/heliosctl` |
| unit | `/etc/systemd/system/heliosd.service` |
| D-Bus policy | `/usr/share/dbus-1/system.d/io.github.pauloeduardods.Helios1.conf` |
| D-Bus activation | `/usr/share/dbus-1/system-services/io.github.pauloeduardods.Helios1.service` |
| polkit actions | `/usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy` |

`install.sh` builds as the user, asks for `sudo` once and uses it only for
the system part (the extension is installed as the user). Every file and every
directory it creates is recorded in `/usr/local/share/helios-panel/install-manifest`,
and `--uninstall` removes exactly those: files first, then the directories it
created, deepest first and only when empty. It refuses to overwrite a file it
did not install, replaces an earlier extension-only install of the same UUID,
reloads systemd and D-Bus and restarts an older heliosd. It never touches
modprobe, kernel parameters, initramfs or modules. `tests/install.test.js`
runs it in a temporary tree with fake `sudo`/`systemctl`/`busctl` and checks
that uninstall leaves the tree byte-for-byte as it was.

## Migration plan

| Task | Delivers |
|---|---|
| 3 | workspace, helios-core, `heliosctl status [--json]`, ported tests; CI starts running cargo (done) |
| 4 | heliosd (sensors, profile, `SetProfile`, polkit), data files, extension becomes a D-Bus client, `lib/core`/`lib/sys`/udev rule removed (done) |
| 5 | `heliosctl doctor` (done) |
| 6 | `install.sh` for extension + daemon, manifest-based `--uninstall` (done, before task 5) |
| 7 | lighting research and API proposal (plan only) |

## Decisions

| # | Decision | Status |
|---|---|---|
| 1 | Bus name `io.github.pauloeduardods.Helios1` | approved |
| 2 | An NVIDIA GPU that is not awake is never woken: it is queried only while `runtime_status` is `active` (or `unsupported`, i.e. always powered). `allow-wake-dgpu` is removed | approved |
| 3 | The extension has no fallback without the daemon; it shows "daemon not running" | approved |
| 4 | License GPL-3.0-or-later (`LICENSE` and SPDX headers added in task 3) | done |
| 5 | Rust toolchain via per-user `rustup` | done |
