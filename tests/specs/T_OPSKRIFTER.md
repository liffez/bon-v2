# T_OPSKRIFTER — Test-spec for Opskrifter & priser

> Test-spec for `routes/recipes_overview.js` — margin-analyse-view i office's
> ØKONOMI-sektion. Krydser Grocy (kostpris fra fulfillment) med Bon v2
> (salgspriser pr. priskategori + faktisk volume fra `bon_lines`).
>
> Implementation-spec: `docs/CLAUDE_OPSKRIFTER.md`
> Sidebar-patch: `docs/PATCH_zoner_og_layout_4.md`
> Mockup: `docs/opskrifter_margin_v3.html`

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Backend-endpoints: `GET /api/recipes/overview` (hovedtabel-data, KPI-summary, period-buckets), `POST /api/recipes/refresh-costs` (cache-refresh), `GET/PUT/PATCH /api/recipes/targets` (DB%-mål-CRUD), `PUT /api/item-prices` (salgspris-redigering med `item_type='recipe'`), `POST /api/recipes/backfill` (force-rerun af auto-backfill). Plus moms-disciplin: revenue summeres som INCL moms i SQL og konverteres via `Moms.inclToExcl()` i Node — ALDRIG `/ 1.25` direkte. |
| **Hvad testes IKKE** | UI-rendering (sparkline, drill-down, tabel-sortering — separat Playwright-track senere). Selve Grocy-fulfillment-beregning (det er Grocys ansvar — vi tester at vi henter og cacher korrekt). Nightly-cron-scriptet køres ikke i suite, men dets in-process tvilling `POST /refresh-costs` testes. |
| **Forhold til T_GROCY** | T_GROCY tester `services/grocyAdapter.js` direkte (recipes, fulfillment, products). T_OPSKRIFTER stoler på adapteren og tester transformations-laget oven på. |
| **Forhold til T_BON_DRAWER_LINES** | T_BON_DRAWER tester at lines oprettes med `grocy_recipe_id`. T_OPSKRIFTER verificerer at sold-aggregering fra disse lines giver korrekte tal pr. opskrift. |
| **Forhold til moms-doktrin (§6b+6c)** | Kritisk område. Aggregat-bug i tidligere spec (revenue_excl_moms = SUM(quantity * unit_price)) er præcis hvad denne suite skal forhindre i at krybe ind igen. T-bon T_OPS_MOMS verificerer end-to-end. |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `data/test.db` seedet via `seed_planning.sql`
- Auth-session etableret (office- eller admin-rolle — alle endpoints kræver auth)
- `payment_types`, `price_categories` (især `'catering'` + `'festival'`) eksisterer
- Grocy-test-instans tilgængelig (grocytest) — fulfillment-endpoint skal svare
- `settings.recipe_prices_backfilled` nulstilles til `'0'` i SETUP

### 2.2 Test-bons — egne T_OPS_

Hver test opretter sine egne bons via direkte SQL med prefix `T_OPS_` på `bon_number`. Salgsdata aggregeres fra disse for at validere `period_buckets` og `revenue_excl_moms`.

| Bon | status | is_offer | is_internal | delivery_date | Lines | Forventet i sold-aggregat |
|-----|--------|----------|-------------|---------------|-------|---------------------------|
| T_OPS_LEV_1 | LEVERET | 0 | 0 | today-10 | recipe_id=R1 × 5 stk | Ja, units=5 |
| T_OPS_LEV_2 | LEVERET | 0 | 0 | today-30 | recipe_id=R1 × 3 stk + R2 × 2 stk | Ja |
| T_OPS_FAKT | FAKTURERET | 0 | 0 | today-60 | recipe_id=R2 × 4 stk | Ja |
| T_OPS_BETALT | BETALT | 0 | 0 | today-90 | recipe_id=R3 × 2 stk | Ja |
| T_OPS_AFSLUT | AFSLUTTET | 0 | 0 | today-120 | recipe_id=R3 × 1 stk | Ja |
| T_OPS_NY | NY | 0 | 0 | today+5 | recipe_id=R1 × 99 stk | **Nej** (status) |
| T_OPS_AFLYST | AFLYST | 0 | 0 | today-5 | recipe_id=R1 × 10 stk | **Nej** (status) |
| T_OPS_OFFER | LEVERET | **1** | 0 | today-5 | recipe_id=R1 × 50 stk | **Nej** (is_offer=1) |
| T_OPS_INTERNAL | LEVERET | 0 | **1** | today-5 | recipe_id=R2 × 50 stk | **Nej** (is_internal=1) |
| T_OPS_OLD | LEVERET | 0 | 0 | today-400 | recipe_id=R1 × 10 stk | **Nej** ved period_days=365, **Ja** ved period_days=730 |
| T_OPS_NULL_RECIPE | LEVERET | 0 | 0 | today-5 | grocy_recipe_id=NULL, qty=5 | **Nej** (NULL) |
| T_OPS_MOMS | LEVERET | 0 | 0 | today-5 | recipe_id=R_MOMS × 4 stk, unit_price=125 (incl) | Revenue ex moms = (4 × 125) / 1.25 = 400 |

### 2.3 Test-opskrifter — virtuelle R1/R2/R3/R_MOMS

Kan IKKE skabes i Grocy-test-instansen for hver test-kørsel (det er en delt
side-effect). I stedet: mock Grocy-adapter på adapter-niveau eller brug
faktiske test-recipe-IDs der allerede eksisterer i grocytest.

**Anbefalet tilgang**: brug 4 eksisterende grocytest-recipes med kendte
egenskaber, og log deres ID'er i SETUP_01. Hvis nogen ændrer dem i Grocy
crashes test — tilføj advarsel ved property-mismatch.

Alternative: stub `grocyAdapter.getRecipes()` / `getRecipeFulfillment()` i en
test-mode helper.

### 2.4 Test-priser

`item_prices` populeres direkte i SETUP for kontrol:
- `(recipe, R1, catering_id, 80.00)` — salgspris ex moms
- `(recipe, R1, festival_id, 75.00)`
- `(recipe, R2, catering_id, 50.00)` — INGEN festival-pris (test mangler-pris)
- `(recipe, R3, catering_id, 30.00)`
- `(recipe, R_MOMS, catering_id, 100.00)`

Kostpriser fra `recipe_cost_cache` (også populeret direkte i SETUP):
- R1: 35.00 ex moms (DB% = (80-35)/80 = 56.25%)
- R2: 40.00 ex moms (DB% = (50-40)/50 = 20% — under alle tænkelige mål)
- R3: 35.00 ex moms (DB% = (30-35)/30 = -16.7% — **tabsgivende**)
- R_MOMS: 50.00 ex moms

### 2.5 Test-mål

`recipe_db_targets` populeres direkte:
- `('01 Sandwich', 65)` — R1, R3 i denne kategori
- `('02 Salat', 60)` — R2 i denne kategori
- R_MOMS er i 'TEST_MOMS' uden mål → under_target=false uanset DB%

### 2.6 Float-tolerance

`FLOAT_TOL = 0.01` — kr- og pct-felter sammenlignes med tolerance.

---

## 3. Strategi: snapshot → seed → query → cleanup

```
1. snapshot = SELECT * FROM bons WHERE bon_number LIKE 'T_OPS_%' (forventet 0)
   snapshot += SELECT * FROM item_prices, recipe_cost_cache, recipe_db_targets (snapshots til diff)
2. ACTION_setup_db:
   - Reset settings.recipe_prices_backfilled = '0'
   - INSERT 12 test-bons + lines med kendte recipe_id'er
   - INSERT item_prices (5 rækker, item_type='recipe')
   - INSERT recipe_cost_cache (4 rækker)
   - INSERT recipe_db_targets (2 rækker)
3. ACTION_test: HTTP-kald mod endpoints med varierende parametre
4. ASSERT: response-strukturen, eksklusioner, moms-konvertering, KPI-tal
5. CLEANUP:
   - DELETE bons LIKE 'T_OPS_%' (CASCADE rydder lines)
   - DELETE item_prices WHERE item_id IN (R1,R2,R3,R_MOMS) AND item_type='recipe'
   - DELETE recipe_cost_cache WHERE grocy_recipe_id IN (...)
   - DELETE recipe_db_targets WHERE category IN ('01 Sandwich', '02 Salat', 'TEST_MOMS')
   - Reset settings.recipe_prices_backfilled til snapshot
6. VERIFY: alle snapshots == final state
```

---

## 4. Test-cases

### 4.1 SETUP (6)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_OPS_SETUP_01** | DB seedet, test-recipe-IDs identificeret | R1/R2/R3/R_MOMS valgt fra grocytest, logget i test-output |
| **T_OPS_SETUP_02** | Migration 068 anvendt | `item_prices.item_type` findes, `recipe_cost_cache` findes, `recipe_db_targets` findes |
| **T_OPS_SETUP_03** | Test-bons + lines inserted | 12 bons + lines, alle med korrekt status/is_offer/is_internal |
| **T_OPS_SETUP_04** | Auth virker | GET uden session → 401, med session → 200 |
| **T_OPS_SETUP_05** | `Moms.inclToExcl(125) ≈ 100` | Helper er importeret korrekt |
| **T_OPS_SETUP_06** | `settings.recipe_prices_backfilled = '0'` | Klar til at teste auto-backfill |

### 4.2 OVERVIEW_BASIC — hovedendpoint (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_OV_01** | GET /overview?price_category=catering&period_days=365 | 200, response har `summary`, `recipes`, `price_category`, `period_days`, `cost_refreshed_at` |
| **T_OPS_OV_02** | summary.active_count | Tæller opskrifter med `sellable='1'` |
| **T_OPS_OV_03** | recipes-array indeholder R1, R2, R3, R_MOMS | Alle med korrekt navn, kategori, cost_price |
| **T_OPS_OV_04** | R1.sales_price_excl_moms == 80.00 | Fra item_prices for catering |
| **T_OPS_OV_05** | R1.db_kr_excl_moms == 80 - 35 == 45 | Beregnet i Node, ikke i DB |
| **T_OPS_OV_06** | R1.db_pct ≈ 56.25 | (80-35)/80 × 100 |
| **T_OPS_OV_07** | R2.sales_price_excl_moms IS NULL (festival mangler), under_target=false (cant calc) | Mangler-pris-tilstand |
| **T_OPS_OV_08** | period_buckets.length === 12 for hver opskrift | Altid 12 buckets uanset period_days |

### 4.3 SOLD_AGGREGATION — eksklusioner (10)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_SOLD_01** | R1.sold_units efter setup | T_OPS_LEV_1 (5) + T_OPS_LEV_2 (3) = 8 stk (T_OPS_OLD ekskluderet ved 365d) |
| **T_OPS_SOLD_02** | R1 ekskluderer T_OPS_NY | NY-status ikke aggregeret |
| **T_OPS_SOLD_03** | R1 ekskluderer T_OPS_AFLYST | AFLYST-status ikke aggregeret |
| **T_OPS_SOLD_04** | R1 ekskluderer T_OPS_OFFER | is_offer=1 ikke aggregeret — **F-kandidat hvis tilbud kommer med** |
| **T_OPS_SOLD_05** | R2 ekskluderer T_OPS_INTERNAL | is_internal=1 ikke aggregeret |
| **T_OPS_SOLD_06** | T_OPS_NULL_RECIPE ekskluderet | `grocy_recipe_id IS NULL` ikke aggregeret |
| **T_OPS_SOLD_07** | T_OPS_OLD inkluderet ved period_days=730 | Verificér period_days virker |
| **T_OPS_SOLD_08** | R3.sold_units == 3 | T_OPS_BETALT (2) + T_OPS_AFSLUT (1) — BETALT og AFSLUTTET tæller med |
| **T_OPS_SOLD_09** | Recipes uden salg har sold_units=0, revenue_excl_moms=0 | Ikke NULL eller exception |
| **T_OPS_SOLD_10** | period_buckets summerer til sold_units | Sanity-check: SUM(buckets) === sold_units |

### 4.4 MOMS — kritisk (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_MOMS_01** | R_MOMS.revenue_excl_moms ≈ 400 | 4 × 125 (incl) / 1.25 = 400 (ex). **Bug-fælde hvis tallet er 500** |
| **T_OPS_MOMS_02** | summary.total_revenue_excl_moms summerer alle | Alle opskrifters revenue_excl_moms — verificeret med direkte SUM |
| **T_OPS_MOMS_03** | Ingen `* 1.25` eller `/ 1.25` i `routes/recipes_overview.js` | grep mod source — pre-commit-hook skal blokere det, men dobbelt-tjek |
| **T_OPS_MOMS_04** | R_MOMS.db_kr_excl_moms ≈ 100 - 50 = 50 | Salgspris ex moms − kostpris ex moms |
| **T_OPS_MOMS_05** | T_OPS_OFFER's lines bidrager IKKE til R1.revenue | is_offer ekskluderes — verificeret ved at fjerne offer og se diff |

### 4.5 SUMMARY_KPI (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_KPI_01** | summary.loss_making_count == 1 | Kun R3 |
| **T_OPS_KPI_02** | summary.under_target_count >= 2 | R2 (DB 20% < 60), R3 (negativ) |
| **T_OPS_KPI_03** | summary.share_under_target_pct beregnes som count/active_count × 100 | Konsistent med under_target_count |
| **T_OPS_KPI_04** | summary.missing_price_count == 1 ved price_category=festival | R2 mangler festival-pris |
| **T_OPS_KPI_05** | summary.not_sold_count tæller opskrifter med 0 salg i perioden | Verificeret mod sold-aggregat |
| **T_OPS_KPI_06** | summary.oko_count tæller `sellable='1' AND Oeko='1'` | Mock én opskrift med Oeko='1' |
| **T_OPS_KPI_07** | summary.total_co2_kg summerer co2_total_period | SUM af recipe.co2_total_period |
| **T_OPS_KPI_08** | summary.avg_db_pct_weighted vægtes med revenue | SUM(db_kr × units) / SUM(revenue) × 100 — verificér mod direkte beregning |

### 4.6 BACKFILL — auto-migration (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_BF_01** | Første GET /overview når `recipe_prices_backfilled='0'` | Backfill kører, item_prices populeres fra Grocy Salesprice*-userfields, flag sættes til '1' |
| **T_OPS_BF_02** | Backfill konverterer incl→excl via Moms.inclToExcl | Userfield SalespriceCatering=125 → item_prices.price=100 |
| **T_OPS_BF_03** | Andet GET /overview springer backfill over | Flag er '1', ingen ekstra INSERTs |
| **T_OPS_BF_04** | POST /backfill?force=1 nulstiller flag og kører igen, men INSERT OR IGNORE | Manuel ændrede priser bevares |
| **T_OPS_BF_05** | POST /backfill?force=2 overskriver | Manuel priser tabes — admin-only, advarsel i response |
| **T_OPS_BF_06** | Ikke-admin kan ikke kalde POST /backfill | 403 forbidden |

### 4.7 REFRESH_COSTS (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_RC_01** | POST /refresh-costs | Looper alle Grocy-recipes, kalder fulfillment, upserts i cache, returnerer `{refreshed, duration_ms, refreshed_at}` |
| **T_OPS_RC_02** | refresh-costs broadcaster SSE `recipe_costs_refreshed` | SSE-listener modtager event med korrekt payload |
| **T_OPS_RC_03** | Enkelt fejlende recipe afbryder ikke batch | Mock én recipe der returnerer 500 fra Grocy → resten cached, fejl logget |
| **T_OPS_RC_04** | refreshed_at opdateres på alle succesfulde rows | Verificér tidsstempel før/efter |

### 4.8 TARGETS_CRUD (7)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_TG_01** | GET /targets returnerer `{categories, targets}` | categories-array indeholder alle distinkte Grocy-kategorier (også uden mål) |
| **T_OPS_TG_02** | PUT /targets bulk-upserter | 2 nye + 1 ændret target → 3 rækker oprettet/ændret |
| **T_OPS_TG_03** | PATCH /targets/:category opdaterer ét mål | Inline-edit fra drill-down |
| **T_OPS_TG_04** | Targets-ændring broadcaster SSE `recipe_targets_updated` | Med opdaterede targets i payload |
| **T_OPS_TG_05** | DELETE /targets/:category fjerner mål | GET /targets viser ingen target-row for den kategori, men kategori-navnet er stadig i categories |
| **T_OPS_TG_06** | recipes uden kategori-mål har db_target_pct=null, under_target=false | Ukategoriserede falder ikke i rød tilstand |
| **T_OPS_TG_07** | Non-admin kan PATCH/PUT targets | Office-rolle accepteres — kun admin er super-power, dette er work-tool |

### 4.9 ITEM_PRICES_CRUD (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_IP_01** | PUT /item-prices opretter ny pris | UPSERT virker, item_type='recipe' |
| **T_OPS_IP_02** | PUT /item-prices opdaterer eksisterende | Samme (item_type, item_id, price_category_id) → UPDATE i stedet for duplikat |
| **T_OPS_IP_03** | item_price_updated broadcaster SSE | Med item_type, item_id, price_category_code, price_excl_moms |
| **T_OPS_IP_04** | logChange skrives ved PUT | changelog-row med entity_type='item_prices', user_id sat |
| **T_OPS_IP_05** | Negativ pris afvises (400) | `price_excl_moms < 0` → ValidationError |

### 4.10 CACHE_INVALIDATION (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_CI_01** | grocyAdapter.updateRecipe(R1) sletter cache-row | SELECT FROM recipe_cost_cache WHERE grocy_recipe_id=R1 → 0 rækker |
| **T_OPS_CI_02** | createRecipePosition({recipe_id: R1}) sletter R1's cache | Per-position-invalidering |
| **T_OPS_CI_03** | deleteRecipePosition sletter cache for ejer-recipe | Verificeret via SELECT |
| **T_OPS_CI_04** | createRecipeNesting(parent=R1) sletter R1's cache | Nested-opskrifter triggers parent-invalidering |
| **T_OPS_CI_05** | Parallel update af R1 og R2 forstyrrer ikke hinanden | Kør 2 parallelle updateRecipe-kald → begge invalideringer registreret |

### 4.11 STALE_DETECTION (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_ST_01** | refreshed_at < 48t → cost_stale=false | GET /overview returnerer ingen stale-flag |
| **T_OPS_ST_02** | refreshed_at 48t–7d → cost_stale='warn' | Mild advarsel |
| **T_OPS_ST_03** | refreshed_at > 7d → cost_stale='critical' | Rødt advarsel-flag |

### 4.12 STANDALONE_SCRIPT (2)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_OPS_SS_01** | Spawn `node scripts/refresh-recipe-costs.js` | Exit-code 0, cache opdateret, log-output indeholder `refreshed: N` |
| **T_OPS_SS_02** | Scriptet bruger `openDb()` fra `db/compat.js` | Inspect source — ikke direkte `DatabaseSync` (CLAUDE.md regel) |

---

## 5. Eksempel: ende-til-ende moms-flow

```javascript
// SETUP
await sql(`INSERT INTO bons (bon_number, status_id, delivery_date, is_offer, is_internal, ...)
           VALUES ('T_OPS_MOMS', leveret_id, date('now', '-5 days'), 0, 0, ...)`);
await sql(`INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, quantity, unit_price)
           VALUES (?, ?, 'TestMoms', 4, 125.00)`, [bonId, R_MOMS]);  // 125 INCL moms

// ACTION
const overview = await get('/api/recipes/overview?price_category=catering&period_days=365');
const rMoms = overview.recipes.find(r => r.grocy_recipe_id === R_MOMS);

// ASSERT — det her er hele suite'ens raison d'être
assert(Math.abs(rMoms.revenue_excl_moms - 400) < FLOAT_TOL,
       `revenue_excl_moms skal være 400 (4×125÷1.25). Fik ${rMoms.revenue_excl_moms}.
        Hvis du ser 500: revenue summeres som incl uden konvertering — fjenden er tilbage.`);

assert(Math.abs(rMoms.db_kr_excl_moms - 50) < FLOAT_TOL,
       'db_kr skal være ex moms − ex moms = 50');
```

---

## 6. Fejlsignaler (forventede F-kandidater)

| # | Hvis | Så | Sandsynlighed |
|---|------|-----|---------------|
| F1 | revenue_excl_moms = 500 (i stedet for 400) i T_OPS_MOMS_01 | Aggregat-bug — unit_price (incl) summeret direkte. Tjek routes/recipes_overview.js for / 1.25 eller manglende Moms.inclToExcl() | Høj — hovedfaren |
| F2 | T_OPS_OFFER's revenue indgår i R1 | is_offer-filter mangler i WHERE-clause | Mellem — let at glemme |
| F3 | T_OPS_INTERNAL's revenue indgår | is_internal-filter mangler | Mellem |
| F4 | Backfill overskriver manuel pris ved force=1 | INSERT OR IGNORE er ændret til REPLACE | Lav |
| F5 | period_buckets-summering matcher ikke sold_units | Bucket-query og total-query bruger forskellige WHERE-clauses | Mellem |
| F6 | grocyAdapter.updateRecipe sletter ikke cache | Hook glemt | Mellem |
| F7 | recipes uden sellable='1' kommer med ved include_inactive=0 | Filter glemt | Lav |
| F8 | Kategori fra grupper-userfield har whitespace | Trim-fejl → "01 Sandwich " matcher ikke target "01 Sandwich" | Mellem |
| F9 | item_prices.UNIQUE constraint forhindrer recipe + product på samme id | Hvis item_type er glemt i constraint | Lav — testes i SETUP_02 |
| F10 | refresh-costs hænger ved enkelt fejlende recipe | Manglende try/catch om hvert kald | Mellem |

---

## 7. Filer

- `tests/specs/T_OPSKRIFTER.md` (denne fil)
- `tests/scripts/run_T_OPSKRIFTER.js` (runner — opretter, kalder endpoints, asserterer, cleanup)
- `tests/scripts/helpers/grocy_test_recipes.js` (vælg test-recipes fra grocytest, log ID'er)
- `tests/scripts/helpers/sse_listener.js` (genbruges — for refresh-costs/item_price_updated/targets_updated events)

---

## 8. Hvad-vi-ved før kodning

- `item_prices`-tabellen er tom i prod og test → drop+recreate i migration 068 er sikkert
- `services/cron.js` findes ikke — standalone-scripts kører fra system-crontab
- `getRecipeFulfillment()` findes allerede i `services/grocyAdapter.js` (linje 333)
- `bon_lines.grocy_recipe_id` findes (`002_bons.sql` linje 89)
- `bon_lines.unit_price` er **INCL moms** (CLAUDE.md §6b — ikke ex som tidligere udkast påstod)
- Tilbud (is_offer=1) ekskluderes fra revenue — samme regel som rapporter
- `sellable` userfield styrer aktiv-tilstand på recipes (Grocy har ingen native is_active på recipes)
- Grocy-kategori = userfield `grupper` (preset-checklist — tag første værdi)

---

## 9. Næste

1. Implementer migration 068
2. Implementer `services/itemPriceBackfill.js`
3. Implementer `routes/recipes_overview.js`
4. Skriv `tests/scripts/run_T_OPSKRIFTER.js`
5. Kør suite mod test-DB
6. Patch eventuelle findings
7. Verificér pre-commit-hook blokerer `/ 1.25` i routes/recipes_overview.js
8. Aktivér crontab på deploy

---

## 10. Status

| Felt | Værdi |
|------|-------|
| Spec-version | 1.1 |
| Sidst opdateret | 17. maj 2026 |
| Suite-status | ✅ Kørt mod test-DB (port 4322) — alle kritiske cases grønne |
| Antal cases i runner | 34 (kompakt subset af spec's 65 — fokuseret på moms + filtre + CRUD) |
| Pass / Fail / Skip | 34 / 0 / 0 |
| Åbne findings | — ingen |

**Runner-design:** Bruger snapshot-then-diff mod baseline (test.db deler
recipe-IDs med seed-data), så assertions kan udtrykkes som DELTA pr.
recipe efter test-bons indsættes. Hermetisk via T_OPS_-prefix på bon_number.

**Springet over i runner (men dækket af spec):** BACKFILL force-modes,
REFRESH_COSTS-mocking, CACHE_INVALIDATION-integration, STALE-tidssim,
STANDALONE_SCRIPT separat process. Disse er enten ekstern-afhængighed-tunge
eller integration-tests der hører til separate kørsler.

---

## 11. Findings

Logges som F1, F2, ... her efterhånden som suiten kører. Reference til
`docs/TEST_OBSERVATIONS.md` for cross-track-observations.
