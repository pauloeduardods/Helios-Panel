// SPDX-License-Identifier: GPL-3.0-or-later
//! Runs the real heliosctl binary against fixture trees on disk, with a fake
//! nvidia-smi that records every run.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

use helios_core::fake::{AMD_DESKTOP, PHN16_72, PHN16_72_SYSTEM};
use serde_json::Value;

const GPU_STATUS: &str = "sys/bus/pci/devices/0000:01:00.0/power/runtime_status";

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    smi: PathBuf,
    smi_log: PathBuf,
}

impl Fixture {
    fn new(files: &[(&str, &str)]) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "heliosctl-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        for (path, value) in files {
            let file = root.join(path.trim_start_matches('/'));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, format!("{value}\n")).unwrap();
        }
        let smi_log = base.join("smi.log");
        let smi = base.join("nvidia-smi");
        fs::write(
            &smi,
            format!(
                "#!/bin/sh\necho run >> '{}'\necho '47, 35.2'\n",
                smi_log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&smi, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            base,
            root,
            smi,
            smi_log,
        }
    }

    fn set(&self, path: &str, value: &str) {
        fs::write(self.root.join(path), value).unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_heliosctl"))
            .arg("--sysfs-root")
            .arg(&self.root)
            .arg("--nvidia-smi")
            .arg(&self.smi)
            .args(args)
            .output()
            .unwrap()
    }

    fn json(&self) -> Value {
        let out = self.run(&["status", "--json"]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }

    fn smi_runs(&self) -> usize {
        fs::read_to_string(&self.smi_log).map_or(0, |s| s.lines().count())
    }

    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.insert(path.clone(), fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &mut out);
        out
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn json_status_phn16_72_with_the_gpu_asleep() {
    let fx = Fixture::new(PHN16_72);
    let before = fx.snapshot();
    let status = fx.json();

    assert_eq!(status["schema"], 1);
    assert_eq!(status["cpu"]["sensor"], "hwmon:coretemp/Package id 0");
    assert_eq!(status["cpu"]["celsius"], 61.0);
    assert_eq!(status["gpu"]["state"], "off");
    assert_eq!(status["gpu"]["celsius"], Value::Null);
    assert_eq!(status["fans"][1]["rpm"], 2600);
    assert_eq!(status["profile"]["active"], "balanced");
    assert_eq!(status["profile"]["driver"], "acer-wmi");
    assert_eq!(status["profile"]["choices"][0], "low-power");
    assert_eq!(status["temperatures"].as_array().unwrap().len(), 4);

    assert_eq!(fx.smi_runs(), 0, "a suspended GPU must never be queried");
    assert_eq!(fx.snapshot(), before, "status must not write anything");
}

#[test]
fn json_status_phn16_72_with_the_gpu_awake() {
    let fx = Fixture::new(PHN16_72);
    fx.set(GPU_STATUS, "active\n");
    let status = fx.json();
    assert_eq!(status["gpu"]["state"], "on");
    assert_eq!(status["gpu"]["source"], "nvidia-smi");
    assert_eq!(status["gpu"]["celsius"], 47.0);
    assert_eq!(fx.smi_runs(), 1);
}

#[test]
fn json_status_amd_desktop() {
    let fx = Fixture::new(AMD_DESKTOP);
    let status = fx.json();
    assert_eq!(status["cpu"]["sensor"], "hwmon:k10temp/Tctl");
    assert_eq!(status["gpu"]["source"], "hwmon:amdgpu/edge");
    assert_eq!(status["gpu"]["celsius"], 50.0);
    assert_eq!(status["profile"]["available"], false);
    assert_eq!(status["fans"], Value::Array(vec![]));
    assert_eq!(fx.smi_runs(), 0);
}

#[test]
fn human_status() {
    let fx = Fixture::new(PHN16_72);
    let out = fx.run(&["status"]);
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.starts_with("CPU      61.0 °C"), "{text}");
    assert!(
        text.contains("GPU      off (asleep, not queried)  (nvidia-smi)"),
        "{text}"
    );
    assert!(text.contains("Profile  balanced  (acer-wmi)"), "{text}");
}

#[test]
fn bad_usage_exits_2() {
    let fx = Fixture::new(PHN16_72);
    let out = fx.run(&["status", "--yaml"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--yaml"));
}

#[test]
fn empty_tree_still_reports() {
    let fx = Fixture::new(&[]);
    let status = fx.json();
    assert_eq!(status["cpu"]["sensor"], Value::Null);
    assert_eq!(status["gpu"]["state"], "none");
    assert_eq!(status["profile"]["available"], false);
}

fn healthy_phn16_72() -> Vec<(&'static str, &'static str)> {
    PHN16_72.iter().chain(PHN16_72_SYSTEM).copied().collect()
}

#[test]
fn doctor_on_a_healthy_phn16_72_finds_nothing_and_writes_nothing() {
    let fx = Fixture::new(&healthy_phn16_72());
    let before = fx.snapshot();
    let out = fx.run(&["doctor"]);
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(out.status.code(), Some(0), "{text}");
    assert!(
        text.starts_with(
            "[ ok ] machine          Acer Predator PHN16-72 (Predator Helios Neo 16), BIOS V1.20\n"
        ),
        "{text}"
    );
    assert!(
        text.contains("[ ok ] heliosd          installed and running (pid 4242)"),
        "{text}"
    );
    assert!(text.ends_with("Nothing to fix.\n"), "{text}");
    assert_eq!(fx.snapshot(), before, "doctor must not write anything");
    assert_eq!(fx.smi_runs(), 0, "doctor never runs nvidia-smi");
}

#[test]
fn doctor_on_a_broken_setup_suggests_commands_and_writes_nothing() {
    let files: Vec<_> = healthy_phn16_72()
        .into_iter()
        .filter(|(p, _)| {
            !p.starts_with("/sys/module")
                && !p.starts_with("/sys/firmware")
                && !p.starts_with("/sys/class/platform-profile")
                && !p.starts_with("/usr/")
                && !p.starts_with("/etc/systemd")
        })
        .chain([("/etc/modprobe.d/blacklist-acer.conf", "blacklist acer_wmi")])
        .collect();
    let fx = Fixture::new(&files);
    let before = fx.snapshot();
    let out = fx.run(&["doctor"]);
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        out.status.code(),
        Some(1),
        "problems give exit status 1: {text}"
    );
    assert!(text.contains("[FAIL] acer_wmi"), "{text}");
    assert!(text.contains("[FAIL] platform_profile"), "{text}");
    assert!(
        text.contains("[warn] heliosd          heliosd is not installed"),
        "{text}"
    );
    assert!(
        text.contains("  sudoedit /etc/modprobe.d/blacklist-acer.conf   # delete the line: blacklist acer_wmi\n"),
        "{text}"
    );
    assert!(
        text.contains("  sudo modprobe acer_wmi predator_v4=1\n"),
        "{text}"
    );
    assert!(text.contains("  ./install.sh\n"), "{text}");
    assert_eq!(fx.snapshot(), before, "doctor must not write anything");
}

#[test]
fn doctor_json() {
    let fx = Fixture::new(&healthy_phn16_72());
    let out = fx.run(&["doctor", "--json"]);
    assert_eq!(out.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    let checks: Vec<&str> = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["check"].as_str().unwrap())
        .collect();
    assert_eq!(
        checks,
        [
            "machine",
            "acer_wmi",
            "predator_v4",
            "platform_profile",
            "lighting",
            "heliosd"
        ]
    );
    assert_eq!(report["findings"][0]["level"], "ok");
}
