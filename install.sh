#!/usr/bin/env bash
# Installs (or updates) the extension for the current user. No root needed.
set -euo pipefail

UUID="helios-panel@paulo"
SRC="$(cd "$(dirname "$0")" && pwd)/extension"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removida. Faça logout/login para sair da memória do GNOME Shell."
    exit 0
fi

command -v glib-compile-schemas >/dev/null || {
    echo "Falta o glib-compile-schemas: sudo apt install libglib2.0-bin" >&2
    exit 1
}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
glib-compile-schemas "$DEST/schemas"
echo "Instalada em $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Ativada. Se não aparecer na barra, faça logout/login (Wayland)."
else
    echo "Faça logout/login e depois rode: gnome-extensions enable $UUID"
fi
