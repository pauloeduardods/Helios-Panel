// SPDX-License-Identifier: GPL-3.0-or-later
//! heliosd on a private D-Bus: every test starts its own dbus-daemon, a fake
//! sysfs tree on disk, a fake nvidia-smi that logs each run and (optionally)
//! a fake polkit authority on the same bus. Nothing here touches the real
//! /sys, the real system bus or the real polkit.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_io::Timer;
use futures_lite::{StreamExt, future};
use helios_core::fake::PHN16_72;
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedValue;
use zbus::{Connection, interface};

const NAME: &str = "io.github.pauloeduardods.Helios1";
const PATH: &str = "/io/github/pauloeduardods/Helios1";
const SENSORS: &str = "io.github.pauloeduardods.Helios1.Sensors";
const PROFILE: &str = "io.github.pauloeduardods.Helios1.Profile";
const DAEMON: &str = "io.github.pauloeduardods.Helios1.Daemon";
const ERR: &str = "io.github.pauloeduardods.Helios1.Error";

const GPU_STATUS: &str = "sys/bus/pci/devices/0000:01:00.0/power/runtime_status";
const CLASS_PROFILE: &str = "sys/class/platform-profile/platform-profile-0/profile";
const LEGACY_PROFILE: &str = "sys/firmware/acpi/platform_profile";
const CPU_TEMP: &str = "sys/class/hwmon/hwmon5/temp1_input";
const RAPL_ENERGY: &str = "sys/class/powercap/intel-rapl:0/energy_uj";
const AC_ONLINE: &str = "sys/class/power_supply/ACAD/online";
const BAT: &str = "sys/class/power_supply/BAT1";

type Battery = (String, String, f64, f64, f64, i32, i32);

const BUS_CONFIG: &str = r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#;

fn temp_dir() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "heliosd-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Kills the child when dropped, even if the test panics.
struct Reaper(Child);

impl Drop for Reaper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Debug, Clone, PartialEq)]
struct AuthCall {
    kind: String,
    name: String,
    action: String,
}

struct FakeAuthority {
    allow: bool,
    calls: Arc<Mutex<Vec<AuthCall>>>,
}

#[interface(name = "org.freedesktop.PolicyKit1.Authority")]
impl FakeAuthority {
    fn check_authorization(
        &self,
        subject: (String, HashMap<String, OwnedValue>),
        action_id: String,
        _details: HashMap<String, String>,
        _flags: u32,
        _cancellation_id: String,
    ) -> (bool, bool, HashMap<String, String>) {
        let name = subject
            .1
            .get("name")
            .and_then(|v| String::try_from(v.clone()).ok())
            .unwrap_or_default();
        self.calls.lock().unwrap().push(AuthCall {
            kind: subject.0,
            name,
            action: action_id,
        });
        (self.allow, false, HashMap::new())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Polkit {
    Allow,
    Deny,
    Missing,
}

struct Harness {
    root: PathBuf,
    smi_log: PathBuf,
    client: Connection,
    auth_calls: Arc<Mutex<Vec<AuthCall>>>,
    // Field order matters: stop heliosd before its bus, delete files last.
    _heliosd: Reaper,
    _polkit: Option<Connection>,
    _bus: Reaper,
    _tmp: TempDir,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Harness {
    async fn start(polkit: Polkit) -> Self {
        let base = temp_dir();

        let root = base.join("root");
        for (path, value) in PHN16_72 {
            let file = root.join(path.trim_start_matches('/'));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, format!("{value}\n")).unwrap();
        }
        // As on a real kernel, both profile files show the same value.
        fs::remove_file(root.join(LEGACY_PROFILE)).unwrap();
        std::os::unix::fs::symlink(root.join(CLASS_PROFILE), root.join(LEGACY_PROFILE)).unwrap();

        let smi_log = base.join("smi.log");
        let smi = base.join("nvidia-smi");
        fs::write(
            &smi,
            format!(
                "#!/bin/sh\necho run >> '{}'\necho '47, 35.2'\n",
                smi_log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&smi, fs::Permissions::from_mode(0o755)).unwrap();

        let config = base.join("bus.conf");
        fs::write(&config, BUS_CONFIG).unwrap();
        let mut bus = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon is required for these tests");
        let mut address = String::new();
        BufReader::new(bus.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let address = address.trim().to_owned();
        let bus = Reaper(bus);

        let connect = || async {
            zbus::connection::Builder::address(address.as_str())
                .unwrap()
                .build()
                .await
                .unwrap()
        };

        let auth_calls = Arc::new(Mutex::new(Vec::new()));
        let polkit_conn = if polkit == Polkit::Missing {
            None
        } else {
            let conn = connect().await;
            let authority = FakeAuthority {
                allow: polkit == Polkit::Allow,
                calls: Arc::clone(&auth_calls),
            };
            conn.object_server()
                .at("/org/freedesktop/PolicyKit1/Authority", authority)
                .await
                .unwrap();
            conn.request_name("org.freedesktop.PolicyKit1")
                .await
                .unwrap();
            Some(conn)
        };

        let heliosd = Reaper(
            Command::new(env!("CARGO_BIN_EXE_heliosd"))
                .env("DBUS_SESSION_BUS_ADDRESS", &address)
                .args(["--bus", "session", "--interval-ms", "100"])
                .arg("--sysfs-root")
                .arg(&root)
                .arg("--nvidia-smi")
                .arg(&smi)
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );

        let client = connect().await;
        let dbus = zbus::fdo::DBusProxy::new(&client).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !dbus.name_has_owner(NAME.try_into().unwrap()).await.unwrap() {
            assert!(Instant::now() < deadline, "heliosd did not claim its name");
            Timer::after(Duration::from_millis(20)).await;
        }

        Self {
            root,
            smi_log,
            client,
            auth_calls,
            _heliosd: heliosd,
            _polkit: polkit_conn,
            _bus: bus,
            _tmp: TempDir(base),
        }
    }

    async fn proxy(&self, iface: &'static str) -> zbus::Proxy<'static> {
        zbus::proxy::Builder::new(&self.client)
            .destination(NAME)
            .unwrap()
            .path(PATH)
            .unwrap()
            .interface(iface)
            .unwrap()
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .unwrap()
    }

    async fn get<T>(&self, iface: &'static str, prop: &str) -> T
    where
        T: TryFrom<OwnedValue>,
        T::Error: Into<zbus::Error>,
    {
        self.proxy(iface).await.get_property(prop).await.unwrap()
    }

    /// The D-Bus error name of a failed `SetProfile`, or "ok".
    async fn set_profile(&self, value: &str) -> String {
        match self
            .proxy(PROFILE)
            .await
            .call_method("SetProfile", &(value,))
            .await
        {
            Ok(_) => "ok".to_owned(),
            Err(zbus::Error::MethodError(name, _, _)) => name.to_string(),
            Err(e) => panic!("unexpected error: {e}"),
        }
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path))
            .unwrap()
            .trim()
            .to_owned()
    }

    fn write(&self, path: &str, value: &str) {
        fs::write(self.root.join(path), value).unwrap();
    }

    fn smi_runs(&self) -> usize {
        fs::read_to_string(&self.smi_log).map_or(0, |s| s.lines().count())
    }

    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() && !path.is_symlink() {
                    walk(&path, out);
                } else {
                    out.insert(path.clone(), fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &mut out);
        out
    }

    fn auth_calls(&self) -> Vec<AuthCall> {
        self.auth_calls.lock().unwrap().clone()
    }

    /// Polls a property until `ok` accepts it, for up to 5 s.
    async fn wait_for<T, F>(&self, iface: &'static str, prop: &str, ok: F) -> T
    where
        T: TryFrom<OwnedValue> + std::fmt::Debug,
        T::Error: Into<zbus::Error>,
        F: Fn(&T) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let value: T = self.get(iface, prop).await;
            if ok(&value) {
                return value;
            }
            assert!(Instant::now() < deadline, "{prop} stayed at {value:?}");
            Timer::after(Duration::from_millis(50)).await;
        }
    }
}

fn err(name: &str) -> String {
    format!("{ERR}.{name}")
}

#[test]
fn properties_reflect_the_sysfs_tree() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;

        let cpu: (String, bool, f64) = h.get(SENSORS, "Cpu").await;
        assert_eq!(cpu, ("hwmon:coretemp/Package id 0".into(), true, 61.0));
        let gpu: (String, String, bool, f64) = h.get(SENSORS, "Gpu").await;
        assert_eq!(gpu, ("nvidia-smi".into(), "off".into(), false, 0.0));
        let fans: Vec<(String, i32)> = h.get(SENSORS, "Fans").await;
        assert_eq!(fans, [("Fan 1".into(), 2350), ("Fan 2".into(), 2600)]);
        let temps: Vec<(String, String, String, f64)> = h.get(SENSORS, "Temperatures").await;
        assert_eq!(temps.len(), 4);
        assert_eq!(
            h.get::<(bool, f64)>(SENSORS, "GpuPower").await,
            (false, 0.0)
        );
        assert_eq!(
            h.get::<(bool, f64)>(SENSORS, "CpuPower").await,
            (false, 0.0),
            "one read of the counter is not enough"
        );
        assert_eq!(h.get::<String>(SENSORS, "PowerSource").await, "ac");
        assert_eq!(
            h.get::<Battery>(SENSORS, "Battery").await,
            ("BAT1".into(), "not-charging".into(), 80.0, 0.0, 92.0, 0, -1)
        );

        assert!(h.get::<bool>(PROFILE, "Available").await);
        assert_eq!(h.get::<String>(PROFILE, "Active").await, "balanced");
        assert_eq!(h.get::<String>(PROFILE, "Driver").await, "acer-wmi");
        let choices: Vec<String> = h.get(PROFILE, "Choices").await;
        assert_eq!(
            choices,
            [
                "low-power",
                "quiet",
                "balanced",
                "balanced-performance",
                "performance"
            ]
        );

        assert_eq!(h.get::<u32>(DAEMON, "ApiVersion").await, 3);
        assert_eq!(
            h.get::<String>(DAEMON, "Version").await,
            env!("CARGO_PKG_VERSION")
        );
    });
}

#[test]
fn set_profile_writes_a_listed_choice_when_polkit_allows() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        assert_eq!(h.set_profile("quiet").await, "ok");
        assert_eq!(h.read(CLASS_PROFILE), "quiet");
        assert_eq!(h.get::<String>(PROFILE, "Active").await, "quiet");

        let caller = h.client.unique_name().unwrap().to_string();
        assert_eq!(
            h.auth_calls(),
            [AuthCall {
                kind: "system-bus-name".into(),
                name: caller,
                action: "io.github.pauloeduardods.helios.set-profile".into(),
            }]
        );

        // Back-to-back writes are spaced out but all succeed.
        assert_eq!(h.set_profile("performance").await, "ok");
        assert_eq!(h.set_profile("balanced").await, "ok");
        assert_eq!(h.read(CLASS_PROFILE), "balanced");
    });
}

#[test]
fn set_profile_rejects_values_not_in_choices_without_asking_polkit() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        let before = h.snapshot();
        for value in [
            "max-power",
            "custom",
            "Balanced",
            "balanced\n",
            " quiet",
            "",
            "../../etc/passwd",
        ] {
            assert_eq!(
                h.set_profile(value).await,
                err("InvalidArgument"),
                "{value:?}"
            );
        }
        assert!(
            h.auth_calls().is_empty(),
            "invalid input must never reach polkit"
        );
        assert_eq!(h.snapshot(), before, "nothing was written");
        assert_eq!(h.get::<String>(PROFILE, "Active").await, "balanced");
    });
}

#[test]
fn polkit_denial_returns_an_error_and_writes_nothing() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Deny).await;
        let before = h.snapshot();
        assert_eq!(h.set_profile("quiet").await, err("NotAuthorized"));
        assert_eq!(h.auth_calls().len(), 1);
        assert_eq!(h.snapshot(), before, "nothing was written");
        assert_eq!(h.get::<String>(PROFILE, "Active").await, "balanced");
    });
}

#[test]
fn missing_polkit_fails_closed() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Missing).await;
        let before = h.snapshot();
        assert_eq!(h.set_profile("quiet").await, err("NotAuthorized"));
        assert_eq!(h.snapshot(), before);
    });
}

#[test]
fn suspended_gpu_is_never_queried_and_an_awake_one_is() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        // At 100 ms per tick this is about ten polls.
        Timer::after(Duration::from_millis(1000)).await;
        assert_eq!(h.smi_runs(), 0, "a suspended GPU must never be queried");
        let gpu: (String, String, bool, f64) = h.get(SENSORS, "Gpu").await;
        assert_eq!(gpu.1, "off");

        h.write(GPU_STATUS, "active\n");
        let gpu: (String, String, bool, f64) = h
            .wait_for(SENSORS, "Gpu", |g: &(String, String, bool, f64)| g.2)
            .await;
        assert_eq!(gpu, ("nvidia-smi".into(), "on".into(), true, 47.0));
        assert_eq!(
            h.get::<(bool, f64)>(SENSORS, "GpuPower").await,
            (true, 35.2)
        );
        Timer::after(Duration::from_millis(500)).await;
        assert_eq!(h.smi_runs(), 1, "rate-limited to one query per 10 s");

        h.write(GPU_STATUS, "suspended\n");
        h.wait_for(SENSORS, "Gpu", |g: &(String, String, bool, f64)| {
            g.1 == "off"
        })
        .await;
        assert_eq!(h.smi_runs(), 1);
    });
}

#[test]
fn sensor_changes_emit_properties_changed() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        let props = zbus::fdo::PropertiesProxy::builder(&h.client)
            .destination(NAME)
            .unwrap()
            .path(PATH)
            .unwrap()
            .build()
            .await
            .unwrap();
        let mut changes = props.receive_properties_changed().await.unwrap();

        h.write(CPU_TEMP, "75000\n");
        let wait = async {
            loop {
                let signal = changes.next().await.unwrap();
                let args = signal.args().unwrap();
                if args.interface_name() == SENSORS && args.changed_properties().contains_key("Cpu")
                {
                    return args
                        .changed_properties()
                        .keys()
                        .map(|k| k.to_string())
                        .collect::<Vec<_>>();
                }
            }
        };
        let timeout = async {
            Timer::after(Duration::from_secs(5)).await;
            panic!("no PropertiesChanged for Cpu");
        };
        let changed = future::or(wait, timeout).await;
        assert!(
            changed.contains(&"Temperatures".to_owned()),
            "one signal carries every change: {changed:?}"
        );
        assert!(
            !changed.contains(&"Fans".to_owned()),
            "unchanged properties are left out"
        );

        let cpu: (String, bool, f64) = h.get(SENSORS, "Cpu").await;
        assert_eq!(cpu.2, 75.0);
    });
}

#[test]
fn unplugging_publishes_the_battery_draw() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        h.write(&format!("{BAT}/current_now"), "1500000\n");
        h.write(&format!("{BAT}/status"), "Discharging\n");
        h.write(AC_ONLINE, "0\n");
        let battery = h
            .wait_for(SENSORS, "Battery", |b: &Battery| b.1 == "discharging")
            .await;
        assert_eq!(
            battery,
            (
                "BAT1".into(),
                "discharging".into(),
                80.0,
                24.5,
                92.0,
                0,
                172
            )
        );
        assert_eq!(h.get::<String>(SENSORS, "PowerSource").await, "battery");
    });
}

#[test]
fn cpu_power_is_averaged_over_the_window() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        // 100 J more than at startup; heliosd polls every 100 ms here but
        // still averages over at least 2 s, so this is at most 50 W.
        h.write(RAPL_ENERGY, "1100000000\n");
        let (_, watts) = h
            .wait_for(SENSORS, "CpuPower", |p: &(bool, f64)| p.0 && p.1 > 0.0)
            .await;
        assert!(watts <= 50.0, "{watts} W over less than 2 s");
    });
}

#[test]
fn external_profile_changes_are_published() {
    async_io::block_on(async {
        let h = Harness::start(Polkit::Allow).await;
        // The mode key or power-profiles-daemon changed it behind our back.
        h.write(CLASS_PROFILE, "performance\n");
        h.wait_for(PROFILE, "Active", |a: &String| a == "performance")
            .await;
        assert!(h.auth_calls().is_empty());
    });
}
