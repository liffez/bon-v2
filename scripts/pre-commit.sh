#!/usr/bin/env bash
# scripts/pre-commit.sh
# ==========================================
# Samler alle pre-commit-tjek ét sted.
#
# Før lå moms-hooken direkte som .git/hooks/pre-commit via symlink, så der
# kun kunne være ét tjek. Denne wrapper kører dem alle og fejler hvis bare
# ét gør.
#
# Aktivér:
#   chmod +x scripts/pre-commit.sh scripts/check-*.sh
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
#
# Springe over i en nødsituation (og ryd op bagefter):
#   git commit --no-verify
# ==========================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Moms: ingen magic 1.25 / 0.25 uden for shared/moms.js (BON_V2_PRINCIPPER §6b)
"$DIR/check-moms-magic.sh"

# Datoer: ingen UTC-dato brugt som "i dag" (#133)
"$DIR/check-utc-date.sh"

exit 0
