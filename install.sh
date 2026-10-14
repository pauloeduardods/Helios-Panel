#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs Helios Panel: the heliosd system service, heliosctl and the GNOME
# extension. Run it as your own user; it asks for sudo only for the system
# files.
#
#   ./install.sh               install, or upgrade an earlier install
#   ./install.sh --uninstall   remove exactly what install put there
#
# Every file and directory it creates is recorded in a manifest, and
# --uninstall removes those and nothing else. It never touches kernel
# modules, modprobe configuration, kernel parameters or the initramfs.
set -euo pipefail

UUID="helios-panel@paulo"
BUS_NAME="io.github.pauloeduardods.Helios1"
REPO="$(cd "$(dirname "$0")" && pwd)"

# Test hooks: system paths go under HELIOS_ROOT, prebuilt binaries can come
# from HELIOS_BIN_DIR, and HELIOS_SUDO="" runs the system part without sudo.
ROOT="${HELIOS_ROOT:-}"
SUDO="${HELIOS_SUDO-sudo}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_DIR="$DATA_HOME/gnome-shell/extensions/$UUID"
MANIFEST="$ROOT/usr/local/share/helios-panel/install-manifest"

# destination|source|mode. "bin:" sources come from the build, the rest from the repository.
SYSTEM_FILES=(
    "/usr/local/libexec/heliosd|bin:heliosd|755"
    "/usr/local/bin/heliosctl|bin:heliosctl|755"
    "/etc/systemd/system/heliosd.service|data/heliosd.service|644"
    "/usr/share/dbus-1/system.d/$BUS_NAME.conf|data/$BUS_NAME.conf|644"
    "/usr/share/dbus-1/system-services/$BUS_NAME.service|data/$BUS_NAME.service|644"
    "/usr/share/polkit-1/actions/io.github.pauloeduardods.helios.policy|data/io.github.pauloeduardods.helios.policy|644"
)

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Runs a command for the system part, through sudo unless HELIOS_SUDO="".
sys() {
    if [[ -n "$SUDO" ]]; then "$SUDO" "$@"; else "$@"; fi
}

# ---------------------------------------------------------------- manifest

declare -A OLD=() # path -> kind, from the previous install
OLD_ENTRIES=()
NEW_ENTRIES=()

read_manifest() {
    [[ -f "$MANIFEST" ]] || return 1
    local kind path
    while IFS=$'\t' read -r kind path; do
        [[ -n "$kind" && -n "$path" ]] || continue
        OLD["$path"]="$kind"
        OLD_ENTRIES+=("$kind"$'\t'"$path")
    done <"$MANIFEST"
}

record() { NEW_ENTRIES+=("$1"$'\t'"$2"); }

# Creates the missing parents of $2 top-down, recording each one as $1-dir.
make_dirs() {
    local scope="$1" dir="$2" missing=()
    while [[ ! -d "$dir" ]]; do
        missing=("$dir" "${missing[@]}")
        dir="$(dirname "$dir")"
    done
    for dir in "${missing[@]}"; do
        if [[ "$scope" == sys ]]; then sys mkdir -m 755 "$dir"; else mkdir -m 755 "$dir"; fi
        record "$scope-dir" "$dir"
    done
}

# Removes every entry of the previous install: files first, then the
# directories it created (deepest first), and only if they are empty.
remove_entries() {
    local i kind path
    for ((i = ${#OLD_ENTRIES[@]} - 1; i >= 0; i--)); do
        IFS=$'\t' read -r kind path <<<"${OLD_ENTRIES[$i]}"
        case "$kind" in
        user-file) rm -f -- "$path" ;;
        sys-file) sys rm -f -- "$path" ;;
        esac
    done
    for ((i = ${#OLD_ENTRIES[@]} - 1; i >= 0; i--)); do
        IFS=$'\t' read -r kind path <<<"${OLD_ENTRIES[$i]}"
        case "$kind" in
        user-dir) rmdir -- "$path" 2>/dev/null || warn "kept $path (not empty)" ;;
        sys-dir) sys rmdir -- "$path" 2>/dev/null || warn "kept $path (not empty)" ;;
        esac
    done
}

reload_services() {
    sys systemctl daemon-reload || warn "systemctl daemon-reload failed"
    sys busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null ||
        warn "could not ask D-Bus to reload its configuration"
}

# ---------------------------------------------------------------- uninstall

uninstall() {
    if ! read_manifest; then
        info "Nothing to uninstall: no manifest at $MANIFEST"
        return 0
    fi
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    sys systemctl stop heliosd.service >/dev/null 2>&1 || true
    remove_entries
    reload_services
    info "Helios Panel removed. Log out and back in to unload the extension from GNOME Shell."
}

# ---------------------------------------------------------------- install

need() {
    command -v "$1" >/dev/null || die "$1 is missing. Install it with: $2"
}

find_cargo() {
    if command -v cargo >/dev/null; then
        command -v cargo
    elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
        printf '%s\n' "$HOME/.cargo/bin/cargo"
    else
        die "cargo is missing. Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    fi
}

# Is $EXT_DIR an extension-only install from before the manifest existed?
is_legacy_extension() {
    [[ ${#OLD_ENTRIES[@]} -eq 0 && -f "$EXT_DIR/metadata.json" ]] &&
        grep -q "\"uuid\": \"$UUID\"" "$EXT_DIR/metadata.json"
}

install_all() {
    [[ $EUID -ne 0 || -n "${HELIOS_ROOT:-}" ]] ||
        die "run this as your own user, not with sudo; it asks for sudo itself"

    # 1. Checks first: nothing is changed if anything is missing.
    need glib-compile-schemas "sudo apt install libglib2.0-bin"
    need systemctl "sudo apt install systemd"
    need busctl "sudo apt install systemd"
    [[ -z "$SUDO" ]] || need "$SUDO" "apt install sudo (as root)"

    read_manifest || true
    local legacy=0
    if is_legacy_extension; then
        legacy=1
    fi
    local entry dest src mode targets=("$MANIFEST")
    for entry in "${SYSTEM_FILES[@]}"; do
        targets+=("$ROOT${entry%%|*}")
    done
    local file
    while IFS= read -r -d '' file; do
        targets+=("$EXT_DIR/${file#"$REPO/extension/"}")
    done < <(find "$REPO/extension" -type f -print0 | sort -z)
    for dest in "${targets[@]}"; do
        if [[ -e "$dest" && -z "${OLD[$dest]:-}" ]] && ! [[ $legacy -eq 1 && "$dest" == "$EXT_DIR"/* ]]; then
            die "$dest already exists and was not installed by this script. Move it away and run again."
        fi
    done

    # 2. Build as the user.
    local bin="${HELIOS_BIN_DIR:-}"
    if [[ -z "$bin" ]]; then
        local cargo
        cargo="$(find_cargo)"
        info "Building heliosd and heliosctl..."
        (cd "$REPO" && "$cargo" build --release --locked -p heliosd -p heliosctl)
        bin="$REPO/target/release"
    fi
    [[ -x "$bin/heliosd" && -x "$bin/heliosctl" ]] || die "no heliosd/heliosctl binaries in $bin"

    # 3. One sudo prompt for the system part.
    if [[ -n "$SUDO" ]]; then
        info "Installing the system service needs sudo:"
        sys -v
    fi

    # 4. Replace the previous install, if any.
    if [[ ${#OLD_ENTRIES[@]} -gt 0 ]]; then
        info "Replacing the previous install..."
        remove_entries
    elif [[ $legacy -eq 1 ]]; then
        info "Replacing the earlier extension-only install..."
        rm -rf -- "$EXT_DIR"
    fi

    # 5. System files.
    for entry in "${SYSTEM_FILES[@]}"; do
        IFS='|' read -r dest src mode <<<"$entry"
        dest="$ROOT$dest"
        case "$src" in
        bin:*) src="$bin/${src#bin:}" ;;
        *) src="$REPO/$src" ;;
        esac
        make_dirs sys "$(dirname "$dest")"
        sys install -m "$mode" "$src" "$dest"
        record sys-file "$dest"
    done

    # 6. The extension, as the user.
    while IFS= read -r -d '' file; do
        dest="$EXT_DIR/${file#"$REPO/extension/"}"
        make_dirs user "$(dirname "$dest")"
        install -m 644 "$file" "$dest"
        record user-file "$dest"
    done < <(find "$REPO/extension" -type f -print0 | sort -z)
    glib-compile-schemas "$EXT_DIR/schemas"
    record user-file "$EXT_DIR/schemas/gschemas.compiled"

    # 7. The manifest, recording itself last so it is removed last.
    make_dirs sys "$(dirname "$MANIFEST")"
    record sys-file "$MANIFEST"
    local tmp
    tmp="$(mktemp)"
    printf '%s\n' "${NEW_ENTRIES[@]}" >"$tmp"
    sys install -m 644 "$tmp" "$MANIFEST"
    rm -f -- "$tmp"

    # 8. Let systemd and D-Bus see the new files; restart an older daemon.
    reload_services
    sys systemctl try-restart heliosd.service || warn "could not restart heliosd"

    local version
    if version="$(busctl --system get-property "$BUS_NAME" /io/github/pauloeduardods/Helios1 \
        "$BUS_NAME.Daemon" Version 2>/dev/null)"; then
        info "heliosd is running (${version#s })."
    else
        warn "heliosd did not start; see: journalctl -u heliosd"
    fi

    if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
        info "Extension enabled. If the panel still shows the old version, log out and back in (on X11: Alt+F2, r)."
    else
        info "Log out and back in, then run: gnome-extensions enable $UUID"
    fi
    info "Done. To remove everything: ./install.sh --uninstall"
}

case "${1:-}" in
"") install_all ;;
--uninstall) uninstall ;;
-h | --help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//' ;;
*) die "unknown option: $1 (try --help)" ;;
esac
