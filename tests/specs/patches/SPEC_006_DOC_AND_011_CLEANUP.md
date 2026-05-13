# SPEC_006_DOC_AND_011_CLEANUP.md

> To små opgaver samlet:
>
> 1. **#006** — Dokumentér i `BON_V2_PRINCIPPER.md` at terminal-statusser
>    ikke kan annulleres ("by design")
> 2. **#011** — Slet 4 døde filer i `shared/` (`bestilling.js/.css` +
>    `shopping_list.js/.css`)

---

## Del 1 — #006: Dokumentationsændring

### Hvor

`BON_V2_PRINCIPPER.md`, sektion om status-flow eller en relevant
underafsnit. Hvis ikke findes, opret nyt afsnit "Terminal-statusser".

### Tekst at tilføje

```markdown
## Terminal-statusser kan ikke annulleres via UI

Statusser `FAKTURERET`, `BETALT` og `AFSLUTTET` er **terminale** —
de kan ikke skiftes til `AFLYST` via status-PATCH-endpointet.

### Hvorfor

Kreditnotaer hører til regnskabsdomænet, ikke status-flowet. En faktureret
ordre annulleres ved at oprette en kreditnota i e-conomic, ikke ved at
sætte bonens status til AFLYST. Hvis status kunne hoppes tilbage, ville
historikken være uklar:

- "Var den her faktureret eller ej?"
- "Skal den med i ÅR-månedsregnskab?"
- "Skal momsen tilbage?"

### Hvis det alligevel skal gøres

I ekstraordinære tilfælde (fx datafejl der skal rettes) kan admin bruge
direkte SQL-UPDATE eller force-mode (`{force: true, user_id: <admin>}`) på
PATCH-endpointet. Begge logger automatisk i changelog.

### Implementering

`status_transitions`-tabellen indeholder ingen rækker hvor `from_status` er
`FAKTURERET`, `BETALT` eller `AFSLUTTET` med `to_status='AFLYST'`. T_BON
verificerer dette i `T_BON_DB_06`.
```

### Test

Ingen nye runner-tests. Eksisterende `T_BON_DB_06` (terminale har 0 udgående
transitions undtagen FAKTURERET→AFSLUTTET) er dokumentationens automatiske
verifikation.

---

## Del 2 — #011: Slet døde filer

### Verificering før sletning

Kør grep mod hele kodebasen for at sikre at filerne ikke er importeret:

```bash
cd /var/www/bon-v2  # eller hvor projektet ligger

# Tjek for imports/script-tags af de 4 filer
grep -rn "bestilling.js" --include="*.html" --include="*.js" --include="*.css"
grep -rn "bestilling.css" --include="*.html" --include="*.js" --include="*.css"
grep -rn "shopping_list.js" --include="*.html" --include="*.js" --include="*.css"
grep -rn "shopping_list.css" --include="*.html" --include="*.js" --include="*.css"

# Forventet output: kun filerne selv eller historiske kommentarer i CLAUDE.md
# Hvis nogen HTML/JS importerer dem aktivt — STOP og undersøg
```

**Note:** Tidligere grep (vores chat-historik) viste at `initBestilling`
ikke kaldes fra andre filer. Men gentag tjekket før sletning — der kan være
ændret kode siden.

### Filer at slette

```bash
git rm shared/bestilling.js
git rm shared/bestilling.css
git rm shared/shopping_list.js
git rm shared/shopping_list.css
```

Hvis indkøb af én eller anden grund stadig har CSS-imports, kan vi droppe
CSS-filerne separat — JS-filerne er det vigtigste at få væk fordi de
forvirrer code-search og er tabsmæssigt ~75 kB.

### Verificering efter sletning

```bash
# Server kører stadig
npm run test:server &
# Hent diverse sider — ingen 404 i console
curl -s http://localhost:4322/kitchen/today.html > /dev/null
curl -s http://localhost:4322/kitchen/indkob.html > /dev/null
# osv.

# Regression — alle tests stadig grønne
npm run test:run-all-tracks   # eller hvad det meta-script hedder
```

Hvis nogen test vipper rødt → restoré filerne, undersøg afhængigheden.

### Markering i TEST_OBSERVATIONS

```markdown
### #011 — bestilling.js + shopping_list.js er død kode (lukket)

| | |
|--|--|
| **Status** | `lukket` (maj 2026) |
| **Fix** | Slettet i oprydnings-PR — 4 filer (~75 kB) fjernet efter grep-verifikation. `initBestilling` blev ikke kaldt fra andre filer. T_*-suite uændret efter sletning |
```

---

## Rækkefølge

Begge dele er små og uafhængige:

1. **#006** — markdown-redigering, kan landes direkte
2. **#011** — verificér grep, slet filer, kør test-suite, commit

Begge kan med fordel samles i samme oprydnings-PR ("housekeeping pre-Office")
sammen med eventuelle andre små opgaver.

---

*Oprettet: maj 2026 — to små "housekeeping"-opgaver før Fase 3.*
