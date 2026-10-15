// SPDX-License-Identifier: GPL-3.0-or-later
//! Power source and the laptop battery, from `/sys/class/power_supply`.
//!
//! Linux cannot measure what the whole laptop draws while it runs on AC, so
//! the draw is only known on battery: it is what flows out of the battery.
//! Every attribute read here is world-readable; nothing is written.

use std::time::Duration;

use serde::Serialize;

use crate::io::{Clock, SysFs, read_int};

pub const POWER_SUPPLY: &str = "/sys/class/power_supply";

/// The draw behind `minutes_left` is averaged over about this long, so the
/// estimate does not jump with every spike.
pub const DRAW_AVERAGE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PowerSource {
    Ac,
    Battery,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BatteryState {
    Charging,
    Discharging,
    Full,
    /// On AC but held (e.g. a charge limit): "Not charging".
    NotCharging,
    Unknown,
}

impl BatteryState {
    pub fn parse(text: Option<&str>) -> Self {
        match text {
            Some("Charging") => Self::Charging,
            Some("Discharging") => Self::Discharging,
            Some("Full") => Self::Full,
            Some("Not charging") => Self::NotCharging,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BatteryStatus {
    /// power_supply name, e.g. `BAT1`.
    pub name: String,
    pub state: BatteryState,
    pub percent: Option<f64>,
    /// Power flowing in or out of the battery, always positive. While
    /// discharging this is what the laptop draws.
    pub watts: Option<f64>,
    /// Full capacity now against the design capacity.
    pub health_percent: Option<f64>,
    /// As the firmware reports it; many report 0 forever.
    pub cycles: Option<i64>,
    /// Only while discharging.
    pub minutes_left: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PowerStatus {
    pub source: PowerSource,
    pub battery: Option<BatteryStatus>,
}

/// Rounds to 0.1 so noise does not look like a change.
pub(crate) fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn supplies(fs: &dyn SysFs) -> Vec<String> {
    fs.read_dir(POWER_SUPPLY)
        .into_iter()
        .map(|name| format!("{POWER_SUPPLY}/{name}"))
        .collect()
}

fn supply_type(fs: &dyn SysFs, dir: &str) -> Option<String> {
    fs.read_to_string(&format!("{dir}/type"))
}

/// `scope` = `Device` marks a peripheral (a mouse, a USB-C port), not the
/// laptop's own supply.
fn is_system(fs: &dyn SysFs, dir: &str) -> bool {
    fs.read_to_string(&format!("{dir}/scope")).as_deref() != Some("Device")
}

/// The laptop's own battery: the first system-scoped `Battery` supply.
pub fn find_battery(fs: &dyn SysFs) -> Option<String> {
    supplies(fs)
        .into_iter()
        .find(|dir| supply_type(fs, dir).as_deref() == Some("Battery") && is_system(fs, dir))
}

/// `Some(online)` from the first system-scoped `Mains` supply.
pub fn ac_online(fs: &dyn SysFs) -> Option<bool> {
    supplies(fs)
        .into_iter()
        .find(|dir| supply_type(fs, dir).as_deref() == Some("Mains") && is_system(fs, dir))
        .and_then(|dir| read_int(fs, &format!("{dir}/online")))
        .map(|online| online == 1)
}

/// Micro-units (µW, µWh, ...) to the unit.
fn micro(fs: &dyn SysFs, path: &str) -> Option<f64> {
    read_int(fs, path).map(|v| v as f64 / 1e6)
}

/// A battery reports either `energy_*` (µWh) and `power_now` (µW), or
/// `charge_*` (µAh) and `current_now` (µA), which need `voltage_now`.
struct Raw {
    watts: Option<f64>,
    /// Wh
    energy_now: Option<f64>,
    energy_full: Option<f64>,
    energy_full_design: Option<f64>,
}

fn read_raw(fs: &dyn SysFs, dir: &str) -> Raw {
    let attr = |name: &str| micro(fs, &format!("{dir}/{name}"));
    let volts = attr("voltage_now");
    let by_charge = |name: &str| Some(attr(name)? * volts?);
    let either = |energy: &str, charge: &str| attr(energy).or_else(|| by_charge(charge));
    Raw {
        watts: attr("power_now")
            .or_else(|| by_charge("current_now"))
            .map(f64::abs),
        energy_now: either("energy_now", "charge_now"),
        energy_full: either("energy_full", "charge_full"),
        energy_full_design: either("energy_full_design", "charge_full_design"),
    }
}

fn ratio_percent(part: Option<f64>, whole: Option<f64>) -> Option<f64> {
    let (part, whole) = (part?, whole?);
    (whole > 0.0).then(|| round_tenth(part / whole * 100.0))
}

/// Keeps the averaged draw between polls.
#[derive(Debug, Default)]
pub struct PowerMonitor {
    /// (average watts, when it was last updated)
    average: Option<(f64, Duration)>,
}

impl PowerMonitor {
    pub fn poll(&mut self, fs: &dyn SysFs, clock: &dyn Clock) -> PowerStatus {
        let battery = find_battery(fs).map(|dir| self.read_battery(fs, &dir, clock));
        if battery
            .as_ref()
            .is_none_or(|b| b.state != BatteryState::Discharging)
        {
            self.average = None;
        }
        let source = match (ac_online(fs), &battery) {
            (Some(true), _) => PowerSource::Ac,
            (Some(false), _) => PowerSource::Battery,
            (None, Some(b)) if b.state == BatteryState::Discharging => PowerSource::Battery,
            (None, _) => PowerSource::Unknown,
        };
        PowerStatus { source, battery }
    }

    fn read_battery(&mut self, fs: &dyn SysFs, dir: &str, clock: &dyn Clock) -> BatteryStatus {
        let state = BatteryState::parse(fs.read_to_string(&format!("{dir}/status")).as_deref());
        let raw = read_raw(fs, dir);
        let percent = read_int(fs, &format!("{dir}/capacity"))
            .map(|p| p as f64)
            .or_else(|| ratio_percent(raw.energy_now, raw.energy_full));

        let minutes_left = match (state, raw.watts) {
            (BatteryState::Discharging, Some(watts)) => {
                let average = self.average(watts, clock.now());
                raw.energy_now
                    .filter(|_| average > 0.0)
                    .map(|wh| (wh / average * 60.0).round() as i64)
            }
            _ => None,
        };

        BatteryStatus {
            name: dir.rsplit('/').next().unwrap_or_default().to_owned(),
            state,
            percent,
            watts: raw.watts.map(round_tenth),
            health_percent: ratio_percent(raw.energy_full, raw.energy_full_design),
            cycles: read_int(fs, &format!("{dir}/cycle_count")),
            minutes_left,
        }
    }

    /// Exponential moving average with a time constant of [`DRAW_AVERAGE`],
    /// so uneven poll intervals weigh correctly.
    fn average(&mut self, watts: f64, now: Duration) -> f64 {
        let average = match self.average {
            Some((previous, at)) => {
                let dt = now.saturating_sub(at).as_secs_f64();
                let alpha = 1.0 - (-dt / DRAW_AVERAGE.as_secs_f64()).exp();
                previous + alpha * (watts - previous)
            }
            None => watts,
        };
        self.average = Some((average, now));
        average
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeClock, FakeFs, PHN16_72};

    const BAT: &str = "/sys/class/power_supply/BAT1";
    const AC: &str = "/sys/class/power_supply/ACAD/online";

    fn poll(fs: &FakeFs) -> PowerStatus {
        PowerMonitor::default().poll(fs, &FakeClock::default())
    }

    fn discharging(fs: &FakeFs) {
        fs.set(AC, "0");
        fs.set(&format!("{BAT}/status"), "Discharging");
        fs.set(&format!("{BAT}/current_now"), "1500000");
    }

    #[test]
    fn phn16_72_on_ac() {
        let fs = FakeFs::new(PHN16_72);
        assert_eq!(
            poll(&fs),
            PowerStatus {
                source: PowerSource::Ac,
                battery: Some(BatteryStatus {
                    name: "BAT1".into(),
                    state: BatteryState::NotCharging,
                    percent: Some(80.0),
                    watts: Some(0.0),
                    health_percent: Some(92.0),
                    cycles: Some(0),
                    minutes_left: None,
                }),
            }
        );
        assert!(fs.writes().is_empty(), "power is read-only");
    }

    #[test]
    fn phn16_72_on_battery() {
        let fs = FakeFs::new(PHN16_72);
        discharging(&fs);
        let status = poll(&fs);
        assert_eq!(status.source, PowerSource::Battery);
        let battery = status.battery.unwrap();
        assert_eq!(battery.state, BatteryState::Discharging);
        // 1.5 A × 16.312 V
        assert_eq!(battery.watts, Some(24.5));
        // 4.305 Ah × 16.312 V = 70.2 Wh, at 24.468 W
        assert_eq!(battery.minutes_left, Some(172));
    }

    #[test]
    fn energy_based_batteries() {
        let fs = FakeFs::new(&[
            ("/sys/class/power_supply/BAT0/type", "Battery"),
            ("/sys/class/power_supply/BAT0/status", "Discharging"),
            ("/sys/class/power_supply/BAT0/power_now", "-12000000"),
            ("/sys/class/power_supply/BAT0/energy_now", "30000000"),
            ("/sys/class/power_supply/BAT0/energy_full", "45000000"),
            (
                "/sys/class/power_supply/BAT0/energy_full_design",
                "50000000",
            ),
        ]);
        let status = poll(&fs);
        assert_eq!(
            status.source,
            PowerSource::Battery,
            "no Mains supply, but the battery is discharging"
        );
        let battery = status.battery.unwrap();
        assert_eq!(battery.watts, Some(12.0), "the sign is dropped");
        assert_eq!(battery.percent, Some(66.7), "no capacity: from energy");
        assert_eq!(battery.health_percent, Some(90.0));
        assert_eq!(battery.minutes_left, Some(150));
        assert_eq!(battery.cycles, None);
    }

    #[test]
    fn peripherals_are_not_the_laptop_battery() {
        let fs = FakeFs::new(&[
            ("/sys/class/power_supply/hidpp_battery_1/type", "Battery"),
            ("/sys/class/power_supply/hidpp_battery_1/scope", "Device"),
            ("/sys/class/power_supply/hidpp_battery_1/capacity", "95"),
            ("/sys/class/power_supply/ucsi-source-psy-1/type", "USB"),
            ("/sys/class/power_supply/ucsi-source-psy-1/scope", "Device"),
            ("/sys/class/power_supply/ucsi-source-psy-1/online", "1"),
        ]);
        assert_eq!(
            poll(&fs),
            PowerStatus {
                source: PowerSource::Unknown,
                battery: None,
            }
        );
    }

    #[test]
    fn desktop_without_a_power_supply() {
        let fs = FakeFs::new(AMD_DESKTOP);
        assert_eq!(
            poll(&fs),
            PowerStatus {
                source: PowerSource::Unknown,
                battery: None,
            }
        );
    }

    #[test]
    fn unreadable_attributes_have_no_value() {
        let fs = FakeFs::new(PHN16_72).with_unreadable(&format!("{BAT}/voltage_now"));
        discharging(&fs);
        let battery = poll(&fs).battery.unwrap();
        assert_eq!(battery.watts, None);
        assert_eq!(battery.minutes_left, None);
        assert_eq!(battery.health_percent, None);
        assert_eq!(battery.percent, Some(80.0), "capacity needs no voltage");
    }

    #[test]
    fn time_left_follows_the_average_draw() {
        let fs = FakeFs::new(PHN16_72);
        discharging(&fs);
        let clock = FakeClock::starting_at(100);
        let mut monitor = PowerMonitor::default();
        let first = monitor.poll(&fs, &clock).battery.unwrap();
        assert_eq!(first.minutes_left, Some(172));

        // A 2 s spike to three times the draw barely moves the estimate ...
        fs.set(&format!("{BAT}/current_now"), "4500000");
        clock.advance(2);
        let spike = monitor.poll(&fs, &clock).battery.unwrap();
        assert_eq!(
            spike.watts,
            Some(73.4),
            "the reading itself is not averaged"
        );
        assert_eq!(spike.minutes_left, Some(162));

        // ... while a sustained one takes over within a few minutes.
        for _ in 0..150 {
            clock.advance(2);
            monitor.poll(&fs, &clock);
        }
        clock.advance(2);
        assert_eq!(
            monitor.poll(&fs, &clock).battery.unwrap().minutes_left,
            Some(58)
        );
    }

    #[test]
    fn plugging_in_resets_the_average() {
        let fs = FakeFs::new(PHN16_72);
        discharging(&fs);
        let clock = FakeClock::starting_at(100);
        let mut monitor = PowerMonitor::default();
        monitor.poll(&fs, &clock);

        fs.set(AC, "1");
        fs.set(&format!("{BAT}/status"), "Charging");
        clock.advance(2);
        let charging = monitor.poll(&fs, &clock);
        assert_eq!(charging.source, PowerSource::Ac);
        assert_eq!(charging.battery.unwrap().minutes_left, None);

        discharging(&fs);
        fs.set(&format!("{BAT}/current_now"), "3000000");
        clock.advance(2);
        assert_eq!(
            monitor.poll(&fs, &clock).battery.unwrap().minutes_left,
            Some(86),
            "the new draw is used as is, not blended with the old one"
        );
    }

    #[test]
    fn battery_state_parsing() {
        assert_eq!(
            BatteryState::parse(Some("Charging")),
            BatteryState::Charging
        );
        assert_eq!(BatteryState::parse(Some("Full")), BatteryState::Full);
        assert_eq!(
            BatteryState::parse(Some("Not charging")),
            BatteryState::NotCharging
        );
        assert_eq!(BatteryState::parse(Some("garbage")), BatteryState::Unknown);
        assert_eq!(BatteryState::parse(None), BatteryState::Unknown);
    }
}
