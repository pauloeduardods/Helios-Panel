// SPDX-License-Identifier: GPL-3.0-or-later
//! polkit authorization over D-Bus. Fails closed: any error means "no".

use std::collections::HashMap;

use zbus::proxy;
use zbus::zvariant::Value;

pub const SET_PROFILE_ACTION: &str = "io.github.pauloeduardods.helios.set-profile";
pub const SET_LIGHTING_ACTION: &str = "io.github.pauloeduardods.helios.set-lighting";

/// Lets the agent prompt when an administrator configured `auth_*` for the action.
const ALLOW_USER_INTERACTION: u32 = 1;

#[proxy(
    interface = "org.freedesktop.PolicyKit1.Authority",
    default_service = "org.freedesktop.PolicyKit1",
    default_path = "/org/freedesktop/PolicyKit1/Authority",
    gen_blocking = false
)]
trait Authority {
    fn check_authorization(
        &self,
        subject: &(&str, HashMap<&str, Value<'_>>),
        action_id: &str,
        details: HashMap<&str, &str>,
        flags: u32,
        cancellation_id: &str,
    ) -> zbus::Result<(bool, bool, HashMap<String, String>)>;
}

/// Whether `caller` (a unique bus name) may perform `action`.
pub async fn authorize(conn: &zbus::Connection, caller: &str, action: &str) -> Result<(), String> {
    let proxy = AuthorityProxy::new(conn)
        .await
        .map_err(|e| format!("polkit unavailable: {e}"))?;
    let subject = (
        "system-bus-name",
        HashMap::from([("name", Value::from(caller))]),
    );
    let (authorized, _challenge, _details) = proxy
        .check_authorization(&subject, action, HashMap::new(), ALLOW_USER_INTERACTION, "")
        .await
        .map_err(|e| format!("polkit check failed: {e}"))?;
    if authorized {
        Ok(())
    } else {
        Err(format!("not authorized for {action}"))
    }
}
