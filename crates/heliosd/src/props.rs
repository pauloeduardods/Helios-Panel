// SPDX-License-Identifier: GPL-3.0-or-later
//! The D-Bus shape of a [`Status`], and which properties changed between two
//! snapshots. Pure: no bus access, unit-tested below.

use helios_core::nvidia::GpuState;
use helios_core::power::{BatteryState, PowerSource};
use helios_core::status::Status;
use zbus::zvariant::Value;

/// (sensor id, valid, °C)
pub type Cpu = (String, bool, f64);
/// (source id, state, valid, °C)
pub type Gpu = (String, String, bool, f64);
/// (label, rpm; -1 = unreadable)
pub type Fan = (String, i32);
/// (id, chip, label, °C); unreadable sensors are left out
pub type Temperature = (String, String, String, f64);
/// (valid, W)
pub type GpuPower = (bool, f64);
/// (valid, W)
pub type CpuPower = (bool, f64);
/// (name, state, %, W, health %, cycles, minutes left); name "" = no battery,
/// -1 = unknown
pub type Battery = (String, String, f64, f64, f64, i32, i32);

#[derive(Debug, Clone, PartialEq)]
pub struct SensorsProps {
    pub cpu: Cpu,
    pub gpu: Gpu,
    pub fans: Vec<Fan>,
    pub temperatures: Vec<Temperature>,
    pub gpu_power: GpuPower,
    pub cpu_power: CpuPower,
    pub power_source: String,
    pub battery: Battery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileProps {
    pub available: bool,
    pub active: String,
    pub choices: Vec<String>,
    pub driver: String,
}

fn reading(celsius: Option<f64>) -> (bool, f64) {
    (celsius.is_some(), celsius.unwrap_or(0.0))
}

pub fn power_source_name(source: PowerSource) -> &'static str {
    match source {
        PowerSource::Ac => "ac",
        PowerSource::Battery => "battery",
        PowerSource::Unknown => "unknown",
    }
}

pub fn battery_state_name(state: BatteryState) -> &'static str {
    match state {
        BatteryState::Charging => "charging",
        BatteryState::Discharging => "discharging",
        BatteryState::Full => "full",
        BatteryState::NotCharging => "not-charging",
        BatteryState::Unknown => "unknown",
    }
}

fn int_or_unknown(value: Option<i64>) -> i32 {
    value.and_then(|v| i32::try_from(v).ok()).unwrap_or(-1)
}

fn battery(s: &Status) -> Battery {
    let Some(b) = &s.power.battery else {
        return (
            String::new(),
            "unknown".to_owned(),
            -1.0,
            -1.0,
            -1.0,
            -1,
            -1,
        );
    };
    (
        b.name.clone(),
        battery_state_name(b.state).to_owned(),
        b.percent.unwrap_or(-1.0),
        b.watts.unwrap_or(-1.0),
        b.health_percent.unwrap_or(-1.0),
        int_or_unknown(b.cycles),
        int_or_unknown(b.minutes_left),
    )
}

pub fn gpu_state_name(state: GpuState) -> &'static str {
    match state {
        GpuState::On => "on",
        GpuState::Off => "off",
        GpuState::None => "none",
    }
}

impl From<&Status> for SensorsProps {
    fn from(s: &Status) -> Self {
        let (cpu_valid, cpu_c) = reading(s.cpu.celsius);
        let (gpu_valid, gpu_c) = reading(s.gpu.celsius);
        Self {
            cpu: (s.cpu.sensor.clone().unwrap_or_default(), cpu_valid, cpu_c),
            gpu: (
                s.gpu.source.clone().unwrap_or_default(),
                gpu_state_name(s.gpu.state).to_owned(),
                gpu_valid,
                gpu_c,
            ),
            fans: s
                .fans
                .iter()
                .map(|f| {
                    let rpm = f.rpm.and_then(|r| i32::try_from(r).ok()).unwrap_or(-1);
                    (f.label.clone(), rpm)
                })
                .collect(),
            temperatures: s
                .temperatures
                .iter()
                .filter_map(|t| Some((t.id.clone(), t.chip.clone(), t.label.clone(), t.celsius?)))
                .collect(),
            gpu_power: reading(s.gpu.watts),
            cpu_power: reading(s.cpu.watts),
            power_source: power_source_name(s.power.source).to_owned(),
            battery: battery(s),
        }
    }
}

impl From<&Status> for ProfileProps {
    fn from(s: &Status) -> Self {
        let p = &s.profile;
        Self {
            available: p.available,
            active: p.active.clone().unwrap_or_default(),
            choices: p.choices.clone(),
            driver: p.driver.clone().unwrap_or_default(),
        }
    }
}

pub type Changes = Vec<(&'static str, Value<'static>)>;

pub fn sensors_changes(old: &SensorsProps, new: &SensorsProps) -> Changes {
    let mut out: Changes = Vec::new();
    if old.cpu != new.cpu {
        out.push(("Cpu", Value::from(new.cpu.clone())));
    }
    if old.gpu != new.gpu {
        out.push(("Gpu", Value::from(new.gpu.clone())));
    }
    if old.fans != new.fans {
        out.push(("Fans", Value::from(new.fans.clone())));
    }
    if old.temperatures != new.temperatures {
        out.push(("Temperatures", Value::from(new.temperatures.clone())));
    }
    if old.gpu_power != new.gpu_power {
        out.push(("GpuPower", Value::from(new.gpu_power)));
    }
    if old.cpu_power != new.cpu_power {
        out.push(("CpuPower", Value::from(new.cpu_power)));
    }
    if old.power_source != new.power_source {
        out.push(("PowerSource", Value::from(new.power_source.clone())));
    }
    if old.battery != new.battery {
        out.push(("Battery", Value::from(new.battery.clone())));
    }
    out
}

pub fn profile_changes(old: &ProfileProps, new: &ProfileProps) -> Changes {
    let mut out: Changes = Vec::new();
    if old.available != new.available {
        out.push(("Available", Value::from(new.available)));
    }
    if old.active != new.active {
        out.push(("Active", Value::from(new.active.clone())));
    }
    if old.choices != new.choices {
        out.push(("Choices", Value::from(new.choices.clone())));
    }
    if old.driver != new.driver {
        out.push(("Driver", Value::from(new.driver.clone())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use helios_core::fake::{FakeClock, FakeFs, PHN16_72};
    use helios_core::status::Monitor;

    fn status(fs: &FakeFs) -> Status {
        Monitor::new(fs).poll(fs, None, &FakeClock::default())
    }

    #[test]
    fn phn16_72_maps_to_dbus_types() {
        let fs = FakeFs::new(PHN16_72);
        let s = status(&fs);
        let sensors = SensorsProps::from(&s);
        assert_eq!(
            sensors.cpu,
            ("hwmon:coretemp/Package id 0".into(), true, 61.0)
        );
        assert_eq!(sensors.gpu, (String::new(), "none".into(), false, 0.0));
        assert_eq!(
            sensors.fans,
            [("Fan 1".into(), 2350), ("Fan 2".into(), 2600)]
        );
        assert_eq!(sensors.temperatures.len(), 4);
        assert_eq!(sensors.gpu_power, (false, 0.0));
        assert_eq!(sensors.cpu_power, (false, 0.0), "first poll: no value yet");
        assert_eq!(sensors.power_source, "ac");
        assert_eq!(
            sensors.battery,
            ("BAT1".into(), "not-charging".into(), 80.0, 0.0, 92.0, 0, -1)
        );

        let profile = ProfileProps::from(&s);
        assert!(profile.available);
        assert_eq!(profile.active, "balanced");
        assert_eq!(profile.driver, "acer-wmi");
        assert_eq!(
            profile.choices.first().map(String::as_str),
            Some("low-power")
        );
    }

    #[test]
    fn unreadable_values_use_the_valid_flag_and_sentinels() {
        let fs = FakeFs::new(PHN16_72)
            .with_unreadable("/sys/class/hwmon/hwmon5/temp1_input")
            .with_unreadable("/sys/class/hwmon/hwmon3/fan1_input");
        let sensors = SensorsProps::from(&status(&fs));
        assert_eq!(
            sensors.cpu,
            ("hwmon:coretemp/Package id 0".into(), false, 0.0)
        );
        assert_eq!(sensors.fans[0], ("Fan 1".into(), -1));
        assert_eq!(
            sensors.temperatures.len(),
            3,
            "the unreadable sensor is left out"
        );
    }

    #[test]
    fn only_changed_properties_are_reported() {
        let fs = FakeFs::new(PHN16_72);
        let before = status(&fs);
        assert!(sensors_changes(&(&before).into(), &(&before).into()).is_empty());
        assert!(profile_changes(&(&before).into(), &(&before).into()).is_empty());

        fs.set("/sys/class/hwmon/hwmon5/temp1_input", "62000");
        fs.set("/sys/firmware/acpi/platform_profile", "quiet");
        let after = status(&fs);
        let names = |c: Changes| c.into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(
            names(sensors_changes(&(&before).into(), &(&after).into())),
            ["Cpu", "Temperatures"]
        );
        assert_eq!(
            names(profile_changes(&(&before).into(), &(&after).into())),
            ["Active"]
        );
    }

    #[test]
    fn no_battery_uses_sentinels() {
        let fs = FakeFs::new(helios_core::fake::AMD_DESKTOP);
        let sensors = SensorsProps::from(&status(&fs));
        assert_eq!(sensors.power_source, "unknown");
        assert_eq!(
            sensors.battery,
            (String::new(), "unknown".into(), -1.0, -1.0, -1.0, -1, -1)
        );
    }

    #[test]
    fn unplugging_changes_source_and_battery() {
        let fs = FakeFs::new(PHN16_72);
        let before = status(&fs);
        fs.set("/sys/class/power_supply/ACAD/online", "0");
        fs.set("/sys/class/power_supply/BAT1/status", "Discharging");
        fs.set("/sys/class/power_supply/BAT1/current_now", "1500000");
        let after = status(&fs);
        let names: Vec<_> = sensors_changes(&(&before).into(), &(&after).into())
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(names, ["PowerSource", "Battery"]);
        assert_eq!(
            SensorsProps::from(&after).battery,
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
    }

    #[test]
    fn cpu_power_is_published_from_the_second_poll() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let before = SensorsProps::from(&monitor.poll(&fs, None, &clock));
        fs.set("/sys/class/powercap/intel-rapl:0/energy_uj", "1024680000");
        clock.advance(2);
        let after = SensorsProps::from(&monitor.poll(&fs, None, &clock));
        assert_eq!(after.cpu_power, (true, 12.3));
        let names: Vec<_> = sensors_changes(&before, &after)
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(names, ["CpuPower"]);
    }

    #[test]
    fn huge_rpm_does_not_wrap() {
        let fs = FakeFs::new(PHN16_72);
        fs.set("/sys/class/hwmon/hwmon3/fan1_input", "99999999999");
        assert_eq!(SensorsProps::from(&status(&fs)).fans[0].1, -1);
    }
}
