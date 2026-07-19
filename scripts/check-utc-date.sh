#!/usr/bin/env bash
# scripts/check-utc-date.sh
# ==========================================
# Pre-commit-hook: blokér nye UTC-datoer brugt som "i dag".
#
# `new Date().toISOString().slice(0,10)` giver UTC-datoen. Mellem midnat og
# kl. 02 dansk sommertid peger den stadig på I GÅR. Kode der bruger den som
# "i dag" viser derfor den forkerte dag — men KUN om natten, så fejlen
# opdages typisk kun ved et tilfælde af en der arbejder sent.
#
# Den har ramt os flere gange: bon-listens "I DAG"-filter, køkkenets
# dato-overskrift, optællingens session-nøgle (#331) og T_KITCHEN_TODAY (#335).
#
# Brug i stedet:
#   Backend (Node):   const { todayISO, offsetISO } = require('../db/helpers');
#   Frontend:         todayISO()  /  offsetISO(n)  /  dateToISO(d)   [shared/utils.js]
#
# Begge er forankret i Europe/Copenhagen, så de er enige — og en maskine med
# forkert tidszone giver stadig den rigtige danske dato.
#
# Mønsteret er bevidst SMALT: kun `new Date()` UDEN argumenter, altså "nu".
# `new Date(eksisterendeVærdi).toISOString()` er ofte legitimt (formattering
# af en dato der allerede findes) og blokeres ikke. Bruger du det på et
# klokkeslæt, så overvej dateToISO() — ellers hopper sen-aftens-timestamps
# en dag tilbage.
#
# Aktivér som git hook (sammen med moms-hooken):
#   chmod +x scripts/check-utc-date.sh
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
#
# Hvis du har en LEGITIM grund (fx en versions-streng eller et filnavn hvor
# UTC er fint), så skriv en kort begrundelse på linjen:
#   const version = new Date().toISOString().slice(0, 10);  // utc-ok: versionsstempel
# ==========================================

set -e

# Kun produktionskode. tests/ har ~37 forekomster endnu (se #133) og ville
# spærre enhver ændring i dem — de konverteres i deres egen omgang.
staged=$(git diff --cached --name-only --diff-filter=ACM \
    -- '*.js' '*.html' \
    | grep -vE '^(tests/|scripts/|node_modules/|\.claude/|db/helpers\.js|shared/utils\.js)' \
    || true)

if [ -z "$staged" ]; then
    exit 0
fi

# `new Date()` uden argumenter → .toISOString() → dato-udtræk.
# Linjer med "utc-ok" i en kommentar slipper igennem.
forbidden=$(echo "$staged" | xargs -r grep -nE \
    "new Date\(\)\.toISOString\(\)\.(slice\(0, ?10\)|split\('T'\)\[0\])" \
    2>/dev/null \
    | grep -v 'utc-ok' \
    || true)

if [ -n "$forbidden" ]; then
    echo "❌ FEJL: UTC-dato brugt som \"i dag\""
    echo ""
    echo "$forbidden"
    echo ""
    echo "Mellem midnat og kl. 02 dansk tid giver toISOString() GÅRSDAGENS dato."
    echo "Fejlen viser sig kun om natten — derfor opdages den næsten aldrig."
    echo ""
    echo "  Backend:   const { todayISO, offsetISO } = require('../db/helpers');"
    echo "  Frontend:  todayISO()      // dansk kalenderdato i dag"
    echo "             offsetISO(-1)   // i går"
    echo "             dateToISO(d)    // et Date-objekt → dansk kalenderdato"
    echo ""
    echo "Er UTC bevidst og korrekt her (versionsstempel, filnavn, ekstern"
    echo "API-kontrakt), så skriv en begrundelse på linjen:"
    echo "  ... // utc-ok: <hvorfor>"
    echo ""
    echo "Se #133 og memory project_utc_today_bug."
    exit 1
fi

exit 0
