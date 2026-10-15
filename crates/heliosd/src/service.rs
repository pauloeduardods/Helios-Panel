// SPDX-License-Identifier: GPL-3.0-or-later
//! The D-Bus objects and the state behind them.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_io::Timer;
use helios_core::history::History;
use helios_core::profile::{self, ProfileError};
use helios_core::status::{Monitor, Status};
use helios_core::{Clock, GpuQuery};
use helios_sys::{NvidiaSmi, RootedFs, SystemClock};
use zbus::fdo::Properties;
use zbus::message::Header;
use zbus::names::InterfaceName;
use zbus::object_server::SignalEmitter;
use zbus::{Connection, interface};

use crate::lighting::LightingProps;
use crate::polkit::{self, SET_PROFILE_ACTION};
use crate::props::{
    self, Battery, Changes, Cpu, CpuFrequency, CpuPower, Device, Fan, Gpu, GpuPower, Memory,
    ProfileProps, SensorsProps, Temperature, Usage,
};

pub const BUS_NAME: &str = "io.github.pauloeduardods.Helios1";
pub const OBJECT_PATH: &str = "/io/github/pauloeduardods/Helios1";
pub const SENSORS_IFACE: &str = "io.github.pauloeduardods.Helios1.Sensors";
pub const PROFILE_IFACE: &str = "io.github.pauloeduardods.Helios1.Profile";
/// 2 added GpuPower, PowerSource and Battery to Sensors; 3 added CpuPower;
/// 4 added CpuUsage, CpuFrequency, GpuUsage and Devices; 5 added the
/// GetHistory method; 6 added the Lighting interface; 7 added the logo
/// mode; 8 added Memory and the memory-usage history series.
pub const API_VERSION: u32 = 8;

/// Firmware profile switches are not instant; do not hammer the EC.
const MIN_WRITE_GAP: Duration = Duration::from_millis(250);

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "io.github.pauloeduardods.Helios1.Error")]
pub enum HeliosError {
    #[zbus(error)]
    ZBus(zbus::Error),
    InvalidArgument(String),
    NotAuthorized(String),
    Unavailable(String),
    WriteFailed(String),
}

impl From<ProfileError> for HeliosError {
    fn from(e: ProfileError) -> Self {
        match e {
            ProfileError::Unavailable => Self::Unavailable(e.to_string()),
            ProfileError::InvalidArgument(m) => Self::InvalidArgument(m),
            ProfileError::WriteFailed(m) => Self::WriteFailed(m),
        }
    }
}

/// Everything the interfaces share.
pub struct Shared {
    pub(crate) fs: RootedFs,
    smi: Option<NvidiaSmi>,
    clock: SystemClock,
    monitor: Mutex<Monitor>,
    history: Mutex<History>,
    published: Mutex<(SensorsProps, ProfileProps)>,
    pub(crate) lighting: Mutex<LightingProps>,
    /// Where the lighting state is saved (/var/lib/heliosd).
    pub(crate) state_dir: PathBuf,
    /// Serializes hardware writes and remembers when the last one happened.
    pub(crate) write_lock: async_lock::Mutex<Option<Instant>>,
    pub(crate) conn: Connection,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock leaves plain data behind; keep serving.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    pub fn new(
        conn: Connection,
        fs: RootedFs,
        smi: Option<NvidiaSmi>,
        state_dir: PathBuf,
    ) -> Arc<Self> {
        let clock = SystemClock::new();
        let mut monitor = Monitor::new(&fs);
        let first = monitor.poll(&fs, smi.as_ref().map(|s| s as &dyn GpuQuery), &clock);
        let mut history = History::default();
        history.record(clock.now(), &first);
        Arc::new(Self {
            history: Mutex::new(history),
            published: Mutex::new(((&first).into(), (&first).into())),
            monitor: Mutex::new(monitor),
            lighting: Mutex::new(LightingProps::default()),
            state_dir,
            fs,
            smi,
            clock,
            write_lock: async_lock::Mutex::new(None),
            conn,
        })
    }

    /// Blocking: may run nvidia-smi (up to its timeout). The result is also
    /// recorded in the history.
    pub fn poll(&self) -> Status {
        let smi = self.smi.as_ref().map(|s| s as &dyn GpuQuery);
        let status = lock(&self.monitor).poll(&self.fs, smi, &self.clock);
        lock(&self.history).record(self.clock.now(), &status);
        status
    }

    /// Publishes a new snapshot and returns what changed per interface.
    pub fn publish(
        &self,
        sensors: Option<SensorsProps>,
        profile: ProfileProps,
    ) -> (Changes, Changes) {
        let mut published = lock(&self.published);
        let sensor_changes = match sensors {
            Some(new) => {
                let changes = props::sensors_changes(&published.0, &new);
                published.0 = new;
                changes
            }
            None => Vec::new(),
        };
        let profile_changes = props::profile_changes(&published.1, &profile);
        published.1 = profile;
        (sensor_changes, profile_changes)
    }

    fn sensors(&self) -> SensorsProps {
        lock(&self.published).0.clone()
    }

    fn profile(&self) -> ProfileProps {
        lock(&self.published).1.clone()
    }
}

/// One `PropertiesChanged` for `iface` with every changed property.
pub async fn emit(
    emitter: &SignalEmitter<'_>,
    iface: &'static str,
    changes: Changes,
) -> zbus::Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let map: HashMap<&str, _> = changes.into_iter().collect();
    Properties::properties_changed(
        emitter,
        InterfaceName::from_static_str_unchecked(iface),
        map,
        Cow::Borrowed(&[]),
    )
    .await
}

pub struct DaemonIface;

#[interface(name = "io.github.pauloeduardods.Helios1.Daemon")]
impl DaemonIface {
    #[zbus(property(emits_changed_signal = "const"))]
    fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }

    #[zbus(property(emits_changed_signal = "const"))]
    fn api_version(&self) -> u32 {
        API_VERSION
    }
}

pub struct SensorsIface(pub Arc<Shared>);

#[interface(name = "io.github.pauloeduardods.Helios1.Sensors")]
impl SensorsIface {
    #[zbus(property)]
    fn cpu(&self) -> Cpu {
        self.0.sensors().cpu
    }

    #[zbus(property)]
    fn gpu(&self) -> Gpu {
        self.0.sensors().gpu
    }

    #[zbus(property)]
    fn fans(&self) -> Vec<Fan> {
        self.0.sensors().fans
    }

    #[zbus(property)]
    fn temperatures(&self) -> Vec<Temperature> {
        self.0.sensors().temperatures
    }

    #[zbus(property)]
    fn gpu_power(&self) -> GpuPower {
        self.0.sensors().gpu_power
    }

    #[zbus(property)]
    fn cpu_power(&self) -> CpuPower {
        self.0.sensors().cpu_power
    }

    #[zbus(property)]
    fn cpu_usage(&self) -> Usage {
        self.0.sensors().cpu_usage
    }

    #[zbus(property)]
    fn cpu_frequency(&self) -> CpuFrequency {
        self.0.sensors().cpu_frequency
    }

    #[zbus(property)]
    fn gpu_usage(&self) -> Usage {
        self.0.sensors().gpu_usage
    }

    #[zbus(property)]
    fn memory(&self) -> Memory {
        self.0.sensors().memory
    }

    #[zbus(property)]
    fn devices(&self) -> Vec<Device> {
        self.0.sensors().devices
    }

    /// The last five minutes: (ages in seconds before now, oldest first;
    /// per series: (name, valid flags, values)), all arrays aligned.
    fn get_history(&self) -> props::HistoryReply {
        let snapshot = lock(&self.0.history).snapshot(self.0.clock.now());
        props::history_reply(&snapshot)
    }

    #[zbus(property)]
    fn power_source(&self) -> String {
        self.0.sensors().power_source
    }

    #[zbus(property)]
    fn battery(&self) -> Battery {
        self.0.sensors().battery
    }
}

pub struct ProfileIface(pub Arc<Shared>);

#[interface(name = "io.github.pauloeduardods.Helios1.Profile")]
impl ProfileIface {
    #[zbus(property)]
    fn available(&self) -> bool {
        self.0.profile().available
    }

    #[zbus(property)]
    fn active(&self) -> String {
        self.0.profile().active
    }

    #[zbus(property)]
    fn choices(&self) -> Vec<String> {
        self.0.profile().choices
    }

    #[zbus(property)]
    fn driver(&self) -> String {
        self.0.profile().driver
    }

    /// Validates against the current choices, asks polkit, then writes.
    async fn set_profile(
        &self,
        profile: String,
        #[zbus(header)] header: Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<(), HeliosError> {
        let shared = &self.0;
        let caller = header.sender().map(|s| s.to_string()).unwrap_or_default();
        let log =
            |outcome: &str| eprintln!("heliosd: SetProfile({profile:?}) from {caller}: {outcome}");

        // Garbage is rejected before polkit, so it can never trigger a prompt.
        if let Err(e) = profile::validate(&shared.fs, &profile) {
            log(&format!("rejected: {e}"));
            return Err(e.into());
        }
        if let Err(reason) = polkit::authorize(&shared.conn, &caller, SET_PROFILE_ACTION).await {
            log(&format!("denied: {reason}"));
            return Err(HeliosError::NotAuthorized(reason));
        }

        let mut last_write = shared.write_lock.lock().await;
        if let Some(gap) = last_write.map(|t| MIN_WRITE_GAP.saturating_sub(t.elapsed())) {
            if !gap.is_zero() {
                Timer::after(gap).await;
            }
        }
        // Validate again: the choices may have changed while we waited.
        let result =
            profile::validate(&shared.fs, &profile).and_then(|t| profile::apply(&shared.fs, &t));
        *last_write = Some(Instant::now());
        drop(last_write);

        match result {
            Ok(readback) => log(&format!("ok, now {readback:?}")),
            Err(e) => {
                log(&format!("failed: {e}"));
                return Err(e.into());
            }
        }

        let state = profile::read_state(&shared.fs);
        let new = ProfileProps {
            available: state.available,
            active: state.active.unwrap_or_default(),
            choices: state.choices,
            driver: state.driver.unwrap_or_default(),
        };
        let (_, changes) = shared.publish(None, new);
        emit(&emitter, PROFILE_IFACE, changes).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! The files in data/ must agree with the code and keep the sandbox tight.
    use super::*;
    use crate::lighting::LIGHTING_IFACE;
    use crate::polkit::SET_LIGHTING_ACTION;

    const UNIT: &str = include_str!("../../../data/heliosd.service");
    const ACTIVATION: &str = include_str!("../../../data/io.github.pauloeduardods.Helios1.service");
    const BUS_POLICY: &str = include_str!("../../../data/io.github.pauloeduardods.Helios1.conf");
    const POLKIT: &str = include_str!("../../../data/io.github.pauloeduardods.helios.policy");

    fn unit_values(key: &str) -> Vec<&'static str> {
        UNIT.lines()
            .filter_map(|l| l.strip_prefix(key)?.strip_prefix('='))
            .collect()
    }

    #[test]
    fn names_match_the_code() {
        assert_eq!(unit_values("BusName"), [BUS_NAME]);
        assert!(ACTIVATION.contains(&format!("Name={BUS_NAME}\n")));
        assert!(ACTIVATION.contains("SystemdService=heliosd.service"));
        assert!(BUS_POLICY.contains(&format!("<allow own=\"{BUS_NAME}\"/>")));
        for iface in [
            SENSORS_IFACE,
            PROFILE_IFACE,
            LIGHTING_IFACE,
            "io.github.pauloeduardods.Helios1.Daemon",
        ] {
            assert!(
                BUS_POLICY.contains(&format!("send_interface=\"{iface}\"")),
                "{iface}"
            );
        }
        assert!(POLKIT.contains(&format!("<action id=\"{SET_PROFILE_ACTION}\">")));
        assert!(POLKIT.contains(&format!("<action id=\"{SET_LIGHTING_ACTION}\">")));
    }

    #[test]
    fn unit_runs_without_privileges() {
        assert_eq!(unit_values("CapabilityBoundingSet"), [""]);
        assert_eq!(unit_values("AmbientCapabilities"), [""]);
        assert_eq!(unit_values("NoNewPrivileges"), ["yes"]);
        assert_eq!(unit_values("ProtectSystem"), ["strict"]);
        assert_eq!(unit_values("ProtectKernelModules"), ["yes"]);
        assert_eq!(unit_values("PrivateNetwork"), ["yes"]);
        assert_eq!(unit_values("DevicePolicy"), ["closed"]);
        // Regression: the default seccomp action (kill) crashed nvidia-smi
        // on its chown() with SIGSYS; blocked calls must fail with EPERM.
        assert_eq!(unit_values("SystemCallErrorNumber"), ["EPERM"]);
        assert_eq!(
            unit_values("SystemCallFilter"),
            ["@system-service", "~@privileged @resources"],
            "the filter itself stays as tight as before"
        );
        assert_eq!(
            unit_values("ExecStart"),
            ["/usr/local/libexec/heliosd"],
            "no test hooks in production"
        );
    }

    #[test]
    fn unit_can_write_only_the_profile_lighting_and_its_state() {
        assert_eq!(
            unit_values("ReadWritePaths"),
            [
                "-/sys/firmware/acpi/platform_profile",
                "-/sys/devices/platform/acer-wmi/platform-profile",
                &format!("-{}", helios_core::lighting::KEYBOARD_FILE),
                &format!("-{}", helios_core::lighting::LOGO_FILE),
            ]
        );
        assert_eq!(unit_values("StateDirectory"), ["heliosd"]);
        assert_eq!(unit_values("StateDirectoryMode"), ["0700"]);
        assert_eq!(
            unit_values("DeviceAllow"),
            ["char-nvidia rw", "char-nvidiactl rw"]
        );
    }

    #[test]
    fn polkit_allows_only_active_local_sessions() {
        assert!(POLKIT.contains("<allow_any>no</allow_any>"));
        assert!(POLKIT.contains("<allow_inactive>no</allow_inactive>"));
        assert!(POLKIT.contains("<allow_active>yes</allow_active>"));
        assert_eq!(
            POLKIT.matches("<allow_active>yes</allow_active>").count(),
            POLKIT.matches("<action id=").count(),
            "every action has the same defaults"
        );
        assert_eq!(POLKIT.matches("<allow_any>no</allow_any>").count(), 2);
        assert_eq!(
            POLKIT
                .matches("<allow_inactive>no</allow_inactive>")
                .count(),
            2
        );
        assert_eq!(
            POLKIT.matches("<action id=").count(),
            2,
            "one action per kind of write"
        );
    }
}
