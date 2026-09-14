#!/usr/bin/env bash
# kiosk-chromium.sh — startes af compositorens autostart ved boot.
# CLAUDE_KIOSK.md §7.3 punkt 1.
#
# To layouts (KIOSK_LAYOUT i kiosk.env):
#   split  — Bon til venstre, Whiteboard til højre. To selvstændige vinduer, som
#            labwc placerer via vinduesregler i ~/.config/labwc/rc.xml.
#   single — ét vindue i fuld skærm (--kiosk).
#
# Hvorfor to vinduer og ikke én side med en iframe: touch virker fuldt i begge,
# og Whiteboard beholder sin egen login og alle sine funktioner. §4.1 fravalgte
# iframen af samme grund.
set -uo pipefail

ENV_FILE="${KIOSK_ENV_FILE:-$HOME/kiosk/kiosk.env}"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

LAYOUT="${KIOSK_LAYOUT:-single}"
MAIN_URL="${1:-${KIOSK_URL:-https://bon.ristetrug.dk/kitchen/today.html?kiosk}}"
SIDE_URL="${KIOSK_SIDE_URL:-}"
# Whiteboard skal vide at den kører på køkkenskærmen, ellers viser den ikke
# byt-knappen. Den husker det selv (localStorage), præcis som Bon gør.
if [ -n "$SIDE_URL" ] && [[ "$SIDE_URL" != *kiosk=* ]]; then
    case "$SIDE_URL" in (*\?*) SIDE_URL="$SIDE_URL&kiosk=${KIOSK_DEVICE_ID:-1}";; (*) SIDE_URL="$SIDE_URL?kiosk=${KIOSK_DEVICE_ID:-1}";; esac
fi

# Watchdogen (§4.6) skriver nødsidens sti hertil når Bon ikke kan nås, og
# rydder filen igen når den kan. Kun HOVED-vinduet (Bon) skifter; vi læser
# filen ved hver start af løkken, så et skift kræver kun at vinduet genstartes.
TARGET_FILE="$HOME/kiosk/current-url"

# Vinduernes identitet. labwc's vinduesregler matcher på den, og watchdogen
# bruger den til at genstarte netop hoved-vinduet. Chromium ignorerer --class
# medmindre vinduet også har sin egen --user-data-dir — derfor en profil pr.
# vindue. Det betyder også at Bon og Whiteboard har hver sin login.
MAIN_CLASS="bon-kiosk-main"
SIDE_CLASS="bon-kiosk-side"
PROFILE_ROOT="$HOME/.config/bon-kiosk"

# Giv den brugerkørende systemd sessionens miljø. UDEN dette kender
# ~/.config/systemd/user-timerne hverken WAYLAND_DISPLAY eller
# XDG_RUNTIME_DIR, og panel-sluk om aftenen fejler tavst.
systemctl --user import-environment \
    WAYLAND_DISPLAY XDG_RUNTIME_DIR DISPLAY XDG_SESSION_TYPE 2>/dev/null || true

# Vi skriver autostart både i compositorens egen fil og som XDG-autostart,
# fordi hvilken af dem der reelt fyrer varierer mellem Pi OS-udgaver. Låsen
# gør det harmløst hvis begge gør: anden instans afslutter straks.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/kiosk-chromium.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
    echo "[kiosk] kører allerede — afslutter"
    exit 0
fi

BIN="$(command -v chromium-browser || command -v chromium || true)"
if [ -z "$BIN" ]; then
    echo "[kiosk] chromium ikke fundet" >&2
    exit 1
fi

COMMON=(
    --noerrdialogs
    --disable-infobars
    --disable-session-crashed-bubble
    --disable-features=TranslateUI,Translate
    --disable-pinch
    --overscroll-history-navigation=0
    --password-store=basic
    --check-for-update-interval=31536000
    --autoplay-policy=no-user-gesture-required
    # En ny profil viser ellers en velkomstside og "gør til standardbrowser"
    # første gang — på en skærm hvor der ingen står til at klikke dem væk.
    --no-first-run
    --no-default-browser-check
    # Pi OS starter Chromium på engelsk, og så tilbyder den at oversætte hver
    # dansk side. --disable-features ovenfor slår ikke igennem, fordi Pi'ens
    # wrapper selv sender et --disable-features, og kun det sidste gælder.
    --lang=da
)

# Efter et strømafbrud åbner Chromium ellers "Gendan sider?" oven på kiosken,
# og der står ingen til at klikke den væk kl. 06:30.
clear_crash_flag() {
    local prefs="$1/Default/Preferences"
    [ -f "$prefs" ] || return 0
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$prefs" || true
}

# Slå "Oversæt denne side?" fra i profilen. Det er en indstilling, ikke et flag,
# så den overlever uanset hvad Pi'ens wrapper sender med.
disable_translate() {
    local prefs="$1/Default/Preferences"
    mkdir -p "$1/Default"
    command -v python3 >/dev/null || return 0
    python3 - "$prefs" <<'PYPREFS' || true
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
try:
    d = json.loads(p.read_text()) if p.exists() else {}
except Exception:
    sys.exit(0)   # halvskrevet fil — rør den ikke
d.setdefault('translate', {})['enabled'] = False
d.setdefault('intl', {})['accept_languages'] = 'da,en'
p.write_text(json.dumps(d))
PYPREFS
}

# Zoom følger PLADSEN, ikke appen. Den store del (1280 px) zoomes 1,4, så
# dashboardet får sit enkolonne-layout (under 960 CSS-pixel) og teksten kan
# læses på afstand. Byt-knappen skriver hvem der har den store del.
MAIN_SCALE="${KIOSK_MAIN_SCALE:-1.4}"
SIDE_SCALE="${KIOSK_SIDE_SCALE:-1}"
PRIMARY_FILE="$HOME/.config/bon-kiosk/primary"
scale_for() {   # scale_for main|side
    local primary; primary="$(cat "$PRIMARY_FILE" 2>/dev/null || echo bon)"
    if [ "$primary" = "whiteboard" ]; then
        [ "$1" = "side" ] && echo "$MAIN_SCALE" || echo "$SIDE_SCALE"
    else
        [ "$1" = "main" ] && echo "$MAIN_SCALE" || echo "$SIDE_SCALE"
    fi
}

# run_window <navn> <class> <standard-url> <tilstand: app|kiosk>
# Chromium dør en sjælden gang. Uden løkken bliver halvdelen af skærmen sort
# resten af dagen.
run_window() {
    local name="$1" class="$2" default_url="$3" mode="$4"
    local profile="$PROFILE_ROOT/$name"
    mkdir -p "$profile"
    while true; do
        local url="$default_url"
        if [ "$name" = "main" ] && [ -s "$TARGET_FILE" ]; then
            url="$(cat "$TARGET_FILE")"
        fi
        clear_crash_flag "$profile"
        disable_translate "$profile"
        local scale; scale="$(scale_for "$name")"
        echo "[kiosk] $name åbner $url (zoom $scale)"
        if [ "$mode" = "kiosk" ]; then
            "$BIN" "${COMMON[@]}" --user-data-dir="$profile" --class="$class" \
                --force-device-scale-factor="$scale" --kiosk --start-fullscreen "$url"
        else
            "$BIN" "${COMMON[@]}" --user-data-dir="$profile" --class="$class" \
                --force-device-scale-factor="$scale" --app="$url"
        fi
        echo "[kiosk] $name afsluttede (kode $?) — genstarter om 5 sek."
        sleep 5
    done
}

if [ "$LAYOUT" = "split" ] && [ -n "$SIDE_URL" ]; then
    run_window side "$SIDE_CLASS" "$SIDE_URL" app &
    run_window main "$MAIN_CLASS" "$MAIN_URL" app &
    wait
else
    [ "$LAYOUT" = "split" ] && echo "[kiosk] split uden KIOSK_SIDE_URL — kører ét vindue"
    run_window main "$MAIN_CLASS" "$MAIN_URL" kiosk
fi
