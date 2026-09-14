#!/usr/bin/env bash
# kiosk-idle.sh — vækker panelet ved berøring efter lukketid.
#
# Timerne slukker panelet kl. KIOSK_OFF_TIME. Skal der laves mad kl. 18 eller
# 21, trykker man på skærmen: panelet tænder, man kan logge ind, og når ingen
# har rørt det i KIOSK_WAKE_IDLE_MINUTES, slukker det igen. Inden for
# åbningstiden gør idle-sluk intet — dér bestemmer timerne.
#
# Startes fra labwc's autostart (swayidle skal tale med compositoren) og
# genstarter sig selv hvis swayidle dør.
#
# To timeouts, fordi swayidle kun kører `resume` for en timeout der faktisk er
# udløst:
#   - kort (15 s): gør intet, men giver et "resume" ved næste berøring → wake.
#     Så vækker et tryk også når timeren slukkede mens nogen stod ved skærmen.
#   - lang (idle-minutter): slukker, men kun uden for åbningstiden.
set -uo pipefail

ENV_FILE="${KIOSK_ENV_FILE:-$HOME/kiosk/kiosk.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

MINUTES="${KIOSK_WAKE_IDLE_MINUTES:-10}"
DISPLAY_SH="$(dirname "$(readlink -f "$0")")/kiosk-display.sh"

log() { echo "[kiosk-idle] $*"; }

if [ "$MINUTES" = "0" ]; then
    log "KIOSK_WAKE_IDLE_MINUTES=0 — vækning ved berøring er slået fra"
    exit 0
fi
if ! command -v swayidle >/dev/null; then
    log "swayidle mangler — kør installeren igen (sudo apt-get install swayidle)"
    exit 1
fi

# Én instans, uanset hvor mange autostart-filer der fyrer.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/kiosk/idle.lock"
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
flock -n 9 || { log "kører allerede"; exit 0; }

while true; do
    log "lytter (sluk efter ${MINUTES} min uden berøring uden for åbningstid)"
    swayidle -w \
        timeout 15 'true' resume "$DISPLAY_SH wake" \
        timeout "$((MINUTES * 60))" "$DISPLAY_SH idle-off"
    log "swayidle stoppede (kode $?) — prøver igen om 10 s"
    sleep 10
done
