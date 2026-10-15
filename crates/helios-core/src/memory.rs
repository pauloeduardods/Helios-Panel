// SPDX-License-Identifier: GPL-3.0-or-later
//! RAM usage from `/proc/meminfo`. World-readable; nothing is written.

use crate::io::SysFs;

pub const MEMINFO: &str = "/proc/meminfo";

const KIB_PER_GIB: f64 = 1024.0 * 1024.0;

/// What is in use, the way `free` and GNOME's System Monitor count it:
/// everything but `MemAvailable` (free memory plus the cache the kernel can
/// drop).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Memory {
    /// GiB, rounded to 0.1.
    pub used_gib: f64,
    pub total_gib: f64,
    /// Whole percent, from the exact amounts.
    pub percent: f64,
}

/// One `Name:   1234 kB` line of meminfo, in KiB.
fn field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?.strip_prefix(':')?;
        rest.split_ascii_whitespace().next()?.parse().ok()
    })
}

/// `None` without meminfo or without `MemAvailable` (kernels before 3.14).
pub fn read(fs: &dyn SysFs) -> Option<Memory> {
    let text = fs.read_to_string(MEMINFO)?;
    let total = field(&text, "MemTotal").filter(|t| *t > 0)?;
    let available = field(&text, "MemAvailable")?.min(total);
    let used = total - available;
    let gib = |kib: u64| (kib as f64 / KIB_PER_GIB * 10.0).round() / 10.0;
    Some(Memory {
        used_gib: gib(used),
        total_gib: gib(total),
        percent: (used as f64 / total as f64 * 100.0).round(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeFs, PHN16_72};

    #[test]
    fn phn16_72_memory() {
        let fs = FakeFs::new(PHN16_72);
        assert_eq!(
            read(&fs),
            Some(Memory {
                used_gib: 12.4,
                total_gib: 31.1,
                percent: 40.0,
            })
        );
        assert!(fs.writes().is_empty(), "memory is read-only");
    }

    #[test]
    fn field_parsing() {
        let text = "MemTotal:       16000 kB\nMemFree:  10 kB\nMemAvailable:    4000 kB\n";
        assert_eq!(field(text, "MemTotal"), Some(16000));
        assert_eq!(field(text, "MemAvailable"), Some(4000));
        assert_eq!(field(text, "Mem"), None, "a prefix is not a field");
        assert_eq!(field("MemTotal: x kB", "MemTotal"), None);
    }

    #[test]
    fn missing_or_odd_meminfo_has_no_value() {
        assert_eq!(read(&FakeFs::new(AMD_DESKTOP)), None);
        let old_kernel = FakeFs::new(&[(MEMINFO, "MemTotal: 16000 kB\nMemFree: 8000 kB\n")]);
        assert_eq!(read(&old_kernel), None);
        let empty = FakeFs::new(&[(MEMINFO, "MemTotal: 0 kB\nMemAvailable: 0 kB\n")]);
        assert_eq!(read(&empty), None);
        let odd = FakeFs::new(&[(MEMINFO, "MemTotal: 1000 kB\nMemAvailable: 2000 kB\n")]);
        assert_eq!(read(&odd).map(|m| m.percent), Some(0.0));
    }
}
