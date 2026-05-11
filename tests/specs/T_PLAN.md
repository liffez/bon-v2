# T_PLAN — Test-spec for planlægnings-viewet

> Test-spec for `kitchen/planning.html` (samme view bruges i office).
> Mål: verificere at planlægning regner rigtigt på alle tre niveauer (antal, råvarer, pris)
> mod et seed med håndberegnet facit, og at moms-doktrinen overholdes overalt.
>
> Baseret på faktisk kode i:
> - `routes/kitchen.js` — `/api/bons/planning` + `/api/bons/planning/ingredients`
> - `shared/planning.js` — client-side aggregering
> - `services/ingredientResolver.js` — råvare-udfoldning fra Grocy

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Planlægnings-viewet — backend `/api/bons/planning`, client-side aggregering, og `/api/bons/planning/ingredients` |
| **Hvad testes IKKE** | Office-ugeoversigt, I dag-viewets status-flow (PREP → KLAR → LEVERET) |
| **Forudsætninger** | `BON_V2_PRINCIPPER.md` §6b/6c (moms-doktrin) overholdt af backend |
| **Forhold til moms-audit** | `CLAUDE_MOMS_AUDIT*.md` auditerer **koden**. T_PLAN auditerer **output**. Komplementært |

---

## 2. Arkitektur — det vi tester

```
Browser (planning.html)
    │
    │  1. fetchBonsPlanning(from, to, status)  →  GET /api/bons/planning
    │     ↳ returnerer rå bons + linjer (ingen aggregering)
    │
    │  2. _plAggregate()  ← KUN VALGTE bonner
    │     ↳ vægtet gennemsnit pr. enhed (unit_price, cost_price)
    │     ↳ aggregeret quantity = sum
    │     ↳ totalCost = sum af (line.cost_price × line.quantity) AFTER aggregate
    │
    │  3. fetchIngredients(bon_ids)  →  POST /api/bons/planning/ingredients
    │     ↳ services/ingredientResolver.js udfolder opskrifter via Grocy
```

**Tre testflader:**

| Flade | Test-værktøj | Hvad |
|-------|--------------|------|
| **Backend `/planning`** | curl + node:sqlite | Korrekt filter, dato-range, status, is_offer-håndtering |
| **Backend `/planning/ingredients`** | curl + Grocy live | Råvarer udfoldes korrekt fra opskrifter |
| **Frontend aggregering** | Playwright | Vægtet gennemsnit, totalCost, "vælg alle"-flow |

---

## 3. Forudsætninger og miljø

Se `docs/CLAUDE_TESTPLAN.md` §4 for miljø-detaljer. Kort:
- Test-DB: `data/test.db` (separat fra prod), seeded fra `seed_planning.sql`
- Test-server: `localhost:4322` med `NODE_ENV=test`
- Grocy: `grocytest.ristetrug.dk` — cafe-database kopieret over (gjort maj 2026)
- Sikkerhed: runner aborterer hvis env'et ikke peger på test-mål

**Database-driver:** `node:sqlite` via `db/compat.js`'s `openDb()` — ingen `better-sqlite3`
eller andre native pakker (jf. CLAUDE.md "ingen native npm-pakker").

---

## 4. Mini-seed: 8 bonner over 5 dage

Periode: **ma 11/5 – fr 15/5 / 2026** (uge 20).

| Bon | Dato | Status | Pax | is_offer | Linjer |
|-----|------|--------|----:|:--------:|--------|
| 4001 | Ma 11/5 | **LEVERET** | 50 | 0 | Falaflen ×30, Kyllingen ×20, RR Boks ×50, Transportkasse ×3 |
| 4002 | Ma 11/5 | **FAKTURERET** | 30 | 0 | Frikadellen-Slider ×15, Tunen ×15, RR Boks ×30, Transportkasse ×2 |
| 4003 | Ti 12/5 | **KLAR** | 50 | 0 | Kyllingen ×40, Falaflen ×10, RR Boks ×50, Transportkasse ×3 |
| 4004 | Ti 12/5 | **AFLYST** | 25 | 0 | Tunen ×25, RR Boks ×25 *(skal IKKE indgå i normal aggregering)* |
| 4005 | On 13/5 | **IGANG** | 70 | 0 | Tunen ×60, Kålen ×10, RR Boks ×60, Transportkasse ×4 |
| 4006 | To 14/5 | **GODKENDT** | 25 | 0 | Falaflen ×20, Kålen ×5, RR Boks ×20, Transportkasse ×2 |
| 4007 | Fr 15/5 | **VENTER** | 40 | 0 | Kyllingen ×30, Frikadellen-Slider ×10, RR Boks ×40, Transportkasse ×3 |
| 4008 | To 14/5 | **VENTER** | 40 | **1** | Falaflen ×25, Tunen ×15, RR Boks ×40, Transportkasse ×3 |

**Statusspredning:** alle status-koder er repræsenteret minus NY og AFSLUTTET.
**Tilbud:** bon 4008 er tilbud (`is_offer=1`) i status VENTER.

**Bon-numre:** 4001–4008 valgt for at undgå kollision med produktion (seneste prod-bon er 3479
pr. maj 2026, ca. 20 nye pr. uge — 4000-serien er sikker buffer).

---

## 5. Mock Grocy-fixture (kun til Niveau B)

Niveau A og C testes mod SQLite alene — `bon_lines` indeholder allerede alle priser snapshot'et.
**Kun niveau B** (råvarebehov) kræver Grocy.

`tests/fixtures/grocy_snapshot.json` genereres af `tests/scripts/snapshot_grocy.js` ved at
læse opskrifter + ingredienser + priser fra Grocy test-instans. Indhold:

| # | Produkt | Kategori | Salgspris (catering) incl |
|---|---------|----------|--------------------------:|
| 1 | Falaflen | 01 Sandwich | 104,00 |
| 2 | Kyllingen | 01 Sandwich | 104,00 |
| 3 | Tunen | 01 Sandwich | 99,00 |
| 4 | Kålen | 02 Salat | 110,00 |
| 5 | Frikadellen-Slider | 04 Slider | 65,00 |
| 6 | RR Boks | 06 Emballage | 0,00 |
| 7 | Sliderbox | 06 Emballage | 0,00 |
| 8 | Transportkasse | 06 Emballage | 12,50 |

### 5.1 Patch-step: opdater grocy_recipe_id

Efter snapshot kører `tests/scripts/patch_grocy_recipe_ids.js` mod test.db og opdaterer
`bon_lines.grocy_recipe_id` baseret på `product_name` → snapshot lookup. Uden dette step er alle
linjer registreret med `grocy_recipe_id=0` (placeholder fra seed) og havner i
`lines_without_recipe` — niveau B-tests ville teste tom data.

```bash
npm run test:reset       # 1. ren test.db + seed
npm run test:snapshot    # 2. dump Grocy → grocy_snapshot.json
npm run test:patch       # 3. patch grocy_recipe_id på bon_lines
npm run test:server &    # 4. start test-server
npm run test:run         # 5. kør runner
```

---

## 6. Filter-scenarier (kritisk for facit)

Backend (`routes/kitchen.js` linje ~125) har følgende **default**:
```javascript
['GODKENDT', 'IGANG', 'KLAR', 'LEVERET']
```

Det betyder VENTER, FAKTURERET og AFLYST er UDE af default. Frontend lader brugeren
vælge andre status-sæt (huskes via localStorage). Tilbud kan toggles client-side
via `_plShowOffers` (default false) — bemærk: kun localStorage, ingen synlig UI-toggle.

**Vigtig backend-adfærd:** backend OR'er ALTID `is_offer = 1` ind i WHERE-klausulen
(`routes/kitchen.js:148`):

```sql
AND (sd.code IN (status_codes) OR b.is_offer = 1)
```

Dvs. tilbud (4008) returneres uanset hvilket status-filter der er aktivt — også når
status=AFLYST. Frontend ekskluderer dem så client-side via `_plShowOffers=false`.

**Scenarier vi tester:**

| ID | Filter (status) | Tilbud client-side (`_plShowOffers`) | Bonner i facit |
|----|-----------------|:------------------------------------:|----------------|
| **S1** *(default)* | `[GODKENDT,IGANG,KLAR,LEVERET]` | false | 4001, 4003, 4005, 4006 *(client har ekskluderet 4008)* |
| **S2** | `[GODKENDT,IGANG,KLAR,LEVERET]` | true  | 4001, 4003, 4005, 4006, 4008 |
| **S3** | `[VENTER,GODKENDT,IGANG,KLAR,LEVERET]` | false | 4001, 4003, 4005, 4006, 4007 |
| **S4** | `[VENTER,GODKENDT,IGANG,KLAR,LEVERET,FAKTURERET]` | true | Alle minus 4004 *(7 bonner)* |
| **S5** | `[AFLYST]` | n/a | **4004 + 4008** *(backend OR'er tilbud ind)* |

> **S5-note:** Backend returnerer både 4004 (AFLYST) og 4008 (tilbud, `is_offer=1`). Frontend
> kan så vælge at skjule 4008 client-side. API-tests forventer **begge** bonner i response.

---

## 7. Facit-tabeller pr. scenarie

### 7.1 Scenarie S1 (DEFAULT) — 4 bonner: 4001, 4003, 4005, 4006

#### Niveau A — Antal pr. produkt pr. dag

| Produkt | Ma 11/5 | Ti 12/5 | On 13/5 | To 14/5 | Fr 15/5 | **Uge** |
|---------|--------:|--------:|--------:|--------:|--------:|--------:|
| Falaflen | 30 | 10 | 0 | 20 | 0 | **60** |
| Kyllingen | 20 | 40 | 0 | 0 | 0 | **60** |
| Tunen | 0 | 0 | 60 | 0 | 0 | **60** |
| Kålen | 0 | 0 | 10 | 5 | 0 | **15** |
| Frikadellen-Slider | 0 | 0 | 0 | 0 | 0 | **0** |
| RR Boks | 50 | 50 | 60 | 20 | 0 | **180** |
| Transportkasse | 3 | 3 | 4 | 2 | 0 | **12** |
| **Total enheder** | **103** | **103** | **134** | **47** | **0** | **387** |

#### Niveau A — Antal pr. kategori pr. dag

| Kategori | Ma | Ti | On | To | Fr | **Uge** |
|----------|---:|---:|---:|---:|---:|--------:|
| 01 Sandwich | 50 | 50 | 60 | 20 | 0 | **180** |
| 02 Salat | 0 | 0 | 10 | 5 | 0 | **15** |
| 04 Slider | 0 | 0 | 0 | 0 | 0 | **0** |
| 06 Emballage | 53 | 53 | 64 | 22 | 0 | **192** |
| **Total** | **103** | **103** | **134** | **47** | **0** | **387** |

#### Niveau A — Bonner og pax pr. dag

| | Ma | Ti | On | To | Fr | **Uge** |
|--|---:|---:|---:|---:|---:|--------:|
| Bonner | 1 | 1 | 1 | 1 | 0 | **4** |
| Pax | 50 | 50 | 70 | 25 | 0 | **195** |

#### Niveau C — Omsætning, moms, kostpris, DB pr. dag

| Dato | Oms. **incl** | Oms. **ex** | Moms (25%) | Kostpris **ex** | DB | DB% |
|------|--------------:|------------:|-----------:|----------------:|---:|----:|
| Ma 11/5 | 5 237,50 | 4 190,00 | 1 047,50 | 1 334,00 | 2 856,00 | 68,2 % |
| Ti 12/5 | 5 237,50 | 4 190,00 | 1 047,50 | 1 334,00 | 2 856,00 | 68,2 % |
| On 13/5 | 7 090,00 | 5 672,00 | 1 418,00 | 1 791,60 | 3 880,40 | 68,4 % |
| To 14/5 | 2 655,00 | 2 124,00 | 531,00 | 668,00 | 1 456,00 | 68,6 % |
| Fr 15/5 | 0,00 | 0,00 | 0,00 | 0,00 | 0,00 | n/a |
| **Uge** | **20 220,00** | **16 176,00** | **4 044,00** | **5 127,60** | **11 048,40** | **68,3 %** |

**Beregningsdetalje for ma 11/5 (kun bon 4001 i S1):**

| Linje | Antal × Sals incl | Linje incl | Antal × Kostpris ex | Linje kost |
|-------|-------------------|----------:|---------------------|----------:|
| Falaflen | 30 × 104,00 | 3 120,00 | 30 × 25,00 | 750,00 |
| Kyllingen | 20 × 104,00 | 2 080,00 | 20 × 25,00 | 500,00 |
| RR Boks | 50 × 0,00 | 0,00 | 50 × 1,50 | 75,00 |
| Transportkasse | 3 × 12,50 | 37,50 | 3 × 3,00 | 9,00 |
| **Total incl** | | **5 237,50** | | **1 334,00** |
| **Total ex** (÷ 1,25) | | **4 190,00** | | |

### 7.2 Scenarie S2 — S1 + tilbud (5 bonner)

Forskellen til S1 er udelukkende på To 14/5 hvor bon 4008 (tilbud, 83 enheder) tilføjes.

| Dag | Total enheder | Bonner |
|-----|--------------:|-------:|
| Ma 11/5 | 103 | 1 |
| Ti 12/5 | 103 | 1 |
| On 13/5 | 134 | 1 |
| To 14/5 | **130** *(47 + 83)* | **2** |
| Fr 15/5 | 0 | 0 |
| **Uge** | **470** | **5** |

#### Niveau C — kun To 14/5 ændres (4006 + 4008)

| Linje | Antal × Sals incl | Linje incl |
|-------|-------------------|----------:|
| Falaflen (4006: 20 + 4008: 25) | 45 × 104,00 | 4 680,00 |
| Tunen (4008) | 15 × 99,00 | 1 485,00 |
| Kålen (4006) | 5 × 110,00 | 550,00 |
| RR Boks (60) | 60 × 0,00 | 0,00 |
| Transportkasse (5) | 5 × 12,50 | 62,50 |
| **Total To 14/5 incl** | | **6 777,50** |

To 14/5 incl moms: **6 777,50** | ex moms: **5 422,00** | moms: **1 355,50**

### 7.3 Scenarie S3 — DEFAULT + VENTER (5 bonner: + 4007)

Tilføjer 4007 på Fr 15/5 (83 enheder, 30 Kyllingen + 10 Frikadellen-Slider + 40 RR Boks + 3 Transportkasse).

| Dag | Total enheder |
|-----|--------------:|
| Ma 11/5 | 103 |
| Ti 12/5 | 103 |
| On 13/5 | 134 |
| To 14/5 | 47 |
| Fr 15/5 | **83** *(0 + 83)* |
| **Uge** | **470** |

### 7.4 Scenarie S4 — alle ekskl. AFLYST + tilbud (7 bonner)

Tilføjer 4002 på Ma 11/5 (62 enheder) + 4007 + 4008. AFLYST 4004 ekskluderes.

| Dag | Total enheder | Bonner |
|-----|--------------:|-------:|
| Ma 11/5 | **165** | **2** |
| Ti 12/5 | 103 | 1 |
| On 13/5 | 134 | 1 |
| To 14/5 | 130 | 2 |
| Fr 15/5 | 83 | 1 |
| **Uge** | **615** | **7** |

### 7.5 Scenarie S5 — eksplicit AFLYST + tilbud (backend-niveau)

Backend returnerer **2 bonner**: 4004 (AFLYST) + 4008 (tilbud OR'es altid ind).

| Bon | Dato | Total enheder |
|-----|------|--------------:|
| 4004 | Ti 12/5 | 50 |
| 4008 | To 14/5 | 83 |
| **Total** | | **133** |

> Frontend kan client-side filtrere 4008 fra (via `_plShowOffers=false`). API-tests
> forventer begge bonner i response.

---

## 8. Test-cases

Format: hver case har **ID, formål, hvor, forventet, scenarie**.

### 8.1 API tests — `/api/bons/planning`

| ID | Formål | Hvor | Forventet |
|----|--------|------|-----------|
| **T_PLAN_API_01** | Default filter returnerer 5 bonner (4 normal + 1 tilbud) | curl `?from=2026-05-11&to=2026-05-15` | Bons: 4001, 4003, 4005, 4006, 4008 |
| **T_PLAN_API_02** | AFLYST ekskluderet i default | Som A_01 | 4004 ikke i resultat |
| **T_PLAN_API_03** | Tilbud (4008) inkluderes i default uanset status | Som A_01 | 4008 i resultat selvom status=VENTER |
| **T_PLAN_API_04** | Eksplicit status=AFLYST returnerer 4004 + 4008 | curl `?status=AFLYST` | `['4004','4008']` |
| **T_PLAN_API_05** | Multiple statusser virker | curl `?status=GODKENDT,VENTER` | 4006, 4007, 4008 |
| **T_PLAN_API_06** | Dato-range bounds inklusiv | curl `?from=2026-05-11&to=2026-05-11` | Kun bonner med delivery_date=2026-05-11 |
| **T_PLAN_API_07** | Dato-range ekskl. uden for | curl `?from=2026-05-12&to=2026-05-15` | Bon 4001+4002 (11/5) ikke i resultat |
| **T_PLAN_API_08** | Hver bon har lines-array udfyldt | Som A_01 | `bon.lines.length > 0` for alle |
| **T_PLAN_API_09** | Lines indeholder alle felter | Som A_01 | grocy_recipe_id, product_name, category, quantity, unit_price, cost_price, line_total, is_accessory |
| **T_PLAN_API_10** | Sortering: delivery_date, pickup_time, id | Som A_01 | 4001 før 4002 (samme dato, lavere id) |
| **T_PLAN_API_11** | price_category_code joined fra price_categories | Som A_01 | bon.price_category_code = 'catering' |
| **T_PLAN_API_12** | Tom periode returnerer tom liste, ikke fejl | curl `?from=2026-06-01&to=2026-06-07` | `[]` med status 200 |

### 8.2 Frontend aggregering — `_plAggregate()` (S1 default + alle valgt)

Test-flow: Playwright åbner planning.html, vælger uge 20/2026, klikker "Vælg alle", asserter på DOM.

**Faktiske selectors fra `shared/planning.js`:**
- `#plFrom`, `#plTo` — dato-inputs
- `#plSelectAll` — "Vælg alle"-knap
- `.pl-bon-check[data-bon-id]` — bon-checkboxes
- `#plBonCount` — bon-tæller
- `.pl-bon-units` — enheder pr. bon
- `#plVatToggle` — moms-toggle (m/u)
- `.pl-empty` — "Ingen bons / Ingen varer"-besked
- `.pl-result-row` — rækker i aggregeringstabellen

| ID | Formål | Forventet | Status |
|----|--------|-----------|:------:|
| **T_PLAN_AGG_01** | Total enheder pr. produkt | Falaflen=60, Kyllingen=60, Tunen=60, Kålen=15, RR Boks=180, Transportkasse=12 | aktiv |
| **T_PLAN_AGG_02** | Total enheder samlet | 387 | aktiv |
| **T_PLAN_AGG_03** | Vægtet snit unit_price = enhedspris | Falaflen=104,00 (alle linjer var 104) | aktiv |
| **T_PLAN_AGG_04** | totalCost = SUM(line.cost_price × quantity) | 5 127,60 (jf. §7.1) | aktiv |
| ~~T_PLAN_AGG_05~~ | ~~Tilbudstoggle skifter scenarie~~ | **SKIP** — `_plShowOffers` er kun localStorage, ingen synlig UI-toggle. Test ved at sætte `localStorage.planning_show_offers='true'` direkte. | skip |
| **T_PLAN_AGG_06** | "Vælg alle" markerer alle synlige bonner | `.pl-bon-check:checked` count = 4 (S1) eller 5 (S2 efter localStorage-flip) | aktiv |
| **T_PLAN_AGG_07** | Ingen valgt = tom resultat | `.pl-empty` synlig med tekst "Ingen varer" | aktiv |
| **T_PLAN_AGG_08** | Aggregering nøgles korrekt på product_name når grocy_recipe_id=0 | Falaflen 30+10+20 = 60, ikke separate linjer | aktiv |
| **T_PLAN_AGG_09** | Status-filter persisteres i localStorage | Reload bevarer `planning_status_filter` | aktiv |
| **T_PLAN_AGG_10** | VAT-toggle skifter incl/excl visning | Total ændres fra 20 220 til 16 176 | aktiv |
| **T_PLAN_AGG_11** | Accessory-håndtering | RR Boks vises (er ikke skjult) | aktiv |
| **T_PLAN_AGG_12** | Sortering: kategori → navn (dansk locale) | "01 Sandwich" før "02 Salat" | aktiv |

### 8.3 Råvarer — `/api/bons/planning/ingredients`

Test mod live Grocy. Forudsætter at `tests/scripts/patch_grocy_recipe_ids.js` er kørt så
`bon_lines.grocy_recipe_id` peger på faktiske recipe-ID'er. Hvis snapshot eller patch
mangler, SKIPpes ING-tests.

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_PLAN_ING_01** | Anmodning med 1 bon-id returnerer ingredienser | bon_ids=[4001] → ingredients-array ikke-tom |
| **T_PLAN_ING_02** | Anmodning med flere bon-ids aggregerer på tværs | bon_ids=[4001,4003] → ≥ ingredienser end [4001] alene |
| **T_PLAN_ING_03** | Linjer uden grocy_recipe_id rapporteres separat | lines_without_recipe-array indeholder navne |
| **T_PLAN_ING_04** | Tom anmodning returnerer tomme arrays | bon_ids=[], extra_lines=[] → `{ingredients:[], groups:[], lines_without_recipe:[]}` |
| **T_PLAN_ING_05** | Extra-lines tilføjer ad hoc ingredienser | extra_lines=[{grocy_recipe_id:42, quantity:5}] → ingredienser inkluderet |
| **T_PLAN_ING_06** | Production vs raw differentieret | Output har separate `production` og `raw` blokke (jf. resolveIngredients) |
| **T_PLAN_ING_07** | GET med ids=parameter virker | GET `?ids=4001,4003` ækvivalent til POST med bon_ids |
| **T_PLAN_ING_08** | Ingen ids → 400 fejl | GET uden ids returnerer `{error:'ids param påkrævet'}` |

### 8.4 Filter-tests (status-scenarier)

| ID | Scenarie | Forventede bonner |
|----|----------|-------------------|
| **T_PLAN_FIL_01** | S1 (default) | 4001, 4003, 4005, 4006, **4008** *(backend; 4008 skjules client-side)* |
| **T_PLAN_FIL_02** | S2 (default + offers ON client-side via localStorage) | Backend giver samme 5 bons, alle vises |
| **T_PLAN_FIL_03** | S3 (+ VENTER) | + 4007 |
| **T_PLAN_FIL_04** | S4 (+ FAKTURERET) | + 4002, 4007 |
| **T_PLAN_FIL_05** | S5 (kun AFLYST) | 4004 + 4008 |
| **T_PLAN_FIL_06** | Filter persisteres på tværs af reloads | localStorage `planning_status_filter` korrekt |

### 8.5 Pris/moms-tests

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_PLAN_PRICE_01** | bon_lines.unit_price er INCL moms (snapshot) | jf. moms-doktrin §6b |
| **T_PLAN_PRICE_02** | bon_lines.cost_price er EX moms | jf. moms-doktrin §6b |
| **T_PLAN_PRICE_03** | Frontend's VAT-toggle: `_plVatMode='incl'` → viser unit_price som det er | Faktiske kr-tal stemmer med §7.1 incl |
| **T_PLAN_PRICE_04** | `_plVatMode='excl'` → unit_price/1,25 | Faktiske kr-tal stemmer med §7.1 ex |
| **T_PLAN_PRICE_05** | totalCost (kostpris) påvirkes IKKE af VAT-toggle | cost_price er altid ex moms |
| **T_PLAN_PRICE_06** | DB% korrekt beregnet | (oms_ex - kost_ex) / oms_ex × 100 ≈ 68,3 |
| **T_PLAN_PRICE_07** | Vægtet gennemsnit korrekt på tværs af forskellige cost_price | Hvis Falaflen i bon A har cost=25 og bon B har cost=27, snit = vægtet med quantity |

### 8.6 Edge cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_PLAN_EDGE_01** | Tom periode | API: tom liste, frontend: "Ingen bonner i perioden" |
| **T_PLAN_EDGE_02** | Bon på grænsedato | from=11/5 inkluderer 11/5; from=12/5 ekskluderer |
| **T_PLAN_EDGE_03** | Bon med 0 linjer | Vises i bon-liste men aggregeres til 0 enheder |
| **T_PLAN_EDGE_04** | Linje uden grocy_recipe_id | Aggregeres på product_name+unit |
| **T_PLAN_EDGE_05** | Periode > 1 uge | Aggregering korrekt på tværs af måned |
| **T_PLAN_EDGE_06** | Tilbud i S1 (default-tilbud client-skjult) | Bon 4008 i `_plBons` men ikke i `_plRenderBonList` |

---

## 9. Test-runner output (eksempel)

```
T_PLAN — 2026-05-12 14:30
Miljø: localhost:4322 / data/test.db / Grocy: grocytest.ristetrug.dk
Scenarie-dækning: S1 ✓ S2 ✓ S3 ✓ S4 ✓ S5 ✓

API-tests       12 PASS, 1 FAIL  (T_PLAN_API_11: kendt bug i kitchen.js:145)
DB-facit         5 PASS, 0 FAIL
Aggregering     11 PASS, 0 FAIL  (kører separat via Playwright)
Råvarer          5 PASS, 0 FAIL  (forudsætter test:patch er kørt)
Filter           5 PASS, 0 FAIL
Pris/moms        7 PASS, 0 FAIL
Edge cases       6 PASS, 0 FAIL

Sum: 51 PASS, 1 FAIL, 1 SKIP
```

---

## 10. Filer der skal eksistere

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_PLAN.md` | Denne fil | ✅ |
| `tests/fixtures/seed_planning.sql` | 8 bonner + 30 linjer | ✅ |
| `tests/fixtures/grocy_snapshot.json` | Snapshot af 8 opskrifter+ingredienser | 🔲 *(genereres af test:snapshot)* |
| `tests/scripts/snapshot_grocy.js` | Læser Grocy → JSON | ✅ |
| `tests/scripts/safety_check.js` | Validerer .env.test før kørsel | ✅ |
| `tests/scripts/apply_fixture.js` | Kører .sql-fixture mod test.db (node:sqlite) | ✅ |
| `tests/scripts/patch_grocy_recipe_ids.js` | Opdaterer bon_lines.grocy_recipe_id efter snapshot | ✅ |
| `tests/scripts/run_T_PLAN.js` | Test-runner — udfører cases, sammenligner med facit | ✅ |
| `tests/playwright/T_PLAN_AGG.spec.js` | Playwright-tests for aggregering | ✅ |
| `tests/reports/T_PLAN_YYYY-MM-DD.md` | Genereres ved hver kørsel | 🔲 |

---

## 11. Verifikation før implementering starter

| | |
|--|--|
| ☑ | Stikprøve §7.1 — ma 11/5: 103 enheder, 5 237,50 kr incl. moms i S1 (verificeret) |
| ☑ | Bon 4008 reflekterer faktisk tilbuds-flow — VENTER + is_offer=1 (verificeret) |
| ☑ | DB% omkring 68 % — realistisk for ren produktion uden indirekte omkostninger |
| ☑ | Default-status `[GODKENDT,IGANG,KLAR,LEVERET]` er bevidst — VENTER ekskluderet (besluttet maj 2026) |
| ☑ | Backend OR'er `is_offer=1` ind uanset status-filter — afspejlet i S5-facit |

---

## 12. Test-runner-arkitektur

`tests/scripts/run_T_PLAN.js` har tre faser:

```
fase 1: Setup (manuel)
  - npm run test:reset      → safety_check + frisk test.db + seed
  - npm run test:snapshot   → refresher grocy_snapshot.json
  - npm run test:patch      → opdater grocy_recipe_id på bon_lines
  - npm run test:server &   → start på port 4322

fase 2: Test-cases
  - npm run test:run
  - Læs T_PLAN.md (eller cases hardcoded i run_T_PLAN.js)
  - For hver case: kør curl/SQL/Playwright, sammenlign mod facit
  - Markér PASS / FAIL / SKIP

fase 3: Rapport
  - Skriv tests/reports/T_PLAN_YYYY-MM-DD.md
  - Exit-kode 0 hvis alle PASS, 1 ellers
```

Playwright-tests kører i headless mode mod test-serveren. Cases der kræver UI-interaktion
(klik, status-filter-toggle, vælg-alle-knap) kører i Playwright; rene API-cases kører via
fetch fra runneren.

---

## 13. Bugs fundet via T_PLAN

| ID | Bug | Sted | Status |
|----|-----|------|--------|
| **T_PLAN_API_11** | `price_category_code` returneres altid som NULL | `routes/kitchen.js:145` joinede `b.price_category` (TEXT) mod `pc.id` (INTEGER) i stedet for `b.price_category_id` | ✅ **Fixet** maj 2026 — én karakter |
| seed-konsistens | `bons.total_price` = 4287,50 men `SUM(bon_lines.line_total)` = 4122,50 på bon 4008 | `tests/fixtures/seed_planning.sql` | ✅ **Fixet** maj 2026 |
| Grocy-API | `GET /userfields/recipes` returnerer 405 (kun OPTIONS) — bør være per-recipe path | `tests/scripts/snapshot_grocy.js` brugte feature-detection-kald i stedet for direkte data | ✅ **Fixet** maj 2026 — fjernet det unødvendige kald |
| Grocy-data | TEST_PRODUCTS-aliases matchede ikke 1:1 med faktiske Grocy-navne (leading spaces, citationstegn, "(emballage)"-suffix) | `tests/scripts/snapshot_grocy.js` | ✅ **Fixet** maj 2026 — eksplicit alias→grocyName mapping |

T_PLAN er ikke kun PASS-test — den skal også fange faktiske bugs. Ovenstående var
de første der dukkede op under setup. Hvis flere fanges ved senere kørsler, dokumenteres
de her sammen med fix-ID.

**Kendte produkter som mangler i grocytest** (rapporteres som `lines_without_recipe`):
- `Frikadellen-Slider` — bruges på bon 4002 + 4007 (begge ekskluderet i S1 default)
- `Sliderbox` — bruges ikke i nogen seed-bon (kun listet i §5)

Hvis Frikadellen-Slider tilføjes i grocytest, opdater `TEST_PRODUCTS` i
`snapshot_grocy.js` med den faktiske `grocyName`.

---

## 14. Status — første kørsel maj 2026

```
28 PASS · 0 FAIL · 0 SKIP

API   13/13  ✓
DB     5/5   ✓
ING    6/6   ✓  (efter test:snapshot + test:patch)
PRICE  4/4   ✓
```

T_PLAN-tracken er **færdig** for Fase 1.

---

*Sidst opdateret: maj 2026 — efter gennemgang og tilpasning til faktisk kode.*
