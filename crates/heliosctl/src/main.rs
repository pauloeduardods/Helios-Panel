// SPDX-License-Identifier: GPL-3.0-or-later
//! heliosctl: read-only command-line client for Helios.

use std::path::PathBuf;
use std::process::ExitCode;

use helios_core::GpuQuery;
use helios_core::nvidia::GpuState;
use helios_core::status::{Monitor, Status};
use helios_sys::{NvidiaSmi, RootedFs, SystemClock};

const USAGE: &str = "\
Usage: heliosctl <command>

Commands:
  status [--json]   Show temperatures, fans and the platform profile
  help              Show this help
  version           Show the version

Reading never needs root, and an NVIDIA GPU that is asleep is never woken.";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status { json: bool },
    Help,
    Version,
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    command: Command,
    /// Test hook: resolve /sys under this directory.
    sysfs_root: PathBuf,
    /// Test hook: nvidia-smi to run instead of the one in PATH.
    nvidia_smi: Option<PathBuf>,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut sysfs_root = PathBuf::from("/");
    let mut nvidia_smi = None;
    let mut words = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sysfs-root" => {
                sysfs_root = args.next().ok_or("--sysfs-root needs a directory")?.into();
            }
            "--nvidia-smi" => {
                nvidia_smi = Some(args.next().ok_or("--nvidia-smi needs a path")?.into());
            }
            "-h" | "--help" => words.push("help".to_owned()),
            "-V" | "--version" => words.push("version".to_owned()),
            _ => words.push(arg),
        }
    }
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let command = match words.as_slice() {
        [] | ["help"] => Command::Help,
        ["version"] => Command::Version,
        ["status"] => Command::Status { json: false },
        ["status", "--json"] => Command::Status { json: true },
        ["status", extra @ ..] => {
            return Err(format!(
                "unexpected argument to status: {}",
                extra.join(" ")
            ));
        }
        [cmd, ..] => return Err(format!("unknown command: {cmd}")),
    };
    Ok(Options {
        command,
        sysfs_root,
        nvidia_smi,
    })
}

fn celsius(value: Option<f64>) -> String {
    value.map_or_else(|| "--".to_owned(), |c| format!("{c:.1} °C"))
}

fn render(status: &Status) -> String {
    let mut out = String::new();
    let mut line = |name: &str, value: String| out.push_str(&format!("{name:<9}{value}\n"));

    let cpu_source = status.cpu.sensor.as_deref().unwrap_or("no sensor found");
    line(
        "CPU",
        format!("{}  ({cpu_source})", celsius(status.cpu.celsius)),
    );

    let gpu = &status.gpu;
    let gpu_value = match gpu.state {
        GpuState::On => celsius(gpu.celsius),
        GpuState::Off => "off (asleep, not queried)".to_owned(),
        GpuState::None => "no sensor found".to_owned(),
    };
    match &gpu.source {
        Some(source) => line("GPU", format!("{gpu_value}  ({source})")),
        None => line("GPU", gpu_value),
    }

    if !status.fans.is_empty() {
        let fans: Vec<String> = status
            .fans
            .iter()
            .map(|f| match f.rpm {
                Some(rpm) => format!("{} {rpm} RPM", f.label),
                None => format!("{} --", f.label),
            })
            .collect();
        line("Fans", fans.join(", "));
    }

    let profile = &status.profile;
    if profile.available {
        let active = profile.active.as_deref().unwrap_or("--");
        match &profile.driver {
            Some(driver) => line("Profile", format!("{active}  ({driver})")),
            None => line("Profile", active.to_owned()),
        }
        line("Choices", profile.choices.join(", "));
    } else {
        line(
            "Profile",
            "unavailable (no /sys/firmware/acpi/platform_profile)".to_owned(),
        );
    }
    out
}

fn status(options: &Options, json: bool) -> Result<String, String> {
    let fs = RootedFs::new(&options.sysfs_root);
    let smi = match &options.nvidia_smi {
        Some(path) => Some(NvidiaSmi::new(path, NvidiaSmi::DEFAULT_TIMEOUT)),
        None => NvidiaSmi::find(),
    };
    let status = Monitor::new(&fs).poll(
        &fs,
        smi.as_ref().map(|s| s as &dyn GpuQuery),
        &SystemClock::new(),
    );
    if json {
        serde_json::to_string_pretty(&status)
            .map(|s| s + "\n")
            .map_err(|e| e.to_string())
    } else {
        Ok(render(&status))
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("heliosctl: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let result = match options.command {
        Command::Help => Ok(format!("{USAGE}\n")),
        Command::Version => Ok(format!("heliosctl {}\n", env!("CARGO_PKG_VERSION"))),
        Command::Status { json } => status(&options, json),
    };
    match result {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("heliosctl: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use helios_core::fake::{AMD_DESKTOP, FakeClock, FakeFs, PHN16_72};

    fn parse(args: &[&str]) -> Result<Options, String> {
        parse_args(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn commands() {
        assert_eq!(parse(&[]).unwrap().command, Command::Help);
        assert_eq!(parse(&["--help"]).unwrap().command, Command::Help);
        assert_eq!(parse(&["-V"]).unwrap().command, Command::Version);
        assert_eq!(
            parse(&["status"]).unwrap().command,
            Command::Status { json: false }
        );
        assert_eq!(
            parse(&["status", "--json"]).unwrap().command,
            Command::Status { json: true }
        );
    }

    #[test]
    fn test_hooks() {
        let o = parse(&[
            "--sysfs-root",
            "/tmp/x",
            "status",
            "--nvidia-smi",
            "/bin/true",
        ])
        .unwrap();
        assert_eq!(o.sysfs_root, PathBuf::from("/tmp/x"));
        assert_eq!(o.nvidia_smi, Some(PathBuf::from("/bin/true")));
        assert_eq!(parse(&["status"]).unwrap().sysfs_root, PathBuf::from("/"));
    }

    #[test]
    fn bad_arguments() {
        assert!(parse(&["frobnicate"]).is_err());
        assert!(parse(&["status", "--yaml"]).unwrap_err().contains("--yaml"));
        assert!(parse(&["status", "--json", "extra"]).is_err());
        assert!(parse(&["status", "--sysfs-root"]).is_err());
    }

    #[test]
    fn human_output_phn16_72() {
        let fs = FakeFs::new(PHN16_72);
        let text = render(&Monitor::new(&fs).poll(&fs, None, &FakeClock::default()));
        assert_eq!(
            text,
            "\
CPU      61.0 °C  (hwmon:coretemp/Package id 0)
GPU      no sensor found
Fans     Fan 1 2350 RPM, Fan 2 2600 RPM
Profile  balanced  (acer-wmi)
Choices  low-power, quiet, balanced, balanced-performance, performance
"
        );
    }

    #[test]
    fn human_output_amd_desktop() {
        let fs = FakeFs::new(AMD_DESKTOP);
        let text = render(&Monitor::new(&fs).poll(&fs, None, &FakeClock::default()));
        assert!(
            text.contains("GPU      50.0 °C  (hwmon:amdgpu/edge)"),
            "{text}"
        );
        assert!(!text.contains("Fans"));
        assert!(text.contains("Profile  unavailable"));
    }
}
