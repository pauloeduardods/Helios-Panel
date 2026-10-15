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
    // Two NVMe drives (both chips are just "nvme") and the Wi-Fi card.
    ("/sys/class/hwmon/hwmon4/name", "nvme"),
    ("/sys/class/hwmon/hwmon4/temp1_input", "47850"),
    ("/sys/class/hwmon/hwmon4/temp1_label", "Composite"),
    ("/sys/class/hwmon/hwmon4/temp2_input", "47850"),
    ("/sys/class/hwmon/hwmon4/temp2_label", "Sensor 1"),
    (
        "/sys/class/hwmon/hwmon4/device/model",
        "SAMSUNG MZVL21T0HCLR-00B07              ",
    ),
    ("/sys/class/hwmon/hwmon6/name", "nvme"),
    ("/sys/class/hwmon/hwmon6/temp1_input", "44850"),
    ("/sys/class/hwmon/hwmon6/temp1_label", "Composite"),
    ("/sys/class/hwmon/hwmon6/device/model", "CT500P2SSD8"),
    ("/sys/class/hwmon/hwmon10/name", "iwlwifi_1_6"),
    ("/sys/class/hwmon/hwmon10/temp1_input", "52000"),
    // 32 threads in the real machine; four policies are enough here.
    (
        "/proc/stat",
        "cpu  1000 0 500 9000 200 0 0 0 0 0\ncpu0 1 1 1 1\n",
    ),
    (
        "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq",
        "800000",
    ),
    (
        "/sys/devices/system/cpu/cpufreq/policy1/scaling_cur_freq",
        "1200000",
    ),
    (
        "/sys/devices/system/cpu/cpufreq/policy2/scaling_cur_freq",
        "1600000",
    ),
    (
        "/sys/devices/system/cpu/cpufreq/policy3/scaling_cur_freq",
        "4800000",
    ),
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
    // On AC with the battery held at 80% (charge_* naming, no power_now).
    ("/sys/class/power_supply/ACAD/type", "Mains"),
    ("/sys/class/power_supply/ACAD/online", "1"),
    ("/sys/class/power_supply/BAT1/type", "Battery"),
    ("/sys/class/power_supply/BAT1/status", "Not charging"),
    ("/sys/class/power_supply/BAT1/capacity", "80"),
    ("/sys/class/power_supply/BAT1/voltage_now", "16312000"),
    ("/sys/class/power_supply/BAT1/current_now", "0"),
    ("/sys/class/power_supply/BAT1/charge_now", "4305000"),
    ("/sys/class/power_supply/BAT1/charge_full", "5413000"),
    ("/sys/class/power_supply/BAT1/charge_full_design", "5884000"),
    ("/sys/class/power_supply/BAT1/cycle_count", "0"),
    // A wireless mouse: a battery, but not the laptop's.
    ("/sys/class/power_supply/hidpp_battery_1/type", "Battery"),
    ("/sys/class/power_supply/hidpp_battery_1/scope", "Device"),
    ("/sys/class/power_supply/hidpp_battery_1/capacity", "95"),
    // RAPL: the package, its cores subdomain, and the same package again
    // through MMIO.
    ("/sys/class/powercap/intel-rapl:0/name", "package-0"),
    ("/sys/class/powercap/intel-rapl:0/energy_uj", "1000000000"),
    (
        "/sys/class/powercap/intel-rapl:0/max_energy_range_uj",
        "262143328850",
    ),
    ("/sys/class/powercap/intel-rapl:0:0/name", "core"),
    ("/sys/class/powercap/intel-rapl:0:0/energy_uj", "600000000"),
    ("/sys/class/powercap/intel-rapl-mmio:0/name", "package-0"),
    (
        "/sys/class/powercap/intel-rapl-mmio:0/energy_uj",
        "1000000000",
    ),
];

/// The rest of a healthy PHN16-72 for `doctor`: DMI, acer_wmi loaded with
/// predator_v4 from modprobe.d, the lighting module loaded and bound, and
/// heliosd installed and running.
pub const PHN16_72_SYSTEM: &[(&str, &str)] = &[
    ("/sys/class/dmi/id/sys_vendor", "Acer"),
    ("/sys/class/dmi/id/product_name", "Predator PHN16-72"),
    ("/sys/class/dmi/id/product_family", "Predator Helios Neo 16"),
    ("/sys/class/dmi/id/bios_version", "V1.20"),
    ("/sys/module/acer_wmi/parameters/predator_v4", "Y"),
    (
        "/etc/modprobe.d/acer-predator.conf",
        "options acer_wmi predator_v4=1",
    ),
    (
        "/etc/modprobe.d/blacklist.conf",
        "blacklist evbug\nblacklist nouveau",
    ),
    (
        "/proc/cmdline",
        "BOOT_IMAGE=/boot/vmlinuz-7.0.0-38-generic ro quiet splash",
    ),
    ("/proc/1/comm", "systemd"),
    ("/proc/4242/comm", "heliosd"),
    ("/usr/local/libexec/heliosd", "binary"),
    ("/etc/systemd/system/heliosd.service", "[Service]"),
    (
        "/usr/share/dbus-1/system.d/io.github.pauloeduardods.Helios1.conf",
        "<busconfig/>",
    ),
    (
        "/usr/share/dbus-1/system-services/io.github.pauloeduardods.Helios1.service",
        "[D-BUS Service]",
    ),
    (
        "/usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy",
        "<policyconfig/>",
    ),
    ("/proc/sys/kernel/osrelease", "7.0.0-38-generic"),
    ("/sys/module/helios_acer_lighting/version", "0.1.6"),
    (
        "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56/keyboard_effect",
        "static 0 100 right ffffff",
    ),
    (
        "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56/keyboard_zones",
        "100 ffffff ffffff ffffff ffffff",
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
    ("/sys/class/hwmon/hwmon4/device/gpu_busy_percent", "12"),
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
    fn query(&self) -> Option<String> {
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
            ["hwmon0", "hwmon10", "hwmon3", "hwmon4", "hwmon5", "hwmon6"]
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
