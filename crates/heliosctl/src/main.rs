// SPDX-License-Identifier: GPL-3.0-or-later
//! heliosctl: read-only command-line client for Helios.

use std::path::PathBuf;
use std::process::ExitCode;

use helios_core::GpuQuery;
use helios_core::doctor::{self, Level, Report};
use helios_core::hwmon::DeviceKind;
use helios_core::nvidia::GpuState;
use helios_core::power::{BatteryState, PowerSource, PowerStatus};
use helios_core::status::{Monitor, Status};
use helios_sys::{NvidiaSmi, RootedFs, SystemClock};

const USAGE: &str = "\
Usage: heliosctl <command>

Commands:
  status [--json]   Show temperatures, fans, power, battery and the profile
  doctor [--json]   Check what Helios needs and suggest fixes (changes nothing)
  help              Show this help
  version           Show the version

Neither command needs root or changes anything; status waits about half a
second to measure CPU usage. An NVIDIA GPU that is
asleep is never woken. doctor exits with 1 when something needs attention.";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status { json: bool },
    Doctor { json: bool },
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
        ["doctor"] => Command::Doctor { json: false },
        ["doctor", "--json"] => Command::Doctor { json: true },
        [cmd @ ("status" | "doctor"), extra @ ..] => {
            return Err(format!("unexpected argument to {cmd}: {}", extra.join(" ")));
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

/// 172 -> "2 h 52 min", 45 -> "45 min".
fn duration(minutes: i64) -> String {
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m} min"),
        (h, m) => format!("{h} h {m:02} min"),
    }
}

fn battery_state(state: BatteryState) -> &'static str {
    match state {
        BatteryState::Charging => "charging",
        BatteryState::Discharging => "discharging",
        BatteryState::Full => "full",
        BatteryState::NotCharging => "not charging",
        BatteryState::Unknown => "unknown state",
    }
}

/// The "Power" and "Battery" lines; none on a machine without either.
fn render_power(power: &PowerStatus) -> Vec<(&'static str, String)> {
    let mut lines = Vec::new();
    let battery = power.battery.as_ref();
    match power.source {
        PowerSource::Ac => lines.push(("Power", "AC".to_owned())),
        PowerSource::Battery => {
            let mut parts = vec!["battery".to_owned()];
            if let Some(watts) = battery.and_then(|b| b.watts) {
                parts.push(format!("{watts:.1} W"));
            }
            if let Some(minutes) = battery.and_then(|b| b.minutes_left) {
                parts.push(format!("about {} left", duration(minutes)));
            }
            lines.push(("Power", parts.join(", ")));
        }
        PowerSource::Unknown => {}
    }
    if let Some(b) = battery {
        let percent = b
            .percent
            .map_or_else(|| "--".to_owned(), |p| format!("{p:.0}%"));
        let mut details = vec![b.name.clone()];
        if let Some(health) = b.health_percent {
            details.push(format!("health {health:.0}%"));
        }
        if let Some(cycles) = b.cycles.filter(|c| *c > 0) {
            details.push(format!("{cycles} cycles"));
        }
        lines.push((
            "Battery",
            format!(
                "{percent}, {}  ({})",
                battery_state(b.state),
                details.join(", ")
            ),
        ));
    }
    lines
}

fn render(status: &Status) -> String {
    let mut out = String::new();
    let mut line = |name: &str, value: String| out.push_str(&format!("{name:<9}{value}\n"));

    let cpu = &status.cpu;
    let cpu_source = cpu.sensor.as_deref().unwrap_or("no sensor found");
    let cpu_value = match cpu.watts {
        Some(watts) => format!("{}, {watts:.1} W", celsius(cpu.celsius)),
        None => celsius(cpu.celsius),
    };
    line("CPU", format!("{cpu_value}  ({cpu_source})"));

    let gpu = &status.gpu;
    let gpu_value = match gpu.state {
        GpuState::On => match gpu.watts {
            Some(watts) => format!("{}, {watts:.1} W", celsius(gpu.celsius)),
            None => celsius(gpu.celsius),
        },
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

    let percent = |p: f64| format!("{p:.0}%");
    let mut usage = Vec::new();
    if let Some(p) = status.cpu.usage_percent {
        usage.push(format!("CPU {}", percent(p)));
    }
    if let Some(p) = gpu.usage_percent {
        usage.push(format!("GPU {}", percent(p)));
    }
    if !usage.is_empty() {
        line("Usage", usage.join(", "));
    }
    if let (Some(average), Some(max)) = (status.cpu.average_ghz, status.cpu.max_ghz) {
        line(
            "Clock",
            format!("{average:.1} GHz average, {max:.1} GHz max"),
        );
    }

    for (kind, name) in [(DeviceKind::Storage, "Drives"), (DeviceKind::Wifi, "Wi-Fi")] {
        let devices: Vec<String> = status
            .devices
            .iter()
            .filter(|d| d.kind == kind)
            .map(|d| match kind {
                DeviceKind::Wifi => celsius(d.celsius),
                DeviceKind::Storage => format!("{} {}", d.name, celsius(d.celsius)),
            })
            .collect();
        if !devices.is_empty() {
            line(name, devices.join(", "));
        }
    }

    for (name, value) in render_power(&status.power) {
        line(name, value);
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
    let smi = smi.as_ref().map(|s| s as &dyn GpuQuery);
    let clock = SystemClock::new();
    let mut monitor = Monitor::new(&fs);
    let mut status = monitor.poll(&fs, smi, &clock);
    // CPU usage (and, as root, the CPU draw) needs a second read.
    if let Some(wait) = monitor.settle_time() {
        std::thread::sleep(wait);
        status = monitor.poll(&fs, smi, &clock);
    }
    if json {
        serde_json::to_string_pretty(&status)
            .map(|s| s + "\n")
            .map_err(|e| e.to_string())
    } else {
        Ok(render(&status))
    }
}

fn render_doctor(report: &Report) -> String {
    let mut out = String::new();
    for f in &report.findings {
        let tag = match f.level {
            Level::Ok => " ok ",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Fail => "FAIL",
        };
        out.push_str(&format!("[{tag}] {:<17}{}\n", f.check, f.message));
    }
    let fixes: Vec<_> = report
        .findings
        .iter()
        .filter(|f| !f.fix.is_empty())
        .collect();
    if fixes.is_empty() {
        out.push_str("\nNothing to fix.\n");
    } else {
        out.push_str("\nSuggested commands (run them yourself; heliosctl changes nothing):\n");
        for f in fixes {
            out.push_str(&format!("  # {}\n", f.check));
            for cmd in &f.fix {
                out.push_str(&format!("  {cmd}\n"));
            }
        }
    }
    out
}

fn run_doctor(options: &Options, json: bool) -> Result<(String, ExitCode), String> {
    let report = doctor::run(&RootedFs::new(&options.sysfs_root));
    let code = if report.has_problems() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    };
    let text = if json {
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())? + "\n"
    } else {
        render_doctor(&report)
    };
    Ok((text, code))
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("heliosctl: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let ok = |text: String| Ok((text, ExitCode::SUCCESS));
    let result = match options.command {
        Command::Help => ok(format!("{USAGE}\n")),
        Command::Version => ok(format!("heliosctl {}\n", env!("CARGO_PKG_VERSION"))),
        Command::Status { json } => status(&options, json).and_then(ok),
        Command::Doctor { json } => run_doctor(&options, json),
    };
    match result {
        Ok((text, code)) => {
            print!("{text}");
            code
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
    fn doctor_command() {
        assert_eq!(
            parse(&["doctor"]).unwrap().command,
            Command::Doctor { json: false }
        );
        assert_eq!(
            parse(&["doctor", "--json"]).unwrap().command,
            Command::Doctor { json: true }
        );
        assert!(
            parse(&["doctor", "--fix"])
                .unwrap_err()
                .contains("doctor: --fix")
        );
    }

    #[test]
    fn doctor_output_lists_findings_then_commands() {
        let fs = FakeFs::new(PHN16_72);
        let text = render_doctor(&doctor::run(&fs));
        assert!(fs.writes().is_empty());
        assert!(
            text.starts_with("[info] machine          Unknown machine"),
            "{text}"
        );
        assert!(
            text.contains("[warn] heliosd          heliosd is not installed\n"),
            "{text}"
        );
        assert!(
            text.contains("Suggested commands (run them yourself; heliosctl changes nothing):\n")
        );
        assert!(text.ends_with("  # heliosd\n  ./install.sh\n"), "{text}");
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
Clock    2.1 GHz average, 4.8 GHz max
Drives   CT500P2SSD8 44.9 °C, SAMSUNG MZVL21T0HCLR-00B07 47.9 °C
Wi-Fi    52.0 °C
Power    AC
Battery  80%, not charging  (BAT1, health 92%)
Profile  balanced  (acer-wmi)
Choices  low-power, quiet, balanced, balanced-performance, performance
"
        );
    }

    #[test]
    fn human_output_on_battery() {
        let fs = FakeFs::new(PHN16_72);
        fs.set("/sys/class/power_supply/ACAD/online", "0");
        fs.set("/sys/class/power_supply/BAT1/status", "Discharging");
        fs.set("/sys/class/power_supply/BAT1/current_now", "1500000");
        fs.set("/sys/class/power_supply/BAT1/cycle_count", "312");
        let text = render(&Monitor::new(&fs).poll(&fs, None, &FakeClock::default()));
        assert!(
            text.contains("Power    battery, 24.5 W, about 2 h 52 min left\n"),
            "{text}"
        );
        assert!(
            text.contains("Battery  80%, discharging  (BAT1, health 92%, 312 cycles)\n"),
            "{text}"
        );
    }

    #[test]
    fn human_output_with_cpu_draw() {
        let fs = FakeFs::new(PHN16_72);
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, None, &clock);
        fs.set("/sys/class/powercap/intel-rapl:0/energy_uj", "1024680000");
        clock.advance(2);
        let text = render(&monitor.poll(&fs, None, &clock));
        assert!(
            text.starts_with("CPU      61.0 °C, 12.3 W  (hwmon:coretemp/Package id 0)\n"),
            "{text}"
        );
    }

    #[test]
    fn human_output_with_usage() {
        let fs = FakeFs::new(PHN16_72);
        fs.set(
            "/sys/bus/pci/devices/0000:01:00.0/power/runtime_status",
            "active",
        );
        let smi = helios_core::fake::FakeGpu::new("47, 35.2, 30\n");
        let clock = FakeClock::starting_at(0);
        let mut monitor = Monitor::new(&fs);
        monitor.poll(&fs, Some(&smi), &clock);
        fs.set("/proc/stat", "cpu  1100 0 630 9750 220 0 0 0 0 0\n");
        clock.advance(2);
        let text = render(&monitor.poll(&fs, Some(&smi), &clock));
        assert!(text.contains("\nUsage    CPU 23%, GPU 30%\n"), "{text}");
    }

    #[test]
    fn durations() {
        assert_eq!(duration(172), "2 h 52 min");
        assert_eq!(duration(60), "1 h 00 min");
        assert_eq!(duration(45), "45 min");
        assert_eq!(duration(0), "0 min");
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
        assert!(!text.contains("Power"));
        assert!(!text.contains("Battery"));
        assert!(text.contains("Profile  unavailable"));
    }
}
