// SPDX-License-Identifier: GPL-3.0-or-later
//! The Lighting interface: the keyboard effect and the lid logo, written
//! through the helios-acer-lighting kernel module. Exported only when the
//! module is bound. The last applied state is saved and re-applied when
//! heliosd starts and after a resume, since the EC may forget it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_lite::StreamExt;
use helios_core::lighting::{
    self, DIRECTIONS, EFFECTS, KeyboardEffect, KeyboardState, LOGO_MODES, LightingError, Logo,
    LogoState, Saved,
};
use zbus::message::{Header, Type};
use zbus::object_server::SignalEmitter;
use zbus::{MatchRule, MessageStream, interface};

use crate::polkit::{self, SET_LIGHTING_ACTION};
use crate::props::Changes;
use crate::service::{HeliosError, OBJECT_PATH, Shared, emit, lock};

pub const LIGHTING_IFACE: &str = "io.github.pauloeduardods.Helios1.Lighting";
const SAVED_FILE: &str = "lighting";

/// (effect, speed, brightness, direction, "#rrggbb").
pub type Keyboard = (String, u32, u32, String, String);
/// (on, brightness, "#rrggbb", mode).
pub type LogoProp = (bool, u32, String, String);

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LightingProps {
    pub keyboard: Keyboard,
    pub logo: LogoProp,
}

fn keyboard_prop(k: KeyboardState) -> Keyboard {
    (k.effect, k.speed, k.brightness, k.direction, k.color)
}

fn logo_prop(l: LogoState) -> LogoProp {
    (l.on, l.brightness, l.color, l.mode)
}

impl LightingProps {
    /// Reads both from the module (each read is one firmware call).
    pub fn read(fs: &dyn helios_core::SysFs) -> Self {
        Self {
            keyboard: lighting::read_keyboard(fs)
                .map(keyboard_prop)
                .unwrap_or_default(),
            logo: lighting::read_logo(fs).map(logo_prop).unwrap_or_default(),
        }
    }
}

pub fn changes(old: &LightingProps, new: &LightingProps) -> Changes {
    let mut out: Changes = Vec::new();
    if old.keyboard != new.keyboard {
        out.push(("Keyboard", new.keyboard.clone().into()));
    }
    if old.logo != new.logo {
        out.push(("Logo", new.logo.clone().into()));
    }
    out
}

impl From<LightingError> for HeliosError {
    fn from(e: LightingError) -> Self {
        match e {
            LightingError::Unavailable => Self::Unavailable(e.to_string()),
            LightingError::InvalidArgument(m) => Self::InvalidArgument(m),
            LightingError::WriteFailed(m) => Self::WriteFailed(m),
        }
    }
}

fn saved_path(dir: &Path) -> PathBuf {
    dir.join(SAVED_FILE)
}

pub fn load_saved(dir: &Path) -> Saved {
    std::fs::read_to_string(saved_path(dir))
        .map(|text| Saved::parse(&text))
        .unwrap_or_default()
}

/// Writes the file whole (temporary file, then rename).
fn store_saved(dir: &Path, saved: &Saved) -> std::io::Result<()> {
    let tmp = dir.join(format!("{SAVED_FILE}.tmp"));
    std::fs::write(&tmp, saved.to_text())?;
    std::fs::rename(tmp, saved_path(dir))
}

/// What one request writes.
#[derive(Debug, Clone)]
enum Request {
    Keyboard(KeyboardEffect),
    Logo(Logo),
}

impl Shared {
    /// Blocking: writes to the module and saves the request.
    fn apply_lighting(&self, request: &Request) -> Result<(), LightingError> {
        let mut saved = load_saved(&self.state_dir);
        match request {
            Request::Keyboard(k) => {
                lighting::apply_keyboard(&self.fs, k)?;
                saved.keyboard = Some(k.clone());
            }
            Request::Logo(l) => {
                lighting::apply_logo(&self.fs, l)?;
                saved.logo = Some(l.clone());
            }
        }
        if let Err(e) = store_saved(&self.state_dir, &saved) {
            eprintln!("heliosd: could not save the lighting state: {e}");
        }
        Ok(())
    }

    /// Blocking: re-applies the saved state, if any. Every saved value was
    /// validated when it was read back.
    pub fn restore_lighting(&self) {
        let saved = load_saved(&self.state_dir);
        if saved.is_empty() || !lighting::available(&self.fs) {
            return;
        }
        if let Some(k) = &saved.keyboard {
            if let Err(e) = lighting::apply_keyboard(&self.fs, k) {
                eprintln!("heliosd: restoring the keyboard effect failed: {e}");
            }
        }
        if let Some(l) = &saved.logo {
            if let Err(e) = lighting::apply_logo(&self.fs, l) {
                eprintln!("heliosd: restoring the logo failed: {e}");
            }
        }
        eprintln!("heliosd: lighting restored");
    }

    /// Blocking: reads the module and returns what changed.
    pub fn refresh_lighting(&self) -> Changes {
        let new = LightingProps::read(&self.fs);
        let mut published = lock(&self.lighting);
        let out = changes(&published, &new);
        *published = new;
        out
    }

    fn lighting(&self) -> LightingProps {
        lock(&self.lighting).clone()
    }
}

/// Restores the saved state off the async threads, then publishes it.
pub async fn restore_and_emit(
    shared: &Arc<Shared>,
    emitter: &SignalEmitter<'_>,
) -> zbus::Result<()> {
    let _guard = shared.write_lock.lock().await;
    let changes = blocking::unblock({
        let shared = Arc::clone(shared);
        move || {
            shared.restore_lighting();
            shared.refresh_lighting()
        }
    })
    .await;
    emit(emitter, LIGHTING_IFACE, changes).await
}

/// Re-applies the saved state each time logind reports the end of a sleep.
/// Only logind's own signals count: the match names its bus name, which
/// only logind can own on the system bus.
pub async fn restore_after_resume(shared: Arc<Shared>) -> zbus::Result<()> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.login1")?
        .interface("org.freedesktop.login1.Manager")?
        .member("PrepareForSleep")?
        .build();
    let mut stream = MessageStream::for_match_rule(rule, &shared.conn, None).await?;
    let emitter = SignalEmitter::new(&shared.conn, OBJECT_PATH)?;
    while let Some(message) = stream.next().await {
        let Ok(message) = message else { continue };
        if let Ok(false) = message.body().deserialize::<bool>() {
            restore_and_emit(&shared, &emitter).await?;
        }
    }
    Ok(())
}

pub struct LightingIface(pub Arc<Shared>);

impl LightingIface {
    /// Validated already: asks polkit, then writes, saves and publishes.
    async fn set(
        &self,
        what: String,
        request: Request,
        header: Header<'_>,
        emitter: SignalEmitter<'_>,
    ) -> Result<(), HeliosError> {
        let shared = &self.0;
        let caller = header.sender().map(|s| s.to_string()).unwrap_or_default();
        let log = |outcome: &str| eprintln!("heliosd: {what} from {caller}: {outcome}");

        if let Err(reason) = polkit::authorize(&shared.conn, &caller, SET_LIGHTING_ACTION).await {
            log(&format!("denied: {reason}"));
            return Err(HeliosError::NotAuthorized(reason));
        }

        let guard = shared.write_lock.lock().await;
        let (result, changes) = blocking::unblock({
            let shared = Arc::clone(shared);
            move || {
                let result = shared.apply_lighting(&request);
                (result, shared.refresh_lighting())
            }
        })
        .await;
        drop(guard);

        emit(&emitter, LIGHTING_IFACE, changes).await?;
        match result {
            Ok(()) => {
                log("ok");
                Ok(())
            }
            Err(e) => {
                log(&format!("failed: {e}"));
                Err(e.into())
            }
        }
    }
}

#[interface(name = "io.github.pauloeduardods.Helios1.Lighting")]
impl LightingIface {
    /// The keyboard effects Helios can set, in menu order.
    #[zbus(property(emits_changed_signal = "const"))]
    fn effects(&self) -> Vec<String> {
        EFFECTS.iter().map(|s| (*s).to_owned()).collect()
    }

    #[zbus(property(emits_changed_signal = "const"))]
    fn directions(&self) -> Vec<String> {
        DIRECTIONS.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The logo modes Helios can set, in menu order.
    #[zbus(property(emits_changed_signal = "const"))]
    fn logo_modes(&self) -> Vec<String> {
        LOGO_MODES.iter().map(|s| (*s).to_owned()).collect()
    }

    /// (effect, speed 0-9, brightness 0-100, direction, "#rrggbb"), as the
    /// module reads it back. The effect may be one Helios cannot set.
    #[zbus(property)]
    fn keyboard(&self) -> Keyboard {
        self.0.lighting().keyboard
    }

    /// (on, brightness 0-100, "#rrggbb", mode). The mode may be `unknown`.
    #[zbus(property)]
    fn logo(&self) -> LogoProp {
        self.0.lighting().logo
    }

    // The D-Bus signature sets the arguments.
    #[allow(clippy::too_many_arguments)]
    async fn set_keyboard_effect(
        &self,
        effect: String,
        speed: u32,
        brightness: u32,
        direction: String,
        color: String,
        #[zbus(header)] header: Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<(), HeliosError> {
        let what = format!(
            "SetKeyboardEffect({effect:?}, {speed}, {brightness}, {direction:?}, {color:?})"
        );
        // Garbage is rejected before polkit, so it can never trigger a prompt.
        let request = KeyboardEffect::validate(&effect, speed, brightness, &direction, &color)
            .map_err(|e| {
                eprintln!("heliosd: {what}: rejected: {e}");
                HeliosError::from(e)
            })?;
        self.set(what, Request::Keyboard(request), header, emitter)
            .await
    }

    async fn set_logo(
        &self,
        on: bool,
        brightness: u32,
        color: String,
        mode: String,
        #[zbus(header)] header: Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> Result<(), HeliosError> {
        let what = format!("SetLogo({on}, {brightness}, {color:?}, {mode:?})");
        let request = Logo::validate(on, brightness, &color, &mode).map_err(|e| {
            eprintln!("heliosd: {what}: rejected: {e}");
            HeliosError::from(e)
        })?;
        self.set(what, Request::Logo(request), header, emitter)
            .await
    }
}
