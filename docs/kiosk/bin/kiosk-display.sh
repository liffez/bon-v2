#!/usr/bin/env bash
# kiosk-display.sh on|off|sleep|blank|unblank|idle-off|wake|status
#
# Efter lukketid skal et tryk kunne tænde skærmen. Men iiyama-skærmen slukker
# sin berøring når panelet går i standby, så "off" lægger i stedet en sort
# skærm over (kiosk-blank.py), der forsvinder ved berøring. Et sort billede
# brænder ikke ind. Er vækning slået fra (KIOSK_WAKE_IDLE_MINUTES=0), eller
# kan den sorte skærm ikke startes, slukkes panelet rigtigt som før.
#
#   off       sort skærm (eller rigtig sluk, se ovenfor) — timeren kl. OFF_TIME
#   on        fjern sort skærm + tænd panelet — timeren kl. ON_TIME
#   sleep     sluk panelet rigtigt (standby). Berøring vækker det IKKE.
#   idle-off  kiosk-idle.sh: sort skærm efter idle, men kun uden for åbningstid
#   wake      kiosk-idle.sh: tænd panelet hvis det er i standby (fx tastatur)
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

STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/kiosk"
STATE_FILE="$STATE_DIR/display-method"
PANEL_FILE="$STATE_DIR/panel"
mkdir -p "$STATE_DIR"
BIN_DIR="$(dirname "$(readlink -f "$0")")"
BLANK_PY="$BIN_DIR/kiosk-blank.py"

blank_running() { pgrep -f -- "$BLANK_PY" >/dev/null 2>&1; }

wake_enabled() { [ "${KIOSK_WAKE_IDLE_MINUTES:-10}" != "0" ]; }

start_blank() {
    blank_running && return 0
    [ -r "$BLANK_PY" ] || { log "$BLANK_PY mangler"; return 1; }
    # Panelet skal være tændt, ellers er berøringen død.
    apply on >/dev/null
    # setsid: timerens service må ikke tage vinduet med sig når den afslutter.
    setsid python3 "$BLANK_PY" >>"$STATE_DIR/blank.log" 2>&1 </dev/null &
    sleep 2
    if blank_running; then
        echo blank > "$PANEL_FILE"
        log "sort skærm — tryk for at tænde"
        return 0
    fi
    log "sort skærm kunne ikke startes (se $STATE_DIR/blank.log)"
    return 1
}

stop_blank() {
    blank_running || return 0
    pkill -f -- "$BLANK_PY"
    log "sort skærm fjernet"
}

# Er vi inden for åbningstiden? KIOSK_DAYS i systemd-form: "Mon-Fri",
# "Mon..Fri" eller "Mon,Wed,Fri". Klokkeslæt som HH:MM.
in_hours() {
    local days="${KIOSK_DAYS:-Mon-Fri}" on="${KIOSK_ON_TIME:-06:30}" off="${KIOSK_OFF_TIME:-17:30}"
    local today now part a b n na nb hit=0
    today="${KIOSK_NOW_DOW:-$(date +%u)}"       # 1=man … 7=søn
    now="${KIOSK_NOW_HM:-$(date +%H:%M)}"
    dow() { case "$1" in Mon) echo 1;; Tue) echo 2;; Wed) echo 3;; Thu) echo 4;; Fri) echo 5;; Sat) echo 6;; Sun) echo 7;; *) echo 0;; esac; }
    for part in $(printf '%s' "$days" | tr ',' ' '); do
        part="${part/../-}"
        a="${part%%-*}"; b="${part##*-}"
        na="$(dow "$a")"; nb="$(dow "$b")"
        [ "$na" -gt 0 ] && [ "$nb" -gt 0 ] || continue
        for n in $(seq "$na" "$nb"); do [ "$n" = "$today" ] && hit=1; done
    done
    [ "$hit" = 1 ] || return 1
    # HH:MM sammenlignes som tal (0630 < 1730).
    [ "$((10#${now/:/}))" -ge "$((10#${on/:/}))" ] && [ "$((10#${now/:/}))" -lt "$((10#${off/:/}))" ]
}

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
            echo "$action" > "$PANEL_FILE"
            log "$action via $m"
            return 0
        fi
        log "gemt metode '$m' fejlede — prøver forfra"
    fi
    for m in wlopm wlr_randr vcgencmd xset; do
        if "try_$m" "$action" >/dev/null 2>&1; then
            echo "$m" > "$STATE_FILE"
            echo "$action" > "$PANEL_FILE"
            log "$action via $m"
            return 0
        fi
    done
    log "INGEN metode virkede ($action). Kør 'kiosk-display.sh status'."
    return 1
}

case "${1:-}" in
    off)
        if wake_enabled && start_blank; then
            exit 0
        fi
        wake_enabled && log "falder tilbage til rigtig sluk — berøring vækker ikke"
        apply off
        ;;
    on)
        stop_blank
        apply on
        ;;
    sleep)
        stop_blank
        apply off
        ;;
    blank)   start_blank ;;
    unblank) stop_blank ;;
    idle-off)
        in_hours && exit 0          # åbningstid: timerne bestemmer, ikke idle
        blank_running && exit 0
        [ "$(cat "$PANEL_FILE" 2>/dev/null)" = off ] && exit 0
        log "ingen berøring efter lukketid"
        start_blank || apply off
        ;;
    wake)
        # Kaldes ved aktivitet. Kun hvis panelet står i rigtig standby.
        [ "$(cat "$PANEL_FILE" 2>/dev/null)" = off ] || exit 0
        log "aktivitet — tænder"
        apply on
        ;;
    status)
        echo "Session : ${XDG_SESSION_TYPE:-ukendt}"
        echo "Wayland : ${WAYLAND_DISPLAY:-<ikke sat>}"
        echo "Runtime : ${XDG_RUNTIME_DIR:-<ikke sat>}"
        echo "Output  : $(detect_output 2>/dev/null || echo '<ukendt>')"
        echo "Metode  : $( [ -r "$STATE_FILE" ] && cat "$STATE_FILE" || echo '<endnu ikke fundet>' )"
        echo "Panel   : $(cat "$PANEL_FILE" 2>/dev/null || echo '<ukendt>')$(blank_running && echo ' (sort skærm vises)')"
        echo "Vækning : $(wake_enabled && echo "ja — sort skærm efter lukketid, sort igen efter ${KIOSK_WAKE_IDLE_MINUTES:-10} min" || echo 'slået fra — panelet slukkes rigtigt')"
        echo "Åbent   : $(in_hours && echo "ja (${KIOSK_DAYS:-Mon-Fri} ${KIOSK_ON_TIME:-06:30}–${KIOSK_OFF_TIME:-17:30})" || echo nej)"
        echo "Findes  :"
        for c in wlopm wlr-randr vcgencmd xset swayidle; do
            printf '  %-10s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo 'nej')"
        done
        printf '  %-10s %s\n' "gtk" "$(python3 -c 'import gi; gi.require_version("Gtk","3.0"); from gi.repository import Gtk' 2>/dev/null && echo ja || echo 'nej (python3-gi mangler)')"
        ;;
    *) echo "brug: $(basename "$0") on|off|sleep|blank|unblank|idle-off|wake|status" >&2; exit 2 ;;
esac
