#!/usr/bin/env bash
# status.sh — overblik over hvad der kører, og hvad der kan ryddes op. KUN læsning.
#
#   cd ~/bon-v2 && ./scripts/status.sh
#
# Ren git — ingen gh, intet at installere, intet netværk udover et stille fetch.
# Opdager OGSÅ squash-mergede branches: i stedet for `git branch --merged` (som ikke
# kan se squash) tjekker den om branchens egne ændringer allerede ligger i main.
#
# Dækker ALLE remote-branches (claude/*, docs/*, hvad som helst) på nær main.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch origin --quiet 2>/dev/null || true

branch=$(git rev-parse --abbrev-ref HEAD)
commit=$(git rev-parse --short HEAD)
subject=$(git log -1 --pretty=%s)
behind=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo "?")

echo "─────────────────────────────────────────────"
echo " Server-branch   : $branch"
echo " Deployet commit : $commit — $subject"
echo " Bagud for main  : $behind commit(s)"
[ "$branch" != "main" ] && echo "   ⚠  Serveren står IKKE på main (tester sandsynligvis en branch)"
echo "─────────────────────────────────────────────"

# Branches der ALDRIG er oprydningskandidater.
#   main  — giver sig selv.
#   HEAD  — refs/remotes/origin/HEAD er en SYMBOLSK ref der peger på main. Den er
#           ikke en branch man kan slette, og %(refname:short) forkorter den til
#           bare "origin", så den sneg sig ind i listen som en falsk kandidat med
#           et navn der lignede en fejl. Derfor loopes der over den FULDE refname
#           nedenfor — så hedder den "HEAD" og kan filtreres pålideligt.
PROTECTED="main HEAD"

mergedlist=""; activelist=""
# refs/remotes/origin — IKKE .../claude. Scannede den kun claude/*, var alt andet
# usynligt: hverken "kan slettes" eller "tjek først". To fuldt mergede docs/-branches
# lå og samlede støv uden at scriptet nævnte dem med ét ord.
for full in $(git for-each-ref --format='%(refname)' refs/remotes/origin 2>/dev/null); do
  b=${full#refs/remotes/origin/}
  skip=""
  for p in $PROTECTED; do [ "$b" = "$p" ] && skip=1; done
  [ -n "$skip" ] && continue
  ref="origin/$b"
  mb=$(git merge-base origin/main "$ref" 2>/dev/null)   || { activelist="$activelist $b"; continue; }
  tree=$(git rev-parse "$ref^{tree}" 2>/dev/null)        || { activelist="$activelist $b"; continue; }
  synth=$(git commit-tree "$tree" -p "$mb" -m _ 2>/dev/null)
  if git cherry origin/main "$synth" 2>/dev/null | grep -q '^-'; then
    mergedlist="$mergedlist $b"
  else
    activelist="$activelist $b"
  fi
done

echo " ⚠  Har ændringer der IKKE er i main (tjek FØR sletning):"
if [ -n "${activelist// /}" ]; then for b in $activelist; do echo "   $b"; done; else echo "   (ingen)"; fi
echo "─────────────────────────────────────────────"
echo " 🗑  Indhold er i main — kan trygt slettes:"
if [ -n "${mergedlist// /}" ]; then
  for b in $mergedlist; do echo "   $b"; done
  echo
  echo "   Slet ALLE på én gang (kopier-klar):"
  for b in $mergedlist; do echo "     git push origin --delete $b"; done
else
  echo "   (ingen)"
fi
echo "─────────────────────────────────────────────"
