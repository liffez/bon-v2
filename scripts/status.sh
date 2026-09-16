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
#
# TRE bunker, ikke to. Den tredje kom til 16. september 2026, fordi den manglede:
# main blev skrevet om 28. august 2026 (ny rod-commit), så enhver branch fra før
# dén dato deler ingen fælles ancestor med main. `git merge-base` fejler, og der er
# så INTET at sammenligne branchens ændringer imod. Før faldt de tavst ned i
# "har ændringer der IKKE er i main" — hvilket læses som "her ligger ufærdigt
# arbejde". Fire af de tolv branches det ramte havde en MERGET PR. På et script
# hvis eneste opgave er at sige hvad der trygt kan slettes, er et forkert svar
# værre end intet svar, så de har nu deres egen bunke: "kan ikke afgøres".
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch origin --quiet 2>/dev/null || true

branch=$(git rev-parse --abbrev-ref HEAD)
commit=$(git rev-parse --short HEAD)
subject=$(git log -1 --pretty=%s)
behind=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo "?")
mainroot=$(git rev-list --max-parents=0 origin/main 2>/dev/null | head -1)
mainrootdate=$(git log -1 --format=%cs "$mainroot" 2>/dev/null || echo "?")

echo "─────────────────────────────────────────────"
echo " Server-branch   : $branch"
echo " Deployet commit : $commit — $subject"
echo " Bagud for main  : $behind commit(s)"
[ "$branch" != "main" ] && echo "   ⚠  Serveren står IKKE på main (tester sandsynligvis en branch)"
echo " main's historik : starter $mainrootdate"
echo "─────────────────────────────────────────────"

# Branches der ALDRIG er oprydningskandidater.
#   main  — giver sig selv.
#   HEAD  — refs/remotes/origin/HEAD er en SYMBOLSK ref der peger på main. Den er
#           ikke en branch man kan slette, og %(refname:short) forkorter den til
#           bare "origin", så den sneg sig ind i listen som en falsk kandidat med
#           et navn der lignede en fejl. Derfor loopes der over den FULDE refname
#           nedenfor — så hedder den "HEAD" og kan filtreres pålideligt.
PROTECTED="main HEAD"

mergedlist=""; activelist=""; unknownlist=""
# refs/remotes/origin — IKKE .../claude. Scannede den kun claude/*, var alt andet
# usynligt: hverken "kan slettes" eller "tjek først". To fuldt mergede docs/-branches
# lå og samlede støv uden at scriptet nævnte dem med ét ord.
for full in $(git for-each-ref --format='%(refname)' refs/remotes/origin 2>/dev/null); do
  b=${full#refs/remotes/origin/}
  skip=""
  for p in $PROTECTED; do [ "$b" = "$p" ] && skip=1; done
  [ -n "$skip" ] && continue
  ref="origin/$b"
  # Ingen fælles ancestor ⇒ intet at måle imod. Det er IKKE det samme som
  # "har uintegreret arbejde" — se noten øverst.
  mb=$(git merge-base origin/main "$ref" 2>/dev/null)   || { unknownlist="$unknownlist $b"; continue; }
  tree=$(git rev-parse "$ref^{tree}" 2>/dev/null)        || { unknownlist="$unknownlist $b"; continue; }
  synth=$(git commit-tree "$tree" -p "$mb" -m _ 2>/dev/null) || { unknownlist="$unknownlist $b"; continue; }
  if git cherry origin/main "$synth" 2>/dev/null | grep -q '^-'; then
    mergedlist="$mergedlist $b"
  else
    activelist="$activelist $b"
  fi
done

echo " ⚠  Har ændringer der IKKE er i main (tjek FØR sletning):"
if [ -n "${activelist// /}" ]; then for b in $activelist; do echo "   $b"; done; else echo "   (ingen)"; fi
echo "─────────────────────────────────────────────"
echo " ❓ Kan ikke afgøres — deler ingen historik med main:"
if [ -n "${unknownlist// /}" ]; then
  echo "   main's historik blev skrevet om ($mainrootdate). Disse branches er ældre,"
  echo "   så der er ingen fælles ancestor at måle deres ændringer imod. Sig ikke at"
  echo "   de har uintegreret arbejde — det ved vi ikke. Afgør hver enkelt på dens PR"
  echo "   (merget ⇒ kan slettes) eller ved at sammenligne indholdet med main."
  echo
  for b in $unknownlist; do
    printf '   %-52s %s\n' "$b" "$(git log -1 --format='%cs  %s' "origin/$b" 2>/dev/null | cut -c1-60)"
  done
else
  echo "   (ingen)"
fi
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
