// SPDX-License-Identifier: GPL-3.0-or-later
//! CPU package power from RAPL, `/sys/class/powercap/intel-rapl:N`. Intel and
//! AMD both expose it there.
//!
//! The kernel offers a cumulative energy counter, not watts, so the draw is
//! the energy used between two reads over the time between them. The counter
//! is root-only since the PLATYPUS side-channel attack (CVE-2020-8694): fast,
//! fine-grained samples leak what other code is doing. heliosd runs as root
//! and owns the file, and it publishes the reading to every user, so it only
//! ever reports an average over at least [`WINDOW`], rounded to 0.1 W.
//! Nothing is written.

use std::time::Duration;

use crate::io::{Clock, SysFs, read_int};
use crate::power::round_tenth;

pub const POWERCAP: &str = "/sys/class/powercap";

/// The shortest interval a reading averages over (the anti-PLATYPUS limit).
pub const WINDOW: Duration = Duration::from_secs(2);

/// Above this the sample is a counter reset (e.g. across suspend), not a
/// real draw: the biggest desktop CPUs stay well under it.
const MAX_PLAUSIBLE_WATTS: f64 = 1000.0;

/// The package domains: `intel-rapl:0`, `intel-rapl:1`, ... (one per socket).
/// Subdomains (`intel-rapl:0:0`, cores) are part of the package, and
/// `intel-rapl-mmio:0` is the same package seen through MMIO; counting
/// either would count the CPU twice.
fn packages(fs: &dyn SysFs) -> Vec<String> {
    fs.read_dir(POWERCAP)
        .into_iter()
        .filter(|name| {
            name.strip_prefix("intel-rapl:")
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(|name| format!("{POWERCAP}/{name}"))
        .filter(|dir| {
            fs.read_to_string(&format!("{dir}/name"))
                .is_some_and(|n| n.starts_with("package"))
        })
        .collect()
}

/// One read of every package counter: (directory, µJ).
fn sample(fs: &dyn SysFs) -> Option<Vec<(String, u64)>> {
    let dirs = packages(fs);
    if dirs.is_empty() {
        return None;
    }
    dirs.into_iter()
        .map(|dir| {
            let uj = u64::try_from(read_int(fs, &format!("{dir}/energy_uj"))?).ok()?;
            Some((dir, uj))
        })
        .collect()
}

/// µJ used since `old`, across one wraparound of the counter.
fn used(fs: &dyn SysFs, dir: &str, old: u64, new: u64) -> Option<u64> {
    if new >= old {
        return Some(new - old);
    }
    let range = u64::try_from(read_int(fs, &format!("{dir}/max_energy_range_uj"))?).ok()?;
    Some(range.checked_sub(old)? + new)
}

#[derive(Debug)]
struct Baseline {
    energy: Vec<(String, u64)>,
    at: Duration,
}

/// Keeps the previous counter read between polls.
#[derive(Debug, Default)]
pub struct CpuPowerMeter {
    baseline: Option<Baseline>,
    watts: Option<f64>,
}

impl CpuPowerMeter {
    /// The package draw in W, or `None` when there is no RAPL, it cannot be
    /// read (not root), or this is the first read. Reads closer together
    /// than [`WINDOW`] return the previous value without touching the
    /// counter.
    pub fn read(&mut self, fs: &dyn SysFs, clock: &dyn Clock) -> Option<f64> {
        let now = clock.now();
        if let Some(b) = &self.baseline {
            if now.saturating_sub(b.at) < WINDOW {
                return self.watts;
            }
        }
        let Some(energy) = sample(fs) else {
            self.baseline = None;
            self.watts = None;
            return None;
        };
        self.watts = self
            .baseline
            .as_ref()
            .and_then(|b| watts(fs, b, &energy, now));
        self.baseline = Some(Baseline { energy, at: now });
        self.watts
    }

    /// The counter is readable but a second read is needed for a value.
    pub fn pending(&self) -> bool {
        self.baseline.is_some() && self.watts.is_none()
    }
}

fn watts(fs: &dyn SysFs, old: &Baseline, energy: &[(String, u64)], now: Duration) -> Option<f64> {
    if old.energy.len() != energy.len() {
        return None;
    }
    let mut total = 0;
    for ((old_dir, old_uj), (dir, uj)) in old.energy.iter().zip(energy) {
        if old_dir != dir {
            return None;
        }
        total += used(fs, dir, *old_uj, *uj)?;
    }
    let secs = now.saturating_sub(old.at).as_secs_f64();
    let watts = total as f64 / 1e6 / secs;
    (watts <= MAX_PLAUSIBLE_WATTS).then(|| round_tenth(watts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeClock, FakeFs, PHN16_72};

    const ENERGY: &str = "/sys/class/powercap/intel-rapl:0/energy_uj";

    /// Polls at `t`, after setting the counter to `uj`.
    fn read_at(meter: &mut CpuPowerMeter, fs: &FakeFs, clock: &FakeClock, uj: u64) -> Option<f64> {
        fs.set(ENERGY, &uj.to_string());
        meter.read(fs, clock)
    }

    #[test]
    fn phn16_72_draw_between_two_reads() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(100);
        let mut meter = CpuPowerMeter::default();
        assert_eq!(read_at(&mut meter, &fs, &clock, 1_000_000_000), None);
        assert!(meter.pending());

        clock.advance(2);
        // 24.68 J in 2 s
        assert_eq!(read_at(&mut meter, &fs, &clock, 1_024_680_000), Some(12.3));
        assert!(!meter.pending());
        assert!(fs.writes().is_empty(), "RAPL is read-only");
    }

    #[test]
    fn mmio_and_subdomains_are_not_counted_twice() {
        let fs = FakeFs::new(PHN16_72);
        assert_eq!(packages(&fs), ["/sys/class/powercap/intel-rapl:0"]);
    }

    #[test]
    fn every_socket_is_summed() {
        let fs = FakeFs::new(&[
            ("/sys/class/powercap/intel-rapl:0/name", "package-0"),
            ("/sys/class/powercap/intel-rapl:0/energy_uj", "0"),
            ("/sys/class/powercap/intel-rapl:1/name", "package-1"),
            ("/sys/class/powercap/intel-rapl:1/energy_uj", "0"),
        ]);
        let clock = FakeClock::starting_at(0);
        let mut meter = CpuPowerMeter::default();
        meter.read(&fs, &clock);
        fs.set("/sys/class/powercap/intel-rapl:0/energy_uj", "20000000");
        fs.set("/sys/class/powercap/intel-rapl:1/energy_uj", "40000000");
        clock.advance(2);
        assert_eq!(meter.read(&fs, &clock), Some(30.0));
    }

    #[test]
    fn the_counter_wraps_around() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut meter = CpuPowerMeter::default();
        read_at(&mut meter, &fs, &clock, 262_143_328_850 - 10_000_000);
        clock.advance(2);
        // 10 J before the wrap + 10 J after it
        assert_eq!(read_at(&mut meter, &fs, &clock, 10_000_000), Some(10.0));
    }

    #[test]
    fn a_counter_reset_is_dropped_and_starts_over() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut meter = CpuPowerMeter::default();
        read_at(&mut meter, &fs, &clock, 5_000_000_000);
        clock.advance(2);
        assert_eq!(read_at(&mut meter, &fs, &clock, 1_000), None, "over 100 kW");
        clock.advance(2);
        assert_eq!(read_at(&mut meter, &fs, &clock, 20_001_000), Some(10.0));
    }

    #[test]
    fn reads_inside_the_window_repeat_the_last_value() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut meter = CpuPowerMeter::default();
        read_at(&mut meter, &fs, &clock, 0);
        clock.advance(2);
        assert_eq!(read_at(&mut meter, &fs, &clock, 20_000_000), Some(10.0));

        // A fast poller sees no finer detail than one value per window.
        clock.advance(1);
        assert_eq!(read_at(&mut meter, &fs, &clock, 90_000_000), Some(10.0));
        clock.advance(1);
        assert_eq!(read_at(&mut meter, &fs, &clock, 100_000_000), Some(40.0));
    }

    #[test]
    fn unreadable_counter_has_no_value() {
        // What a normal user gets: the file is root 0400.
        let fs = FakeFs::new(PHN16_72).with_unreadable(ENERGY);
        let clock = FakeClock::starting_at(0);
        let mut meter = CpuPowerMeter::default();
        assert_eq!(meter.read(&fs, &clock), None);
        clock.advance(2);
        assert_eq!(meter.read(&fs, &clock), None);
        assert!(!meter.pending(), "nothing to wait for");
    }

    #[test]
    fn no_rapl_has_no_value() {
        let fs = FakeFs::new(AMD_DESKTOP);
        let mut meter = CpuPowerMeter::default();
        assert_eq!(meter.read(&fs, &FakeClock::default()), None);
        assert!(!meter.pending());
    }
}
