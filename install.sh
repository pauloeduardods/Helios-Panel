#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs (or updates) the extension for the current user. No root needed.
set -euo pipefail

UUID="helios-panel@paulo"
SRC="$(cd "$(dirname "$0")" && pwd)/extension"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removed. Log out and back in to unload it from GNOME Shell."
    exit 0
fi

command -v glib-compile-schemas >/dev/null || {
    echo "glib-compile-schemas is missing: sudo apt install libglib2.0-bin" >&2
    exit 1
}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
glib-compile-schemas "$DEST/schemas"
echo "Installed to $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled. If it does not show up in the top bar, log out and back in (Wayland)."
else
    echo "Log out and back in, then run: gnome-extensions enable $UUID"
fi
