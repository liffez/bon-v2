#!/usr/bin/env bash
# kiosk-watchdog.sh — CLAUDE_KIOSK.md §4.6, nødvisning.
#
# Kiosken viser Bon, som kører på Hetzner. Ryger forbindelsen, viser skærmen
# ingenting — og det er præcis dér nogen har brug for at se temperaturerne.
#
# Den kritiske detalje fra specen: nødvisningen må IKKE hentes fra det der er
# nede. Derfor ligger nødsiden lokalt på Pi'en, og denne watchdog kører som en
# systemd-service uafhængigt af browseren.
#
# Vejen TILBAGE ligger bevidst ikke her. Nødsiden poller selv Bon og navigerer
# først når den har stået urørt — §4.4's regel om ingen hårde skift. En
# watchdog kan ikke se berøringer; siden kan.
set -uo pipefail

ENV_FILE="${KIOSK_ENV_FILE:-$HOME/kiosk/kiosk.env}"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

HEALTH_URL="${KIOSK_HEALTH_URL:-https://bon.ristetrug.dk/login.html}"
TARGET_FILE="$HOME/kiosk/current-url"
OFFLINE_PAGE="file://$HOME/kiosk/offline.html"

INTERVAL="${KIOSK_WATCHDOG_INTERVAL:-20}"   # sekunder mellem tjek
FAILS_BEFORE_SWITCH="${KIOSK_WATCHDOG_FAILS:-3}"  # ~1 min før vi skifter

fails=0
state="online"

log() { echo "[kiosk-watchdog] $*"; }
log "starter — poller $HEALTH_URL hvert ${INTERVAL}s"

while true; do
    if curl -fsS --max-time 8 -o /dev/null "$HEALTH_URL" 2>/dev/null; then
        if [ "$state" = "offline" ]; then
            log "Bon er nåelig igen — rydder nød-target"
            # Vi dræber IKKE chromium her. Nødsiden ser selv at Bon er tilbage
            # og navigerer efter idle. Ryddes filen, lander en evt. senere
            # genstart på Bon i stedet for på nødsiden.
            : > "$TARGET_FILE"
            state="online"
        fi
        fails=0
    else
        fails=$(( fails + 1 ))
        if [ "$state" = "online" ] && [ "$fails" -ge "$FAILS_BEFORE_SWITCH" ]; then
            log "Bon uden svar $fails gange — skifter til nødvisning"
            echo "$OFFLINE_PAGE" > "$TARGET_FILE"
            # Hårdt skift er forsvarligt her: siden på skærmen er i forvejen død.
            # Kun hoved-vinduet (Bon) — Whiteboard i højre side røres ikke.
            pkill -f -- '--class=bon-kiosk-main' || true
            state="offline"
        fi
    fi
    sleep "$INTERVAL"
done
