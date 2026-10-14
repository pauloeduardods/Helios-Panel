// SPDX-License-Identifier: GPL-3.0-or-later
//! Pure logic shared by heliosd and heliosctl.
//!
//! Nothing in this crate opens files, spawns processes or talks to D-Bus:
//! every interaction with the system goes through the traits in [`io`], so
//! the whole crate is tested against in-memory fakes (see the `fake` feature).

pub mod hwmon;
pub mod io;
pub mod nvidia;
pub mod profile;
pub mod status;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use io::{Clock, GpuQuery, SysFs};
