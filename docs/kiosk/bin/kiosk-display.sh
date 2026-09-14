#!/usr/bin/env bash
# kiosk-display.sh on|off|status
#
# Slukker og tænder panelet (CLAUDE_KIOSK.md §7.3, punkt 2 og 3).
# Eneste grund er indbrænding: ni timers stillestående dashboard hver aften.
#
# Der findes ikke ét kald der virker på tværs af Pi-modeller og compositors,
# så vi prøver dem i rækkefølge og LOGGER hvilken der virkede. Efter første
# kørsel ved du hvad din maskine bruger — læs `kiosk-display.sh status`.
#
# Rækkefølgen er valgt efter hvor lidt de forstyrrer:
#   1. wlopm       — ren DPMS. Outputtet forbliver konfigureret, kun panelet
#                    slukkes. Chromium mærker ingenting.
#   2. wlr-randr   — deaktiverer outputtet. Virker, men compositoren kan
#                    reflowe vinduet, så Chromium omtegner ved opvågning.
#   3. vcgencmd    — firmware-vejen. Findes ikke på alle modeller.
#   4. xset dpms   — kun hvis nogen kører X11.
set -uo pipefail

STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/kiosk"
STATE_FILE="$STATE_DIR/display-method"
mkdir -p "$STATE_DIR"

ENV_FILE="${KIOSK_ENV_FILE:-$HOME/kiosk/kiosk.env}"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
OUTPUT="${KIOSK_OUTPUT:-}"

log() { echo "[kiosk-display] $*"; }

# En SSH-session har hverken XDG_RUNTIME_DIR eller WAYLAND_DISPLAY, så et
# manuelt `kiosk-display.sh off` ville fejle selvom alt er sat rigtigt op —
# og man ville tro det var maskinen. Vi finder skrivebordets socket selv.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    for sock in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
        case "$sock" in *.lock) continue ;; esac
        [ -S "$sock" ] || continue
        export WAYLAND_DISPLAY="$(basename "$sock")"
        break
    done
fi

# Første output wlr-randr rapporterer, hvis intet er valgt i kiosk.env.
detect_output() {
    [ -n "$OUTPUT" ] && { echo "$OUTPUT"; return; }
    command -v wlr-randr >/dev/null || return 1
    wlr-randr 2>/dev/null | awk '/^[^ ]/ { print $1; exit }'
}

try_wlopm() {
    command -v wlopm >/dev/null || return 1
    if [ "$1" = "off" ]; then wlopm --off '*'; else wlopm --on '*'; fi
}

try_wlr_randr() {
    command -v wlr-randr >/dev/null || return 1
    local out; out="$(detect_output)" || return 1
    [ -n "$out" ] || return 1
    if [ "$1" = "off" ]; then
        wlr-randr --output "$out" --off
    else
        wlr-randr --output "$out" --on
    fi
}

try_vcgencmd() {
    command -v vcgencmd >/dev/null || return 1
    if [ "$1" = "off" ]; then vcgencmd display_power 0; else vcgencmd display_power 1; fi
}

try_xset() {
    command -v xset >/dev/null || return 1
    [ -n "${DISPLAY:-}" ] || return 1
    if [ "$1" = "off" ]; then xset dpms force off; else xset dpms force on; fi
}

apply() {
    local action="$1" m
    # Har vi allerede fundet en metode der virker, bruger vi kun den — så et
    # halvvirkende fallback ikke pludselig overtager en aften.
    if [ -r "$STATE_FILE" ]; then
        m="$(cat "$STATE_FILE")"
        if "try_$m" "$action" >/dev/null 2>&1; then
            log "$action via $m"
            return 0
        fi
        log "gemt metode '$m' fejlede — prøver forfra"
    fi
    for m in wlopm wlr_randr vcgencmd xset; do
        if "try_$m" "$action" >/dev/null 2>&1; then
            echo "$m" > "$STATE_FILE"
            log "$action via $m"
            return 0
        fi
    done
    log "INGEN metode virkede ($action). Kør 'kiosk-display.sh status'."
    return 1
}

case "${1:-}" in
    off) apply off ;;
    on)  apply on ;;
    status)
        echo "Session : ${XDG_SESSION_TYPE:-ukendt}"
        echo "Wayland : ${WAYLAND_DISPLAY:-<ikke sat>}"
        echo "Runtime : ${XDG_RUNTIME_DIR:-<ikke sat>}"
        echo "Output  : $(detect_output 2>/dev/null || echo '<ukendt>')"
        echo "Metode  : $( [ -r "$STATE_FILE" ] && cat "$STATE_FILE" || echo '<endnu ikke fundet>' )"
        echo "Findes  :"
        for c in wlopm wlr-randr vcgencmd xset; do
            printf '  %-10s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo 'nej')"
        done
        ;;
    *) echo "brug: $(basename "$0") on|off|status" >&2; exit 2 ;;
esac
