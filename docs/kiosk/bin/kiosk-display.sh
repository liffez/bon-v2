#!/usr/bin/env bash
# kiosk-display.sh on|off|sleep|blank|unblank|idle-off|wake|status
#
# Efter lukketid skal et tryk kunne tænde skærmen. Men iiyama ProLite
# T2752MSC slukker sin berøring i standby — og kommer ikke engang ud af
# standby igen efter ~1 minut (hverken wlopm, wlr-randr eller DDC; kun genstart
# af Pi'en). Derfor går panelet ALDRIG i standby automatisk. Efter lukketid
# lægges en sort skærm over (kiosk-blank.py) med lysstyrken skruet ned over
# DDC/CI (KIOSK_NIGHT_BRIGHTNESS). Et tryk fjerner den og sætter lyset tilbage.
#
#   off       sort skærm + lys ned — timeren kl. OFF_TIME
#   on        fjern sort skærm, lys op, tænd panelet — timeren kl. ON_TIME
#   idle-off  kiosk-idle.sh: sort skærm igen efter idle uden for åbningstid
#   restore   sæt lysstyrken tilbage (kaldes når den sorte skærm lukker)
#   sleep     rigtig standby i hånden. PAS PÅ: iiyama-skærmen kommer ikke
#             tilbage uden genstart af Pi'en.
#   wake      tænd panelet hvis det står i standby (virker kun kort efter)
#
# Grunden til det hele er indbrænding: stillestående dashboard hver aften
# (CLAUDE_KIOSK.md §7.3).
#
# Der findes ikke ét kald der tænder/slukker panelet på tværs af Pi-modeller og
# compositors, så vi prøver dem i rækkefølge og LOGGER hvilken der virkede. Efter første
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
        dim_brightness
        # Trykkede nogen mens vi skruede ned, er vinduet væk igen — lys op.
        blank_running || restore_brightness
        return 0
    fi
    log "sort skærm kunne ikke startes (se $STATE_DIR/blank.log)"
    return 1
}

stop_blank() {
    if blank_running; then
        pkill -f -- "$BLANK_PY"
        log "sort skærm fjernet"
    fi
    restore_brightness
}

# ── Lysstyrke over DDC/CI ───────────────────────────────────────────────────
# VCP 10 er lysstyrke. Den oprindelige værdi gemmes før vi skruer ned, så en
# manuelt valgt lysstyrke på skærmen kommer tilbage — ikke en hardkodet 100.
BRIGHT_FILE="$STATE_DIR/brightness"

ddc() {
    command -v ddcutil >/dev/null || return 1
    ddcutil ${KIOSK_DDC_BUS:+--bus "$KIOSK_DDC_BUS"} "$@"
}

dim_brightness() {
    local night="${KIOSK_NIGHT_BRIGHTNESS:-0}" cur
    [ "$night" = "off" ] && return 0
    command -v ddcutil >/dev/null || return 0
    if [ ! -s "$BRIGHT_FILE" ]; then
        # "VCP 10 C 75 100" → 75
        cur="$(ddc getvcp 10 --brief 2>/dev/null | awk '{print $4}')"
        case "$cur" in ''|*[!0-9]*) log "kunne ikke læse lysstyrken over DDC/CI — lader den være"; return 0 ;; esac
        [ "$cur" -gt "$night" ] || return 0
        echo "$cur" > "$BRIGHT_FILE"
    fi
    ddc setvcp 10 "$night" >/dev/null 2>&1 && log "lysstyrke $night" || log "kunne ikke skrue ned over DDC/CI"
}

restore_brightness() {
    [ -s "$BRIGHT_FILE" ] || return 0
    local v; v="$(cat "$BRIGHT_FILE")"
    if ddc setvcp 10 "$v" >/dev/null 2>&1; then
        rm -f "$BRIGHT_FILE"
        log "lysstyrke $v"
    else
        log "kunne ikke sætte lysstyrken tilbage til $v over DDC/CI"
    fi
}

# Er i dag en af KIOSK_DAYS? Systemd-form: "Mon-Fri", "Mon..Fri" eller
# "Mon,Wed,Fri".
day_matches() {
    local days="${KIOSK_DAYS:-Mon-Fri}" today part a b n na nb hit=0
    today="${KIOSK_NOW_DOW:-$(date +%u)}"       # 1=man … 7=søn
    dow() { case "$1" in Mon) echo 1;; Tue) echo 2;; Wed) echo 3;; Thu) echo 4;; Fri) echo 5;; Sat) echo 6;; Sun) echo 7;; *) echo 0;; esac; }
    for part in $(printf '%s' "$days" | tr ',' ' '); do
        part="${part/../-}"
        a="${part%%-*}"; b="${part##*-}"
        na="$(dow "$a")"; nb="$(dow "$b")"
        [ "$na" -gt 0 ] && [ "$nb" -gt 0 ] || continue
        for n in $(seq "$na" "$nb"); do [ "$n" = "$today" ] && hit=1; done
    done
    [ "$hit" = 1 ]
}

# HH:MM som tal (06:30 → 630), så tider kan sammenlignes.
hm() { local t="${1/:/}"; echo "$((10#$t))"; }
now_hm() { hm "${KIOSK_NOW_HM:-$(date +%H:%M)}"; }

# Åbningstid: KIOSK_DAYS, KIOSK_ON_TIME..KIOSK_OFF_TIME.
in_hours() {
    day_matches || return 1
    local now; now="$(now_hm)"
    [ "$now" -ge "$(hm "${KIOSK_ON_TIME:-06:30}")" ] && [ "$now" -lt "$(hm "${KIOSK_OFF_TIME:-17:30}")" ]
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
        start_blank && exit 0
        # Ingen standby som nødudgang: skærmen kommer ikke tilbage af sig selv.
        log "sort skærm kunne ikke startes — skruer kun lyset ned, panelet bliver tændt"
        dim_brightness
        ;;
    on)
        stop_blank
        apply on
        ;;
    sleep)
        log "ADVARSEL: iiyama-skærmen kommer ikke ud af standby igen uden genstart af Pi'en"
        stop_blank
        apply off
        ;;
    blank)   start_blank ;;
    unblank) stop_blank ;;
    idle-off)
        in_hours && exit 0          # åbningstid: timerne bestemmer, ikke idle
        [ "$(cat "$PANEL_FILE" 2>/dev/null)" = off ] && exit 0
        blank_running && exit 0
        log "ingen berøring efter lukketid"
        start_blank || dim_brightness
        ;;
    restore) restore_brightness ;;
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
        echo "Efter lukketid : sort skærm, tryk fjerner den$(wake_enabled && echo ", sort igen efter ${KIOSK_WAKE_IDLE_MINUTES:-10} min" || echo " (sort igen efter idle er slået fra)")"
        echo "Nat-lys : ${KIOSK_NIGHT_BRIGHTNESS:-0}$( [ -s "$BRIGHT_FILE" ] && echo " (skruet ned, gemt: $(cat "$BRIGHT_FILE"))")"
        echo "Åbent   : $(in_hours && echo "ja (${KIOSK_DAYS:-Mon-Fri} ${KIOSK_ON_TIME:-06:30}–${KIOSK_OFF_TIME:-17:30})" || echo nej)"
        echo "Findes  :"
        for c in wlopm wlr-randr vcgencmd xset swayidle ddcutil; do
            printf '  %-10s %s\n' "$c" "$(command -v "$c" 2>/dev/null || echo 'nej')"
        done
        printf '  %-10s %s\n' "gtk" "$(python3 -c 'import gi; gi.require_version("Gtk","3.0"); from gi.repository import Gtk' 2>/dev/null && echo ja || echo 'nej (python3-gi mangler)')"
        ;;
    *) echo "brug: $(basename "$0") on|off|sleep|blank|unblank|idle-off|wake|restore|status" >&2; exit 2 ;;
esac
