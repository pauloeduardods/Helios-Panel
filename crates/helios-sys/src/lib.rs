// SPDX-License-Identifier: GPL-3.0-or-later
//! Real implementations of the helios-core I/O traits.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use helios_core::{Clock, GpuQuery, SysFs};

/// sysfs access with every absolute path resolved under `root`. Production
/// uses `/`; tests point it at a temporary tree.
#[derive(Debug, Clone)]
pub struct RootedFs {
    root: PathBuf,
}

impl RootedFs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn system() -> Self {
        Self::new("/")
    }

    fn map(&self, path: &str) -> PathBuf {
        self.root.join(path.trim_start_matches('/'))
    }
}

/// Larger than any attribute Helios reads (/proc/stat is the largest).
const MAX_ATTRIBUTE: u64 = 1 << 20;

impl SysFs for RootedFs {
    fn read_to_string(&self, path: &str) -> Option<String> {
        // `fs::read_to_string` first asks for the file's size (statx), which
        // sysfs does not know anyway. Reading through `take` skips that: one
        // syscall fewer per attribute, about 70 per poll.
        let file = fs::File::open(self.map(path)).ok()?;
        let mut text = String::with_capacity(256);
        file.take(MAX_ATTRIBUTE).read_to_string(&mut text).ok()?;
        Some(text.trim().to_owned())
    }

    fn read_dir(&self, path: &str) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.map(path)) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .collect();
        names.sort();
        names
    }

    fn exists(&self, path: &str) -> bool {
        self.map(path).exists()
    }

    fn write(&self, path: &str, value: &str) -> std::io::Result<()> {
        // No create: sysfs attributes already exist, and a missing one must
        // stay missing. Truncate matches what a shell `>` redirect does.
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(self.map(path))?;
        file.write_all(value.as_bytes())
    }
}

/// Runs nvidia-smi with a fixed argv and a timeout.
#[derive(Debug, Clone)]
pub struct NvidiaSmi {
    program: PathBuf,
    timeout: Duration,
}

impl NvidiaSmi {
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(4);
    const ARGS: [&'static str; 2] = [
        "--query-gpu=temperature.gpu,power.draw,utilization.gpu",
        "--format=csv,noheader,nounits",
    ];

    pub fn new(program: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            program: program.into(),
            timeout,
        }
    }

    /// `nvidia-smi` from `PATH`, if installed.
    pub fn find() -> Option<Self> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join("nvidia-smi"))
            .find(|p| is_executable(p))
            .map(|p| Self::new(p, Self::DEFAULT_TIMEOUT))
    }
}

impl NvidiaSmi {
    /// Retries briefly on ETXTBSY: exec fails while any process (e.g. one
    /// forked during a driver upgrade) still has the binary open for writing.
    fn spawn(&self) -> Option<Child> {
        for _ in 0..5 {
            match Command::new(&self.program)
                .args(Self::ARGS)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => return Some(child),
                Err(e) if e.kind() == ErrorKind::ExecutableFileBusy => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return None,
            }
        }
        None
    }
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

impl GpuQuery for NvidiaSmi {
    fn query(&self) -> Option<String> {
        let mut child = self.spawn()?;
        let deadline = Instant::now() + self.timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
            }
        }
        // One short line: it fits in the pipe buffer, so reading after exit is safe.
        let mut out = String::new();
        child.stdout.take()?.read_to_string(&mut out).ok()?;
        Some(out)
    }
}

/// Monotonic clock counted from construction.
#[derive(Debug)]
pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.start.elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "helios-sys-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("nvidia-smi");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn rooted_fs_reads_trimmed_and_lists_sorted() {
        let root = temp_dir();
        fs::create_dir_all(root.join("sys/a")).unwrap();
        fs::write(root.join("sys/a/x"), "balanced\n").unwrap();
        fs::write(root.join("sys/a/b"), "1").unwrap();
        let rfs = RootedFs::new(&root);
        assert_eq!(rfs.read_to_string("/sys/a/x").as_deref(), Some("balanced"));
        assert_eq!(rfs.read_dir("/sys/a"), ["b", "x"]);
        assert!(rfs.exists("/sys/a"));
        assert_eq!(rfs.read_to_string("/sys/missing"), None);
        assert!(rfs.read_dir("/sys/missing").is_empty());
    }

    #[test]
    fn rooted_fs_write_replaces_content_and_never_creates() {
        let root = temp_dir();
        fs::create_dir_all(root.join("sys")).unwrap();
        fs::write(root.join("sys/profile"), "balanced-performance\n").unwrap();
        let rfs = RootedFs::new(&root);
        rfs.write("/sys/profile", "quiet").unwrap();
        assert_eq!(
            fs::read_to_string(root.join("sys/profile")).unwrap(),
            "quiet"
        );
        assert!(rfs.write("/sys/new", "x").is_err());
        assert!(!root.join("sys/new").exists());
    }

    #[test]
    fn nvidia_smi_output_is_returned() {
        let dir = temp_dir();
        let smi = NvidiaSmi::new(script(&dir, "echo 47"), NvidiaSmi::DEFAULT_TIMEOUT);
        assert_eq!(smi.query().as_deref(), Some("47\n"));
    }

    #[test]
    fn nvidia_smi_gets_the_fixed_arguments() {
        let dir = temp_dir();
        let smi = NvidiaSmi::new(script(&dir, "echo \"$@\""), NvidiaSmi::DEFAULT_TIMEOUT);
        assert_eq!(
            smi.query().as_deref(),
            Some(
                "--query-gpu=temperature.gpu,power.draw,utilization.gpu --format=csv,noheader,nounits\n"
            )
        );
    }

    #[test]
    fn nvidia_smi_busy_binary_is_retried() {
        // Regression: exec fails with ETXTBSY while another process still
        // has the binary open for writing (seen as flaky parallel tests).
        let dir = temp_dir();
        let path = script(&dir, "echo 47");
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(15));
            drop(writer);
        });
        let smi = NvidiaSmi::new(&path, NvidiaSmi::DEFAULT_TIMEOUT);
        assert_eq!(smi.query().as_deref(), Some("47\n"));
        release.join().unwrap();
    }

    #[test]
    fn nvidia_smi_failure_and_timeout_give_none() {
        let dir = temp_dir();
        let failing = NvidiaSmi::new(script(&dir, "echo 47; exit 1"), NvidiaSmi::DEFAULT_TIMEOUT);
        assert_eq!(failing.query(), None);

        let dir = temp_dir();
        let slow = NvidiaSmi::new(script(&dir, "exec sleep 5"), Duration::from_millis(200));
        let started = Instant::now();
        assert_eq!(slow.query(), None);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the hung process was killed"
        );

        let missing = NvidiaSmi::new(dir.join("nope"), NvidiaSmi::DEFAULT_TIMEOUT);
        assert_eq!(missing.query(), None);
    }
}
