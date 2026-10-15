// SPDX-License-Identifier: GPL-3.0-or-later
//! Keyboard and lid logo lighting through the helios-acer-lighting kernel
//! module (kmod/helios-acer-lighting): validating a request, turning it into
//! the exact line the module accepts, reading the state back, and the saved
//! state heliosd re-applies after a restart or a resume.
//!
//! Every value is checked here before a line is built, and the module checks
//! it again. The static effect is not offered: on the PHN16-72 it leaves the
//! keyboard dark (docs/LIGHTING.md).

use std::fmt;

use crate::io::SysFs;

/// The Acer gaming WMI device the module binds to.
pub const DEVICE: &str = "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56";
pub const KEYBOARD_FILE: &str =
    "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56/keyboard_effect";
pub const LOGO_FILE: &str = "/sys/bus/wmi/devices/7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56/logo";

/// The effects Helios can set, in menu order.
pub const EFFECTS: &[&str] = &["breathing", "neon", "wave", "shifting", "zoom"];
pub const DIRECTIONS: &[&str] = &["left", "right"];
/// The logo modes, in menu order: lit in its colour, pulsing in its colour,
/// cycling through the colours.
pub const LOGO_MODES: &[&str] = &["static", "breathing", "cycle"];
pub const MAX_SPEED: u32 = 9;
pub const MAX_BRIGHTNESS: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LightingError {
    /// The module is not loaded or not bound.
    Unavailable,
    InvalidArgument(String),
    WriteFailed(String),
}

impl fmt::Display for LightingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => f.write_str("keyboard lighting is not available"),
            Self::InvalidArgument(m) | Self::WriteFailed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for LightingError {}

fn invalid(message: String) -> LightingError {
    LightingError::InvalidArgument(message)
}

/// Whether the module is loaded and bound (both files present).
pub fn available(fs: &dyn SysFs) -> bool {
    fs.exists(KEYBOARD_FILE) && fs.exists(LOGO_FILE)
}

/// A colour as the module writes it: six lowercase hex digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color(pub u8, pub u8, pub u8);

impl Color {
    /// Exactly `#rrggbb` (D-Bus form) or `rrggbb` (module form).
    pub fn parse(text: &str) -> Option<Self> {
        let hex = text.strip_prefix('#').unwrap_or(text);
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some(Self(byte(0)?, byte(2)?, byte(4)?))
    }

    /// `#rrggbb`, the D-Bus form.
    pub fn to_hash(self) -> String {
        format!("#{}", self.hex())
    }

    fn hex(self) -> String {
        format!("{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
}

/// A validated keyboard effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardEffect {
    pub effect: &'static str,
    pub speed: u32,
    pub brightness: u32,
    pub direction: &'static str,
    pub color: Color,
}

fn pick(list: &'static [&'static str], value: &str) -> Option<&'static str> {
    list.iter().copied().find(|v| *v == value)
}

impl KeyboardEffect {
    pub fn validate(
        effect: &str,
        speed: u32,
        brightness: u32,
        direction: &str,
        color: &str,
    ) -> Result<Self, LightingError> {
        let effect = pick(EFFECTS, effect).ok_or_else(|| {
            invalid(format!(
                "unknown effect {effect:?}; expected one of: {}",
                EFFECTS.join(", ")
            ))
        })?;
        if speed > MAX_SPEED {
            return Err(invalid(format!("speed {speed} is not 0 to {MAX_SPEED}")));
        }
        if brightness > MAX_BRIGHTNESS {
            return Err(invalid(format!(
                "brightness {brightness} is not 0 to {MAX_BRIGHTNESS}"
            )));
        }
        let direction = pick(DIRECTIONS, direction).ok_or_else(|| {
            invalid(format!(
                "unknown direction {direction:?}; expected left or right"
            ))
        })?;
        let color = Color::parse(color)
            .ok_or_else(|| invalid(format!("colour {color:?} is not #rrggbb")))?;
        Ok(Self {
            effect,
            speed,
            brightness,
            direction,
            color,
        })
    }

    /// The line `keyboard_effect` accepts.
    pub fn to_line(&self) -> String {
        format!(
            "{} {} {} {} {}",
            self.effect,
            self.speed,
            self.brightness,
            self.direction,
            self.color.hex()
        )
    }

    /// Parses a saved line, validating it again.
    fn from_line(line: &str) -> Option<Self> {
        let [effect, speed, brightness, direction, color] = words(line)?;
        Self::validate(
            effect,
            speed.parse().ok()?,
            brightness.parse().ok()?,
            direction,
            color,
        )
        .ok()
    }
}

/// A validated logo setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Logo {
    pub on: bool,
    pub brightness: u32,
    pub color: Color,
    pub mode: &'static str,
}

impl Logo {
    pub fn validate(
        on: bool,
        brightness: u32,
        color: &str,
        mode: &str,
    ) -> Result<Self, LightingError> {
        if brightness > MAX_BRIGHTNESS {
            return Err(invalid(format!(
                "brightness {brightness} is not 0 to {MAX_BRIGHTNESS}"
            )));
        }
        let color = Color::parse(color)
            .ok_or_else(|| invalid(format!("colour {color:?} is not #rrggbb")))?;
        let mode = pick(LOGO_MODES, mode).ok_or_else(|| {
            invalid(format!(
                "unknown logo mode {mode:?}; expected one of: {}",
                LOGO_MODES.join(", ")
            ))
        })?;
        Ok(Self {
            on,
            brightness,
            color,
            mode,
        })
    }

    /// The line `logo` accepts.
    pub fn to_line(&self) -> String {
        format!(
            "{} {} {} {}",
            u8::from(self.on),
            self.brightness,
            self.color.hex(),
            self.mode
        )
    }

    /// Parses a saved line, validating it again. A line saved before the
    /// logo had modes has three words and means static.
    fn from_line(line: &str) -> Option<Self> {
        let (on, brightness, color, mode) = match words::<4>(line) {
            Some([on, brightness, color, mode]) => (on, brightness, color, mode),
            None => {
                let [on, brightness, color] = words(line)?;
                (on, brightness, color, "static")
            }
        };
        let on = match on {
            "0" => false,
            "1" => true,
            _ => return None,
        };
        Self::validate(on, brightness.parse().ok()?, color, mode).ok()
    }
}

fn words<const N: usize>(line: &str) -> Option<[&str; N]> {
    line.split(' ')
        .collect::<Vec<_>>()
        .try_into()
        .ok()
        .filter(|w: &[&str; N]| w.iter().all(|s| !s.is_empty()))
}

/// The keyboard as the module reads it back. The effect may be one Helios
/// cannot set (`static`, or `unknown` for a value from another tool).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeyboardState {
    pub effect: String,
    pub speed: u32,
    pub brightness: u32,
    pub direction: String,
    /// `#rrggbb`.
    pub color: String,
}

/// The logo as the module reads it back. The mode may be `unknown`, for a
/// value from another tool.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LogoState {
    pub on: bool,
    pub brightness: u32,
    /// `#rrggbb`.
    pub color: String,
    pub mode: String,
}

pub fn read_keyboard(fs: &dyn SysFs) -> Option<KeyboardState> {
    let text = fs.read_to_string(KEYBOARD_FILE)?;
    let [effect, speed, brightness, direction, color] = words(&text)?;
    Some(KeyboardState {
        effect: effect.to_owned(),
        speed: speed.parse().ok()?,
        brightness: brightness.parse().ok()?,
        direction: direction.to_owned(),
        color: Color::parse(color)?.to_hash(),
    })
}

pub fn read_logo(fs: &dyn SysFs) -> Option<LogoState> {
    let text = fs.read_to_string(LOGO_FILE)?;
    let [on, brightness, color, mode] = words(&text)?;
    Some(LogoState {
        on: on != "0",
        brightness: brightness.parse().ok()?,
        color: Color::parse(color)?.to_hash(),
        mode: mode.to_owned(),
    })
}

fn write(fs: &dyn SysFs, path: &str, line: &str) -> Result<(), LightingError> {
    if !available(fs) {
        return Err(LightingError::Unavailable);
    }
    fs.write(path, line)
        .map_err(|e| LightingError::WriteFailed(format!("writing {path}: {e}")))
}

/// Writes a validated effect; returns the state read back.
pub fn apply_keyboard(
    fs: &dyn SysFs,
    effect: &KeyboardEffect,
) -> Result<Option<KeyboardState>, LightingError> {
    write(fs, KEYBOARD_FILE, &effect.to_line())?;
    Ok(read_keyboard(fs))
}

/// Writes a validated logo setting; returns the state read back.
pub fn apply_logo(fs: &dyn SysFs, logo: &Logo) -> Result<Option<LogoState>, LightingError> {
    write(fs, LOGO_FILE, &logo.to_line())?;
    Ok(read_logo(fs))
}

/// What heliosd saved after the last successful writes, to re-apply after a
/// restart or a resume. Stored as text, one line per part:
///
/// ```text
/// keyboard wave 4 80 left ff0000
/// logo 1 100 00ff00 cycle
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Saved {
    pub keyboard: Option<KeyboardEffect>,
    pub logo: Option<Logo>,
}

impl Saved {
    /// Lenient: a line that does not validate is dropped, never applied.
    pub fn parse(text: &str) -> Self {
        let mut saved = Self::default();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("keyboard ") {
                saved.keyboard = KeyboardEffect::from_line(rest);
            } else if let Some(rest) = line.strip_prefix("logo ") {
                saved.logo = Logo::from_line(rest);
            }
        }
        saved
    }

    pub fn to_text(&self) -> String {
        let mut text = String::new();
        if let Some(k) = &self.keyboard {
            text.push_str(&format!("keyboard {}\n", k.to_line()));
        }
        if let Some(l) = &self.logo {
            text.push_str(&format!("logo {}\n", l.to_line()));
        }
        text
    }

    pub fn is_empty(&self) -> bool {
        self.keyboard.is_none() && self.logo.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakeFs;

    const BOUND: &[(&str, &str)] = &[
        (KEYBOARD_FILE, "wave 5 100 left 000000"),
        (LOGO_FILE, "0 0 000000 static"),
    ];

    fn wave() -> KeyboardEffect {
        KeyboardEffect::validate("wave", 4, 80, "right", "#FF8000").unwrap()
    }

    #[test]
    fn valid_effects_build_the_module_line() {
        assert_eq!(wave().to_line(), "wave 4 80 right ff8000");
        for effect in EFFECTS {
            for direction in DIRECTIONS {
                let e = KeyboardEffect::validate(effect, 0, 100, direction, "00ffaa").unwrap();
                assert_eq!(e.to_line(), format!("{effect} 0 100 {direction} 00ffaa"));
            }
        }
    }

    #[test]
    fn every_number_is_accepted_exactly_when_in_range() {
        for n in 0..1000 {
            let speed = KeyboardEffect::validate("neon", n, 50, "left", "#000000");
            assert_eq!(speed.is_ok(), n <= MAX_SPEED, "speed {n}");
            let brightness = KeyboardEffect::validate("neon", 5, n, "left", "#000000");
            assert_eq!(brightness.is_ok(), n <= MAX_BRIGHTNESS, "brightness {n}");
            assert_eq!(
                Logo::validate(true, n, "#000000", "static").is_ok(),
                n <= MAX_BRIGHTNESS,
                "logo {n}"
            );
        }
    }

    #[test]
    fn invalid_requests_are_rejected() {
        let bad = [
            ("static", 0, 100, "right", "#ff0000"),
            ("meteor", 4, 80, "right", "#ff0000"),
            ("Wave", 4, 80, "right", "#ff0000"),
            ("", 4, 80, "right", "#ff0000"),
            ("wave", 4, 80, "up", "#ff0000"),
            ("wave", 4, 80, "", "#ff0000"),
            ("wave", 4, 80, "right", "ff000"),
            ("wave", 4, 80, "right", "#ff00000"),
            ("wave", 4, 80, "right", "#gg0000"),
            ("wave", 4, 80, "right", "red"),
            ("wave", 4, 80, "right", "##ff0000"),
            ("wave", 4, 80, "right", "#ff 000"),
            ("wave", 4, 80, "right", "+ff0000"),
        ];
        for (effect, speed, brightness, direction, color) in bad {
            let e = KeyboardEffect::validate(effect, speed, brightness, direction, color);
            assert!(
                matches!(e, Err(LightingError::InvalidArgument(_))),
                "{effect} {direction} {color}: {e:?}"
            );
        }
        assert!(Logo::validate(true, 50, "#12345", "static").is_err());
        assert!(Logo::validate(true, 50, "nope", "static").is_err());
        for mode in ["", "Cycle", "unknown", "wave", "3", "cycle "] {
            let e = Logo::validate(true, 50, "#00ff00", mode);
            assert!(
                matches!(e, Err(LightingError::InvalidArgument(_))),
                "{mode:?}: {e:?}"
            );
        }
    }

    #[test]
    fn logo_line() {
        let logo = Logo::validate(true, 70, "#FF6600", "static").unwrap();
        assert_eq!(logo.to_line(), "1 70 ff6600 static");
        assert_eq!(
            Logo::validate(false, 0, "#000000", "breathing")
                .unwrap()
                .to_line(),
            "0 0 000000 breathing"
        );
        for mode in LOGO_MODES {
            let logo = Logo::validate(true, 100, "#00ff00", mode).unwrap();
            assert_eq!(logo.to_line(), format!("1 100 00ff00 {mode}"));
        }
    }

    #[test]
    fn apply_writes_exactly_the_line_and_reads_back() {
        let fs = FakeFs::new(BOUND);
        let state = apply_keyboard(&fs, &wave()).unwrap().unwrap();
        assert_eq!(
            fs.writes(),
            [(
                KEYBOARD_FILE.to_owned(),
                "wave 4 80 right ff8000".to_owned()
            )]
        );
        assert_eq!(
            state,
            KeyboardState {
                effect: "wave".into(),
                speed: 4,
                brightness: 80,
                direction: "right".into(),
                color: "#ff8000".into(),
            }
        );

        let logo = apply_logo(&fs, &Logo::validate(true, 70, "#ff6600", "cycle").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            logo,
            LogoState {
                on: true,
                brightness: 70,
                color: "#ff6600".into(),
                mode: "cycle".into(),
            }
        );
        assert_eq!(
            fs.writes()[1],
            (LOGO_FILE.to_owned(), "1 70 ff6600 cycle".to_owned())
        );
    }

    #[test]
    fn nothing_is_written_without_the_module() {
        let fs = FakeFs::new(&[(KEYBOARD_FILE, "wave 5 100 left 000000")]);
        assert!(!available(&fs));
        assert_eq!(
            apply_keyboard(&fs, &wave()),
            Err(LightingError::Unavailable)
        );
        assert!(fs.writes().is_empty());
    }

    #[test]
    fn a_rejected_write_is_reported() {
        let fs = FakeFs::new(&[(LOGO_FILE, "0 0 000000 static")]);
        // available() needs both files; make the keyboard file unwritable.
        fs.set(KEYBOARD_FILE, "wave 5 100 left 000000");
        let fs = fs.with_unwritable(KEYBOARD_FILE);
        let e = apply_keyboard(&fs, &wave()).unwrap_err();
        assert!(matches!(e, LightingError::WriteFailed(_)), "{e:?}");
    }

    #[test]
    fn read_back_shows_effects_helios_cannot_set() {
        let fs = FakeFs::new(&[
            (KEYBOARD_FILE, "static 0 100 right ff0000"),
            (LOGO_FILE, "1 80 123456 unknown"),
        ]);
        assert_eq!(read_keyboard(&fs).unwrap().effect, "static");
        fs.set(KEYBOARD_FILE, "unknown 9 100 unknown 010203");
        let k = read_keyboard(&fs).unwrap();
        assert_eq!(
            (k.effect.as_str(), k.direction.as_str()),
            ("unknown", "unknown")
        );
        fs.set(KEYBOARD_FILE, "garbage");
        assert_eq!(read_keyboard(&fs), None);
        assert_eq!(
            read_logo(&fs).unwrap(),
            LogoState {
                on: true,
                brightness: 80,
                color: "#123456".into(),
                mode: "unknown".into(),
            }
        );
        // A module older than 0.3.0 reads back three words.
        fs.set(LOGO_FILE, "1 80 123456");
        assert_eq!(read_logo(&fs), None);
    }

    #[test]
    fn saved_state_round_trips() {
        let saved = Saved {
            keyboard: Some(wave()),
            logo: Some(Logo::validate(true, 100, "#00ff00", "breathing").unwrap()),
        };
        let text = saved.to_text();
        assert_eq!(
            text,
            "keyboard wave 4 80 right ff8000\nlogo 1 100 00ff00 breathing\n"
        );
        assert_eq!(Saved::parse(&text), saved);
        assert!(Saved::parse("").is_empty());
    }

    #[test]
    fn saved_state_never_yields_an_invalid_value() {
        let text = "keyboard static 0 100 right ff0000\n\
                    logo 1 101 00ff00\n\
                    keyboard wave 99 80 right ff0000\n\
                    unrelated line\n";
        assert!(Saved::parse(text).is_empty());
        let text = "logo 2 50 00ff00\nkeyboard wave 4 80 right ff0000 extra\n";
        assert!(Saved::parse(text).is_empty());
        let text = "logo 1 50 00ff00 rainbow\n";
        assert!(Saved::parse(text).is_empty());
        let text = "logo 1 50 00ff00 cycle extra\n";
        assert!(Saved::parse(text).is_empty());
        let text = "keyboard zoom 1 2 left 0000ff\nlogo 0 0 000000\n";
        let saved = Saved::parse(text);
        assert_eq!(saved.keyboard.unwrap().effect, "zoom");
        let logo = saved.logo.unwrap();
        assert!(!logo.on);
        // Saved before the logo had modes: static.
        assert_eq!(logo.mode, "static");
    }
}
