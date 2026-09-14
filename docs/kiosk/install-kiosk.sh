#!/usr/bin/env bash
# install-kiosk.sh — køres PÅ Raspberry Pi'en, som den almindelige bruger.
# Idempotent: kan køres igen efter en rettelse uden at lave rod.
#
# CLAUDE_KIOSK.md §7.3 — enheden gør tre ting og ikke mere:
#   1. Chromium mod Bon ved boot — i split-layout Bon + Whiteboard side om side
#   2. Panel slukkes om aftenen  (KIOSK_OFF_TIME i kiosk.env)
#   3. Panel tændes om morgenen (KIOSK_ON_TIME)
# Watchdog + nødvisning (§4.6) installeres samtidig, men kan slås fra.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/kiosk"
UNITS="$HOME/.config/systemd/user"

WITH_WATCHDOG="${KIOSK_WITH_WATCHDOG:-1}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Kør IKKE som root — kør som den bruger der ejer skrivebordet." >&2; exit 1; }

# ── 1. Afhængigheder ────────────────────────────────────────────────────────
say "Installerer afhængigheder"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends curl wlr-randr >/dev/null
# wlopm er den pæneste måde at slukke panelet (ren DPMS), men er ikke i alle
# Debian-udgaver. Vi prøver, og kiosk-display.sh falder tilbage hvis den mangler.
sudo apt-get install -y --no-install-recommends wlopm >/dev/null 2>&1 || warn "wlopm findes ikke i apt her — kiosk-display.sh bruger wlr-randr i stedet"

command -v chromium-browser >/dev/null || command -v chromium >/dev/null || {
    warn "Chromium mangler — installerer"
    sudo apt-get install -y chromium-browser >/dev/null 2>&1 || sudo apt-get install -y chromium >/dev/null
}

# ── 2. Filer på plads ───────────────────────────────────────────────────────
say "Lægger filer i $DEST"
mkdir -p "$DEST/bin"
install -m 755 "$SRC/bin/kiosk-display.sh"  "$DEST/bin/"
install -m 755 "$SRC/bin/kiosk-chromium.sh" "$DEST/bin/"
install -m 755 "$SRC/bin/kiosk-watchdog.sh" "$DEST/bin/"
install -m 644 "$SRC/bin/kiosk_layout.py" "$DEST/bin/"
install -m 755 "$SRC/bin/kiosk-layout-server.py" "$DEST/bin/"

if [ ! -f "$DEST/kiosk.env" ]; then
    install -m 644 "$SRC/kiosk.env.example" "$DEST/kiosk.env"
    say "Oprettede $DEST/kiosk.env — ret device-id og URL dér, ikke i scripts"
else
    say "Beholder eksisterende $DEST/kiosk.env"
fi
# shellcheck disable=SC1090
. "$DEST/kiosk.env"

# En kiosk.env fra en ældre udgave mangler nye indstillinger. Vi overskriver den
# ikke — den kan indeholde egne rettelser — men vi siger det højt.
EXAMPLE_VERSION="$(sed -n 's/^KIOSK_ENV_VERSION="\([0-9]*\)".*/\1/p' "$SRC/kiosk.env.example")"
if [ "${KIOSK_ENV_VERSION:-1}" != "$EXAMPLE_VERSION" ]; then
    warn "$DEST/kiosk.env er version ${KIOSK_ENV_VERSION:-1}, eksemplet er version $EXAMPLE_VERSION."
    warn "Har du ikke rettet i den selv:  rm $DEST/kiosk.env  og kør installeren igen."
fi

OFF_TIME="${KIOSK_OFF_TIME:-17:30}"
ON_TIME="${KIOSK_ON_TIME:-06:30}"
DAYS="${KIOSK_DAYS:-Mon-Fri}"
LAYOUT="${KIOSK_LAYOUT:-single}"

# Nødsiden er statisk og kan ikke læse kiosk.env (den ligger på file://),
# så konfigurationen bages ind her ved installation.
PROBE_URL="${KIOSK_PROBE_URL:-https://bon.ristetrug.dk/assets/logo.svg}"
sed -e "s|__BON_URL__|${KIOSK_URL}|g" \
    -e "s|__PROBE_URL__|${PROBE_URL}|g" \
    -e "s|__IDLE_SECONDS__|${KIOSK_OFFLINE_IDLE_SECONDS:-120}|g" \
    -e "s|__SLZB_URL__|${KIOSK_SLZB_URL:-}|g" \
    "$SRC/offline.html" > "$DEST/offline.html"
chmod 644 "$DEST/offline.html"
: > "$DEST/current-url"

# ── 3. Autostart ────────────────────────────────────────────────────────────
# Hvilken fil der reelt fyrer, afhænger af compositor og Pi OS-udgave. Vi
# skriver den compositor-specifikke OG XDG-autostart; låsen i kiosk-chromium.sh
# sørger for at kun én instans kører uanset hvor mange der prøver.
say "Sætter autostart op"
COMPOSITOR="${KIOSK_COMPOSITOR:-}"
if [ -z "$COMPOSITOR" ]; then
    if   pgrep -x labwc   >/dev/null 2>&1; then COMPOSITOR=labwc
    elif pgrep -x wayfire >/dev/null 2>&1; then COMPOSITOR=wayfire
    elif pgrep -x Xorg    >/dev/null 2>&1; then COMPOSITOR=x11
    elif command -v labwc >/dev/null 2>&1;  then COMPOSITOR=labwc
    elif command -v wayfire >/dev/null 2>&1; then COMPOSITOR=wayfire
    else COMPOSITOR=x11
    fi
fi
echo "  compositor: $COMPOSITOR (sessionstype: ${XDG_SESSION_TYPE:-ukendt})"

LAUNCH="$DEST/bin/kiosk-chromium.sh"
MARK="# bon-v2 kiosk"

case "$COMPOSITOR" in
  labwc)
    mkdir -p "$HOME/.config/labwc"
    F="$HOME/.config/labwc/autostart"
    touch "$F"; chmod +x "$F"
    grep -qF "$MARK" "$F" || printf '\n%s\n%s &\n' "$MARK" "$LAUNCH" >> "$F"
    echo "  → $F"
    ;;
  wayfire)
    mkdir -p "$HOME/.config"
    F="$HOME/.config/wayfire.ini"
    touch "$F"
    grep -q '^\[autostart\]' "$F" || printf '\n[autostart]\n' >> "$F"
    # awk frem for `sed -i ... a`: den form er GNU-specifik, og så kan grenen
    # ikke efterprøves andre steder end på selve Pi'en.
    if ! grep -q '^bonkiosk *=' "$F"; then
        awk -v line="bonkiosk = $LAUNCH" '
            { print }
            /^\[autostart\]/ && !seen { print line; seen = 1 }
        ' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
    fi
    echo "  → $F  [autostart] bonkiosk"
    ;;
  x11)
    F="$HOME/.config/lxsession/LXDE-pi/autostart"
    mkdir -p "$(dirname "$F")"
    touch "$F"
    grep -qF "$LAUNCH" "$F" || printf '@%s\n' "$LAUNCH" >> "$F"
    echo "  → $F"
    ;;
esac

mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/bon-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Bon kiosk
Exec=$LAUNCH
X-GNOME-Autostart-enabled=true
DESKTOP
echo "  → $HOME/.config/autostart/bon-kiosk.desktop"

# ── 3b. Split-layout: vinduesregler + panel (kun labwc) ─────────────────────
if [ "$COMPOSITOR" = "labwc" ]; then
    LABWC_RC="$HOME/.config/labwc/rc.xml"
    SCREEN_W="${KIOSK_SCREEN_WIDTH:-1920}"
    SCREEN_H="${KIOSK_SCREEN_HEIGHT:-1080}"
    FRACTION="${KIOSK_MAIN_FRACTION:-2/3}"
    FRAC_NUM="${FRACTION%%/*}"; FRAC_DEN="${FRACTION##*/}"
    case "$FRAC_NUM$FRAC_DEN" in (*[!0-9]*|'') FRAC_NUM=2; FRAC_DEN=3; warn "KIOSK_MAIN_FRACTION='$FRACTION' forstås ikke — bruger 2/3";; esac
    [ "$FRAC_DEN" -gt 0 ] || { FRAC_NUM=2; FRAC_DEN=3; }
    MAIN_W=$(( SCREEN_W * FRAC_NUM / FRAC_DEN ))
    SIDE_W=$(( SCREEN_W - MAIN_W ))

    if [ "$LAYOUT" = "split" ]; then
        say "Vinduesregler: Bon ${MAIN_W}px venstre · Whiteboard ${SIDE_W}px højre"

        # labwc læser KUN den første rc.xml den finder, medmindre den er startet
        # med --merge-config. Uden merge ville en rc.xml med kun vores regler
        # smide Pi OS' egne tastaturgenveje og tema væk — så i det tilfælde
        # kopierer vi systemets fil først og lægger reglerne ind i kopien.
        MERGE=0
        ps -o args= -C labwc 2>/dev/null | grep -Eq -- '(--merge-config|(^| )-m( |$))' && MERGE=1
        echo "  labwc --merge-config: $( [ "$MERGE" = 1 ] && echo ja || echo nej )"

        mkdir -p "$(dirname "$LABWC_RC")"
        if [ -f "$LABWC_RC" ]; then
            [ -f "$LABWC_RC.bak-kiosk" ] || cp "$LABWC_RC" "$LABWC_RC.bak-kiosk"
        else
            SYS_RC=""
            for c in /etc/xdg/labwc/rc.xml /usr/share/labwc/rc.xml; do
                [ -f "$c" ] && { SYS_RC="$c"; break; }
            done
            if [ "$MERGE" = 0 ] && [ -n "$SYS_RC" ]; then
                cp "$SYS_RC" "$LABWC_RC"
                echo "  kopierede $SYS_RC som udgangspunkt"
            else
                printf '<?xml version="1.0"?>\n<labwc_config>\n</labwc_config>\n' > "$LABWC_RC"
            fi
        fi

        # Reglerne skrives af kiosk_layout.py — samme kode som byt-knappen
        # bruger, så de to aldrig er uenige om hvor et vindue står. Den læser
        # kiosk.env fra miljøet og husker hvilken app der har den store del.
        ( set -a; . "$DEST/kiosk.env"; set +a
          python3 "$DEST/bin/kiosk_layout.py" rules "$LABWC_RC" ) \
            || warn "Kunne ikke skrive vinduesregler i $LABWC_RC — vinduerne placeres ikke side om side"

        # Få labwc til at læse filen igen. Gælder nye vinduer — de eksisterende
        # får reglerne ved næste genstart.
        pkill -HUP -x labwc 2>/dev/null || true
    fi

    # Pi OS' panel kan ikke auto-skjule sig under labwc. Den eneste vej er at
    # lade være med at starte det. Linjen står i systemets autostart, så vi
    # kommenterer den ud der — med backup, og kun den ene linje.
    SYS_AUTOSTART="/etc/xdg/labwc/autostart"
    if [ "${KIOSK_HIDE_PANEL:-0}" = "1" ] && [ -f "$SYS_AUTOSTART" ]; then
        if grep -Eq '^[[:space:]]*[^#].*wf-panel-pi' "$SYS_AUTOSTART"; then
            say "Skjuler panelet (wf-panel-pi) i $SYS_AUTOSTART"
            [ -f "$SYS_AUTOSTART.bak-kiosk" ] || sudo cp "$SYS_AUTOSTART" "$SYS_AUTOSTART.bak-kiosk"
            sudo sed -i -E 's|^([[:space:]]*[^#].*wf-panel-pi.*)$|# bon-v2 kiosk: # \1|' "$SYS_AUTOSTART"
            echo "  gendan med:  sudo cp $SYS_AUTOSTART.bak-kiosk $SYS_AUTOSTART"
        else
            echo "  panelet er allerede slået fra (eller hedder noget andet her)"
        fi
    fi
fi

# ── 4. Panel-tider som brugertimere ─────────────────────────────────────────
# Bruger- og ikke systemtimere, fordi kommandoen skal tale med compositoren i
# den grafiske session. En root-cron har hverken WAYLAND_DISPLAY eller
# XDG_RUNTIME_DIR og fejler tavst. kiosk-chromium.sh kalder
# `systemctl --user import-environment`, så timerne arver miljøet.
say "Opretter timere ($DAYS — sluk $OFF_TIME, tænd $ON_TIME)"
mkdir -p "$UNITS"

for mode in off on; do
    if [ "$mode" = off ]; then
        when="$OFF_TIME"; label="slukker"
    else
        when="$ON_TIME";  label="tænder"
    fi
    cat > "$UNITS/kiosk-display-$mode.service" <<UNIT
[Unit]
Description=Kiosk: $label panelet

[Service]
Type=oneshot
ExecStart=$DEST/bin/kiosk-display.sh $mode
UNIT
    cat > "$UNITS/kiosk-display-$mode.timer" <<UNIT
[Unit]
Description=Kiosk: $label panelet $DAYS kl. $when

[Timer]
OnCalendar=$DAYS *-*-* $when:00
Persistent=false

[Install]
WantedBy=timers.target
UNIT
done

if [ "$WITH_WATCHDOG" = "1" ]; then
    cat > "$UNITS/kiosk-watchdog.service" <<UNIT
[Unit]
Description=Kiosk: nødvisning når Bon ikke kan nås

[Service]
ExecStart=$DEST/bin/kiosk-watchdog.sh
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
UNIT
fi

# Byt-knappen: en lille server på 127.0.0.1 der bytter Bon og Whiteboard.
# Knapperne i appsene vises kun når den svarer — altså kun på denne skærm.
if [ "$LAYOUT" = "split" ]; then
    cat > "$UNITS/kiosk-layout.service" <<UNIT
[Unit]
Description=Kiosk: byt Bon og Whiteboard (kun 127.0.0.1)

[Service]
ExecStart=/bin/bash -c 'set -a; . $DEST/kiosk.env; set +a; exec python3 $DEST/bin/kiosk-layout-server.py'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
fi

# Chromium-politik for kiosken:
#  - TranslateEnabled=false: "Oversæt denne side?" dukkede op på hver dansk side.
#    Et --disable-features-flag virker ikke, fordi Pi'ens wrapper sender sit eget.
#  - LocalNetworkAccessAllowedForUrls: nyere Chromium spørger om lov før en
#    hjemmeside må kalde 127.0.0.1. Der står ingen ved skærmen til at svare ja,
#    så Bon og Whiteboard får lov på forhånd — kun til at nå byt-knappens server.
POLICY_DIR=/etc/chromium/policies/managed
MAIN_ORIGIN="$(printf '%s' "$KIOSK_URL" | sed -E 's#^([A-Za-z]+://[^/?\#]+).*#\1#')"
SIDE_ORIGIN="$(printf '%s' "${KIOSK_SIDE_URL:-}" | sed -E 's#^([A-Za-z]+://[^/?\#]+).*#\1#')"
say "Chromium-politik i $POLICY_DIR"
sudo mkdir -p "$POLICY_DIR"
printf '{\n  "TranslateEnabled": false,\n  "LocalNetworkAccessAllowedForUrls": ["%s"%s]\n}\n' \
    "$MAIN_ORIGIN" "$( [ -n "$SIDE_ORIGIN" ] && printf ', "%s"' "$SIDE_ORIGIN" )" \
    | sudo tee "$POLICY_DIR/bon-kiosk.json" >/dev/null
cat "$POLICY_DIR/bon-kiosk.json" | sed 's/^/  /'

# Uden linger stoppes brugerens systemd når ingen er logget ind, og timerne dør.
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "kunne ikke sætte linger — timere kan dø når du logger ud af SSH"

systemctl --user daemon-reload
systemctl --user enable --now kiosk-display-off.timer kiosk-display-on.timer >/dev/null
if [ "$WITH_WATCHDOG" = "1" ]; then
    systemctl --user enable --now kiosk-watchdog.service >/dev/null
fi
if [ "$LAYOUT" = "split" ]; then
    systemctl --user enable kiosk-layout.service >/dev/null
    systemctl --user restart kiosk-layout.service
fi

# ── 5. Kvittering ───────────────────────────────────────────────────────────
say "Færdig"
cat <<SUMMARY

  Layout       $LAYOUT$( [ "$LAYOUT" = split ] && echo " · Whiteboard: ${KIOSK_SIDE_URL:-}" )
  URL          $KIOSK_URL
  Device-id    $KIOSK_DEVICE_ID
  Panel        slukker $OFF_TIME · tænder $ON_TIME · $DAYS
  Watchdog     $( [ "$WITH_WATCHDOG" = 1 ] && echo "aktiv" || echo "slået fra" )

Næste skridt

  1. Slå skærmslukning fra i selve OS'et — ellers slukker det panelet efter
     10 minutter, uafhængigt af timerne ovenfor:
         sudo raspi-config  →  Display Options  →  Screen Blanking  →  No

  2. Efterprøv at panelet kan slukkes NU, i stedet for at opdage kl. $OFF_TIME
     at det ikke kunne:
         ~/kiosk/bin/kiosk-display.sh status
         ~/kiosk/bin/kiosk-display.sh off && sleep 5 && ~/kiosk/bin/kiosk-display.sh on

  3. Genstart og se at Chromium selv kommer op:
         sudo reboot

  4. Log ind på skærmen med køkken-PIN én gang. kitchen-rollen har allerede
     365 dages session (settings-nøgle session_days_kitchen), så det er
     én gang om året — ikke hver morgen.

  Timere:   systemctl --user list-timers 'kiosk-*'
  Watchdog: journalctl --user -u kiosk-watchdog -f
  Byt-knap: journalctl --user -u kiosk-layout -f   (stor del: cat ~/.config/bon-kiosk/primary)

SUMMARY
