# CLAUDE_TESTPLAN.md — Master test-plan for Bon v2

> Master-dokument for hele testindsatsen før Bon v1 lukkes ned.
> Definerer faser, scope, miljø og konventioner.
> De individuelle test-specs (`tests/specs/T_*.md`) henviser til dette dokument.

---

## 1. Formål

Verificere at Bon v2 leverer korrekte resultater på tværs af alle berørte funktioner
**før** Bon v1 lukkes ned og kontoret/køkkenet skifter fuldt over.

Test-pakken skal kunne køres af Claude Code uden manuel intervention bortset fra:
- Initial opsætning af test-miljø (én gang)
- Verifikation af rapport (efter hver kørsel)

---

## 2. Faser

| Fase | Område | Mål | Status |
|------|--------|-----|--------|
| **1** | Grundlæggende bon | Bon-kerne, kitchen-views, planlægning, Grocy-adapter, økonomi pr. bon | ✅ **Færdig (130/130 PASS, 3 SKIP)** maj 2026 |
| **2** | Specialfunktioner | Lager (T_INVENTORY ✅ 13/13 + T_STOCK ✅ 31/31) + opskrifter (T_RECIPES ✅ 20/20) + indkøb (4 tracks: T_INDKOB_LISTE/SETUP/ADMIN/HORKRAM) + varemodtagelse (T_VAREMODTAGELSE) | 🟡 I gang — lager-tracks ✅ grønne, indkøb-tracks 🔲 specs klar (maj 2026) |
| **3** | Office (bon-delen) | Bon-list, bon-detalje, office-dashboard for bon, tilbud | 🔲 Senere |
| **4** | Resterende | CRM, mail-ind, fakturering, levering, ugeoversigt | 🔲 Når relevant |

**Princip:** En fase er færdig når **alle** tracks i den fase rapporterer PASS i seneste runner-output.

---

## 3. Fase 1 — tracks

| ID | Track | Hvad testes | Spec-fil |
|----|-------|-------------|----------|
| **T_DB** | Database integritet | FK'er, NOT NULL, unique, seed reproducerbar | `tests/specs/T_DB.md` ✅ **18/18 PASS** (maj 2026) |
| **T_BON** | Bon livscyklus | Status-flow, changelog, force-mode, transitions | `tests/specs/T_BON.md` ✅ **18/18 PASS** (1 SKIP: force-mode parkeret) |
| **T_PLAN** | Planlægning | Antal/råvarer/pris pr. dag og uge, status-filtre, moms | `tests/specs/T_PLAN.md` ✅ **28/28 PASS** (maj 2026) |
| **T_KITCHEN_TODAY** | I dag-viewet | PREP → KLAR → LEVERET, bonner forsvinder korrekt | `tests/specs/T_KITCHEN_TODAY.md` ✅ **13/13 PASS** (maj 2026) |
| **T_GROCY** | Grocy-adapter + lagertræk | Læs opskrifter/lager/priser, `consumeRecipe` ved LEVERET, tilbageføring | `tests/specs/T_GROCY.md` ✅ **14/14 PASS** (2 SKIP: write-tests udskudt) |
| **T_AGGR** | Optællings-konsistens | Samme tal pr. dag på dashboard, kalender, planlægning, kitchen-views | `tests/specs/T_AGGR.md` ✅ **24/24 PASS** (maj 2026) |
| **T_ECON** | Økonomi pr. bon | Moms-doktrin overholdt på enkelt-bon (linje × pris × moms) | `tests/specs/T_ECON.md` ✅ **14/14 PASS** (maj 2026) |
| **T_INPUT** | Bon-opret | Manuel oprettelse + formbuilder webhook → korrekte felter | `tests/specs/T_INPUT.md` ✅ **15/15 PASS** (maj 2026) |

T_PLAN dækker aggregerings-perspektivet i T_AGGR og T_ECON, så de bliver mindre når de skrives.

## 3.1 Fase 2 — tracks

| ID | Track | Hvad testes | Spec-fil |
|----|-------|-------------|----------|
| **T_INVENTORY** | Lager-træk ved LEVERET | `consumeRecipes`, parent/child-substitution, partial-consume + auto-shopping-list | `tests/specs/T_INVENTORY.md` ✅ **13/13 PASS** (11. maj 2026) |
| **T_STOCK** | Direkte stock-mutation + userfields | `setInventory`, `addToStock`, userfield-CRUD, status-funktioner i `inventory_check.js`/`stock_overview.js` | `tests/specs/T_STOCK.md` ✅ **31/31 PASS** (11. maj 2026) |
| **T_RECIPES** | Recipe CRUD via Grocy proxy | `POST/PUT /recipes`, positions, nestings, multi-field PUT, cascade-observation | `tests/specs/T_RECIPES.md` ✅ **20/20 PASS** (11. maj 2026) |
| **T_INDKOB_LISTE** | Grocy shopping_list-proxy | Smart vs rå add, remove/delete, PUT split-routing, bulk-flows (manglende/udløbne/forfaldne), clear | `tests/specs/T_INDKOB_LISTE.md` 🔲 spec klar |
| **T_INDKOB_SETUP** | Suppliers + grocy-locations + barcodes | CRUD i `routes/purchasing.js`, CHECK-constraints, soft-delete, product-barcodes + userfields, cache-invalidering, duplicate_candidates | `tests/specs/T_INDKOB_SETUP.md` 🔲 spec klar |
| **T_INDKOB_ADMIN** | Hørkram batch-import + mapping | READ-endpoints, snapshot→userfield-write, Dice-bigram-scoring (`_isStringSimilarity`), udgået-detection, foretrukket-toggle | `tests/specs/T_INDKOB_ADMIN.md` 🔲 spec klar |
| **T_INDKOB_HORKRAM** | Hørkram-bestillingsflow | Kurv-add (`PUT /api/horkram/basket`), order-POST, PO-mail-tråde | 🔲 ikke skrevet |
| **T_VAREMODTAGELSE** | Atomisk goods-receipts | `POST /api/goods-receipts` (receipt + addStock + shopping_list cleanup + Whiteboard-webhook) | 🔲 ikke skrevet |

**Forudsætninger der skal lande før / som del af T_INDKOB_LISTE-PR:**
- `tests/specs/PATCH_consumeRecipes_smart_shopping_list.md` — to ændringer i `services/grocyAdapter.js` + opdatering af `T_INV_PARTIAL_02`-assertion. Logget som **#012** i `docs/TEST_OBSERVATIONS.md` (åben)
- `tests/specs/PATCH_grocy_qu_broedrug_v1_cleanup.md` — ✅ **anvendt manuelt på grocytest** 11. maj 2026. Skal også køres på grocycafe inden cutover. Logget som **#010** (lukket)

### 3.2 Parallelt: T_V1_AFSTEMNING

| ID | Track | Hvad |
|----|-------|------|
| **T_V1_AFSTEMNING** | Bon v1 ↔ Bon v2 sammenligning | Vælg historisk uge, sammenlign output dag-for-dag |

Køres når T_PLAN, T_BON og T_GROCY er stabile. Blokerer ikke Fase 1 — afvigelser kan stamme fra
v1-bugs lige så godt som v2-bugs.

**Datakilde:** Bon v1's data kopieres hver nat til Bon v2-prod, så v1-historik er allerede
tilgængelig i v2-prod-DB. T_V1_AFSTEMNING kan kopiere en historisk uges bonner fra v2-prod-DB
ind i `data/test.db` og sammenligne mod den eksterne v1-frontends visning af samme uge.

---

## 4. Test-miljø

### 4.1 Database — separat fra produktion

| | |
|--|--|
| **Fil** | `data/test.db` (separat SQLite-fil, ikke `bon.db`) |
| **Driver** | `node:sqlite` via `db/compat.js`'s `openDb()` — ingen `better-sqlite3` |
| **Reset** | `npm run test:reset` — sletter `test.db`, kører migrate + applicerer fixture |
| **Konfiguration** | Læses fra `.env.test` via `--env-file=.env.test` (Node 22+) |
| **Sikkerhedsforanstaltning** | Runner aborterer hvis `DB_PATH` ikke indeholder `test` |

### 4.2 Bon v2 server-instans

| | |
|--|--|
| **Port** | 4322 (skiller sig fra prod på 4321) |
| **Start** | `npm run test:server` — starter med `NODE_ENV=test` og loader `.env.test` |
| **API-base** | `http://localhost:4322/api` |

### 4.3 Grocy test-target

**Besluttet (maj 2026): `grocytest.ristetrug.dk` (Linode).** Allerede oppe og adskilt fra prod.
Grocy cafe-data er kopieret over (gjort maj 2026). Migrering til intern Hetzner-instans
kan ske senere uden ændring i testsuite — kun env-variabel skifter.

### 4.4 Sikkerheds-foranstaltninger

Runneren kører **kun** hvis alle disse holder:
- `NODE_ENV === 'test'`
- `DB_PATH` indeholder strengen `test`
- `GROCY_API_URL` indeholder strengen `test`
- `BON_V1_DB_PATH` er **ikke** sat (ingen risiko for at læse v1)

Mismatch → runner skriver fejl og afslutter med exit-kode 2 før den rører noget.

### 4.5 .env.test

Filen er allerede oprettet og indeholder:

```dotenv
NODE_ENV=test
TEST_RUNNER_ALLOWED=1

PORT=4322
DB_PATH=./data/test.db

GROCY_API_URL=https://grocytest.ristetrug.dk/api
GROCY_API_KEY=<test-key>

# + smtp/imap/smartplan/horkram credentials så server kan starte
```

`locations`-tabellen i test-DB peger samme sted via seed.

---

## 5. Filstruktur

```
bon-v2/
├── tests/
│   ├── specs/
│   │   ├── T_PLAN.md                  ← spec for planlægning
│   │   ├── T_DB.md                    ← (skrives senere)
│   │   ├── T_BON.md                   ← (skrives senere)
│   │   └── ...
│   ├── fixtures/
│   │   ├── seed_planning.sql          ← 8 bonner + linjer for T_PLAN
│   │   └── grocy_snapshot.json        ← genereres af test:snapshot
│   ├── scripts/
│   │   ├── safety_check.js            ← validér .env.test
│   │   ├── apply_fixture.js           ← kører .sql-fixture mod test.db
│   │   ├── snapshot_grocy.js          ← læser Grocy → JSON-fixture
│   │   ├── patch_grocy_recipe_ids.js  ← opdaterer bon_lines.grocy_recipe_id
│   │   └── run_T_PLAN.js              ← test-runner for T_PLAN
│   ├── playwright/
│   │   └── T_PLAN_AGG.spec.js         ← frontend-tests
│   └── reports/
│       └── T_PLAN_YYYY-MM-DD.md       ← genereres ved kørsel
├── data/
│   ├── bon.db                         ← prod (rør ikke)
│   └── test.db                        ← test (skabes af test:reset)
├── .env                               ← prod
├── .env.test                          ← test (allerede oprettet)
└── package.json                       ← har test:* scripts
```

### npm-scripts

```json
{
  "scripts": {
    "test:check":    "node --env-file=.env.test tests/scripts/safety_check.js --skip-db-check",
    "test:migrate":  "node --env-file=.env.test --experimental-sqlite db/migrate.js",
    "test:fixture":  "node --env-file=.env.test --experimental-sqlite tests/scripts/apply_fixture.js tests/fixtures/seed_planning.sql",
    "test:reset":    "rm -f data/test.db && npm run test:migrate && npm run test:fixture",
    "test:server":   "node --env-file=.env.test --experimental-sqlite server.js",
    "test:snapshot": "node --env-file=.env.test --experimental-sqlite tests/scripts/snapshot_grocy.js",
    "test:patch":    "node --env-file=.env.test --experimental-sqlite tests/scripts/patch_grocy_recipe_ids.js",
    "test:run":      "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_PLAN.js"
  }
}
```

---

## 6. Test-runner og rapport

### 6.1 Hvad runneren gør

1. Validerer `.env.test` via `safety_check.js`
2. Åbner test.db via `openDb()` fra `db/compat.js` (node:sqlite)
3. For hver test-case:
   - Eksekverer SQL eller fetch mod test-server
   - Sammenligner resultat med facit
   - Markerer PASS / FAIL / SKIP
4. Skriver rapport til `tests/reports/<TRACK>_<YYYY-MM-DD>.md`

### 6.2 Rapportformat

```markdown
# T_PLAN — 2026-05-12 14:30
Miljø: localhost:4322 / data/test.db / Grocy: grocytest.ristetrug.dk

## Resumé
- 51 PASS · 1 FAIL · 1 SKIP

## Fejl
| ID | Detalje |
|----|---------|
| T_PLAN_API_11 | price_category_code: forventet "catering", fik null |

## Alle cases
T_PLAN_API_01, T_PLAN_API_02, ...
```

### 6.3 Rerun-flow ved fix

1. Læs rapport → identificér fejl
2. Fix kode
3. `npm run test:reset && npm run test:server &` → `npm run test:run`
4. Sammenlign ny rapport med forrige

---

## 7. Hvordan vi kommer i gang

Tjekliste i kronologisk rækkefølge.

### 7.1 Miljø-opsætning *(Simon, én gang — alt er gjort pr. maj 2026)*

- [x] Grocy-test-target besluttet: **`grocytest.ristetrug.dk` (Linode)**
- [x] Grocy cafe → `grocytest.ristetrug.dk` kopieret
- [x] `.env.test` oprettet (jf. §4.5)
- [x] `tests/scripts/safety_check.js` på plads
- [x] npm-scripts tilføjet i `package.json`
- [x] `data/test.db` eksisterer
- [ ] Verificér: `npm run test:reset` → `test:server` → `test:run` giver ren rapport

### 7.2 Fase 1 — track for track

Rækkefølge for at undgå afhængighedsproblemer:

1. **T_PLAN** — vi har en komplet spec og runner ✅
2. **T_DB** — verificér at fundamentet er solidt (FK'er, seed reproducerbar)
3. **T_BON** — verificér at status-flow og changelog virker pr. bon
4. **T_GROCY** — verificér at adapter læser/skriver korrekt
5. **T_INPUT** — verificér at bonner kan oprettes (forudsætter T_BON)
6. **T_KITCHEN_TODAY** — bygger på T_BON
7. **T_ECON** — verificér moms-doktrin pr. enkelt-bon
8. **T_AGGR** — verificér konsistens på tværs af views

### 7.3 Per track

For hver track:

1. Skriv eller bekræft spec (`tests/specs/T_*.md`)
2. Lav fixture(s): `seed_*.sql`, evt. `grocy_snapshot.json`
3. Lav facit-tabeller (i specen eller separat .md)
4. Implementér runner-cases
5. Kør første gang — typisk mange FAIL
6. Iterativt: fix kode → rerun → indtil PASS
7. Når alle PASS: marker tracken som ✅ i denne fil

---

## 8. Konventioner

| | |
|--|--|
| **Test-IDs** | `T_<TRACK>_<NIVEAU><nummer>` — fx `T_PLAN_API_11`, `T_BON_03` |
| **Niveauer** | A = direkte data, B = beregning fra opskrift, C = pris/moms (kun hvor relevant) |
| **Mock vs Live** | (M) = mock-fixture, (L) = live Grocy. Begge skal returnere samme resultat |
| **Fejlklassificering** | "AFVIGELSE" = forventet ≠ fik. "ADAPTER" = M og L afviger fra hinanden |
| **Sprog** | Specs på dansk. Code-kommentarer på engelsk |
| **Frontend-tests** | Playwright hvor muligt (DOM-tests, bruger-flow, status-skift). Installeres som `devDependency` — kører ikke på prod-server. Manuel verifikation kun hvor Playwright ikke giver mening |
| **Driver** | `node:sqlite` via `db/compat.js`'s `openDb()` — ingen native pakker |

---

## 9. Beslutninger

### Truffet (maj 2026)

| # | Spørgsmål | Beslutning |
|---|-----------|------------|
| 1 | Grocy test-target | **Linode `grocytest.ristetrug.dk`** — eksisterende, hurtigste vej |
| 2 | Bon v1 sammenligning | **Separat track T_V1_AFSTEMNING** — kører parallelt med Fase 1, ikke blokerende |
| 3 | Frontend-tests | **Playwright** hvor muligt, manuel kun hvor Playwright ikke giver mening |
| 4 | Database-driver i test | **`node:sqlite` via `db/compat.js`** — matcher prod-koden, ingen native pakker |
| 5 | Default status-filter for T_PLAN | **`[GODKENDT,IGANG,KLAR,LEVERET]`** — VENTER ekskluderet bevidst |
| 6 | Tilbud (`is_offer=1`) i backend-filter | **OR'es altid ind**, frontend filtrerer client-side |
| 7 | Bon-numre i seed | **4001–4008** — sikker buffer over prod-seneste 3479 |
| 8 | Test-fixture-loading | **`apply_fixture.js`** — `db/seed.js` understøtter ikke `--fixture=` |
| 9 | grocy_recipe_id på seed | **Patch efter snapshot** via `patch_grocy_recipe_ids.js` |

### Åbne

| # | Spørgsmål | Beslutter | Hvornår |
|---|-----------|-----------|---------|
| 10 | Tidsforbrug pr. track | Måles efter T_PLAN er kørt første gang | Efter T_PLAN-kørsel |
| 11 | Bon v1-data: pull eller manuel kopi? | Leif + Simon | Når T_V1_AFSTEMNING begynder |
| 12 | Force-mode på status-PATCH: implementér eller fjern fra CLAUDE.md? | Leif | Når konkret behov opstår — ikke akut |

---

## 10. Når Fase 1 er færdig

- Alle 8 tracks rapporterer ✅ PASS i seneste rapport
- Rapporterne arkiveres i `tests/reports/` med dato i filnavn
- `CLAUDE_TESTPLAN.md` opdateres med Fase 1 = ✅
- Beslutning: Fortsæt til Fase 2 (specialfunktioner) eller direkte til Fase 3 (office bon-del)

---

## 11. Næste opgave — pickup for ny session

> Skrevet maj 2026 efter Fase 1 + T_INVENTORY (c2fbb82, 040e535, dddf4c9).
> Opdateret 11. maj 2026 efter T_STOCK (735e1ea), T_RECIPES (90dc6ef + 0c4474f), T_INV_FLAG_01-refaktor (15c9728) og TEST_OBSERVATIONS-backfill (0a07749).
> Opdateret 11. maj 2026 (sen aften): indkøbs-tracket splittet i 4 (`T_INDKOB_LISTE/SETUP/ADMIN/HORKRAM`) + `T_VAREMODTAGELSE` — specs klar i `tests/specs/`.
> Læs hele §11 for et hurtigt overblik over hvor vi står og hvad næste track bør være.

### Hvad er gjort

- **Fase 1: 130/130 PASS · 3 SKIP** — alle 8 tracks grønne. Specs i `tests/specs/T_DB.md`, `T_BON.md`, `T_PLAN.md`, `T_GROCY.md`, `T_AGGR.md`, `T_INPUT.md`, `T_ECON.md`, `T_KITCHEN_TODAY.md`.
- **Fase 2 påbegyndt — T_INVENTORY: 13/13 PASS · 0 SKIP** (FLAG_01 refaktoreret 11. maj 2026 — runneren behøver ikke længere en frisk bon).
- **T_STOCK: 31/31 PASS · 0 SKIP** (11. maj 2026) — direkte stock-mutation (`setInventory`, `addToStock`) + userfield-CRUD + enhedstest af status-beregningen i `shared/inventory_check.js` + `shared/stock_overview.js` via CommonJS-export-guard (tests importerer direkte fra produktionsfilerne, ingen kodeduplikering). Testprodukter: 87, 89, 95, 205 — disjoint fra T_INVENTORY. Spec: `tests/specs/T_STOCK.md`.
- **T_RECIPES: 20/20 PASS · 0 SKIP** (11. maj 2026) — recipe CRUD via vores Grocy proxy: `POST/PUT /recipes`, `PUT /recipes/:id/userfields`, `POST/PUT/DELETE /recipes-pos`, `POST/PUT/DELETE /recipes-nestings`. Inkluderer multi-field PUT på positioner (`ingredient_group`, `note`, `variable_amount`, `qu_id`) og CASCADE-observation: Grocy cascade'r IKKE `recipes_pos`/`recipes_nestings` ved recipe-delete — orphans hænger. Spec: `tests/specs/T_RECIPES.md`. Cross-cutting observations: `docs/TEST_OBSERVATIONS.md` #002, #003, #004.

### Kode-fixes der er landed undervejs (alle committed)

1. `routes/kitchen.js:145` — JOIN-bug på `price_category`-kolonne
2. `routes/bons.js:357-368` — `inventory_deducted=1` sættes nu efter consume + tjekkes før for at undgå dobbelt-træk
3. `services/grocyAdapter.js:534-624` — to nye features:
   - `allow_subproduct_substitution: true` (parent-produkter trækker fra børn)
   - Partial consume + auto-shopping-list-add (v1-paritet)
4. `services/ingredientResolver.js:402-450` — `resolveConsumeItems` returnerer `qu_id_stock`, `qu_id_purchase`, `parent_product_id`, `purchase_factor`
5. `.gitignore` — `.env.*`, `tests/reports/`, `tests/fixtures/grocy_snapshot.json`, DB-backups, zip-arkiver, `.claude/worktrees/`

### Næste track — **T_INDKOB_LISTE** (første af 5 indkøbs/varemodtagelses-tracks)

T_STOCK ✅, T_RECIPES ✅ og T_INV_FLAG_01-refaktor ✅ er færdige (11. maj 2026).
Lager-tracksene er hermed komplet grønne. Indkøb-området er besluttet splittet
i 4 + 1 tracks fordi T_PURCHASING-monolitten blev for stor i scope:

1. **T_INDKOB_LISTE** — shopping_list-proxy (denne)
2. **T_INDKOB_SETUP** — suppliers, grocy-locations, barcodes
3. **T_INDKOB_ADMIN** — Hørkram batch-import + Dice auto-mapping
4. **T_INDKOB_HORKRAM** — bestillingsflow (kurv-add + order + PO-mail)
5. **T_VAREMODTAGELSE** — atomisk goods-receipts

Alle 5 specs er i `tests/specs/` (T_INDKOB_LISTE/SETUP/ADMIN klar, HORKRAM + VAREMODTAGELSE ikke skrevet endnu).

**To patches skal anvendes FØR eller SOM DEL AF T_INDKOB_LISTE-PR:**

| Patch | Status | Beskrivelse |
|-------|--------|-------------|
| `tests/specs/PATCH_grocy_qu_broedrug_v1_cleanup.md` | ✅ **Anvendt manuelt på grocytest** 11. maj 2026 (Leif). Skal også køres på grocycafe inden cutover | Brød Rug pid=1 havde forkert QU-konvertering `1 Kasse = 10.8 kg` (gamle v1-data). Rettet til 7.68 + 0.1302 |
| `tests/specs/PATCH_consumeRecipes_smart_shopping_list.md` | 🔲 **Ikke anvendt endnu** — landes som første commit i T_INDKOB_LISTE-PR | 3 ændringer: udvid `addShoppingListProduct` med note-param, brug smart endpoint i `consumeRecipes`, opdater `T_INV_PARTIAL_02`-assertion fra "ny entry-id" til "amount-stigning" (ellers ramler T_INVENTORY 13/13 → 12/13) |

**Start-prompt for ny session (T_INDKOB_LISTE):**

> Læs `docs/CLAUDE_TESTPLAN.md` §11 (denne sektion), `tests/specs/T_INDKOB_LISTE.md` (komplet spec), `tests/specs/PATCH_consumeRecipes_smart_shopping_list.md` (skal anvendes som første commit) og `docs/TEST_OBSERVATIONS.md` #012 (åben — patch'en lukker den).
>
> Trin 1: Anvend `PATCH_consumeRecipes_smart_shopping_list.md` — 3 ændringer (2 i `services/grocyAdapter.js`, 1 i `tests/scripts/run_T_INVENTORY.js`). Kør T_INVENTORY → fortsat 13/13 PASS. Flyt #012 til `lukket` i TEST_OBSERVATIONS.
>
> Trin 2: Skriv `tests/scripts/run_T_INDKOB_LISTE.js` + `tests/scripts/helpers/grocy_mutation.js` (refactor af eksisterende T_STOCK-helpers). Implementér alle cases fra §4.1-4.11 i specen. Forventet ~30 cases.
>
> Trin 3: Generer `tests/fixtures/T_INDKOB_pids.json` via `pickDisjointProducts(4, exclude=[T_STOCK_pids, T_INVENTORY_pids])`. Filen genbruges af SETUP/ADMIN.
>
> Brug Hørkram-credentials fra `.env.test` hvis de er sat — T_INDKOB_LISTE er Grocy-only, ingen Hørkram-kald.

### Åbne tekniske beslutninger

| # | Spørgsmål | Status |
|---|-----------|--------|
| 12 | Force-mode på status-PATCH (CLAUDE.md vs. kode) | Parkeret — ikke akut. Også logged som `docs/TEST_OBSERVATIONS.md` #005 |
| 13 | `T_INV_FLAG_01` runner-design — kræver fresh bon mellem cases | ✅ **Løst** 11. maj 2026 (commit 15c9728) — testen kører nu reelt, 13/13 PASS |
| 14 | Recipe 53 (Frikadellen-Slider) sub-recipe data | Logged som `docs/TEST_OBSERVATIONS.md` #008 (manglende på grocytest) + #009 (sub-recipes 9/12/80 ikke individuelt testet) |

**Nyt centralt sted for observations:** `docs/TEST_OBSERVATIONS.md` samler nu alle
fund/uklarheder/UI-gaps på tværs af tracks. Kør gennem den ved planlægning af nye sessions.

### Sikkerheds-foranstaltninger (vigtigt — læs før kørsel)

- **Grocy-adapter læser URL fra `locations`-tabellen i DB**, IKKE fra `GROCY_API_URL` env-var. `seed_planning.sql` sætter `default_grocy_location_id=3` så vi rammer grocytest. **Hvis denne setting mangler, falder adapteren tilbage til prod-Grocy** — `tests/scripts/safety_check.js` afviser nu kørsel hvis aktiv lokation ikke indeholder "test" i URL'en.
- Alle test-bonner bruger nummer 4001–4008 (sikker buffer over prod-seneste 3479).
- `inventory_auto_deduct=1` er sat i `seed_planning.sql`. Skal også manuelt sættes i prod-DB ved go-live.

---

*Sidst opdateret: 11. maj 2026 (sen aften) — indkøbs-tracket splittet i 4 specs (T_INDKOB_LISTE/SETUP/ADMIN) + T_INDKOB_HORKRAM + T_VAREMODTAGELSE planlagt. To patch-filer logget i `tests/specs/`. Tidligere opdatering: efter T_STOCK + T_RECIPES + T_INV_FLAG_01-refaktor + TEST_OBSERVATIONS-backfill (commits 735e1ea, 90dc6ef, 0c4474f, 15c9728, 0a07749).*
