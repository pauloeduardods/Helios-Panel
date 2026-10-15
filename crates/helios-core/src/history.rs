// SPDX-License-Identifier: GPL-3.0-or-later
//! The last few minutes of a handful of readings, kept in memory for the
//! sparklines. Fixed size and never written to disk.

use std::collections::VecDeque;
use std::time::Duration;

use crate::power::BatteryState;
use crate::status::Status;

/// How far back the history goes.
pub const SPAN: Duration = Duration::from_secs(5 * 60);

/// Enough samples for [`SPAN`] at heliosd's 2 s interval.
pub const CAPACITY: usize = 150;

/// The readings that are kept, in the order [`History::series`] returns them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Series {
    CpuCelsius,
    GpuCelsius,
    CpuUsage,
    GpuUsage,
    CpuWatts,
    /// Only while discharging: what the whole laptop draws.
    BatteryWatts,
    MemoryUsage,
}

impl Series {
    pub const ALL: [Series; 7] = [
        Series::CpuCelsius,
        Series::GpuCelsius,
        Series::CpuUsage,
        Series::GpuUsage,
        Series::CpuWatts,
        Series::BatteryWatts,
        Series::MemoryUsage,
    ];

    /// The name clients ask for and receive.
    pub fn name(self) -> &'static str {
        match self {
            Series::CpuCelsius => "cpu-celsius",
            Series::GpuCelsius => "gpu-celsius",
            Series::CpuUsage => "cpu-usage",
            Series::GpuUsage => "gpu-usage",
            Series::CpuWatts => "cpu-watts",
            Series::BatteryWatts => "battery-watts",
            Series::MemoryUsage => "memory-usage",
        }
    }

    fn read(self, s: &Status) -> Option<f64> {
        match self {
            Series::CpuCelsius => s.cpu.celsius,
            Series::GpuCelsius => s.gpu.celsius,
            Series::CpuUsage => s.cpu.usage_percent,
            Series::GpuUsage => s.gpu.usage_percent,
            Series::CpuWatts => s.cpu.watts,
            Series::BatteryWatts => s
                .power
                .battery
                .as_ref()
                .filter(|b| b.state == BatteryState::Discharging)
                .and_then(|b| b.watts),
            Series::MemoryUsage => s.memory.usage_percent,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    at: Duration,
    values: [Option<f64>; Series::ALL.len()],
}

/// One series as clients get it, oldest first, aligned with
/// [`Snapshot::ages`]; `None` where the reading had no value.
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesData {
    pub series: Series,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Seconds before now of each sample, oldest first.
    pub ages: Vec<f64>,
    pub series: Vec<SeriesData>,
}

/// A ring buffer of the last [`CAPACITY`] polls.
#[derive(Debug, Default)]
pub struct History {
    samples: VecDeque<Sample>,
}

impl History {
    /// Records one poll taken at `at` (monotonic time).
    pub fn record(&mut self, at: Duration, status: &Status) {
        if self.samples.len() == CAPACITY {
            self.samples.pop_front();
        }
        self.samples.push_back(Sample {
            at,
            values: Series::ALL.map(|s| s.read(status)),
        });
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Everything within [`SPAN`] of `now`, oldest first. Samples older
    /// than that (e.g. from before a long pause) are left out.
    pub fn snapshot(&self, now: Duration) -> Snapshot {
        let recent: Vec<&Sample> = self
            .samples
            .iter()
            .filter(|s| now.saturating_sub(s.at) <= SPAN)
            .collect();
        Snapshot {
            ages: recent
                .iter()
                .map(|s| now.saturating_sub(s.at).as_secs_f64())
                .collect(),
            series: Series::ALL
                .iter()
                .enumerate()
                .map(|(i, series)| SeriesData {
                    series: *series,
                    values: recent.iter().map(|s| s.values[i]).collect(),
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeClock, FakeFs, PHN16_72};
    use crate::io::Clock;
    use crate::status::Monitor;

    const CPU_TEMP: &str = "/sys/class/hwmon/hwmon5/temp1_input";

    fn values(snapshot: &Snapshot, series: Series) -> Vec<Option<f64>> {
        snapshot
            .series
            .iter()
            .find(|d| d.series == series)
            .unwrap()
            .values
            .clone()
    }

    #[test]
    fn records_polls_oldest_first() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(1000);
        let mut monitor = Monitor::new(&fs);
        let mut history = History::default();
        for celsius in [60, 62, 64] {
            fs.set(CPU_TEMP, &format!("{celsius}000"));
            history.record(clock.now(), &monitor.poll(&fs, None, &clock));
            clock.advance(2);
        }
        let snap = history.snapshot(clock.now());
        assert_eq!(snap.ages, [6.0, 4.0, 2.0]);
        assert_eq!(
            values(&snap, Series::CpuCelsius),
            [Some(60.0), Some(62.0), Some(64.0)]
        );
        assert_eq!(
            values(&snap, Series::GpuCelsius),
            [None, None, None],
            "the GPU is asleep"
        );
        assert_eq!(
            values(&snap, Series::BatteryWatts),
            [None, None, None],
            "on AC"
        );
        let names: Vec<_> = snap.series.iter().map(|d| d.series.name()).collect();
        assert_eq!(
            names,
            [
                "cpu-celsius",
                "gpu-celsius",
                "cpu-usage",
                "gpu-usage",
                "cpu-watts",
                "battery-watts",
                "memory-usage"
            ]
        );
    }

    #[test]
    fn keeps_only_the_last_capacity_samples() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let mut history = History::default();
        for _ in 0..CAPACITY + 50 {
            history.record(clock.now(), &monitor.poll(&fs, None, &clock));
            clock.advance(2);
        }
        assert_eq!(history.len(), CAPACITY);
        let snap = history.snapshot(clock.now());
        assert_eq!(snap.ages.len(), CAPACITY);
        assert_eq!(snap.ages.first(), Some(&300.0), "exactly five minutes");
    }

    #[test]
    fn samples_older_than_the_span_are_left_out() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        let mut history = History::default();
        history.record(clock.now(), &monitor.poll(&fs, None, &clock));
        clock.advance(400);
        history.record(clock.now(), &monitor.poll(&fs, None, &clock));
        let snap = history.snapshot(clock.now());
        assert_eq!(snap.ages, [0.0]);
        assert!(History::default().snapshot(clock.now()).ages.is_empty());
    }

    #[test]
    fn battery_draw_only_while_discharging() {
        let fs = FakeFs::new(PHN16_72);
        fs.set("/sys/class/power_supply/ACAD/online", "0");
        fs.set("/sys/class/power_supply/BAT1/status", "Discharging");
        fs.set("/sys/class/power_supply/BAT1/current_now", "1500000");
        let clock = FakeClock::starting_at(0);
        let mut history = History::default();
        history.record(clock.now(), &Monitor::new(&fs).poll(&fs, None, &clock));
        assert_eq!(
            values(&history.snapshot(clock.now()), Series::BatteryWatts),
            [Some(24.5)]
        );
    }
}
