// SPDX-License-Identifier: GPL-3.0-or-later
//! In-memory fakes and fixture trees for tests. Never used by a shipped binary.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use crate::io::{Clock, GpuQuery, SysFs};

/// Roughly what a PHN16-72 (i9-14900HX + RTX 4070 Max-Q) with acer_wmi
/// predator_v4=1 looks like, with the NVIDIA GPU asleep (RTD3).
pub const PHN16_72: &[(&str, &str)] = &[
    ("/sys/class/hwmon/hwmon0/name", "acpitz"),
    ("/sys/class/hwmon/hwmon0/temp1_input", "45000"),
    ("/sys/class/hwmon/hwmon3/name", "acer"),
    ("/sys/class/hwmon/hwmon3/fan1_input", "2350"),
    ("/sys/class/hwmon/hwmon3/fan2_input", "2600"),
    ("/sys/class/hwmon/hwmon3/temp1_input", "52000"),
    ("/sys/class/hwmon/hwmon5/name", "coretemp"),
    ("/sys/class/hwmon/hwmon5/temp1_input", "61000"),
    ("/sys/class/hwmon/hwmon5/temp1_label", "Package id 0"),
    ("/sys/class/hwmon/hwmon5/temp2_input", "58000"),
    ("/sys/class/hwmon/hwmon5/temp2_label", "Core 0"),
    ("/sys/bus/pci/devices/0000:00:02.0/vendor", "0x8086"),
    ("/sys/bus/pci/devices/0000:00:02.0/class", "0x030000"),
    ("/sys/bus/pci/devices/0000:01:00.1/vendor", "0x10de"),
    ("/sys/bus/pci/devices/0000:01:00.1/class", "0x040300"),
    ("/sys/bus/pci/devices/0000:01:00.0/vendor", "0x10de"),
    ("/sys/bus/pci/devices/0000:01:00.0/class", "0x030000"),
    (
        "/sys/bus/pci/devices/0000:01:00.0/power/runtime_status",
        "suspended",
    ),
    ("/sys/firmware/acpi/platform_profile", "balanced"),
    (
        "/sys/firmware/acpi/platform_profile_choices",
        "performance quiet balanced-performance low-power balanced",
    ),
    (
        "/sys/class/platform-profile/platform-profile-0/name",
        "acer-wmi",
    ),
    (
        "/sys/class/platform-profile/platform-profile-0/profile",
        "balanced",
    ),
    (
        "/sys/class/platform-profile/platform-profile-0/choices",
        "low-power quiet balanced balanced-performance performance",
    ),
];

/// A Ryzen desktop with an AMD iGPU and a discrete Radeon, no fans exposed
/// and no platform profile.
pub const AMD_DESKTOP: &[(&str, &str)] = &[
    ("/sys/class/hwmon/hwmon1/name", "k10temp"),
    ("/sys/class/hwmon/hwmon1/temp1_input", "55000"),
    ("/sys/class/hwmon/hwmon1/temp1_label", "Tctl"),
    ("/sys/class/hwmon/hwmon2/name", "amdgpu"), // iGPU
    ("/sys/class/hwmon/hwmon2/temp1_input", "40000"),
    ("/sys/class/hwmon/hwmon2/temp1_label", "edge"),
    ("/sys/class/hwmon/hwmon4/name", "amdgpu"), // RX 7800 XT
    ("/sys/class/hwmon/hwmon4/temp1_input", "50000"),
    ("/sys/class/hwmon/hwmon4/temp1_label", "edge"),
    ("/sys/class/hwmon/hwmon4/temp2_input", "60000"),
    ("/sys/class/hwmon/hwmon4/temp2_label", "junction"),
];

/// In-memory sysfs. Directories are implied by file paths. Writes are only
/// allowed to existing files (as in sysfs) and are recorded.
#[derive(Debug, Default)]
pub struct FakeFs {
    files: RefCell<BTreeMap<String, String>>,
    unreadable: BTreeSet<String>,
    writes: RefCell<Vec<(String, String)>>,
}

impl FakeFs {
    pub fn new(files: &[(&str, &str)]) -> Self {
        Self {
            files: RefCell::new(
                files
                    .iter()
                    .map(|(p, v)| ((*p).to_owned(), (*v).to_owned()))
                    .collect(),
            ),
            ..Self::default()
        }
    }

    /// The file exists but reading it fails (e.g. EIO from the driver).
    pub fn with_unreadable(mut self, path: &str) -> Self {
        self.files.get_mut().entry(path.to_owned()).or_default();
        self.unreadable.insert(path.to_owned());
        self
    }

    /// Changes a file behind the code's back (e.g. the GPU going to sleep).
    pub fn set(&self, path: &str, value: &str) {
        self.files
            .borrow_mut()
            .insert(path.to_owned(), value.to_owned());
    }

    pub fn get(&self, path: &str) -> Option<String> {
        self.files.borrow().get(path).cloned()
    }

    /// Every successful write, in order.
    pub fn writes(&self) -> Vec<(String, String)> {
        self.writes.borrow().clone()
    }
}

impl SysFs for FakeFs {
    fn read_to_string(&self, path: &str) -> Option<String> {
        if self.unreadable.contains(path) {
            return None;
        }
        self.files.borrow().get(path).map(|v| v.trim().to_owned())
    }

    fn read_dir(&self, path: &str) -> Vec<String> {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        let names: BTreeSet<String> = self
            .files
            .borrow()
            .keys()
            .filter_map(|p| p.strip_prefix(&prefix))
            .filter_map(|rest| rest.split('/').next())
            .map(str::to_owned)
            .collect();
        names.into_iter().collect()
    }

    fn exists(&self, path: &str) -> bool {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        let files = self.files.borrow();
        files.contains_key(path) || files.keys().any(|p| p.starts_with(&prefix))
    }

    fn write(&self, path: &str, value: &str) -> std::io::Result<()> {
        let mut files = self.files.borrow_mut();
        let Some(slot) = files.get_mut(path) else {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        };
        *slot = value.to_owned();
        self.writes
            .borrow_mut()
            .push((path.to_owned(), value.to_owned()));
        Ok(())
    }
}

/// Fake nvidia-smi that counts how often it was run.
#[derive(Debug)]
pub struct FakeGpu {
    output: RefCell<Option<String>>,
    calls: Cell<usize>,
}

impl FakeGpu {
    pub fn new(output: &str) -> Self {
        Self {
            output: RefCell::new(Some(output.to_owned())),
            calls: Cell::new(0),
        }
    }

    pub fn set_output(&self, output: Option<&str>) {
        *self.output.borrow_mut() = output.map(str::to_owned);
    }

    pub fn calls(&self) -> usize {
        self.calls.get()
    }
}

impl GpuQuery for FakeGpu {
    fn query_temperature(&self) -> Option<String> {
        self.calls.set(self.calls.get() + 1);
        self.output.borrow().clone()
    }
}

/// Manually advanced monotonic clock.
#[derive(Debug, Default)]
pub struct FakeClock(Cell<Duration>);

impl FakeClock {
    pub fn starting_at(secs: u64) -> Self {
        Self(Cell::new(Duration::from_secs(secs)))
    }

    pub fn advance(&self, secs: u64) {
        self.0.set(self.0.get() + Duration::from_secs(secs));
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        self.0.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_fs_lists_implied_directories() {
        let fs = FakeFs::new(PHN16_72);
        assert_eq!(
            fs.read_dir("/sys/class/hwmon"),
            ["hwmon0", "hwmon3", "hwmon5"]
        );
        assert!(fs.exists("/sys/class/hwmon/hwmon3"));
        assert!(!fs.exists("/sys/class/hwmon/hwmon9"));
    }

    #[test]
    fn fake_fs_never_creates_files() {
        let fs = FakeFs::new(PHN16_72);
        assert!(fs.write("/sys/new_file", "x").is_err());
        assert!(fs.writes().is_empty());
    }
}
