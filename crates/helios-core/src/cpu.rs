// SPDX-License-Identifier: GPL-3.0-or-later
//! CPU usage from `/proc/stat` and clock speed from cpufreq. Both are
//! world-readable; nothing is written.

use std::time::Duration;

use crate::io::{SysFs, read_int};

pub const PROC_STAT: &str = "/proc/stat";
pub const CPUFREQ: &str = "/sys/devices/system/cpu/cpufreq";

/// How long a one-shot reader waits between the two `/proc/stat` reads that
/// make one usage value.
pub const USAGE_SETTLE: Duration = Duration::from_millis(500);

/// (busy, total) jiffies from the aggregate `cpu` line. Idle and iowait are
/// the idle time; guest time is already inside user and nice.
fn parse_stat(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().next()?;
    let mut fields = line.split_ascii_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let values: Vec<u64> = fields
        .take(8) // user nice system idle iowait irq softirq steal
        .map(|f| f.parse().ok())
        .collect::<Option<_>>()?;
    if values.len() < 4 {
        return None;
    }
    let total: u64 = values.iter().sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

/// Keeps the previous `/proc/stat` read between polls.
#[derive(Debug, Default)]
pub struct CpuUsageMeter {
    last: Option<(u64, u64)>,
    percent: Option<f64>,
}

impl CpuUsageMeter {
    /// Whole percent of all CPUs busy since the previous read; `None` on the
    /// first read.
    pub fn read(&mut self, fs: &dyn SysFs) -> Option<f64> {
        let Some(now) = fs.read_to_string(PROC_STAT).as_deref().and_then(parse_stat) else {
            self.last = None;
            self.percent = None;
            return None;
        };
        self.percent = self.last.and_then(|(busy, total)| {
            let busy = now.0.checked_sub(busy)?;
            let total = now.1.checked_sub(total)?;
            // No time passed (two reads in the same jiffy): keep the last value.
            (total > 0).then(|| (busy as f64 / total as f64 * 100.0).round())
        });
        self.last = Some(now);
        self.percent
    }

    /// `/proc/stat` is readable but a second read is needed for a value.
    pub fn pending(&self) -> bool {
        self.last.is_some() && self.percent.is_none()
    }
}

/// Clock speed across the cores, in GHz rounded to 0.1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frequency {
    pub average: f64,
    pub max: f64,
}

/// From every `policyN/scaling_cur_freq` (kHz); `None` without cpufreq.
pub fn read_frequency(fs: &dyn SysFs) -> Option<Frequency> {
    let khz: Vec<i64> = fs
        .read_dir(CPUFREQ)
        .into_iter()
        .filter(|name| name.starts_with("policy"))
        .filter_map(|name| read_int(fs, &format!("{CPUFREQ}/{name}/scaling_cur_freq")))
        .filter(|khz| *khz > 0)
        .collect();
    let max = *khz.iter().max()?;
    let average = khz.iter().sum::<i64>() as f64 / khz.len() as f64;
    let ghz = |khz: f64| (khz / 1e5).round() / 10.0;
    Some(Frequency {
        average: ghz(average),
        max: ghz(max as f64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeFs, PHN16_72};

    #[test]
    fn stat_parsing() {
        assert_eq!(
            parse_stat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n"),
            Some((150, 1000))
        );
        assert_eq!(
            parse_stat("cpu  10 20 30 40"),
            Some((60, 100)),
            "old kernels"
        );
        assert_eq!(parse_stat("cpu0 1 2 3 4"), None);
        assert_eq!(parse_stat("cpu  1 x 3 4"), None);
        assert_eq!(parse_stat("cpu  1 2"), None);
        assert_eq!(parse_stat(""), None);
    }

    #[test]
    fn usage_between_two_reads() {
        let fs = FakeFs::new(PHN16_72);
        let mut meter = CpuUsageMeter::default();
        assert_eq!(meter.read(&fs), None);
        assert!(meter.pending());

        // 230 of 1000 more jiffies were busy
        fs.set(PROC_STAT, "cpu  1100 0 630 9750 220 0 0 0 0 0\n");
        assert_eq!(meter.read(&fs), Some(23.0));
        assert!(!meter.pending());
        assert!(fs.writes().is_empty(), "usage is read-only");
    }

    #[test]
    fn a_counter_that_goes_back_has_no_value() {
        let fs = FakeFs::new(PHN16_72);
        let mut meter = CpuUsageMeter::default();
        meter.read(&fs);
        fs.set(PROC_STAT, "cpu  1 0 1 1 0 0 0 0 0 0\n");
        assert_eq!(meter.read(&fs), None);
        fs.set(PROC_STAT, "cpu  51 0 51 101 0 0 0 0 0 0\n");
        assert_eq!(
            meter.read(&fs),
            Some(50.0),
            "starts over from the new value"
        );
    }

    #[test]
    fn no_proc_stat_has_no_value() {
        let fs = FakeFs::new(AMD_DESKTOP);
        let mut meter = CpuUsageMeter::default();
        assert_eq!(meter.read(&fs), None);
        assert!(!meter.pending());
    }

    #[test]
    fn phn16_72_frequency() {
        assert_eq!(
            read_frequency(&FakeFs::new(PHN16_72)),
            Some(Frequency {
                average: 2.1,
                max: 4.8,
            })
        );
    }

    #[test]
    fn offline_or_unreadable_cores_are_skipped() {
        let fs = FakeFs::new(&[
            (
                "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq",
                "3000000",
            ),
            (
                "/sys/devices/system/cpu/cpufreq/policy1/scaling_cur_freq",
                "<unknown>",
            ),
            (
                "/sys/devices/system/cpu/cpufreq/policy2/scaling_cur_freq",
                "0",
            ),
        ]);
        assert_eq!(
            read_frequency(&fs),
            Some(Frequency {
                average: 3.0,
                max: 3.0,
            })
        );
        assert_eq!(read_frequency(&FakeFs::new(AMD_DESKTOP)), None);
    }
}
