// SPDX-License-Identifier: GPL-3.0-or-later
//! NVIDIA temperature without defeating runtime power management.
//!
//! The proprietary driver does not export hwmon temperatures, so the only
//! source is `nvidia-smi`, and every call powers the GPU up if it was asleep
//! (RTD3 / D3cold). So: read the PCI runtime-PM status first and never query
//! a GPU that is not awake, and space the queries further apart than the
//! autosuspend delay so our own polling cannot keep the card awake.

use std::time::Duration;

use serde::Serialize;

use crate::hwmon::find_nvidia_pci_dir;
use crate::io::{Clock, GpuQuery, SysFs, read_int};

/// Never query more often than this, whatever the autosuspend delay says.
pub const MIN_QUERY_INTERVAL: Duration = Duration::from_secs(10);

/// First line of `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`.
pub fn parse_smi_temp(output: &str) -> Option<f64> {
    let line = output.trim().lines().next()?.trim();
    let digits = line.strip_prefix('-').unwrap_or(line);
    let (int, frac) = digits.split_once('.').unwrap_or((digits, "0"));
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !numeric(int) || !numeric(frac) {
        return None;
    }
    line.parse().ok()
}

/// Every query resets the GPU's runtime-PM idle timer, so the interval is at
/// least twice the autosuspend delay plus a second. An unreadable delay (the
/// PHN16-72 with fine-grained RTD3 returns EIO) falls back to the minimum.
pub fn query_interval(autosuspend_ms: Option<i64>) -> Duration {
    let from_delay = autosuspend_ms
        .filter(|ms| *ms > 0)
        .map(|ms| Duration::from_secs((ms as u64 * 2).div_ceil(1000) + 1))
        .unwrap_or_default();
    from_delay.max(MIN_QUERY_INTERVAL)
}

/// `power/runtime_status` of a PCI device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStatus {
    Active,
    Suspended,
    Suspending,
    Resuming,
    /// Runtime PM disabled: the device is always powered.
    Unsupported,
    /// Missing or unrecognized: treated as asleep, never queried.
    Unknown,
}

impl RuntimeStatus {
    pub fn parse(text: Option<&str>) -> Self {
        match text {
            Some("active") => Self::Active,
            Some("suspended") => Self::Suspended,
            Some("suspending") => Self::Suspending,
            Some("resuming") => Self::Resuming,
            Some("unsupported") => Self::Unsupported,
            _ => Self::Unknown,
        }
    }

    /// Only an awake GPU may be queried: querying cannot wake it.
    pub fn is_awake(self) -> bool {
        matches!(self, Self::Active | Self::Unsupported)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuState {
    /// Awake; the temperature may still be unknown.
    On,
    /// Asleep; not queried.
    Off,
    /// No GPU temperature source.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GpuReading {
    pub state: GpuState,
    pub celsius: Option<f64>,
}

/// The NVIDIA GPU, gated on runtime PM and rate-limited.
#[derive(Debug)]
pub struct NvidiaGpu {
    pci_dir: String,
    interval: Duration,
    last_query: Option<Duration>,
    last_temp: Option<f64>,
}

impl NvidiaGpu {
    /// `None` when there is no NVIDIA display controller.
    pub fn detect(fs: &dyn SysFs) -> Option<Self> {
        let pci_dir = find_nvidia_pci_dir(fs)?;
        let autosuspend = read_int(fs, &format!("{pci_dir}/power/autosuspend_delay_ms"));
        Some(Self {
            interval: query_interval(autosuspend),
            pci_dir,
            last_query: None,
            last_temp: None,
        })
    }

    pub fn pci_dir(&self) -> &str {
        &self.pci_dir
    }

    pub fn interval(&self) -> Duration {
        self.interval
    }

    pub fn runtime_status(&self, fs: &dyn SysFs) -> RuntimeStatus {
        let text = fs.read_to_string(&format!("{}/power/runtime_status", self.pci_dir));
        RuntimeStatus::parse(text.as_deref())
    }

    pub fn read(&mut self, fs: &dyn SysFs, gpu: &dyn GpuQuery, clock: &dyn Clock) -> GpuReading {
        if !self.runtime_status(fs).is_awake() {
            self.last_temp = None;
            return GpuReading {
                state: GpuState::Off,
                celsius: None,
            };
        }
        let now = clock.now();
        let due = self
            .last_query
            .is_none_or(|last| now.saturating_sub(last) >= self.interval);
        if due {
            self.last_query = Some(now);
            self.last_temp = gpu.query_temperature().as_deref().and_then(parse_smi_temp);
        }
        GpuReading {
            state: GpuState::On,
            celsius: self.last_temp,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeClock, FakeFs, FakeGpu, PHN16_72};

    const STATUS: &str = "/sys/bus/pci/devices/0000:01:00.0/power/runtime_status";
    const DELAY: &str = "/sys/bus/pci/devices/0000:01:00.0/power/autosuspend_delay_ms";

    fn off() -> GpuReading {
        GpuReading {
            state: GpuState::Off,
            celsius: None,
        }
    }

    fn on(celsius: Option<f64>) -> GpuReading {
        GpuReading {
            state: GpuState::On,
            celsius,
        }
    }

    #[test]
    fn nvidia_smi_output_parsing() {
        assert_eq!(parse_smi_temp("48\n"), Some(48.0));
        assert_eq!(parse_smi_temp("48.5"), Some(48.5));
        assert_eq!(parse_smi_temp("-3"), Some(-3.0));
        assert_eq!(parse_smi_temp("[N/A]"), None);
        assert_eq!(parse_smi_temp("No devices were found"), None);
        assert_eq!(parse_smi_temp(""), None);
        assert_eq!(parse_smi_temp("4 8"), None);
        assert_eq!(parse_smi_temp("48."), None);
        assert_eq!(parse_smi_temp("inf"), None);
    }

    #[test]
    fn query_interval_never_undercuts_the_autosuspend_delay() {
        assert_eq!(query_interval(None), Duration::from_secs(10));
        assert_eq!(query_interval(Some(5000)), Duration::from_secs(11));
        assert_eq!(query_interval(Some(30000)), Duration::from_secs(61));
        assert_eq!(query_interval(Some(-1)), Duration::from_secs(10));
    }

    #[test]
    fn suspended_gpu_is_reported_off_and_never_queried() {
        for status in ["suspended", "suspending", "resuming", "garbage"] {
            let fs = FakeFs::new(PHN16_72);
            fs.set(STATUS, status);
            let smi = FakeGpu::new("47\n");
            let clock = FakeClock::starting_at(100);
            let mut gpu = NvidiaGpu::detect(&fs).unwrap();
            for _ in 0..5 {
                assert_eq!(gpu.read(&fs, &smi, &clock), off(), "status {status}");
                clock.advance(60);
            }
            assert_eq!(smi.calls(), 0, "status {status} must never run nvidia-smi");
        }
    }

    #[test]
    fn missing_runtime_status_is_never_queried() {
        let fs = FakeFs::new(PHN16_72).with_unreadable(STATUS);
        let smi = FakeGpu::new("47\n");
        let mut gpu = NvidiaGpu::detect(&fs).unwrap();
        assert_eq!(gpu.read(&fs, &smi, &FakeClock::default()), off());
        assert_eq!(smi.calls(), 0);
    }

    #[test]
    fn active_gpu_is_queried_then_rate_limited() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let smi = FakeGpu::new("47\n");
        let clock = FakeClock::starting_at(100);
        let mut gpu = NvidiaGpu::detect(&fs).unwrap();

        assert_eq!(gpu.read(&fs, &smi, &clock), on(Some(47.0)));
        clock.advance(2);
        assert_eq!(gpu.read(&fs, &smi, &clock), on(Some(47.0)));
        assert_eq!(
            smi.calls(),
            1,
            "second read within the interval used the cache"
        );

        clock.advance(20);
        smi.set_output(Some("[N/A]"));
        assert_eq!(gpu.read(&fs, &smi, &clock), on(None));
        assert_eq!(smi.calls(), 2);

        clock.advance(20);
        smi.set_output(None);
        assert_eq!(
            gpu.read(&fs, &smi, &clock),
            on(None),
            "a failed run is not fatal"
        );
        assert_eq!(smi.calls(), 3);
    }

    #[test]
    fn always_powered_gpu_is_queried() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "unsupported");
        let smi = FakeGpu::new("50");
        let mut gpu = NvidiaGpu::detect(&fs).unwrap();
        assert_eq!(gpu.read(&fs, &smi, &FakeClock::default()), on(Some(50.0)));
    }

    #[test]
    fn going_to_sleep_drops_the_cached_temperature_without_querying() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(STATUS, "active");
        let smi = FakeGpu::new("47");
        let clock = FakeClock::starting_at(100);
        let mut gpu = NvidiaGpu::detect(&fs).unwrap();
        assert_eq!(gpu.read(&fs, &smi, &clock), on(Some(47.0)));

        fs.set(STATUS, "suspended");
        clock.advance(60);
        assert_eq!(gpu.read(&fs, &smi, &clock), off());
        assert_eq!(smi.calls(), 1);

        fs.set(STATUS, "active");
        assert_eq!(gpu.read(&fs, &smi, &clock), on(Some(47.0)));
        assert_eq!(
            smi.calls(),
            2,
            "after waking up the GPU is queried again once due"
        );
    }

    #[test]
    fn interval_comes_from_the_autosuspend_delay() {
        let mut files = PHN16_72.to_vec();
        files.push((DELAY, "5000"));
        let gpu = NvidiaGpu::detect(&FakeFs::new(&files)).unwrap();
        assert_eq!(gpu.interval(), Duration::from_secs(11));

        let eio = FakeFs::new(PHN16_72).with_unreadable(DELAY);
        assert_eq!(
            NvidiaGpu::detect(&eio).unwrap().interval(),
            MIN_QUERY_INTERVAL
        );
    }

    #[test]
    fn no_nvidia_device_means_no_reader() {
        assert!(NvidiaGpu::detect(&FakeFs::new(crate::fake::AMD_DESKTOP)).is_none());
    }
}
