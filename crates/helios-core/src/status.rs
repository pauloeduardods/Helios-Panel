// SPDX-License-Identifier: GPL-3.0-or-later
//! One snapshot of everything Helios reports. Serialized as-is by
//! `heliosctl status --json`; heliosd publishes the same data over D-Bus.

use serde::Serialize;

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use crate::cpu::{self, CpuUsageMeter, FrequencyReader};
use crate::hwmon::{self, DeviceKind, milli_to_celsius};
use crate::io::{Clock, GpuQuery, SysFs, read_int};
use crate::memory;
use crate::nvidia::{GpuState, NvidiaGpu};
use crate::power::{PowerMonitor, PowerStatus};
use crate::profile::{self, ProfileState};
use crate::rapl::CpuPowerMeter;

/// Bumped on incompatible changes to the JSON layout.
pub const SCHEMA_VERSION: u32 = 1;

/// Source id of the NVIDIA reader in [`GpuStatus::source`].
pub const NVIDIA_SMI_SOURCE: &str = "nvidia-smi";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub schema: u32,
    pub cpu: CpuStatus,
    pub gpu: GpuStatus,
    pub fans: Vec<FanStatus>,
    pub memory: MemoryStatus,
    pub power: PowerStatus,
    pub profile: ProfileState,
    pub temperatures: Vec<TempStatus>,
    /// Drives and network cards.
    pub devices: Vec<DeviceStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CpuStatus {
    pub sensor: Option<String>,
    pub celsius: Option<f64>,
    /// Package draw from RAPL; needs root and two polls.
    pub watts: Option<f64>,
    /// All CPUs, whole percent; needs two polls.
    pub usage_percent: Option<f64>,
    /// Across the cores, GHz.
    pub average_ghz: Option<f64>,
    pub max_ghz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GpuStatus {
    pub source: Option<String>,
    pub state: GpuState,
    pub celsius: Option<f64>,
    /// Board power draw; only from nvidia-smi.
    pub watts: Option<f64>,
    pub usage_percent: Option<f64>,
}

/// RAM in use: everything but what the kernel reports as available.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryStatus {
    /// GiB, rounded to 0.1.
    pub used_gib: Option<f64>,
    pub total_gib: Option<f64>,
    /// Whole percent.
    pub usage_percent: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceStatus {
    pub kind: DeviceKind,
    pub name: String,
    pub celsius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FanStatus {
    pub label: String,
    pub rpm: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TempStatus {
    pub id: String,
    pub chip: String,
    pub label: String,
    pub celsius: Option<f64>,
}

/// Rounds to 0.1 °C so sensor noise does not look like a change.
fn round_tenth(celsius: f64) -> f64 {
    (celsius * 10.0).round() / 10.0
}

/// Which sensors exist (hwmon chips, their labels, drive models, the battery,
/// RAPL and cpufreq directories) is found once and kept, then found again
/// this often, or on the next poll when a file that read before stops
/// reading (a driver reloaded, hwmon renumbered, a device unplugged).
pub const RESCAN_INTERVAL: Duration = Duration::from_secs(30);

/// Drive temperatures are read this often instead of every poll, keeping
/// the last value in between. Each read is a command to the drive (an NVMe
/// SMART log page) that takes milliseconds and wakes it from its power-saving
/// state, and a drive's temperature changes slowly.
pub const STORAGE_READ_INTERVAL: Duration = Duration::from_secs(30);

/// The hwmon side of discovery.
#[derive(Debug)]
struct Discovery {
    chips: Vec<hwmon::Chip>,
    cpu: Option<hwmon::SensorRef>,
    amd_gpu: Option<hwmon::SensorRef>,
    fans: Vec<hwmon::Input>,
    devices: Vec<hwmon::DeviceSensor>,
    at: Duration,
    /// Inputs that did not read on the first poll after the scan (some
    /// drivers return EIO for good); they never trigger a rescan.
    dead: BTreeSet<String>,
    /// The first poll after the scan has not happened yet.
    fresh: bool,
    /// An input that read before has stopped: scan again.
    stale: bool,
    /// This poll's values, so an input shown twice (the CPU sensor is also
    /// in the full list) is read once.
    values: BTreeMap<String, Option<i64>>,
    /// Inputs of drive chips, read every [`STORAGE_READ_INTERVAL`]: their
    /// last value and when it was read.
    slow: BTreeMap<String, Option<(Option<i64>, Duration)>>,
    /// The time of the current poll.
    now: Duration,
}

impl Discovery {
    fn scan(fs: &dyn SysFs, now: Duration) -> Self {
        let chips = hwmon::scan(fs);
        let slow = chips
            .iter()
            .filter(|c| hwmon::device_kind(&c.name) == Some(hwmon::DeviceKind::Storage))
            .flat_map(|c| c.temps.iter().map(|t| (t.path.clone(), None)))
            .collect();
        Self {
            slow,
            now,
            cpu: hwmon::resolve_cpu(&chips, ""),
            amd_gpu: hwmon::resolve_amd_gpu(&chips),
            fans: hwmon::resolve_fans(&chips),
            devices: hwmon::resolve_devices(fs, &chips),
            chips,
            at: now,
            dead: BTreeSet::new(),
            fresh: true,
            stale: false,
            values: BTreeMap::new(),
        }
    }

    /// Reads one input, noting failures.
    fn read(&mut self, fs: &dyn SysFs, path: &str) -> Option<i64> {
        if let Some(value) = self.values.get(path) {
            return *value;
        }
        if let Some(Some((value, at))) = self.slow.get(path) {
            if self.now.saturating_sub(*at) < STORAGE_READ_INTERVAL {
                return *value;
            }
        }
        let value = read_int(fs, path);
        if let Some(held) = self.slow.get_mut(path) {
            *held = Some((value, self.now));
        }
        self.values.insert(path.to_owned(), value);
        if value.is_none() {
            if self.fresh {
                self.dead.insert(path.to_owned());
            } else if !self.dead.contains(path) {
                self.stale = true;
            }
        }
        value
    }
}

/// Keeps the state that must survive between polls (the NVIDIA rate limit,
/// the averaged battery draw, the last RAPL counter).
#[derive(Debug)]
pub struct Monitor {
    nvidia: Option<NvidiaGpu>,
    power: PowerMonitor,
    cpu_power: CpuPowerMeter,
    cpu_usage: CpuUsageMeter,
    frequency: FrequencyReader,
    discovery: Option<Discovery>,
}

impl Monitor {
    pub fn new(fs: &dyn SysFs) -> Self {
        Self {
            nvidia: NvidiaGpu::detect(fs),
            power: PowerMonitor::default(),
            cpu_power: CpuPowerMeter::default(),
            cpu_usage: CpuUsageMeter::default(),
            frequency: FrequencyReader::default(),
            discovery: None,
        }
    }

    /// The cached discovery, redone when due.
    fn discovery(&mut self, fs: &dyn SysFs, now: Duration) -> Discovery {
        let due = self
            .discovery
            .as_ref()
            .is_none_or(|d| d.stale || now.saturating_sub(d.at) >= RESCAN_INTERVAL);
        if due {
            self.power.forget();
            self.cpu_power.forget();
            self.frequency.forget();
            return Discovery::scan(fs, now);
        }
        self.discovery.take().expect("checked above")
    }

    /// How long a one-shot reader (heliosctl) should wait before a second
    /// poll that fills the readings needing two reads; `None` when the first
    /// poll already has everything it can get.
    pub fn settle_time(&self) -> Option<std::time::Duration> {
        if self.cpu_power.pending() {
            Some(crate::rapl::WINDOW)
        } else if self.cpu_usage.pending() {
            Some(cpu::USAGE_SETTLE)
        } else {
            None
        }
    }

    /// `gpu_query` is `None` when nvidia-smi is not installed.
    pub fn poll(
        &mut self,
        fs: &dyn SysFs,
        gpu_query: Option<&dyn GpuQuery>,
        clock: &dyn Clock,
    ) -> Status {
        let now = clock.now();
        let mut found = self.discovery(fs, now);
        found.now = now;
        let celsius = |found: &mut Discovery, path: &str| {
            found
                .read(fs, path)
                .map(|m| round_tenth(milli_to_celsius(m)))
        };

        let frequency = self.frequency.read(fs);
        let cpu = CpuStatus {
            celsius: found.cpu.clone().and_then(|s| celsius(&mut found, &s.path)),
            sensor: found.cpu.as_ref().map(|s| s.id()),
            watts: self.cpu_power.read(fs, clock),
            usage_percent: self.cpu_usage.read(fs),
            average_ghz: frequency.map(|f| f.average),
            max_ghz: frequency.map(|f| f.max),
        };

        let gpu = if let Some(amd) = found.amd_gpu.clone() {
            let chip_dir = amd.path.rsplit_once('/').map_or("", |(dir, _)| dir);
            GpuStatus {
                celsius: celsius(&mut found, &amd.path),
                source: Some(amd.id()),
                state: GpuState::On,
                watts: None,
                usage_percent: read_int(fs, &format!("{chip_dir}/device/gpu_busy_percent"))
                    .filter(|p| (0..=100).contains(p))
                    .map(|p| p as f64),
            }
        } else if let (Some(nvidia), Some(query)) = (self.nvidia.as_mut(), gpu_query) {
            let reading = nvidia.read(fs, query, clock);
            GpuStatus {
                source: Some(NVIDIA_SMI_SOURCE.to_owned()),
                state: reading.state,
                celsius: reading.celsius.map(round_tenth),
                watts: reading.watts.map(round_tenth),
                usage_percent: reading.usage.map(f64::round),
            }
        } else {
            GpuStatus {
                source: None,
                state: GpuState::None,
                celsius: None,
                watts: None,
                usage_percent: None,
            }
        };

        let fans = found
            .fans
            .clone()
            .into_iter()
            .map(|f| FanStatus {
                rpm: found.read(fs, &f.path),
                label: f.label,
            })
            .collect();

        let inputs: Vec<(String, String, String)> = found
            .chips
            .iter()
            .flat_map(|c| {
                c.temps
                    .iter()
                    .map(|t| (c.name.clone(), t.label.clone(), t.path.clone()))
            })
            .collect();
        let temperatures = inputs
            .into_iter()
            .map(|(chip, label, path)| TempStatus {
                id: hwmon::sensor_id(&chip, &label),
                celsius: celsius(&mut found, &path),
                chip,
                label,
            })
            .collect();

        let devices = found
            .devices
            .clone()
            .into_iter()
            .map(|d| DeviceStatus {
                celsius: celsius(&mut found, &d.path),
                kind: d.kind,
                name: d.name,
            })
            .collect();

        found.fresh = false;
        found.values.clear();
        self.discovery = Some(found);

        let memory = memory::read(fs);
        let memory = MemoryStatus {
            used_gib: memory.map(|m| m.used_gib),
            total_gib: memory.map(|m| m.total_gib),
            usage_percent: memory.map(|m| m.percent),
        };

        Status {
            schema: SCHEMA_VERSION,
            cpu,
            gpu,
            fans,
            memory,
            power: self.power.poll(fs, clock),
            profile: profile::read_state(fs),
            temperatures,
            devices,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeClock, FakeFs, FakeGpu, PHN16_72};
    use serde_json::json;

    const STATUS: &str = "/sys/bus/pci/devices/0000:01:00.0/power/runtime_status";

    #[test]
    fn phn16_72_with_the_gpu_asleep() {
        let fs = FakeFs::new(PHN16_72);
        let smi = FakeGpu::new("47");
        let status = Monitor::new(&fs).poll(&fs, Some(&smi), &FakeClock::default());
        assert_eq!(smi.calls(), 0);
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "schema": 1,
                "cpu": {
                    "sensor": "hwmon:coretemp/Package id 0", "celsius": 61.0, "watts": null,
                    "usage_percent": null, "average_ghz": 2.1, "max_ghz": 4.8,
                },
                "gpu": {
                    "source": "nvidia-smi", "state": "off", "celsius": null, "watts": null,
                    "usage_percent": null,
                },
                "fans": [{"label": "Fan 1", "rpm": 2350}, {"label": "Fan 2", "rpm": 2600}],
                "memory": {"used_gib": 12.4, "total_gib": 31.1, "usage_percent": 40.0},
                "power": {
                    "source": "ac",
                    "battery": {
                        "name": "BAT1", "state": "not-charging", "percent": 80.0, "watts": 0.0,
                        "health_percent": 92.0, "cycles": 0, "minutes_left": null,
                    },
                },
                "profile": {
                    "available": true, "active": "balanced", "driver": "acer-wmi",
                    "choices": ["low-power", "quiet", "balanced", "balanced-performance", "performance"],
                },
                "temperatures": [
                    {"id": "hwmon:acpitz/temp1", "chip": "acpitz", "label": "temp1", "celsius": 45.0},
                    {"id": "hwmon:iwlwifi_1_6/temp1", "chip": "iwlwifi_1_6", "label": "temp1", "celsius": 52.0},
                    {"id": "hwmon:acer/temp1", "chip": "acer", "label": "temp1", "celsius": 52.0},
                    {"id": "hwmon:nvme/Composite", "chip": "nvme", "label": "Composite", "celsius": 47.9},
                    {"id": "hwmon:nvme/Sensor 1", "chip": "nvme", "label": "Sensor 1", "celsius": 47.9},
                    {"id": "hwmon:coretemp/Package id 0", "chip": "coretemp", "label": "Package id 0", "celsius": 61.0},
                    {"id": "hwmon:coretemp/Core 0", "chip": "coretemp", "label": "Core 0", "celsius": 58.0},
                    // Same id as the other drive: hwmon ids cannot tell two
                    // drives apart, which is why `devices` exists.
                    {"id": "hwmon:nvme/Composite", "chip": "nvme", "label": "Composite", "celsius": 44.9},
                ],
                "devices": [
                    {"kind": "storage", "name": "CT500P2SSD8", "celsius": 44.9},
                    {"kind": "storage", "name": "SAMSUNG MZVL21T0HCLR-00B07", "celsius": 47.9},
                    {"kind": "wifi", "name": "Wi-Fi", "celsius": 52.0},
                ],
            })
        );
        assert!(fs.writes().is_empty(), "status is read-only");
    }

    #[test]
    fn phn16_72_with_the_gpu_awake() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let smi = FakeGpu::new("47, 35.23, 30.4\n");
        let status = Monitor::new(&fs).poll(&fs, Some(&smi), &FakeClock::default());
        assert_eq!(
            status.gpu,
            GpuStatus {
                source: Some("nvidia-smi".into()),
                state: GpuState::On,
                celsius: Some(47.0),
                watts: Some(35.2),
                usage_percent: Some(30.0),
            }
        );
        assert_eq!(smi.calls(), 1);
    }

    #[test]
    fn cpu_draw_and_usage_need_a_second_poll() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let first = monitor.poll(&fs, None, &clock);
        assert_eq!((first.cpu.watts, first.cpu.usage_percent), (None, None));
        assert_eq!(
            monitor.settle_time(),
            Some(crate::rapl::WINDOW),
            "the longer wait wins"
        );

        fs.set("/sys/class/powercap/intel-rapl:0/energy_uj", "1024680000");
        fs.set("/proc/stat", "cpu  1100 0 630 9750 220 0 0 0 0 0\n");
        clock.advance(2);
        let second = monitor.poll(&fs, None, &clock);
        assert_eq!(second.cpu.watts, Some(12.3));
        assert_eq!(second.cpu.usage_percent, Some(23.0));
        assert_eq!(monitor.settle_time(), None);
    }

    #[test]
    fn as_a_normal_user_only_usage_needs_to_settle() {
        let fs =
            FakeFs::new(PHN16_72).with_unreadable("/sys/class/powercap/intel-rapl:0/energy_uj");
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, None, &FakeClock::default());
        assert_eq!(monitor.settle_time(), Some(cpu::USAGE_SETTLE));
    }

    /// The footprint budget: after the first poll, a poll lists one
    /// directory (the platform-profile class) and reads only values.
    #[test]
    fn a_steady_poll_reads_only_values() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, None, &clock);
        let (first, _) = fs.take_access_log();
        clock.advance(2);
        monitor.poll(&fs, None, &clock);
        let (reads, listings) = fs.take_access_log();

        assert_eq!(listings, ["/sys/class/platform-profile"]);
        let unique: BTreeSet<_> = reads.iter().collect();
        assert_eq!(
            unique.len(),
            reads.len(),
            "no file is read twice: {reads:#?}"
        );
        assert!(
            !reads.iter().any(
                |p| p.ends_with("/name") && p.starts_with("/sys/class/hwmon")
                    || p.ends_with("_label")
                    || p.ends_with("/model")
                    || p.ends_with("/type")
            ),
            "no discovery files: {reads:#?}"
        );
        assert!(reads.len() <= 32, "{} reads: {reads:#?}", reads.len());
        assert!(
            first.len() > reads.len(),
            "the first poll does the discovery"
        );
    }

    #[test]
    fn drive_temperatures_are_read_every_storage_interval() {
        const NVME: &str = "/sys/class/hwmon/hwmon6/temp1_input";
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let drive = |s: &Status| s.devices[0].celsius;
        assert_eq!(drive(&monitor.poll(&fs, None, &clock)), Some(44.9));

        fs.set(NVME, "50000");
        let mut reads = 0;
        for _ in 0..14 {
            clock.advance(2);
            fs.take_access_log();
            let status = monitor.poll(&fs, None, &clock);
            reads += fs.take_access_log().0.iter().filter(|p| *p == NVME).count();
            assert_eq!(drive(&status), Some(44.9), "the held value");
        }
        assert_eq!(reads, 0, "not read again within 30 s");

        clock.advance(2);
        assert_eq!(
            drive(&monitor.poll(&fs, None, &clock)),
            Some(50.0),
            "read at 30 s"
        );
    }

    #[test]
    fn a_sensor_that_stops_reading_triggers_a_rescan() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, None, &clock);
        clock.advance(2);

        // The Wi-Fi card's driver is reloaded: its hwmon chip goes away.
        fs.remove("/sys/class/hwmon/hwmon10/temp1_input");
        fs.remove("/sys/class/hwmon/hwmon10/name");
        let status = monitor.poll(&fs, None, &clock);
        assert_eq!(
            status.devices.len(),
            3,
            "still listed this poll, without a value"
        );
        fs.take_access_log();

        clock.advance(2);
        let status = monitor.poll(&fs, None, &clock);
        let (_, listings) = fs.take_access_log();
        assert!(
            listings.contains(&"/sys/class/hwmon".to_owned()),
            "{listings:?}"
        );
        assert_eq!(status.devices.len(), 2, "the next poll found it gone");
    }

    #[test]
    fn a_sensor_dead_from_the_start_never_triggers_a_rescan() {
        let fs = FakeFs::new(PHN16_72).with_unreadable("/sys/class/hwmon/hwmon0/temp1_input");
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, None, &clock);
        for _ in 0..5 {
            clock.advance(2);
            fs.take_access_log();
            monitor.poll(&fs, None, &clock);
            let (_, listings) = fs.take_access_log();
            assert!(!listings.contains(&"/sys/class/hwmon".to_owned()));
        }
    }

    #[test]
    fn discovery_is_redone_every_rescan_interval() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let mut scans = 0;
        for _ in 0..=(2 * RESCAN_INTERVAL.as_secs() / 2) {
            monitor.poll(&fs, None, &clock);
            let (_, listings) = fs.take_access_log();
            scans += listings.iter().filter(|l| *l == "/sys/class/hwmon").count();
            clock.advance(2);
        }
        assert_eq!(scans, 3, "at 0 s, 30 s and 60 s");
    }

    #[test]
    fn rate_limit_holds_across_polls() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let smi = FakeGpu::new("47");
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        for _ in 0..5 {
            monitor.poll(&fs, Some(&smi), &clock);
            clock.advance(2);
        }
        assert_eq!(
            smi.calls(),
            1,
            "five polls 2 s apart fit in one 10 s interval"
        );
    }

    #[test]
    fn no_nvidia_smi_means_no_gpu_source() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let status = Monitor::new(&fs).poll(&fs, None, &FakeClock::default());
        assert_eq!(
            status.gpu,
            GpuStatus {
                source: None,
                state: GpuState::None,
                celsius: None,
                watts: None,
                usage_percent: None,
            }
        );
    }

    #[test]
    fn amd_desktop() {
        let fs = FakeFs::new(AMD_DESKTOP);
        let status = Monitor::new(&fs).poll(&fs, None, &FakeClock::default());
        assert_eq!(status.cpu.sensor.as_deref(), Some("hwmon:k10temp/Tctl"));
        assert_eq!(status.cpu.celsius, Some(55.0));
        assert_eq!(
            status.gpu,
            GpuStatus {
                source: Some("hwmon:amdgpu/edge".into()),
                state: GpuState::On,
                celsius: Some(50.0),
                watts: None,
                usage_percent: Some(12.0),
            }
        );
        assert!(status.fans.is_empty());
        assert!(!status.profile.available);
        assert_eq!(status.power.battery, None);
        assert_eq!(status.temperatures.len(), 4);
        assert_eq!(
            status.cpu.usage_percent, None,
            "no /proc/stat in this fixture"
        );
        assert_eq!(status.cpu.average_ghz, None);
        assert_eq!(status.memory.usage_percent, None, "no /proc/meminfo either");
        assert!(status.devices.is_empty());
    }

    #[test]
    fn unreadable_sensors_have_no_value() {
        let fs = FakeFs::new(PHN16_72)
            .with_unreadable("/sys/class/hwmon/hwmon5/temp1_input")
            .with_unreadable("/sys/class/hwmon/hwmon3/fan2_input");
        let status = Monitor::new(&fs).poll(&fs, None, &FakeClock::default());
        assert_eq!(status.cpu.celsius, None);
        assert_eq!(status.fans[1].rpm, None);
    }

    #[test]
    fn temperatures_are_rounded_to_a_tenth() {
        assert_eq!(round_tenth(61.04), 61.0);
        assert_eq!(round_tenth(61.06), 61.1);
        assert_eq!(round_tenth(-0.04), -0.0);
    }
}
