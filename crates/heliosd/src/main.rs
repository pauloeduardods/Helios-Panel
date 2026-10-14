// SPDX-License-Identifier: GPL-3.0-or-later
//! heliosd: publishes sensors and the platform profile on the system bus and
//! performs the only hardware writes Helios allows, behind polkit.

mod polkit;
mod props;
mod service;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use async_io::Timer;
use helios_sys::{NvidiaSmi, RootedFs};
use zbus::object_server::SignalEmitter;

use crate::service::{
    BUS_NAME, DaemonIface, OBJECT_PATH, PROFILE_IFACE, ProfileIface, SENSORS_IFACE, SensorsIface,
    Shared, emit,
};

const USAGE: &str = "\
Usage: heliosd

The Helios system daemon. It is started by D-Bus activation through
systemd (heliosd.service) and takes no options in normal use.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bus {
    System,
    Session,
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    // Test hooks, never set by the systemd unit.
    bus: Bus,
    sysfs_root: PathBuf,
    nvidia_smi: Option<PathBuf>,
    interval: Duration,
}

enum Parsed {
    Run(Options),
    Print(String),
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut options = Options {
        bus: Bus::System,
        sysfs_root: PathBuf::from("/"),
        nvidia_smi: None,
        interval: Duration::from_secs(2),
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--bus" => {
                options.bus = match value("--bus")?.as_str() {
                    "system" => Bus::System,
                    "session" => Bus::Session,
                    other => return Err(format!("unknown bus: {other}")),
                }
            }
            "--sysfs-root" => options.sysfs_root = value("--sysfs-root")?.into(),
            "--nvidia-smi" => options.nvidia_smi = Some(value("--nvidia-smi")?.into()),
            "--interval-ms" => {
                let ms: u64 = value("--interval-ms")?
                    .parse()
                    .map_err(|_| "--interval-ms needs a number".to_owned())?;
                options.interval = Duration::from_millis(ms.max(50));
            }
            "-h" | "--help" => return Ok(Parsed::Print(format!("{USAGE}\n"))),
            "-V" | "--version" => {
                return Ok(Parsed::Print(format!(
                    "heliosd {}\n",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Parsed::Run(options))
}

async fn run(options: Options) -> zbus::Result<()> {
    let conn = match options.bus {
        Bus::System => zbus::connection::Builder::system()?,
        Bus::Session => zbus::connection::Builder::session()?,
    }
    .build()
    .await?;

    let smi = match &options.nvidia_smi {
        Some(path) => Some(NvidiaSmi::new(path, NvidiaSmi::DEFAULT_TIMEOUT)),
        None => NvidiaSmi::find(),
    };
    let shared = Shared::new(conn.clone(), RootedFs::new(&options.sysfs_root), smi);

    let server = conn.object_server();
    server.at(OBJECT_PATH, DaemonIface).await?;
    server
        .at(OBJECT_PATH, SensorsIface(Arc::clone(&shared)))
        .await?;
    server
        .at(OBJECT_PATH, ProfileIface(Arc::clone(&shared)))
        .await?;
    // Only claim the name once every object is in place.
    conn.request_name(BUS_NAME).await?;
    eprintln!("heliosd {}: serving {BUS_NAME}", env!("CARGO_PKG_VERSION"));

    let emitter = SignalEmitter::new(&conn, OBJECT_PATH)?;
    loop {
        Timer::after(options.interval).await;
        let status = blocking::unblock({
            let shared = Arc::clone(&shared);
            move || shared.poll()
        })
        .await;
        let (sensors, profile) = shared.publish(Some((&status).into()), (&status).into());
        emit(&emitter, SENSORS_IFACE, sensors).await?;
        emit(&emitter, PROFILE_IFACE, profile).await?;
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("heliosd: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match async_io::block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("heliosd: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Parsed, String> {
        parse_args(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn defaults_are_production_values() {
        let Ok(Parsed::Run(o)) = parse(&[]) else {
            panic!()
        };
        assert_eq!(
            o,
            Options {
                bus: Bus::System,
                sysfs_root: PathBuf::from("/"),
                nvidia_smi: None,
                interval: Duration::from_secs(2),
            }
        );
    }

    #[test]
    fn test_hooks() {
        let Ok(Parsed::Run(o)) = parse(&[
            "--bus",
            "session",
            "--sysfs-root",
            "/tmp/x",
            "--nvidia-smi",
            "/bin/true",
            "--interval-ms",
            "10",
        ]) else {
            panic!()
        };
        assert_eq!(o.bus, Bus::Session);
        assert_eq!(o.sysfs_root, PathBuf::from("/tmp/x"));
        assert_eq!(o.nvidia_smi, Some(PathBuf::from("/bin/true")));
        assert_eq!(o.interval, Duration::from_millis(50), "clamped");
    }

    #[test]
    fn bad_arguments() {
        assert!(parse(&["--bus", "tcp"]).is_err());
        assert!(parse(&["--bus"]).is_err());
        assert!(parse(&["--interval-ms", "x"]).is_err());
        assert!(parse(&["--frobnicate"]).is_err());
    }
}
