// SPDX-License-Identifier: GPL-3.0-or-later
//! One snapshot of everything Helios reports. Serialized as-is by
//! `heliosctl status --json`; heliosd publishes the same data over D-Bus.

use serde::Serialize;

use crate::hwmon::{self, milli_to_celsius};
use crate::io::{Clock, GpuQuery, SysFs, read_int};
use crate::nvidia::{GpuState, NvidiaGpu};
use crate::profile::{self, ProfileState};

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
    pub profile: ProfileState,
    pub temperatures: Vec<TempStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CpuStatus {
    pub sensor: Option<String>,
    pub celsius: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GpuStatus {
    pub source: Option<String>,
    pub state: GpuState,
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

fn read_celsius(fs: &dyn SysFs, path: &str) -> Option<f64> {
    read_int(fs, path).map(|m| round_tenth(milli_to_celsius(m)))
}

/// Keeps the state that must survive between polls (the NVIDIA rate limit).
#[derive(Debug)]
pub struct Monitor {
    nvidia: Option<NvidiaGpu>,
}

impl Monitor {
    pub fn new(fs: &dyn SysFs) -> Self {
        Self {
            nvidia: NvidiaGpu::detect(fs),
        }
    }

    /// `gpu_query` is `None` when nvidia-smi is not installed.
    pub fn poll(
        &mut self,
        fs: &dyn SysFs,
        gpu_query: Option<&dyn GpuQuery>,
        clock: &dyn Clock,
    ) -> Status {
        // Rescanned every time: hwmon numbering can change across resume.
        let chips = hwmon::scan(fs);

        let cpu = hwmon::resolve_cpu(&chips, "");
        let cpu = CpuStatus {
            celsius: cpu.as_ref().and_then(|s| read_celsius(fs, &s.path)),
            sensor: cpu.map(|s| s.id()),
        };

        let gpu = if let Some(amd) = hwmon::resolve_amd_gpu(&chips) {
            GpuStatus {
                celsius: read_celsius(fs, &amd.path),
                source: Some(amd.id()),
                state: GpuState::On,
            }
        } else if let (Some(nvidia), Some(query)) = (self.nvidia.as_mut(), gpu_query) {
            let reading = nvidia.read(fs, query, clock);
            GpuStatus {
                source: Some(NVIDIA_SMI_SOURCE.to_owned()),
                state: reading.state,
                celsius: reading.celsius.map(round_tenth),
            }
        } else {
            GpuStatus {
                source: None,
                state: GpuState::None,
                celsius: None,
            }
        };

        let fans = hwmon::resolve_fans(&chips)
            .into_iter()
            .map(|f| FanStatus {
                rpm: read_int(fs, &f.path),
                label: f.label,
            })
            .collect();

        let temperatures = chips
            .iter()
            .flat_map(|c| {
                c.temps.iter().map(|t| TempStatus {
                    id: hwmon::sensor_id(&c.name, &t.label),
                    chip: c.name.clone(),
                    label: t.label.clone(),
                    celsius: read_celsius(fs, &t.path),
                })
            })
            .collect();

        Status {
            schema: SCHEMA_VERSION,
            cpu,
            gpu,
            fans,
            profile: profile::read_state(fs),
            temperatures,
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
                "cpu": {"sensor": "hwmon:coretemp/Package id 0", "celsius": 61.0},
                "gpu": {"source": "nvidia-smi", "state": "off", "celsius": null},
                "fans": [{"label": "Fan 1", "rpm": 2350}, {"label": "Fan 2", "rpm": 2600}],
                "profile": {
                    "available": true, "active": "balanced", "driver": "acer-wmi",
                    "choices": ["low-power", "quiet", "balanced", "balanced-performance", "performance"],
                },
                "temperatures": [
                    {"id": "hwmon:acpitz/temp1", "chip": "acpitz", "label": "temp1", "celsius": 45.0},
                    {"id": "hwmon:acer/temp1", "chip": "acer", "label": "temp1", "celsius": 52.0},
                    {"id": "hwmon:coretemp/Package id 0", "chip": "coretemp", "label": "Package id 0", "celsius": 61.0},
                    {"id": "hwmon:coretemp/Core 0", "chip": "coretemp", "label": "Core 0", "celsius": 58.0},
                ],
            })
        );
        assert!(fs.writes().is_empty(), "status is read-only");
    }

    #[test]
    fn phn16_72_with_the_gpu_awake() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let smi = FakeGpu::new("47\n");
        let status = Monitor::new(&fs).poll(&fs, Some(&smi), &FakeClock::default());
        assert_eq!(
            status.gpu,
            GpuStatus {
                source: Some("nvidia-smi".into()),
                state: GpuState::On,
                celsius: Some(47.0)
            }
        );
        assert_eq!(smi.calls(), 1);
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
                celsius: None
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
                celsius: Some(50.0)
            }
        );
        assert!(status.fans.is_empty());
        assert!(!status.profile.available);
        assert_eq!(status.temperatures.len(), 4);
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
