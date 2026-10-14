// SPDX-License-Identifier: GPL-3.0-or-later
//! The ACPI platform profile: reading it, validating a requested value and
//! writing it. The only accepted values are the ones the firmware lists in
//! its `choices` file at the moment of the request.

use std::fmt;

use serde::Serialize;

use crate::io::SysFs;

pub const LEGACY_PROFILE: &str = "/sys/firmware/acpi/platform_profile";
pub const LEGACY_CHOICES: &str = "/sys/firmware/acpi/platform_profile_choices";
/// Kernel 6.14+: one device per driver with `name`, `choices` and `profile`.
pub const CLASS_ROOT: &str = "/sys/class/platform-profile";

/// Longer than any profile name the kernel defines.
pub const MAX_PROFILE_LEN: usize = 32;

/// 0 = most economical ... 5 = most powerful.
pub fn tier(id: &str) -> Option<u8> {
    Some(match id {
        "low-power" => 0,
        "cool" | "quiet" => 1,
        "balanced" | "custom" => 2,
        "balanced-performance" => 3,
        "performance" => 4,
        "max-power" => 5,
        _ => return None,
    })
}

/// Parses a space-separated `choices` file.
pub fn parse_choices(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_owned).collect()
}

/// From most economical to most powerful; unknown names last, in their order.
pub fn sort_choices(mut choices: Vec<String>) -> Vec<String> {
    choices.sort_by_key(|c| tier(c).unwrap_or(u8::MAX));
    choices
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassDevice {
    pub dir: String,
    pub name: String,
}

/// The class device to use: the Acer one when there are several.
pub fn find_class_device(fs: &dyn SysFs) -> Option<ClassDevice> {
    let devices: Vec<ClassDevice> = fs
        .read_dir(CLASS_ROOT)
        .into_iter()
        .map(|entry| {
            let dir = format!("{CLASS_ROOT}/{entry}");
            let name = fs
                .read_to_string(&format!("{dir}/name"))
                .unwrap_or_default();
            ClassDevice { dir, name }
        })
        .filter(|d| fs.exists(&format!("{}/profile", d.dir)))
        .collect();
    let acer = devices
        .iter()
        .position(|d| d.name.to_ascii_lowercase().contains("acer"));
    devices.into_iter().nth(acer.unwrap_or(0))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileState {
    pub available: bool,
    pub active: Option<String>,
    pub driver: Option<String>,
    /// Sorted from most economical to most powerful.
    pub choices: Vec<String>,
}

pub fn read_state(fs: &dyn SysFs) -> ProfileState {
    let device = find_class_device(fs);
    let from_device = |file: &str| {
        device
            .as_ref()
            .and_then(|d| fs.read_to_string(&format!("{}/{file}", d.dir)))
    };
    let active = fs
        .read_to_string(LEGACY_PROFILE)
        .or_else(|| from_device("profile"));
    let choices = fs
        .read_to_string(LEGACY_CHOICES)
        .or_else(|| from_device("choices"))
        .map(|t| sort_choices(parse_choices(&t)))
        .unwrap_or_default();
    ProfileState {
        available: active.is_some(),
        active,
        driver: device.map(|d| d.name).filter(|n| !n.is_empty()),
        choices,
    }
}

/// Where a write goes: the class device's own file (only that driver), else
/// the legacy file.
pub fn write_path(fs: &dyn SysFs) -> Option<String> {
    if let Some(device) = find_class_device(fs) {
        return Some(format!("{}/profile", device.dir));
    }
    fs.exists(LEGACY_PROFILE).then(|| LEGACY_PROFILE.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileError {
    /// No platform profile on this machine.
    Unavailable,
    /// Not one of the firmware's current choices.
    InvalidArgument(String),
    /// The driver rejected the write.
    WriteFailed(String),
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => f.write_str("no platform profile on this machine"),
            Self::InvalidArgument(msg) | Self::WriteFailed(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ProfileError {}

/// A validated write: only [`validate`] can build one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileTarget {
    path: String,
    value: String,
}

impl ProfileTarget {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

/// Accepts `requested` only if it is exactly one of the current choices.
pub fn validate(fs: &dyn SysFs, requested: &str) -> Result<ProfileTarget, ProfileError> {
    let state = read_state(fs);
    if !state.available {
        return Err(ProfileError::Unavailable);
    }
    let well_formed = !requested.is_empty()
        && requested.len() <= MAX_PROFILE_LEN
        && requested
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !well_formed || !state.choices.iter().any(|c| c == requested) {
        let shown: String = requested.escape_debug().take(MAX_PROFILE_LEN * 2).collect();
        return Err(ProfileError::InvalidArgument(format!(
            "profile \"{shown}\" is not one of: {}",
            state.choices.join(", ")
        )));
    }
    let path = write_path(fs).ok_or(ProfileError::Unavailable)?;
    Ok(ProfileTarget {
        path,
        value: requested.to_owned(),
    })
}

/// Writes a validated profile and returns what the file reads back.
pub fn apply(fs: &dyn SysFs, target: &ProfileTarget) -> Result<String, ProfileError> {
    fs.write(&target.path, &target.value)
        .map_err(|e| ProfileError::WriteFailed(format!("writing {}: {e}", target.path)))?;
    Ok(fs.read_to_string(&target.path).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{AMD_DESKTOP, FakeFs, PHN16_72};

    const CLASS_PROFILE: &str = "/sys/class/platform-profile/platform-profile-0/profile";

    #[test]
    fn names_and_ordering() {
        assert_eq!(
            sort_choices(parse_choices(
                "performance quiet balanced-performance low-power balanced"
            )),
            [
                "low-power",
                "quiet",
                "balanced",
                "balanced-performance",
                "performance"
            ]
        );
        assert_eq!(
            sort_choices(parse_choices("weird balanced zzz low-power")),
            ["low-power", "balanced", "weird", "zzz"]
        );
        assert!(parse_choices("  \n").is_empty());
    }

    #[test]
    fn phn16_72_state() {
        let state = read_state(&FakeFs::new(PHN16_72));
        assert_eq!(
            state,
            ProfileState {
                available: true,
                active: Some("balanced".into()),
                driver: Some("acer-wmi".into()),
                choices: [
                    "low-power",
                    "quiet",
                    "balanced",
                    "balanced-performance",
                    "performance"
                ]
                .map(String::from)
                .to_vec(),
            }
        );
    }

    #[test]
    fn class_device_only_kernel() {
        let files: Vec<_> = PHN16_72
            .iter()
            .copied()
            .filter(|(p, _)| !p.starts_with("/sys/firmware"))
            .collect();
        let fs = FakeFs::new(&files);
        let state = read_state(&fs);
        assert_eq!(state.active.as_deref(), Some("balanced"));
        assert_eq!(state.choices.len(), 5);
        assert_eq!(write_path(&fs).as_deref(), Some(CLASS_PROFILE));
    }

    #[test]
    fn legacy_only_kernel() {
        let files: Vec<_> = PHN16_72
            .iter()
            .copied()
            .filter(|(p, _)| !p.starts_with(CLASS_ROOT))
            .collect();
        let fs = FakeFs::new(&files);
        assert_eq!(read_state(&fs).driver, None);
        assert_eq!(write_path(&fs).as_deref(), Some(LEGACY_PROFILE));
    }

    #[test]
    fn acer_class_device_is_preferred() {
        let mut files = PHN16_72.to_vec();
        files.extend([
            (
                "/sys/class/platform-profile/platform-profile-0/name",
                "other",
            ),
            (
                "/sys/class/platform-profile/platform-profile-1/name",
                "acer-wmi",
            ),
            (
                "/sys/class/platform-profile/platform-profile-1/profile",
                "quiet",
            ),
        ]);
        // later entries override the fixture's platform-profile-0 name
        let fs = FakeFs::new(&files);
        assert_eq!(
            find_class_device(&fs).unwrap().dir,
            "/sys/class/platform-profile/platform-profile-1"
        );
    }

    #[test]
    fn no_platform_profile_at_all() {
        let fs = FakeFs::new(AMD_DESKTOP);
        assert_eq!(
            read_state(&fs),
            ProfileState {
                available: false,
                active: None,
                driver: None,
                choices: vec![]
            }
        );
        assert_eq!(validate(&fs, "balanced"), Err(ProfileError::Unavailable));
        assert!(fs.writes().is_empty());
    }

    #[test]
    fn valid_profile_is_written_to_the_class_device_and_read_back() {
        let fs = FakeFs::new(PHN16_72);
        let target = validate(&fs, "quiet").unwrap();
        assert_eq!(target.path(), CLASS_PROFILE);
        assert_eq!(apply(&fs, &target).unwrap(), "quiet");
        assert_eq!(
            fs.writes(),
            [(CLASS_PROFILE.to_owned(), "quiet".to_owned())]
        );
    }

    #[test]
    fn every_listed_choice_is_accepted() {
        for choice in [
            "low-power",
            "quiet",
            "balanced",
            "balanced-performance",
            "performance",
        ] {
            let fs = FakeFs::new(PHN16_72);
            apply(&fs, &validate(&fs, choice).unwrap()).unwrap();
            assert_eq!(fs.get(CLASS_PROFILE).as_deref(), Some(choice));
        }
    }

    #[test]
    fn invalid_profiles_are_rejected_without_writing() {
        let long = "a".repeat(MAX_PROFILE_LEN + 1);
        let rejected = [
            "max-power", // a real kernel name, but not offered by this firmware
            "custom",
            "Balanced",
            "balanced ",
            " balanced",
            "balanced\n",
            "balanced\nperformance",
            "quiet performance",
            "",
            "../../../etc/passwd",
            "balanced\0",
            long.as_str(),
        ];
        for value in rejected {
            let fs = FakeFs::new(PHN16_72);
            let err = validate(&fs, value).unwrap_err();
            assert!(
                matches!(err, ProfileError::InvalidArgument(_)),
                "{value:?} gave {err:?}"
            );
            assert!(fs.writes().is_empty(), "{value:?} must not write");
        }
    }

    #[test]
    fn choices_are_reread_on_every_validation() {
        let fs = FakeFs::new(PHN16_72);
        assert!(validate(&fs, "quiet").is_ok());
        fs.set(LEGACY_CHOICES, "balanced performance");
        assert!(matches!(
            validate(&fs, "quiet"),
            Err(ProfileError::InvalidArgument(_))
        ));
    }

    #[test]
    fn error_message_escapes_control_characters() {
        let fs = FakeFs::new(PHN16_72);
        let err = validate(&fs, "x\ny").unwrap_err().to_string();
        assert!(err.contains(r"x\ny"), "{err}");
        assert!(!err.contains('\n'));
    }

    #[test]
    fn driver_failure_is_reported() {
        let fs = FakeFs::new(PHN16_72);
        let target = validate(&fs, "quiet").unwrap();
        // the device disappears between validation and the write
        let gone = FakeFs::new(&[]);
        assert!(matches!(
            apply(&gone, &target),
            Err(ProfileError::WriteFailed(_))
        ));
    }
}
