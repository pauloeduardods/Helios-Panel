#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Measures what Helios costs. Read-only: it reads /proc and /sys and listens
# to heliosd's D-Bus signals; it changes nothing.
#
#   tools/footprint.sh live [seconds]
#       The installed heliosd and gnome-shell as they run now (default 120 s).
#   tools/footprint.sh bench <heliosd binary> [seconds]
#       Runs a copy of heliosd as you, on the session bus, against the real
#       /sys, without nvidia-smi, and reports its own cost. Use it to compare
#       two builds on the same machine (default 120 s).
#   tools/footprint.sh extension [seconds]
#       gnome-shell's CPU with the extension on, then off, then turns it back
#       on (default 120 s each). The panel disappears during the "off" half.

set -euo pipefail

BUS_NAME=io.github.pauloeduardods.Helios1
EXTENSION=helios-panel@paulo
TCK=$(getconf CLK_TCK)

# CPU seconds of a process: own (utime+stime) and reaped children.
cpu_self() { awk -v t="$TCK" '{printf "%.2f", ($14+$15)/t}' "/proc/$1/stat"; }
cpu_children() { awk -v t="$TCK" '{printf "%.2f", ($16+$17)/t}' "/proc/$1/stat"; }
ctx_switches() { awk '/ctxt_switches/ {s += $2} END {print s}' "/proc/$1/status"; }
rss_kb() { awk '/^VmRSS/ {print $2}' "/proc/$1/status"; }
percent() { awk -v c="$1" -v s="$2" 'BEGIN {printf "%.3f", c / s * 100}'; }
sub() { awk -v a="$1" -v b="$2" 'BEGIN {printf "%.2f", a - b}'; }

nvidia_dir() {
    local d
    for d in /sys/bus/pci/devices/*; do
        [[ $(cat "$d/vendor" 2>/dev/null) == 0x10de ]] || continue
        [[ $(cat "$d/class" 2>/dev/null) == 0x0300* || $(cat "$d/class" 2>/dev/null) == 0x0302* ]] && { echo "$d"; return; }
    done
}

live() {
    local seconds=${1:-120} pid shell gpu
    pid=$(pgrep -x heliosd) || { echo "heliosd is not running" >&2; exit 1; }
    shell=$(pgrep -x gnome-shell | head -1 || true)
    gpu=$(nvidia_dir || true)

    local s0 c0 x0 r0 g0 a0
    s0=$(cpu_self "$pid"); c0=$(cpu_children "$pid"); x0=$(ctx_switches "$pid"); r0=$(rss_kb "$pid")
    g0=${shell:+$(cpu_self "$shell")}
    a0=${gpu:+$(cat "$gpu/power/runtime_active_time")}

    echo "Measuring for ${seconds} s…" >&2
    local signals
    signals=$(timeout "$seconds" gdbus monitor --system --dest "$BUS_NAME" 2>/dev/null \
        | grep -c PropertiesChanged || true)

    local s1 c1 x1 r1 g1 a1
    s1=$(cpu_self "$pid"); c1=$(cpu_children "$pid"); x1=$(ctx_switches "$pid"); r1=$(rss_kb "$pid")
    g1=${shell:+$(cpu_self "$shell")}
    a1=${gpu:+$(cat "$gpu/power/runtime_active_time")}

    local self children
    self=$(sub "$s1" "$s0"); children=$(sub "$c1" "$c0")
    echo "| What | Over ${seconds} s |"
    echo "|---|---|"
    echo "| heliosd CPU, own | ${self} s ($(percent "$self" "$seconds") %) |"
    echo "| heliosd CPU, nvidia-smi runs | ${children} s ($(percent "$children" "$seconds") %) |"
    echo "| heliosd resident memory | ${r0} → ${r1} kB |"
    echo "| heliosd context switches | $((x1 - x0)) ($(awk -v n=$((x1 - x0)) -v s="$seconds" 'BEGIN {printf "%.1f", n / s}')/s) |"
    echo "| D-Bus PropertiesChanged signals | ${signals} ($(awk -v n="$signals" -v s="$seconds" 'BEGIN {printf "%.2f", n / s}')/s) |"
    if [[ -n $shell ]]; then
        local gs
        gs=$(sub "$g1" "$g0")
        echo "| gnome-shell CPU (everything in it) | ${gs} s ($(percent "$gs" "$seconds") %) |"
    fi
    if [[ -n $gpu ]]; then
        local holders
        holders=$(for p in /proc/[0-9]*; do
            ls -l "$p/fd" 2>/dev/null | grep -q /dev/nvidia && cat "$p/comm" 2>/dev/null
        done | sort -u | paste -sd, - || true)
        echo "| NVIDIA GPU awake | $(( (a1 - a0) / 1000 )) of ${seconds} s (/dev/nvidia* held by: ${holders:-nobody visible}) |"
    fi
}

bench() {
    local binary=${1:?usage: footprint.sh bench <heliosd binary> [seconds]} seconds=${2:-120}
    command -v dbus-run-session >/dev/null || { echo "dbus-run-session is missing" >&2; exit 1; }
    local out
    out=$(mktemp)
    # A private session bus, so the copy cannot clash with anything.
    dbus-run-session -- bash -c '
        "$1" --bus session --nvidia-smi /bin/false 2>/dev/null &
        pid=$!
        sleep 3   # startup is not what we measure
        read -r s0 < <(awk "{print \$14+\$15}" /proc/$pid/stat)
        sleep "$2"
        read -r s1 < <(awk "{print \$14+\$15}" /proc/$pid/stat)
        rss=$(awk "/^VmRSS/ {print \$2}" /proc/$pid/status)
        kill $pid
        echo "$s0 $s1 $rss"
    ' bench "$binary" "$seconds" > "$out"
    local s0 s1 rss self
    read -r s0 s1 rss < "$out"
    rm -f "$out"
    self=$(awk -v a="$s0" -v b="$s1" -v t="$TCK" 'BEGIN {printf "%.2f", (b - a) / t}')
    echo "| $(basename "$binary") ($binary) | ${self} s over ${seconds} s ($(percent "$self" "$seconds") %) | ${rss} kB |"
}

extension() {
    local seconds=${1:-120} shell on off
    shell=$(pgrep -x gnome-shell | head -1) || { echo "gnome-shell is not running" >&2; exit 1; }
    trap 'gnome-extensions enable "$EXTENSION"' EXIT
    gnome-extensions enable "$EXTENSION"
    sleep 5
    local a b
    a=$(cpu_self "$shell"); sleep "$seconds"; b=$(cpu_self "$shell"); on=$(sub "$b" "$a")
    gnome-extensions disable "$EXTENSION"
    sleep 5
    a=$(cpu_self "$shell"); sleep "$seconds"; b=$(cpu_self "$shell"); off=$(sub "$b" "$a")
    echo "| gnome-shell CPU | ${seconds} s |"
    echo "|---|---|"
    echo "| extension on | ${on} s ($(percent "$on" "$seconds") %) |"
    echo "| extension off | ${off} s ($(percent "$off" "$seconds") %) |"
    echo "| difference | $(sub "$on" "$off") s ($(percent "$(sub "$on" "$off")" "$seconds") %) |"
}

case ${1:-} in
    live) shift; live "$@" ;;
    bench) shift; bench "$@" ;;
    extension) shift; extension "$@" ;;
    *) sed -n '4,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
