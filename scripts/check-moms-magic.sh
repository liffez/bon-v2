#!/usr/bin/env bash
# scripts/check-moms-magic.sh
# ==========================================
# Pre-commit-hook: blokér nye magic moms-konstanter.
#
# Hele Bon v2 bruger shared/moms.js til moms-beregninger. Ingen anden kode
# må have et bart 1.25 / 0.25 / 1,25 / 0,25 — alt går gennem helpers.
#
# Whitelisted (legitime brug):
#   - shared/moms.js          (autoritativ definition)
#   - tests/                  (test-cases må reference værdierne)
#   - scripts/                (dette script m.v.)
#
# Aktivér som git hook:
#   chmod +x scripts/check-moms-magic.sh
#   ln -sf ../../scripts/check-moms-magic.sh .git/hooks/pre-commit
#
# Test at den virker:
#   echo "const x = price * 1.25;" >> /tmp/test_moms.js
#   git add /tmp/test_moms.js  # ← skal blokeres
#
# Hvis du har en LEGITIM grund til en hardcoded 1.25 / 0.25 udenfor
# whitelisten, refaktorér til Moms.MOMS_FACTOR / Moms.MOMS_RATE eller
# omskriv til en ækvivalent form (fx / 4 i stedet for * 0.25).
# ==========================================

set -e

# Find staged JS/HTML/SQL-filer
staged=$(git diff --cached --name-only --diff-filter=ACM \
    -- '*.js' '*.html' '*.sql' \
    | grep -vE '^(shared/moms\.js|tests/|scripts/|node_modules/|\.claude/)' \
    || true)

if [ -z "$staged" ]; then
    exit 0
fi

# Søg efter magic moms-mønstre
forbidden=$(echo "$staged" | xargs -r grep -nE \
    '(\* *1[.,]25|/ *1[.,]25|\* *0[.,]25|0[.,]25 *\*|grand *\* *25 */ *125)' \
    2>/dev/null \
    || true)

if [ -n "$forbidden" ]; then
    echo "❌ FEJL: Magic moms-konstant fundet uden for shared/moms.js og tests/"
    echo ""
    echo "$forbidden"
    echo ""
    echo "Brug helpers fra shared/moms.js i stedet:"
    echo "  Backend (Node):"
    echo "    const { MOMS_FACTOR, inclToExcl, exclToIncl, momsOfIncl, computeMomsFields } = require('../db/helpers');"
    echo ""
    echo "  Frontend (browser):"
    echo "    Moms.inclToExcl(incl)        // = incl / 1.25"
    echo "    Moms.exclToIncl(excl)        // = excl * 1.25"
    echo "    Moms.momsOfIncl(incl)        // = incl - inclToExcl(incl)"
    echo "    Moms.computeMomsFields(incl) // → { total_incl_moms, total_excl_moms, moms_amount }"
    echo "    Moms.applyDiscount(sub, pct) // → { discountIncl, discountExcl, totalIncl }"
    echo ""
    echo "Eller: hvis det IKKE er moms (fx en kvartil-beregning eller alpha-værdi),"
    echo "skriv det på en form der ikke matcher mønsteret (fx '/ 4' i stedet for '* 0.25')."
    echo ""
    echo "Se BON_V2_PRINCIPPER.md sektion 6b+6c."
    exit 1
fi

exit 0
