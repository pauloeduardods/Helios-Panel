// SPDX-License-Identifier: GPL-3.0-or-later
//! Sensor discovery over /sys/class/hwmon, and the NVIDIA PCI device lookup.

use serde::Serialize;

use crate::io::SysFs;

pub const HWMON_ROOT: &str = "/sys/class/hwmon";
pub const PCI_ROOT: &str = "/sys/bus/pci/devices";

/// One `tempN_input` or `fanN_input` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    pub label: String,
    pub path: String,
    pub index: u32,
}

/// One hwmon chip with its temperature and fan inputs, sorted by index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chip {
    pub dir: String,
    pub name: String,
    pub temps: Vec<Input>,
    pub fans: Vec<Input>,
}

/// A resolved temperature sensor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SensorRef {
    pub chip: String,
    pub label: String,
    pub path: String,
}

impl SensorRef {
    pub fn id(&self) -> String {
        sensor_id(&self.chip, &self.label)
    }
}

/// Stable id that survives reboots (hwmonN numbers do not).
pub fn sensor_id(chip: &str, label: &str) -> String {
    format!("hwmon:{chip}/{label}")
}

/// Inverse of [`sensor_id`]: `(chip, label)`.
pub fn parse_sensor_id(id: &str) -> Option<(&str, &str)> {
    let (chip, label) = id.strip_prefix("hwmon:")?.split_once('/')?;
    (!chip.is_empty() && !label.is_empty()).then_some((chip, label))
}

/// hwmon reports millidegrees Celsius.
pub fn milli_to_celsius(milli: i64) -> f64 {
    milli as f64 / 1000.0
}

/// `N` from `{prefix}N{suffix}`.
fn input_index(file: &str, prefix: &str, suffix: &str) -> Option<u32> {
    let digits = file.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Lists every hwmon chip that has a name.
pub fn scan(fs: &dyn SysFs) -> Vec<Chip> {
    let mut chips = Vec::new();
    for entry in fs.read_dir(HWMON_ROOT) {
        let dir = format!("{HWMON_ROOT}/{entry}");
        let Some(name) = fs.read_to_string(&format!("{dir}/name")) else {
            continue;
        };
        let mut temps = Vec::new();
        let mut fans = Vec::new();
        for file in fs.read_dir(&dir) {
            if let Some(n) = input_index(&file, "temp", "_input") {
                let label = fs
                    .read_to_string(&format!("{dir}/temp{n}_label"))
                    .unwrap_or_else(|| format!("temp{n}"));
                temps.push(Input {
                    label,
                    path: format!("{dir}/{file}"),
                    index: n,
                });
            } else if let Some(n) = input_index(&file, "fan", "_input") {
                let label = fs
                    .read_to_string(&format!("{dir}/fan{n}_label"))
                    .unwrap_or_else(|| format!("Fan {n}"));
                fans.push(Input {
                    label,
                    path: format!("{dir}/{file}"),
                    index: n,
                });
            }
        }
        temps.sort_by_key(|i| i.index);
        fans.sort_by_key(|i| i.index);
        chips.push(Chip {
            dir,
            name,
            temps,
            fans,
        });
    }
    chips
}

/// First temperature of `chip` with `label` (or its first one when `None`).
pub fn find_temp(chips: &[Chip], chip: &str, label: Option<&str>) -> Option<SensorRef> {
    chips.iter().filter(|c| c.name == chip).find_map(|c| {
        let t = match label {
            None => c.temps.first(),
            Some(l) => c.temps.iter().find(|t| t.label == l),
        }?;
        Some(SensorRef {
            chip: c.name.clone(),
            label: t.label.clone(),
            path: t.path.clone(),
        })
    })
}

/// Preferred CPU package sensors, most specific first.
const CPU_CANDIDATES: &[(&str, Option<&str>)] = &[
    ("coretemp", Some("Package id 0")), // Intel
    ("k10temp", Some("Tctl")),          // AMD Ryzen
    ("k10temp", Some("Tdie")),
    ("zenpower", Some("Tdie")),
    ("coretemp", None),
    ("k10temp", None),
    ("acpitz", None), // last resort: ACPI thermal zone
];

/// The CPU sensor: `id` if it still exists, else the first known candidate.
pub fn resolve_cpu(chips: &[Chip], id: &str) -> Option<SensorRef> {
    if let Some((chip, label)) = parse_sensor_id(id) {
        if let Some(hit) = find_temp(chips, chip, Some(label)) {
            return Some(hit);
        }
    }
    CPU_CANDIDATES
        .iter()
        .find_map(|(chip, label)| find_temp(chips, chip, *label))
}

/// AMD GPUs expose hwmon directly. With an AMD iGPU *and* dGPU both are
/// "amdgpu"; only the discrete card reports a "junction" sensor, so it wins.
pub fn resolve_amd_gpu(chips: &[Chip]) -> Option<SensorRef> {
    let amd: Vec<&Chip> = chips
        .iter()
        .filter(|c| c.name == "amdgpu" && !c.temps.is_empty())
        .collect();
    let discrete = amd
        .iter()
        .find(|c| c.temps.iter().any(|t| t.label == "junction"))
        .or(amd.first())?;
    let edge = discrete
        .temps
        .iter()
        .find(|t| t.label == "edge")
        .unwrap_or(&discrete.temps[0]);
    Some(SensorRef {
        chip: discrete.name.clone(),
        label: edge.label.clone(),
        path: edge.path.clone(),
    })
}

/// Fans: the Acer chip first (acer-wmi), else any chip that has fan inputs.
pub fn resolve_fans(chips: &[Chip]) -> Vec<Input> {
    chips
        .iter()
        .find(|c| c.name == "acer" && !c.fans.is_empty())
        .or_else(|| chips.iter().find(|c| !c.fans.is_empty()))
        .map(|c| c.fans.clone())
        .unwrap_or_default()
}

/// What a component sensor belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Storage,
    Wifi,
}

/// Components other than the CPU and GPU, by chip name. A chip matches its
/// name or the name plus a `_` suffix (the Wi-Fi chip is `iwlwifi_1_6`), so
/// supporting another chip is one line here.
const DEVICE_CHIPS: &[(&str, DeviceKind)] = &[
    ("nvme", DeviceKind::Storage),
    ("drivetemp", DeviceKind::Storage), // SATA drives
    ("iwlwifi", DeviceKind::Wifi),      // Intel
];

/// One component temperature: the chip's first input (an NVMe drive's
/// "Composite").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSensor {
    pub kind: DeviceKind,
    /// The drive model when the device reports one, else a generic name.
    /// Several drives share the chip name "nvme", so this tells them apart.
    pub name: String,
    pub path: String,
}

/// The kind of component a chip belongs to, by its name.
pub fn device_kind(chip: &str) -> Option<DeviceKind> {
    DEVICE_CHIPS.iter().find_map(|(name, kind)| {
        let matches = chip == *name
            || chip
                .strip_prefix(name)
                .is_some_and(|rest| rest.starts_with('_'));
        matches.then_some(*kind)
    })
}

/// Drives and network cards with a temperature, sorted by kind then name so
/// the order survives reboots (hwmon numbers do not).
pub fn resolve_devices(fs: &dyn SysFs, chips: &[Chip]) -> Vec<DeviceSensor> {
    let mut devices: Vec<DeviceSensor> = chips
        .iter()
        .filter_map(|c| {
            let kind = device_kind(&c.name)?;
            let input = c.temps.first()?;
            let name = match kind {
                DeviceKind::Wifi => "Wi-Fi".to_owned(),
                DeviceKind::Storage => fs
                    .read_to_string(&format!("{}/device/model", c.dir))
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "Drive".to_owned()),
            };
            Some(DeviceSensor {
                kind,
                name,
                path: input.path.clone(),
            })
        })
        .collect();
    devices.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
    devices
}

/// The NVIDIA display controller's PCI directory, if any.
pub fn find_nvidia_pci_dir(fs: &dyn SysFs) -> Option<String> {
    fs.read_dir(PCI_ROOT).into_iter().find_map(|entry| {
        let dir = format!("{PCI_ROOT}/{entry}");
        let vendor = fs.read_to_string(&format!("{dir}/vendor"))?;
        let class = fs.read_to_string(&format!("{dir}/class"))?;
        // 0x0300xx = VGA controller, 0x0302xx = 3D controller
        let display = class.starts_with("0x0300") || class.starts_with("0x0302");
        (vendor == "0x10de" && display).then_some(dir)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeFs, PHN16_72};

    #[test]
    fn phn16_72_cpu_package_acer_fans_nvidia_device() {
        let fs = FakeFs::new(PHN16_72);
        let chips = scan(&fs);
        assert_eq!(
            resolve_cpu(&chips, ""),
            Some(SensorRef {
                chip: "coretemp".into(),
                label: "Package id 0".into(),
                path: "/sys/class/hwmon/hwmon5/temp1_input".into(),
            })
        );
        let fans: Vec<_> = resolve_fans(&chips).into_iter().map(|f| f.label).collect();
        assert_eq!(fans, ["Fan 1", "Fan 2"]);
        assert_eq!(
            find_nvidia_pci_dir(&fs).as_deref(),
            Some("/sys/bus/pci/devices/0000:01:00.0"),
            "the audio function 01:00.1 is not a display controller"
        );
        assert_eq!(resolve_amd_gpu(&chips), None);
    }

    #[test]
    fn explicit_sensor_id_wins_and_falls_back_when_it_vanished() {
        let chips = scan(&FakeFs::new(PHN16_72));
        let core0 = sensor_id("coretemp", "Core 0");
        assert_eq!(resolve_cpu(&chips, &core0).unwrap().label, "Core 0");
        let gone = sensor_id("gone", "x");
        assert_eq!(resolve_cpu(&chips, &gone).unwrap().label, "Package id 0");
    }

    #[test]
    fn sensor_ids_round_trip() {
        assert_eq!(parse_sensor_id("hwmon:acer/temp1"), Some(("acer", "temp1")));
        assert_eq!(
            parse_sensor_id("hwmon:coretemp/Package id 0"),
            Some(("coretemp", "Package id 0"))
        );
        assert_eq!(parse_sensor_id("nvidia-smi"), None);
        assert_eq!(parse_sensor_id("hwmon:/x"), None);
        assert_eq!(parse_sensor_id("hwmon:acer/"), None);
    }

    #[test]
    fn unlabeled_inputs_get_default_labels() {
        let chips = scan(&FakeFs::new(PHN16_72));
        let acer = chips.iter().find(|c| c.name == "acer").unwrap();
        assert_eq!(acer.temps[0].label, "temp1");
        assert_eq!(acer.fans[1].label, "Fan 2");
    }

    #[test]
    fn chips_without_a_name_and_stray_files_are_ignored() {
        let fs = FakeFs::new(&[
            ("/sys/class/hwmon/hwmon0/temp1_input", "1000"),
            ("/sys/class/hwmon/hwmon1/name", "x"),
            ("/sys/class/hwmon/hwmon1/temp_input", "1000"),
            ("/sys/class/hwmon/hwmon1/tempA_input", "1000"),
            ("/sys/class/hwmon/hwmon1/temp2_max", "1000"),
        ]);
        let chips = scan(&fs);
        assert_eq!(chips.len(), 1);
        assert!(chips[0].temps.is_empty());
    }

    #[test]
    fn inputs_sort_numerically() {
        let fs = FakeFs::new(&[
            ("/sys/class/hwmon/hwmon0/name", "x"),
            ("/sys/class/hwmon/hwmon0/temp10_input", "1"),
            ("/sys/class/hwmon/hwmon0/temp2_input", "1"),
        ]);
        let labels: Vec<_> = scan(&fs)[0].temps.iter().map(|t| t.label.clone()).collect();
        assert_eq!(labels, ["temp2", "temp10"]);
    }

    #[test]
    fn amd_desktop_ryzen_tctl_and_discrete_radeon_over_igpu() {
        let chips = scan(&FakeFs::new(AMD_DESKTOP));
        assert_eq!(resolve_cpu(&chips, "").unwrap().label, "Tctl");
        assert_eq!(
            resolve_amd_gpu(&chips).unwrap().path,
            "/sys/class/hwmon/hwmon4/temp1_input"
        );
        assert!(resolve_fans(&chips).is_empty());
    }

    #[test]
    fn phn16_72_drives_and_wifi() {
        let fs = FakeFs::new(PHN16_72);
        let devices = resolve_devices(&fs, &scan(&fs));
        let names: Vec<_> = devices.iter().map(|d| (d.kind, d.name.as_str())).collect();
        assert_eq!(
            names,
            [
                (DeviceKind::Storage, "CT500P2SSD8"),
                (DeviceKind::Storage, "SAMSUNG MZVL21T0HCLR-00B07"),
                (DeviceKind::Wifi, "Wi-Fi"),
            ]
        );
        assert_eq!(
            devices[1].path, "/sys/class/hwmon/hwmon4/temp1_input",
            "the drive's Composite sensor"
        );
    }

    #[test]
    fn device_chips_match_by_name_or_prefix() {
        assert_eq!(device_kind("nvme"), Some(DeviceKind::Storage));
        assert_eq!(device_kind("iwlwifi_1_6"), Some(DeviceKind::Wifi));
        assert_eq!(device_kind("iwlwifi"), Some(DeviceKind::Wifi));
        assert_eq!(device_kind("nvmex"), None);
        assert_eq!(device_kind("coretemp"), None);
    }

    #[test]
    fn drives_without_a_model_or_a_temperature() {
        let fs = FakeFs::new(&[
            ("/sys/class/hwmon/hwmon0/name", "drivetemp"),
            ("/sys/class/hwmon/hwmon0/temp1_input", "35000"),
            ("/sys/class/hwmon/hwmon1/name", "nvme"),
        ]);
        let devices = resolve_devices(&fs, &scan(&fs));
        assert_eq!(devices.len(), 1, "a chip without a temperature is skipped");
        assert_eq!(devices[0].name, "Drive");
        assert!(
            resolve_devices(&FakeFs::new(AMD_DESKTOP), &scan(&FakeFs::new(AMD_DESKTOP))).is_empty()
        );
    }

    #[test]
    fn millidegrees() {
        assert_eq!(milli_to_celsius(61000), 61.0);
        assert_eq!(milli_to_celsius(-500), -0.5);
    }
}
