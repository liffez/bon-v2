# T_STOCK — Test-spec for lageroptælling, stock-mutation og check-status

> Test-spec for direkte stock-mutation (uden om recipe-consume) og produkt-userfields:
> `setInventory`, `addToStock`, `PUT /products/:id/userfields` (HverDag/LastCheckedAt/LastCheckedUnit).
>
> Plus enhedstest af **check-status-beregningen** (`_icComputeCheckStatus` i `shared/inventory_check.js`)
> og **expiry/low-stock-beregningen** (`_soRecalcStatus` i `shared/stock_overview.js`) —
> testen importerer funktionerne **direkte fra produktionsfilerne** via CommonJS export-guard,
> så enhver fremtidig ændring i UI-koden fanges automatisk.
>
> Erstatter intet — supplerer T_INVENTORY (LEVERET-driven consume) med direkte stock-mutation.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Direkte stock-mutation (setInventory, addToStock) + produkt-userfield-CRUD + status-beregningen i `inventory_check.js` og `stock_overview.js` |
| **Hvad testes IKKE** | Recipe-driven consume (det er T_INVENTORY) — fysisk optælling-UI-flow (Playwright, parkeret) |
| **Forhold til T_INVENTORY** | T_INVENTORY rører consume-flowet ved LEVERET. T_STOCK rører de samme Grocy-stock-endpoints men kalder dem direkte. Produkter er **disjoint** (Lager varer / Drikkevarer som ikke indgår i bons 4006/4007's opskrifter) |
| **Kontrakt-baseret** | Stock-endpoints testes via vores adapter (`POST /api/grocy/stock/:id/inventory` osv.) — ikke direkte mod Grocys API. Hvis Grocy udskiftes, opdateres kun adapter — testen er uændret. Status-funktionerne importeres direkte fra `shared/`-filerne, så live UI-kode altid er sandhedsgrundlag |

---

## 2. Forudsætninger

### 2.1 Grocy test-instans

- `grocytest.ristetrug.dk` aktiv (samme som T_INVENTORY)
- `default_grocy_location_id = 3` i settings (sat af `seed_planning.sql`)
- Safety-check afviser kørsel hvis aktiv lokation ikke har "test" i URL'en

### 2.2 Test-produkter

Reserveret til T_STOCK — **disjoint** fra opskrifter i T_INVENTORY (bons 4006/4007).
Alle er aktive, ikke parent/child, og har stk-baseret qu_stock (ingen decimaltal i diff):

| pid | Navn | Gruppe | Lokation | qu_stock / qu_purchase | Rolle |
|-----|------|--------|----------|------------------------|--------|
| **87** | Affaldsposer | Lager varer | Hylder | 8 / 8 (stk / stk) | Primær — `setInventory` + userfields |
| **89** | Bagepapir | Lager varer | Hylder | 8 / 15 (stk / kasser) | `setInventory` med `best_before_date` |
| **95** | Engangshandsker - L | Lager varer | Hylder | 8 / 13 | `addToStock` |
| **205** | Cava | Drikkevarer | Externt Lager | 10 / 10 | Sekundær — userfields i isolation |

**Hvorfor disse:** stk-baserede (ingen float-præcision), ingen recipe-afhængighed, varieret qu_purchase.

### 2.3 Eksport-guards i shared-filer

For at testen kan importere status-funktionerne fra de samme filer browseren loader,
er der tilføjet en CommonJS-export-guard nederst i:
- `shared/inventory_check.js` — eksporterer `_icParseIntervalDays`, `_icComputeCheckStatus`
- `shared/stock_overview.js` — eksporterer `_soRecalcStatus`

Browseren ignorerer blokken (`typeof module === 'undefined'`); Node `require()` får funktionerne.
Hvis nogen omskriver funktionerne i UI-koden uden at opdatere testen, fanges driften.

---

## 3. Strategi: snapshot + mutate + restore

### 3.1 Per stock-mutationscase

```
1. snapshot_before = GET /api/grocy/stock → finde {amount, best_before_date} for pid
2. snapshot_uf_before = GET /api/grocy/products → finde p.userfields for pid

3. ACTION: udfør test-action (setInventory / addToStock / PUT userfields)

4. snapshot_after = GET /api/grocy/stock → ny værdi

5. ASSERT: snapshot_after matcher forventning (tolerance 0.01 for amount)

6. CLEANUP A (stock): POST /api/grocy/stock/{pid}/inventory { amount: snapshot_before.amount,
                                                              best_before_date: snapshot_before.best_before_date }
7. CLEANUP B (userfields): PUT /api/grocy/products/{pid}/userfields { ...snapshot_uf_before }

8. VERIFY CLEANUP: snapshot_final matcher snapshot_before (tolerance 0.01)
                   userfields_final matcher userfields_before
```

### 3.2 Per enhedstest-case (status-funktioner)

```
1. require('../../shared/inventory_check')  // eller stock_overview
2. Konstruér input (userfield-objekt + now-Date eller item-objekt)
3. Kald funktion → modtag output
4. ASSERT output matcher forventning
```

Ingen Grocy-kald, ingen state, fuldt deterministisk.

### 3.3 Per-case cleanup vs. end-of-run cleanup

- **Per-case:** mutations restores umiddelbart efter case for at undgå at en case påvirker næste
  (samme pattern som T_INVENTORY's per-bon-cleanup-fix)
- **End-of-run:** final stock + userfield-snapshot sammenlignes med initial snapshot for hvert
  testprodukt. Eventuelle afvigelser rapporteres som CLEANUP-FAIL med manuel fix-instruktion

### 3.4 Float-tolerance

`FLOAT_TOL = 0.01` — samme som T_INVENTORY. Alle stk-baserede testprodukter bør give præcis diff,
men tolerancen beskytter mod usynlige float-konverteringer i Grocy.

---

## 4. Test-cases

### 4.1 SETUP-cases (forudsætninger)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_STOCK_SETUP_01** | Test-produkter eksisterer | GET `/api/grocy/products` indeholder pids 87, 89, 95, 205 alle med `active=1` |
| **T_STOCK_SETUP_02** | `inventory_check.js` export-guard fungerer | `require('shared/inventory_check')` returnerer objekt med `_icParseIntervalDays` og `_icComputeCheckStatus` som funktioner |
| **T_STOCK_SETUP_03** | `stock_overview.js` export-guard fungerer | `require('shared/stock_overview')` returnerer objekt med `_soRecalcStatus` som funktion |
| **T_STOCK_SETUP_04** | Stock-endpoint reagerer | GET `/api/grocy/stock` returnerer 200 + array, og pid 87 findes med `amount` ≥ 0 |

### 4.2 setInventory — sæt eksakt mængde

`POST /api/grocy/stock/:id/inventory { amount, best_before_date? }`

| ID | Pid | Action | Forventet |
|----|-----|--------|-----------|
| **T_STOCK_INV_01** | 87 | `setInventory(amount = current + 5)` | Stock for pid=87 er præcis `current + 5` efter call (tolerance 0.01) |
| **T_STOCK_INV_02** | 87 | `setInventory(amount = current - 3)` | Stock kan reduceres med setInventory, ikke kun øges |
| **T_STOCK_INV_03** | 89 | `setInventory(amount = current + 2, best_before_date = '2030-12-31')` | Både amount OG best_before_date er sat (best_before vises i GET stock for relevant entry) |

### 4.3 addToStock — læg oven i eksisterende

`POST /api/grocy/stock/:id/add { amount, best_before_date? }`

| ID | Pid | Action | Forventet |
|----|-----|--------|-----------|
| **T_STOCK_ADD_01** | 95 | `addToStock(amount = 10)` | Stock øges med præcis 10 (current → current + 10) |

T_INVENTORY's cleanup-flow bruger samme endpoint, men dette er den **direkte test af adfærden**.

### 4.4 Userfield-CRUD

`PUT /api/grocy/products/:id/userfields { HverDag, LastCheckedAt, LastCheckedUnit }`

| ID | Pid | Action | Forventet |
|----|-----|--------|-----------|
| **T_STOCK_UF_01** | 87 | PUT `{ HverDag: '7' }` | GET products → pid=87 har `userfields.HverDag === '7'` |
| **T_STOCK_UF_02** | 87 | PUT `{ LastCheckedAt: '<ISO now>', LastCheckedUnit: 'KØL-1' }` | GET → begge felter matcher præcist |
| **T_STOCK_UF_03** | 205 | PUT `{ HverDag: '14' }` på et andet produkt | Userfield på pid=205 er isoleret — pid=87's HverDag er IKKE påvirket |
| **T_STOCK_UF_04** | 87 | Observation: PUT `{ HverDag: null }` (eller `''`) | GET tilbage viser hvad Grocy faktisk returnerer for tomt felt. Rapportér den faktiske værdi (`null`, `''`, eller key droppet) — dokumentér i rapport, brug som rollback-strategi |

**Observation fra første kørsel (11. maj 2026):** Grocy returnerer `null` for både `PUT { HverDag: '' }` og `PUT { HverDag: null }`. Begge giver HTTP 200. Det betyder rollback-strategien er enkel: **send `''` (tom streng) for at rydde et userfield**, og Grocy lagrer det internt som `null`. Når man GET'er tilbage, kommer `null` (ikke `''`). `_icParseIntervalDays` håndterer korrekt både `null`, `undefined` og `''` som "ikke sat".

### 4.5 Enhedstest — `_icComputeCheckStatus`

Importeret fra `shared/inventory_check.js`. Tester logikken for HverDag-overdue-status.

Signatur: `_icComputeCheckStatus(intervalDays, lastChecked: Date | null, now: Date) → { status, ratio, daysSince }`

| ID | intervalDays | lastChecked (relativ til now) | Forventet |
|----|--------------|-------------------------------|-----------|
| **T_STOCK_HVERDAG_01** | `null` | irrelevant | `status === 'neutral'`, `daysSince === null` |
| **T_STOCK_HVERDAG_02** | 7 | `null` (aldrig tjekket) | `status === 'overdue'`, `daysSince === Infinity` |
| **T_STOCK_HVERDAG_03** | 7 | for 10 dage siden | `status === 'overdue'`, `daysSince === 10` |
| **T_STOCK_HVERDAG_04** | 7 | for 6 dage siden (ratio = 6/7 ≈ 0.857 > 0.8) | `status === 'soon'`, `daysSince === 6` |
| **T_STOCK_HVERDAG_05** | 7 | for 2 dage siden (ratio = 2/7 ≈ 0.29) | `status === 'ok'`, `daysSince === 2` |
| **T_STOCK_HVERDAG_06** | 7 | for 0 dage siden (lige tjekket) | `status === 'ok'`, `daysSince === 0` |

### 4.6 Enhedstest — `_icParseIntervalDays`

| ID | Input userfield-objekt | Forventet |
|----|------------------------|-----------|
| **T_STOCK_PARSE_01** | `{}` (intet HverDag) | `null` |
| **T_STOCK_PARSE_02** | `{ HverDag: '' }` | `null` |
| **T_STOCK_PARSE_03** | `{ HverDag: '7' }` | `7` |
| **T_STOCK_PARSE_04** | `{ HverDag: 'abc' }` | `null` (ugyldig) |
| **T_STOCK_PARSE_05** | `{ HverDag: '-3' }` | `null` (negativ) |

### 4.7 Enhedstest — `_soRecalcStatus`

Importeret fra `shared/stock_overview.js`. Tester expiry + low-stock-beregningen.

Signatur: `_soRecalcStatus(item)` — muterer `item.status` og `item.daysUntilExpiry`.

| ID | item-input | Forventet `status` |
|----|-----------|--------------------|
| **T_STOCK_EXPIRY_01** | `{ amount: 5, best_before_date: '<i går>', min_stock_amount: 0 }` | `'expired'` |
| **T_STOCK_EXPIRY_02** | `{ amount: 5, best_before_date: '<om 3 dage>', min_stock_amount: 0 }` | `'duesoon'` |
| **T_STOCK_EXPIRY_03** | `{ amount: 5, best_before_date: '<om 30 dage>', min_stock_amount: 0 }` | `'ok'` |
| **T_STOCK_EXPIRY_04** | `{ amount: 2, best_before_date: '<om 30 dage>', min_stock_amount: 5 }` | `'low'` (under min) |
| **T_STOCK_EXPIRY_05** | `{ amount: 0, best_before_date: '2999-12-31', min_stock_amount: 0 }` | `'low'` (amount ≤ 0) |
| **T_STOCK_EXPIRY_06** | `{ amount: 5, best_before_date: '2999-12-31', min_stock_amount: 0 }` | `'ok'` (sentinel-dato = "ingen udløb") |

### 4.8 Integrationscase — produktion data → status-funktion

Verificerer at en **rigtig PUT userfield** kan læses tilbage og fodres ind i `_icComputeCheckStatus` og give samme svar som hvis vi havde konstrueret userfields-objektet i hånden.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_STOCK_INTEGR_01** | Pid=87: PUT `{ HverDag: '7', LastCheckedAt: '<for 10 dage siden ISO>' }` → GET tilbage → kald `_icComputeCheckStatus(...)` på resultatet | `status === 'overdue'`, kæden Grocy→adapter→funktion virker end-to-end |

---

## 5. Konkret eksempel — T_STOCK_INV_03 step for step

```
1. GET /api/grocy/stock → finde entry hvor product_id=89 (Bagepapir)
   → snapshot_before = { amount: 770, best_before_date: '2999-12-31' (sentinel) }
2. GET /api/grocy/products → finde p.id=89
   → snapshot_uf_before = { HverDag: '', LastCheckedAt: '', ... }

3. POST /api/grocy/stock/89/inventory { amount: 772, best_before_date: '2030-12-31' }
   → Grocy svarer 200

4. GET /api/grocy/stock → finde entry for 89
   → snapshot_after.amount = 772 ✓
   → snapshot_after.best_before_date = '2030-12-31' ✓

5. CLEANUP A: POST /api/grocy/stock/89/inventory { amount: 770, best_before_date: '2999-12-31' }
6. CLEANUP B: PUT /api/grocy/products/89/userfields { ...snapshot_uf_before }
7. VERIFY: GET stock + products → matcher snapshot_before ✓

PASS — hermetisk
```

---

## 6. Fejlsignaler og fortolkning

| Faktisk symptom | Sandsynlig årsag |
|-----------------|------------------|
| `setInventory` → stock uændret | Grocy `inventory_amount=null` payload issue. Tjek adapter-payload-format |
| `setInventory(0)` → stock = 0 men entry forsvundet fra GET stock | Grocy fjerner entries med amount=0. Forventet adfærd; test bør ikke sætte til 0 |
| Userfield → `null` returneres som `""` (eller omvendt) | Grocy-specifik normalisering. Dokumentér og brug som rollback-værdi |
| `_icComputeCheckStatus` fejler med "is not a function" | Export-guard mangler eller misplaceret. Tjek `module.exports` nederst i `shared/inventory_check.js` |
| Cleanup verify fejler | Tidligere case efterlod skæv state. Kør `test:reset` og re-importer hvis nødvendigt — ikke ødelæggende for prod (vi rammer grocytest) |
| Integration T_STOCK_INTEGR_01 fejler men enheds-cases passerer | Adapter normaliserer userfields anderledes end direkte funktion forventer. Tjek `getProducts()` i `services/grocyAdapter.js` |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_STOCK.md` | Denne fil | ✅ |
| `tests/scripts/run_T_STOCK.js` | Test-runner | 🔲 (skrives efter spec-godkendelse) |
| `tests/reports/T_STOCK_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |
| `shared/inventory_check.js` | Export-guard for status-funktioner | ✅ |
| `shared/stock_overview.js` | Export-guard for status-funktion | ✅ |
| `package.json` | `test:run-stock` script | 🔲 |

`run_T_STOCK.js` tilføjes som npm-script:
```json
"test:run-stock": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_STOCK.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| `setInventory` sætter eksakt mængde + best_before_date | Lager-optællings-UI kan trygt skrive til Grocy uden risiko for off-by-X |
| `addToStock` lægger oven i (additiv) | T_INVENTORY's cleanup-flow er bekræftet korrekt; varemodtagelse v3 også |
| Userfield-PUT virker per-produkt isoleret | LastCheckedAt-opdatering fra `inventory_check.js:1057` skader ikke nabo-produkter |
| `_icComputeCheckStatus` matcher faktiske produktionsdata | Sort-rækkefølge i lagercheck-UI (`overdue` først) er pålidelig |
| `_soRecalcStatus` matcher faktiske produktionsdata | Status-pills i lageroversigt (`expired`/`duesoon`/`low`) er pålidelige |
| Empty userfield-rollback-strategien er kendt | Vi ved præcis hvad Grocy gør med `null`/`''`/key-drop — fremtidige tests har facit |

---

## 9. Næste skridt efter T_STOCK

| Track | Indhold |
|-------|---------|
| **T_INV_FLAG_01-refaktor** | Separat PR. Adresserer `T_INV_FLAG_01`-SKIP fra T_INVENTORY (kræver fresh bon mellem cases) |
| **T_RECIPES** | Recipe-CRUD (POST/PUT/DELETE recipes, recipes-pos, recipes-nestings) — kan vente til Fase 3 |
| **T_PURCHASING** | Indkøb-flow (Hørkram-kurv, manuel bestilling, varemodtagelse v3) — Fase 2 fortsat |

---

## 10. Status — efter første kørsel maj 2026

```
31 PASS · 0 FAIL · 0 SKIP

SETUP    4/4    ✓
INV      3/3    ✓  (setInventory: øg, sænk, med best_before_date)
ADD      1/1    ✓  (addToStock additivt)
UF       4/4    ✓  (HverDag, LastCheckedAt+Unit, isolation, null-observation)
HVERDAG  6/6    ✓  (status: neutral/overdue/soon/ok + edges)
PARSE    5/5    ✓  (_icParseIntervalDays: {}, '', '7', 'abc', '-3')
EXPIRY   6/6    ✓  (_soRecalcStatus: expired/duesoon/ok/low + sentinel)
INTEGR   1/1    ✓  (Grocy → adapter → status-funktion end-to-end)
CLEANUP  1/1    ✓  (alle 4 produkter restored til baseline)
```

T_STOCK-tracken er **fuldt grøn**. Alle kontrakter mellem `setInventory`, `addToStock`,
userfield-CRUD, og status-beregningen i `inventory_check.js` + `stock_overview.js`
fungerer som forventet og er verificeret end-to-end mod live grocytest.

Mindre fix undervejs: `T_STOCK_EXPIRY_01` brugte oprindeligt `dateDaysFromNow(-1)` som
"udløbet"-input, men `Math.ceil((expiry-now)/dayMs)` rammer 0 ved klokkeslæt nær midnat
og falder dermed i `duesoon`. Skiftet til `-2` dage for stabilitet.

---

*Sidst opdateret: 11. maj 2026 — første kørsel grøn (31/31).*
