// SPDX-License-Identifier: GPL-3.0-or-later
//! The only doors to the outside world. Implemented for real in helios-sys
//! and in memory in [`crate::fake`].

use std::time::Duration;

/// Filesystem access. Paths are absolute ("/sys/...").
pub trait SysFs {
    /// Contents with surrounding whitespace trimmed; `None` on any error.
    fn read_to_string(&self, path: &str) -> Option<String>;
    /// Entry names, sorted; empty on any error.
    fn read_dir(&self, path: &str) -> Vec<String>;
    fn exists(&self, path: &str) -> bool;
    /// Writes an existing file in place. sysfs attributes cannot be replaced
    /// through a temporary file and a rename, and must never be created.
    fn write(&self, path: &str, value: &str) -> std::io::Result<()>;
}

/// Runs `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits`.
pub trait GpuQuery {
    /// Its stdout, or `None` if it failed or timed out.
    fn query_temperature(&self) -> Option<String>;
}

/// Monotonic time.
pub trait Clock {
    fn now(&self) -> Duration;
}

/// Reads a decimal integer attribute.
pub fn read_int(fs: &dyn SysFs, path: &str) -> Option<i64> {
    fs.read_to_string(path)?.parse().ok()
}
