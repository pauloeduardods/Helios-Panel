// SPDX-License-Identifier: GPL-3.0-or-later
//! `heliosctl doctor`: read-only diagnosis of what Helios needs. It only
//! reads (through [`SysFs`]) and returns findings with suggested commands
//! for the user to run; it never changes anything itself.

use serde::Serialize;

use crate::io::SysFs;
use crate::profile;

const DMI: &str = "/sys/class/dmi/id";
const MODULE: &str = "/sys/module/acer_wmi";
const CMDLINE: &str = "/proc/cmdline";
/// modprobe.d directories, highest priority first. A file in an earlier
/// directory hides a file with the same name in a later one.
const MODPROBE_DIRS: &[&str] = &[
    "/etc/modprobe.d",
    "/run/modprobe.d",
    "/usr/local/lib/modprobe.d",
    "/usr/lib/modprobe.d",
    "/lib/modprobe.d",
];
/// Where the persistent option goes when the user asks for it.
const OPTIONS_FILE: &str = "/etc/modprobe.d/acer-wmi-predator.conf";
/// Files install.sh puts in place for heliosd.
const DAEMON_FILES: &[&str] = &[
    "/usr/local/libexec/heliosd",
    "/etc/systemd/system/heliosd.service",
    "/usr/share/dbus-1/system.d/io.github.pauloeduardods.Helios1.conf",
    "/usr/share/dbus-1/system-services/io.github.pauloeduardods.Helios1.service",
    "/usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy",
];

/// The optional keyboard lighting module (kmod/helios-acer-lighting).
pub const LIGHTING_MODULE_VERSION: &str = "0.1.0";
const LIGHTING_LOADED: &str = "/sys/module/helios_acer_lighting";
/// The gaming WMI device the module binds to, and the files it adds there.
const LIGHTING_DEVICE: &str = "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56";
const LIGHTING_ATTRS: &[&str] = &["keyboard_effect", "keyboard_zones"];
/// Models in the module's DMI allow-list.
const LIGHTING_MODELS: &[&str] = &["Predator PHN16-72"];
const SECURE_BOOT: &str =
    "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c";
/// Where Ubuntu's DKMS keeps the key it signs modules with.
const DKMS_MOK: &str = "/var/lib/shim-signed/mok/MOK.der";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Info,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub check: &'static str,
    pub level: Level,
    pub message: String,
    /// Commands for the user to run, in order. Never run by Helios.
    pub fix: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub findings: Vec<Finding>,
}

impl Report {
    /// Whether anything needs attention (a warning or a failure).
    pub fn has_problems(&self) -> bool {
        self.findings.iter().any(|f| f.level >= Level::Warn)
    }
}

fn finding(check: &'static str, level: Level, message: impl Into<String>, fix: &[&str]) -> Finding {
    Finding {
        check,
        level,
        message: message.into(),
        fix: fix.iter().map(|s| (*s).to_owned()).collect(),
    }
}

/// Kernel module names treat `-` and `_` the same.
fn is_acer_wmi(name: &str) -> bool {
    name.replace('-', "_") == "acer_wmi"
}

/// Something that keeps acer_wmi from loading or sets predator_v4.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Directive {
    /// `blacklist acer_wmi`, `install acer_wmi /bin/false`, or a kernel parameter.
    Blocked { location: String, text: String },
    /// `options acer_wmi ... predator_v4=VALUE`, or `acer_wmi.predator_v4=VALUE`.
    PredatorV4 { location: String, value: String },
}

fn modprobe_directives(fs: &dyn SysFs) -> Vec<Directive> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for dir in MODPROBE_DIRS {
        for name in fs.read_dir(dir) {
            if !name.ends_with(".conf") || seen.contains(&name) {
                continue;
            }
            seen.push(name.clone());
            let path = format!("{dir}/{name}");
            let Some(text) = fs.read_to_string(&path) else {
                continue;
            };
            for (n, raw) in text.lines().enumerate() {
                let line = raw.split('#').next().unwrap_or("").trim();
                let words: Vec<&str> = line.split_whitespace().collect();
                let location = format!("{path}:{}", n + 1);
                match words.as_slice() {
                    ["blacklist", m] if is_acer_wmi(m) => {
                        out.push(Directive::Blocked {
                            location,
                            text: line.to_owned(),
                        });
                    }
                    ["install", m, cmd, ..]
                        if is_acer_wmi(m)
                            && matches!(
                                *cmd,
                                "/bin/false" | "/bin/true" | "/usr/bin/false" | "/usr/bin/true"
                            ) =>
                    {
                        out.push(Directive::Blocked {
                            location,
                            text: line.to_owned(),
                        });
                    }
                    ["options", m, opts @ ..] if is_acer_wmi(m) => {
                        for opt in opts {
                            if let Some(value) = opt.strip_prefix("predator_v4=") {
                                out.push(Directive::PredatorV4 {
                                    location: location.clone(),
                                    value: value.to_owned(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

fn cmdline_directives(fs: &dyn SysFs) -> Vec<Directive> {
    let Some(cmdline) = fs.read_to_string(CMDLINE) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for word in cmdline.split_whitespace() {
        let location = "kernel command line".to_owned();
        if let Some(value) = word
            .strip_prefix("acer_wmi.predator_v4=")
            .or_else(|| word.strip_prefix("acer-wmi.predator_v4="))
        {
            out.push(Directive::PredatorV4 {
                location,
                value: value.to_owned(),
            });
        } else if let Some(list) = word
            .strip_prefix("modprobe.blacklist=")
            .or_else(|| word.strip_prefix("module_blacklist="))
        {
            if list.split(',').any(is_acer_wmi) {
                out.push(Directive::Blocked {
                    location,
                    text: word.to_owned(),
                });
            }
        }
    }
    out
}

fn truthy(value: &str) -> bool {
    matches!(value, "1" | "Y" | "y" | "true" | "on")
}

fn check_machine(fs: &dyn SysFs) -> (Finding, bool) {
    let read = |f: &str| fs.read_to_string(&format!("{DMI}/{f}")).unwrap_or_default();
    let (vendor, product, family, bios) = (
        read("sys_vendor"),
        read("product_name"),
        read("product_family"),
        read("bios_version"),
    );
    let shown = match (product.is_empty(), family.is_empty()) {
        (false, false) if family != product => format!("{vendor} {product} ({family})"),
        (false, _) => format!("{vendor} {product}"),
        _ => vendor.clone(),
    };
    let bios = if bios.is_empty() {
        String::new()
    } else {
        format!(", BIOS {bios}")
    };
    let gaming = ["Predator", "Nitro"]
        .iter()
        .any(|m| product.contains(m) || family.contains(m));
    if vendor == "Acer" && gaming {
        (
            finding("machine", Level::Ok, format!("{shown}{bios}"), &[]),
            true,
        )
    } else if vendor == "Acer" {
        let msg =
            format!("{shown}{bios}: not a Predator or Nitro; the gaming profiles may not exist");
        (finding("machine", Level::Info, msg, &[]), true)
    } else {
        let who = if shown.is_empty() {
            "Unknown machine".to_owned()
        } else {
            shown
        };
        let msg = format!(
            "{who}: not an Acer laptop; the acer_wmi checks are skipped, sensors still work"
        );
        (finding("machine", Level::Info, msg, &[]), false)
    }
}

fn check_acer_wmi(fs: &dyn SysFs, directives: &[Directive]) -> Vec<Finding> {
    let mut out = Vec::new();
    let blocks: Vec<&Directive> = directives
        .iter()
        .filter(|d| matches!(d, Directive::Blocked { .. }))
        .collect();
    let options: Vec<(&str, &str)> = directives
        .iter()
        .filter_map(|d| match d {
            Directive::PredatorV4 { location, value } => Some((location.as_str(), value.as_str())),
            Directive::Blocked { .. } => None,
        })
        .collect();

    if !fs.exists(MODULE) {
        if blocks.is_empty() {
            out.push(finding(
                "acer_wmi",
                Level::Fail,
                "acer_wmi is not loaded",
                &["sudo modprobe acer_wmi predator_v4=1"],
            ));
        } else {
            for block in &blocks {
                let Directive::Blocked { location, text } = block else {
                    continue;
                };
                let fix = if location == "kernel command line" {
                    vec![
                        "sudoedit /etc/default/grub   # remove acer_wmi from the blacklist parameter".to_owned(),
                        "sudo update-grub".to_owned(),
                    ]
                } else {
                    let file = location
                        .rsplit_once(':')
                        .map_or(location.as_str(), |(f, _)| f);
                    vec![format!("sudoedit {file}   # delete the line: {text}")]
                };
                out.push(Finding {
                    check: "acer_wmi",
                    level: Level::Fail,
                    message: format!("acer_wmi is blocked by \"{text}\" ({location})"),
                    fix,
                });
            }
            out.last_mut()
                .expect("at least one block")
                .fix
                .push("sudo modprobe acer_wmi predator_v4=1".to_owned());
        }
        return out;
    }

    let param = fs.read_to_string(&format!("{MODULE}/parameters/predator_v4"));
    match param.as_deref() {
        Some(v) if truthy(v) => {
            out.push(finding(
                "acer_wmi",
                Level::Ok,
                "acer_wmi is loaded with predator_v4=1",
                &[],
            ));
            match options.iter().find(|(_, value)| truthy(value)) {
                Some((location, _)) => {
                    out.push(finding(
                        "predator_v4",
                        Level::Ok,
                        format!("set at boot by {location}"),
                        &[],
                    ));
                }
                None => out.push(Finding {
                    check: "predator_v4",
                    level: Level::Info,
                    message: "predator_v4 is set for this boot only; it is not in modprobe.d"
                        .to_owned(),
                    fix: vec![format!(
                        "echo 'options acer_wmi predator_v4=1' | sudo tee {OPTIONS_FILE}"
                    )],
                }),
            }
        }
        _ => {
            let mut fix = Vec::new();
            match options.iter().find(|(_, value)| !truthy(value)) {
                Some((location, value)) => {
                    let file = location.rsplit_once(':').map_or(*location, |(f, _)| f);
                    fix.push(format!(
                        "sudoedit {file}   # change predator_v4={value} to predator_v4=1"
                    ));
                }
                None => fix.push(format!(
                    "echo 'options acer_wmi predator_v4=1' | sudo tee {OPTIONS_FILE}"
                )),
            }
            fix.push(
                "sudo modprobe -r acer_wmi && sudo modprobe acer_wmi   # or reboot".to_owned(),
            );
            out.push(Finding {
                check: "acer_wmi",
                level: Level::Warn,
                message:
                    "acer_wmi is loaded without predator_v4=1, so the Predator profiles are missing"
                        .to_owned(),
                fix,
            });
        }
    }
    out
}

fn check_profile(fs: &dyn SysFs, acer: bool) -> Finding {
    let state = profile::read_state(fs);
    if state.available {
        let driver = state.driver.as_deref().unwrap_or("acpi");
        let msg = format!(
            "{} ({driver}); choices: {}",
            state.active.as_deref().unwrap_or("?"),
            state.choices.join(", ")
        );
        finding("platform_profile", Level::Ok, msg, &[])
    } else if acer {
        finding(
            "platform_profile",
            Level::Fail,
            "no /sys/firmware/acpi/platform_profile; profile switching is unavailable (see acer_wmi above)",
            &[],
        )
    } else {
        finding(
            "platform_profile",
            Level::Info,
            "no platform profile on this machine; profile switching is unavailable",
            &[],
        )
    }
}

/// The EFI variable is 4 attribute bytes followed by 1 when Secure Boot is on.
fn secure_boot(fs: &dyn SysFs) -> bool {
    fs.read_to_string(SECURE_BOOT)
        .is_some_and(|v| v.ends_with('\u{1}'))
}

fn lighting_installed(fs: &dyn SysFs) -> bool {
    let Some(release) = fs.read_to_string("/proc/sys/kernel/osrelease") else {
        return false;
    };
    ["", ".zst", ".xz", ".gz"].iter().any(|ext| {
        fs.exists(&format!(
            "/lib/modules/{release}/updates/dkms/helios-acer-lighting.ko{ext}"
        ))
    })
}

fn check_lighting(fs: &dyn SysFs) -> Finding {
    let product = fs
        .read_to_string(&format!("{DMI}/product_name"))
        .unwrap_or_default();
    if !LIGHTING_MODELS.contains(&product.as_str()) {
        return finding(
            "lighting",
            Level::Info,
            "keyboard lighting is not supported on this model yet",
            &[],
        );
    }
    let bound = LIGHTING_ATTRS
        .iter()
        .all(|a| fs.exists(&format!("{LIGHTING_DEVICE}/{a}")));
    if bound {
        return finding(
            "lighting",
            Level::Ok,
            "helios-acer-lighting is loaded and bound to the gaming WMI device",
            &[],
        );
    }
    if fs.exists(LIGHTING_LOADED) {
        return finding(
            "lighting",
            Level::Warn,
            "helios-acer-lighting is loaded but not bound to the gaming WMI device",
            &["journalctl -k -b | grep -i helios"],
        );
    }
    let load = "sudo modprobe helios_acer_lighting";
    let sb = secure_boot(fs);
    if lighting_installed(fs) {
        let msg = if sb {
            "helios-acer-lighting is installed but not loaded. If modprobe says \"Key was \
             rejected by service\", enroll the DKMS key first (docs/LIGHTING.md)"
        } else {
            "helios-acer-lighting is installed but not loaded"
        };
        return finding("lighting", Level::Info, msg, &[load]);
    }

    let v = LIGHTING_MODULE_VERSION;
    let mut fix = Vec::new();
    if !fs.exists("/usr/sbin/dkms") {
        fix.push("sudo apt install dkms".to_owned());
    }
    if let Some(release) = fs.read_to_string("/proc/sys/kernel/osrelease") {
        if !fs.exists(&format!("/lib/modules/{release}/build")) {
            fix.push(format!("sudo apt install linux-headers-{release}"));
        }
    }
    fix.push(format!(
        "sudo cp -r kmod/helios-acer-lighting /usr/src/helios-acer-lighting-{v}"
    ));
    fix.push(format!("sudo dkms install helios-acer-lighting/{v}"));
    let msg = if sb {
        fix.push(format!("sudo mokutil --import {DKMS_MOK}"));
        fix.push("sudo reboot".to_owned());
        "the optional keyboard lighting module is not installed. Run these from the Helios \
         Panel source directory. Secure Boot is on: on the next boot, enroll the key on the \
         blue MOK screen (docs/LIGHTING.md)"
    } else {
        fix.push(load.to_owned());
        "the optional keyboard lighting module is not installed. Run these from the Helios \
         Panel source directory"
    };
    Finding {
        check: "lighting",
        level: Level::Info,
        message: msg.to_owned(),
        fix,
    }
}

fn heliosd_pid(fs: &dyn SysFs) -> Option<String> {
    fs.read_dir("/proc")
        .into_iter()
        .filter(|e| e.bytes().all(|b| b.is_ascii_digit()))
        .find(|pid| fs.read_to_string(&format!("/proc/{pid}/comm")).as_deref() == Some("heliosd"))
}

fn check_daemon(fs: &dyn SysFs) -> Finding {
    let missing: Vec<&str> = DAEMON_FILES
        .iter()
        .copied()
        .filter(|p| !fs.exists(p))
        .collect();
    if missing.len() == DAEMON_FILES.len() {
        return finding(
            "heliosd",
            Level::Warn,
            "heliosd is not installed",
            &["./install.sh"],
        );
    }
    if !missing.is_empty() {
        return finding(
            "heliosd",
            Level::Warn,
            format!(
                "heliosd is partly installed; missing: {}",
                missing.join(", ")
            ),
            &["./install.sh"],
        );
    }
    match heliosd_pid(fs) {
        Some(pid) => finding(
            "heliosd",
            Level::Ok,
            format!("installed and running (pid {pid})"),
            &[],
        ),
        None => finding(
            "heliosd",
            Level::Info,
            "installed, not running right now (it starts when a client needs it)",
            &["systemctl status heliosd"],
        ),
    }
}

/// Runs every check. Reads only.
pub fn run(fs: &dyn SysFs) -> Report {
    let (machine, acer) = check_machine(fs);
    let mut findings = vec![machine];
    if acer {
        let mut directives = modprobe_directives(fs);
        directives.extend(cmdline_directives(fs));
        findings.extend(check_acer_wmi(fs, &directives));
    }
    findings.push(check_profile(fs, acer));
    if acer {
        findings.push(check_lighting(fs));
    }
    findings.push(check_daemon(fs));
    Report { findings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeFs, PHN16_72, PHN16_72_SYSTEM};

    fn phn16_72(extra: &[(&'static str, &'static str)], drop: &[&str]) -> FakeFs {
        let files: Vec<(&str, &str)> = PHN16_72
            .iter()
            .chain(PHN16_72_SYSTEM)
            .chain(extra)
            .copied()
            .filter(|(p, _)| !drop.iter().any(|d| p.starts_with(d)))
            .collect();
        FakeFs::new(&files)
    }

    /// Runs doctor and checks that it wrote nothing.
    fn doctor(fs: &FakeFs) -> Report {
        let report = run(fs);
        assert!(fs.writes().is_empty(), "doctor must never write");
        report
    }

    fn get<'a>(report: &'a Report, check: &str) -> &'a Finding {
        report
            .findings
            .iter()
            .find(|f| f.check == check)
            .unwrap_or_else(|| panic!("no {check} finding in {report:#?}"))
    }

    #[test]
    fn healthy_phn16_72() {
        let report = doctor(&phn16_72(&[], &[]));
        assert!(!report.has_problems(), "{report:#?}");
        assert_eq!(
            get(&report, "machine").message,
            "Acer Predator PHN16-72 (Predator Helios Neo 16), BIOS V1.20"
        );
        assert_eq!(get(&report, "acer_wmi").level, Level::Ok);
        assert_eq!(
            get(&report, "predator_v4").message,
            "set at boot by /etc/modprobe.d/acer-predator.conf:1"
        );
        assert!(
            get(&report, "platform_profile")
                .message
                .starts_with("balanced (acer-wmi)")
        );
        assert_eq!(get(&report, "lighting").level, Level::Ok);
        assert_eq!(
            get(&report, "heliosd").message,
            "installed and running (pid 4242)"
        );
        assert!(report.findings.iter().all(|f| f.fix.is_empty()));
    }

    #[test]
    fn loaded_without_predator_v4() {
        let fs = phn16_72(
            &[],
            &[
                "/sys/module/acer_wmi/parameters",
                "/etc/modprobe.d",
                "/sys/firmware",
                "/sys/class/platform-profile",
            ],
        );
        fs.set("/sys/module/acer_wmi/parameters/predator_v4", "N");
        let report = doctor(&fs);
        let acer = get(&report, "acer_wmi");
        assert_eq!(acer.level, Level::Warn);
        assert_eq!(
            acer.fix,
            [
                "echo 'options acer_wmi predator_v4=1' | sudo tee /etc/modprobe.d/acer-wmi-predator.conf",
                "sudo modprobe -r acer_wmi && sudo modprobe acer_wmi   # or reboot",
            ]
        );
        assert_eq!(get(&report, "platform_profile").level, Level::Fail);
        assert!(report.has_problems());
    }

    #[test]
    fn predator_v4_disabled_in_a_file_points_at_that_file() {
        let fs = phn16_72(&[], &["/sys/module/acer_wmi/parameters"]);
        fs.set("/sys/module/acer_wmi/parameters/predator_v4", "N");
        fs.set(
            "/etc/modprobe.d/acer-predator.conf",
            "options acer_wmi predator_v4=0\n",
        );
        let report = doctor(&fs);
        let acer_fix = &get(&report, "acer_wmi").fix;
        assert_eq!(
            acer_fix[0],
            "sudoedit /etc/modprobe.d/acer-predator.conf   # change predator_v4=0 to predator_v4=1"
        );
    }

    #[test]
    fn blacklisted_module_names_the_file_and_line() {
        let fs = phn16_72(
            &[(
                "/etc/modprobe.d/blacklist-acer.conf",
                "# laptop quirks\nblacklist acer-wmi\n",
            )],
            &[
                "/sys/module/acer_wmi",
                "/sys/firmware",
                "/sys/class/platform-profile",
            ],
        );
        let report = doctor(&fs);
        let acer = get(&report, "acer_wmi");
        assert_eq!(acer.level, Level::Fail);
        assert_eq!(
            acer.message,
            "acer_wmi is blocked by \"blacklist acer-wmi\" (/etc/modprobe.d/blacklist-acer.conf:2)"
        );
        assert_eq!(
            acer.fix,
            [
                "sudoedit /etc/modprobe.d/blacklist-acer.conf   # delete the line: blacklist acer-wmi",
                "sudo modprobe acer_wmi predator_v4=1",
            ]
        );
    }

    #[test]
    fn install_false_counts_as_blocked() {
        let fs = phn16_72(
            &[(
                "/usr/lib/modprobe.d/x.conf",
                "install acer_wmi /bin/false\n",
            )],
            &["/sys/module/acer_wmi"],
        );
        let acer = get(&doctor(&fs), "acer_wmi").clone();
        assert!(
            acer.message.contains("install acer_wmi /bin/false"),
            "{acer:?}"
        );
    }

    #[test]
    fn etc_overrides_a_vendor_file_with_the_same_name() {
        let fs = phn16_72(
            &[
                ("/usr/lib/modprobe.d/acer.conf", "blacklist acer_wmi\n"),
                (
                    "/etc/modprobe.d/acer.conf",
                    "# local override, nothing blocked\n",
                ),
            ],
            &["/sys/module/acer_wmi"],
        );
        let acer = get(&doctor(&fs), "acer_wmi").clone();
        assert_eq!(acer.message, "acer_wmi is not loaded");
        assert_eq!(acer.fix, ["sudo modprobe acer_wmi predator_v4=1"]);
    }

    #[test]
    fn commented_lines_and_other_modules_are_ignored() {
        let fs = phn16_72(
            &[(
                "/etc/modprobe.d/misc.conf",
                "# blacklist acer_wmi\nblacklist acer_wmi_extra\nblacklist nouveau\n",
            )],
            &["/sys/module/acer_wmi"],
        );
        assert_eq!(
            get(&doctor(&fs), "acer_wmi").message,
            "acer_wmi is not loaded"
        );
    }

    #[test]
    fn kernel_command_line_blacklist() {
        let fs = phn16_72(&[], &["/sys/module/acer_wmi", "/proc/cmdline"]);
        fs.set(
            "/proc/cmdline",
            "ro quiet modprobe.blacklist=nouveau,acer_wmi splash",
        );
        let acer = get(&doctor(&fs), "acer_wmi").clone();
        assert!(acer.message.contains("kernel command line"), "{acer:?}");
        assert_eq!(acer.fix[1], "sudo update-grub");
    }

    #[test]
    fn predator_v4_for_this_boot_only_suggests_persisting_it() {
        let report = doctor(&phn16_72(&[], &["/etc/modprobe.d"]));
        let v4 = get(&report, "predator_v4");
        assert_eq!(v4.level, Level::Info);
        assert_eq!(
            v4.fix,
            [
                "echo 'options acer_wmi predator_v4=1' | sudo tee /etc/modprobe.d/acer-wmi-predator.conf"
            ]
        );
        assert!(!report.has_problems(), "info is not a problem");
    }

    #[test]
    fn predator_v4_from_the_kernel_command_line() {
        let fs = phn16_72(&[], &["/etc/modprobe.d", "/proc/cmdline"]);
        fs.set("/proc/cmdline", "ro acer_wmi.predator_v4=1");
        assert_eq!(
            get(&doctor(&fs), "predator_v4").message,
            "set at boot by kernel command line"
        );
    }

    #[test]
    fn non_acer_machine_skips_acer_checks() {
        let fs = FakeFs::new(&[
            (
                "/sys/class/dmi/id/sys_vendor",
                "Micro-Star International Co., Ltd.",
            ),
            ("/sys/class/dmi/id/product_name", "MS-7D75"),
        ]);
        let report = doctor(&fs);
        assert!(report.findings.iter().all(|f| f.check != "acer_wmi"));
        assert_eq!(get(&report, "machine").level, Level::Info);
        assert_eq!(get(&report, "platform_profile").level, Level::Info);
        assert_eq!(get(&report, "heliosd").fix, ["./install.sh"]);
    }

    #[test]
    fn amd_desktop_without_dmi() {
        let report = doctor(&FakeFs::new(AMD_DESKTOP));
        assert!(
            get(&report, "machine")
                .message
                .starts_with("Unknown machine")
        );
    }

    #[test]
    fn other_acer_laptop() {
        let fs = phn16_72(&[], &["/sys/class/dmi"]);
        fs.set("/sys/class/dmi/id/sys_vendor", "Acer");
        fs.set("/sys/class/dmi/id/product_name", "Swift SF314-512");
        let m = get(&doctor(&fs), "machine").clone();
        assert_eq!(m.level, Level::Info);
        assert!(m.message.contains("not a Predator or Nitro"));
    }

    const SB_ON: (&str, &str) = (SECURE_BOOT, "\u{6}\0\0\0\u{1}");
    const SB_OFF: (&str, &str) = (SECURE_BOOT, "\u{6}\0\0\0\0");
    const NO_LIGHTING: &[&str] = &["/sys/module/helios_acer_lighting", "/sys/bus/wmi"];
    const DKMS_AND_HEADERS: &[(&str, &str)] = &[
        ("/usr/sbin/dkms", "#!/bin/bash"),
        ("/lib/modules/7.0.0-38-generic/build/Makefile", ""),
    ];

    fn lighting_with(extra: &[(&'static str, &'static str)], drop: &[&str]) -> Finding {
        get(&doctor(&phn16_72(extra, drop)), "lighting").clone()
    }

    #[test]
    fn lighting_loaded_but_not_bound() {
        let f = lighting_with(&[], &["/sys/bus/wmi"]);
        assert_eq!(f.level, Level::Warn);
        assert!(f.message.contains("not bound"));
    }

    #[test]
    fn lighting_installed_but_not_loaded() {
        let ko = (
            "/lib/modules/7.0.0-38-generic/updates/dkms/helios-acer-lighting.ko.zst",
            "",
        );
        let f = lighting_with(&[ko, SB_OFF], NO_LIGHTING);
        assert_eq!(f.level, Level::Info);
        assert_eq!(f.fix, ["sudo modprobe helios_acer_lighting"]);
        assert!(!f.message.contains("Key was rejected"));

        let f = lighting_with(&[ko, SB_ON], NO_LIGHTING);
        assert_eq!(f.fix, ["sudo modprobe helios_acer_lighting"]);
        assert!(f.message.contains("Key was rejected"));

        // Built for another kernel only: not installed for this one.
        let old = (
            "/lib/modules/6.17.0-35-generic/updates/dkms/helios-acer-lighting.ko.zst",
            "",
        );
        let f = lighting_with(&[old, SB_OFF], NO_LIGHTING);
        assert!(f.fix.iter().any(|c| c.starts_with("sudo dkms install")));
    }

    #[test]
    fn lighting_not_installed_without_secure_boot() {
        let mut extra = DKMS_AND_HEADERS.to_vec();
        extra.push(SB_OFF);
        let f = lighting_with(&extra, NO_LIGHTING);
        assert_eq!(f.level, Level::Info);
        assert_eq!(
            f.fix,
            [
                "sudo cp -r kmod/helios-acer-lighting /usr/src/helios-acer-lighting-0.1.0",
                "sudo dkms install helios-acer-lighting/0.1.0",
                "sudo modprobe helios_acer_lighting",
            ]
        );
    }

    #[test]
    fn lighting_not_installed_with_secure_boot_and_nothing_to_build_with() {
        let f = lighting_with(&[SB_ON], NO_LIGHTING);
        assert_eq!(f.level, Level::Info, "optional: not a problem");
        assert_eq!(
            f.fix,
            [
                "sudo apt install dkms",
                "sudo apt install linux-headers-7.0.0-38-generic",
                "sudo cp -r kmod/helios-acer-lighting /usr/src/helios-acer-lighting-0.1.0",
                "sudo dkms install helios-acer-lighting/0.1.0",
                "sudo mokutil --import /var/lib/shim-signed/mok/MOK.der",
                "sudo reboot",
            ]
        );
        assert!(f.message.contains("MOK screen"));
        assert!(!doctor(&phn16_72(&[SB_ON], NO_LIGHTING)).has_problems());
    }

    #[test]
    fn lighting_on_other_models_and_machines() {
        let fs = phn16_72(&[], &["/sys/class/dmi"]);
        fs.set("/sys/class/dmi/id/sys_vendor", "Acer");
        fs.set("/sys/class/dmi/id/product_name", "Predator PH16-72");
        let f = get(&doctor(&fs), "lighting").clone();
        assert_eq!(f.level, Level::Info);
        assert!(f.message.contains("not supported on this model"));
        assert!(f.fix.is_empty());

        let report = doctor(&FakeFs::new(AMD_DESKTOP));
        assert!(report.findings.iter().all(|f| f.check != "lighting"));
    }

    /// The constants here must match the module's sources.
    #[test]
    fn lighting_constants_match_the_module() {
        let dkms = include_str!("../../../kmod/helios-acer-lighting/dkms.conf");
        let driver = include_str!("../../../kmod/helios-acer-lighting/driver.c");
        assert!(dkms.contains(&format!("PACKAGE_VERSION=\"{LIGHTING_MODULE_VERSION}\"")));
        assert!(driver.contains(&format!("MODULE_VERSION(\"{LIGHTING_MODULE_VERSION}\")")));
        let guid = LIGHTING_DEVICE.rsplit('/').next().unwrap();
        assert!(driver.contains(&format!("#define ACER_GAMING_WMI_GUID \"{guid}\"")));
        for attr in LIGHTING_ATTRS {
            assert!(driver.contains(&format!("DEVICE_ATTR_ADMIN_RW({attr})")));
        }
        assert_eq!(
            driver.matches("DMI_PRODUCT_NAME").count(),
            LIGHTING_MODELS.len()
        );
        for model in LIGHTING_MODELS {
            assert!(driver.contains(&format!("DMI_EXACT_MATCH(DMI_PRODUCT_NAME, \"{model}\")")));
        }
    }

    #[test]
    fn daemon_states() {
        let none = doctor(&phn16_72(&[], &["/usr", "/etc/systemd", "/proc/4242"]));
        assert_eq!(get(&none, "heliosd").message, "heliosd is not installed");

        let partial = doctor(&phn16_72(&[], &["/usr/share/polkit-1"]));
        let h = get(&partial, "heliosd");
        assert_eq!(h.level, Level::Warn);
        assert!(h.message.contains("io.github.pauloeduardods.helios.policy"));

        let idle = doctor(&phn16_72(&[], &["/proc/4242"]));
        assert_eq!(get(&idle, "heliosd").level, Level::Info);
        assert_eq!(get(&idle, "heliosd").fix, ["systemctl status heliosd"]);
    }

    #[test]
    fn report_serializes_with_lowercase_levels() {
        let json = serde_json::to_value(doctor(&phn16_72(&[], &[]))).unwrap();
        assert_eq!(json["findings"][0]["check"], "machine");
        assert_eq!(json["findings"][0]["level"], "ok");
    }
}
