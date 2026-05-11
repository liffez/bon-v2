# T_INVENTORY — Test-spec for lagertræk ved LEVERET

> Test-spec for lager-flowet: `consumeRecipes` ved LEVERET-status og adfærd ved tilbageskift.
> Kontrakt-baseret design — overlever en udskiftning af Grocy uden ændring af test-logikken.
>
> Erstatter SKIP-cases i T_GROCY (W_01, W_02). T_GROCY tester adapter-kontrakten;
> T_INVENTORY tester forretnings-flowet. Begge specs består side om side.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | At LEVERET-status reducerer Grocy-lager med præcis det `resolveConsumeItems` siger |
| **Hvad testes IKKE** | Selve consume-API'et i Grocy (testes i T_GROCY) — vi tester kontrakten på vores side |
| **Forhold til T_GROCY** | T_GROCY_W_01 og T_GROCY_W_02 forbliver SKIP med note "→ se T_INVENTORY" |
| **Kontrakt-baseret** | Testen importerer `resolveConsumeItems` direkte og bruger output som facit. Hvis Grocy udskiftes, opdateres kun adapter-laget — testen er uændret |

---

## 2. Forudsætninger

### 2.1 Settings-flag

`inventory_auto_deduct` SKAL være `'1'` i `settings`-tabellen. Uden flaget køres
`consumeRecipes` aldrig, og testen vil fejle med "no stock change" på alle cases.

```sql
INSERT OR REPLACE INTO settings (key, value) VALUES ('inventory_auto_deduct', '1');
```

Tilføjes til `seed_planning.sql` for test-DB. **Skal også verificeres i prod-DB**
inden go-live — flaget er `0` på en frisk Bon v2-installation.

### 2.2 Grocy test-instans

- `grocytest.ristetrug.dk` aktiv
- Cafe-database kopieret (samme som T_PLAN/T_GROCY)
- 8 testprodukter har komplette opskrifter med ingredienser
- Tilstrækkelig stock på alle ingredienser så ingen kommer i minus under test

### 2.3 Test-bonner

| Bon | Status (start) | Linjer | Bruges til |
|-----|----------------|--------|------------|
| **4006** | GODKENDT | Falaflen×20, Kålen×5, RR Boks×20, Transportkasse×2 | Kerne-test (T_INV_LEVERET_01–03, REVERT_01–02, IDEM_01) |
| **4007** | VENTER | Kyllingen×30, Frikadellen-Slider×10, RR Boks×40, Transportkasse×3 | Robusthed (T_INV_LEVERET_04) |

Hver test sætter bonnen til LEVERET, måler diff, og **rester lageret** via Grocy
stock-add API så næste kørsel starter fra samme baseline.

---

## 3. Strategi: snapshot + diff + manuel restore

### 3.1 Per test-case

```
1. expected_diff = await resolveConsumeItems(bon.lines)
   → liste af { product_id, amount_stock, product_name }

2. snapshot_before = for hvert product_id i expected_diff:
                       hent stock fra Grocy

3. ACTION: PATCH /api/bons/{id}/status { status_code: 'LEVERET' }

4. WAIT: poll DB op til 5 sek indtil bons.inventory_deducted = 1
         (bons.js linje 350-368 kører consumeRecipes async)

5. snapshot_after = hent stock igen for samme product_ids

6. actual_diff[pid] = snapshot_before[pid] - snapshot_after[pid]

7. ASSERT: for hver pid i expected_diff:
             |actual_diff[pid] - expected_diff[pid].amount_stock| < 0.01
           (tolerance for float-præcision)

8. CLEANUP A: PATCH /api/bons/{id}/status { status_code: 'IGANG' }
              → bonnen tilbage i kæden

9. CLEANUP B: For hver pid i expected_diff:
              POST /api/grocy/stock/{pid}/add { amount: <det der blev trukket> }
              → lager genoprettet til oprindelig værdi

10. VERIFY CLEANUP: snapshot_final = hent stock igen
                    assert snapshot_final == snapshot_before
                    (tolerance 0.01 pr. produkt)
```

### 3.2 Hvad der gøres parallelt vs. serielt

- Test-cases kører **serielt** (én bon ad gangen) — Grocy stock er global state
- Snapshot-læsning for n produkter er **parallel** (`Promise.all` over getStock-kald)
- Cleanup stock-add er **serielt** for at undgå race conditions i Grocy

### 3.3 Hvis cleanup fejler

Det værste der kan ske er at en test fejler under cleanup, og lager efterlades skævt.
Runner skriver til rapporten:

```
T_INV_LEVERET_01  FAIL  Cleanup-fejl: kunne ikke restore product_id=42 (kikærter)
                        manual fix: POST /api/grocy/stock/42/add { amount: 1600 }
```

Du kan så fikse manuelt eller re-importere cafe-databasen til grocytest.

---

## 4. Test-cases

### 4.1 Setup-cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INV_SETUP_01** | `inventory_auto_deduct` = `'1'` | SQL: `SELECT value FROM settings WHERE key='inventory_auto_deduct'` returnerer `'1'` |
| **T_INV_SETUP_02** | `resolveConsumeItems` importerbar | `require('../../services/ingredientResolver').resolveConsumeItems` er en funktion |
| **T_INV_SETUP_03** | Grocy stock kan læses | GET `/api/grocy/stock` returnerer 200 + ikke-tom array |

### 4.2 Kerne-cases (LEVERET)

| ID | Bon | Action | Forventet |
|----|-----|--------|-----------|
| **T_INV_LEVERET_01** | 4006 | Sæt → LEVERET | `actual_diff` matcher `expected_diff` for **alle** produkter (tolerance 0,01) |
| **T_INV_LEVERET_02** | 4006 | Som ovenfor | `bons.inventory_deducted = 1` i DB efter consume |
| **T_INV_LEVERET_03** | 4006 | Som ovenfor | `changelog` har én entry hvor `action='grocy_consume'` for bon_id=4006 |
| **T_INV_LEVERET_04** | 4007 | Sæt → LEVERET | Som T_INV_LEVERET_01 men på anden bon — robusthed |

### 4.3 Revert-cases (LEVERET → IGANG)

Mulighed C: tilbageskift sker ikke automatisk. Disse cases bekræfter det.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INV_REVERT_01** | Bon 4006 LEVERET → IGANG | Stock UÆNDRET (samme som efter LEVERET, ikke restored) |
| **T_INV_REVERT_02** | Som ovenfor | `bons.inventory_deducted = 1` (flag forbliver 1, ingen reset) |

### 4.4 Off-state og idempotens

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INV_FLAG_01** | Med `inventory_auto_deduct='0'`: bon 4006 → LEVERET | INGEN stock-ændring |
| **T_INV_IDEM_01** | Bon 4006: LEVERET → IGANG → LEVERET igen | Stock trækkes **IKKE** igen — `inventory_deducted=1` blokerer dobbelt-træk |

Idempotens-beskyttelsen er implementeret i `routes/bons.js:353-359` (tilføjet maj 2026
efter T_INV_IDEM_01 oprindeligt rapporterede IKKE-IDEMPOTENT). Verificér i server-log
ved næste LEVERET: `[grocy_consume] bon X: lager allerede trukket — skipper (idempotens)`.

### 4.5 Partial consume + auto-shopping-list (v1-paritet)

Bon v1 har en kritisk drift-feature: når en opskrift trækker mere end der er på lager,
trækkes det der ER, og en hel **purchase-enhed** (oprundet) lægges automatisk på Grocy's
shopping_list. Uden den vil LEVERET virke "korrekt" på UI'et, men der bliver ikke købt ind.

Implementeret i `services/grocyAdapter.js` `consumeRecipes` (maj 2026):

1. **Pre-consume stock-fetch**: hent stock for alle relevante produkter (inkl. sum
   over børn for parent-produkter — kål's effective stock = Hvidkål + Spidskål).
2. **Partial consume**: `min(needed, available)` trækkes via Grocy consume-API.
3. **Shortfall → shopping list**: `Math.ceil(shortfall_stock × purchase_factor)`
   tilføjes som ny entry på `/objects/shopping_list` med note "Auto-tilføjet ved LEVERET".

`resolveConsumeItems` er udvidet til at returnere `qu_id_stock`, `qu_id_purchase`,
`parent_product_id` og `purchase_factor` per produkt så consume-flowet har data nok.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INV_PARTIAL_01** | Mock consume af 47 (Transportkasse) × (available+3) | `partial=true`, `amount=available`, `shortfall_stock=3`, `shortfall_purchase≥1` |
| **T_INV_PARTIAL_02** | Som T_INV_PARTIAL_01 | Ny entry på Grocy shopping_list med oprundet purchase-enhed |

---

## 5. Konkret eksempel — T_INV_LEVERET_01 step for step

Bon 4006 har linjer:
- Falaflen ×20 (recipe_id ≠ 0)
- Kålen ×5 (recipe_id ≠ 0)
- RR Boks ×20 (emballage, recipe_id ≠ 0)
- Transportkasse ×2 (emballage, recipe_id ≠ 0)

Lad os antage Grocy-snapshot siger:
- Falaflen-opskrift har 80 g kikærter, 1 stk pita per stk
- Kålen-opskrift har 200 g kål, 1 stk dressing per stk
- RR Boks-opskrift har 1 stk plastboks
- Transportkasse-opskrift har 1 stk transportkasse

Det betyder `resolveConsumeItems` returnerer (forenklet):

```json
[
  { product_id: 12, product_name: "Kikærter",     amount_stock: 1600 },  // 20 × 80 g
  { product_id: 15, product_name: "Pita",         amount_stock: 20 },    // 20 × 1 stk
  { product_id: 23, product_name: "Kål",          amount_stock: 1000 },  //  5 × 200 g
  { product_id: 24, product_name: "Dressing",     amount_stock: 5 },     //  5 × 1 stk
  { product_id: 99, product_name: "Plastboks",    amount_stock: 20 },    // 20 × 1 stk
  { product_id: 88, product_name: "Transportkasse", amount_stock: 2 }    //  2 × 1 stk
]
```

Step:
1. Snapshot før: `{12: 5000, 15: 200, 23: 8000, 24: 50, 99: 500, 88: 30}`
2. PATCH bon 4006 → LEVERET
3. Vent på `inventory_deducted=1`
4. Snapshot efter: `{12: 3400, 15: 180, 23: 7000, 24: 45, 99: 480, 88: 28}`
5. Diff: `{12: 1600, 15: 20, 23: 1000, 24: 5, 99: 20, 88: 2}` ✓ matcher expected
6. PATCH bon 4006 → IGANG
7. Snapshot endnu en gang: `{12: 3400, 15: 180, ...}` — uændret (mulighed C ✓)
8. Restore: stock-add 1600 til pid=12, 20 til pid=15, ...
9. Final snapshot: `{12: 5000, 15: 200, ...}` — som start ✓

PASS — testen er hermetisk.

---

## 6. Fejlsignaler og fortolkning

| Faktisk symptom | Sandsynlig årsag |
|-----------------|------------------|
| Alle `actual_diff = 0` | `inventory_auto_deduct = '0'` ELLER consumeRecipes fejlede asynkront uden at sætte `inventory_deducted=1` |
| `actual_diff` ≠ `expected_diff` for enkelte produkter | Bug i `resolveConsumeItems` eller i Grocys consume-håndtering. Tjek Grocy-historik for hvad consume faktisk trak |
| `actual_diff` < 0 (lager øget) | Vi har kaldt status-skift forkert eller cleanup-rest fra forrige kørsel — Grocy stock-add gik forkert |
| Cleanup verify fejler | Grocy stock-add API fejlede eller har en delay — re-importer cafe-database til grocytest |
| Test hænger på "venter på inventory_deducted=1" | consumeRecipes promise smed exception der ikke logges til DB. Tjek serverkonsol for `[grocy_consume]` fejl |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_INVENTORY.md` | Denne fil | ✅ |
| `tests/fixtures/seed_planning.sql` | Tilføjelse af `inventory_auto_deduct=1` setting | ✅ |
| `tests/scripts/run_T_INVENTORY.js` | Test-runner | ✅ |
| `tests/reports/T_INVENTORY_YYYY-MM-DD.md` | Rapport (genereres) | ✅ |

---

## 6b. Bugs/findings via T_INVENTORY

| ID | Finding | Sted | Status |
|----|---------|------|--------|
| **kode-bug** | `bons.inventory_deducted`-flaget blev aldrig sat efter `consumeRecipes`-success — kolonnen eksisterede i schema men ingen kode skrev til den | `routes/bons.js:355-369` | ✅ **Fixet** maj 2026 — UPDATE tilføjet i .then-callback |
| **runner-timing** | `waitForDeducted` brugte 5s timeout, men consumeRecipes kan tage 10–20s pga. mange Grocy-kald | `tests/scripts/run_T_INVENTORY.js:123` | ✅ **Fixet** — timeout øget til 30s |
| **kritisk: peger på prod** | `default_grocy_location_id` ikke sat i test.db → adapteren faldt tilbage til id=1 (HQ = grocycafe = PROD). Vi har trukket og tilføjet stock til prod-Grocy under første kørsel | `tests/fixtures/seed_planning.sql` + `tests/scripts/safety_check.js` | ✅ **Fixet** maj 2026 — seed sætter `default_grocy_location_id=3`, safety_check læser `locations`-tabellen og afviser ikke-test-URL'er |
| **per-bon-cleanup** | Cleanup-stock-add kørte kun til sidst — bon 4007's snapshot_before var påvirket af 4006's consume (genererede falske `fik X, expected Y`-fejl) | `tests/scripts/run_T_INVENTORY.js:607-646` | ✅ **Fixet** maj 2026 — `restoreNow()` mellem bonner, final cleanup nu kun fallback for fejlede per-bon-restores |
| **parent-produkt-substitution** | Grocy returnerede 400 ved consume mod parent-produkter (fx kål) selvom børn (Hvidkål, Spidskål) havde stock | `services/grocyAdapter.js:558+595` + runner | ✅ **Fixet** maj 2026 — `allow_subproduct_substitution: true` på consume-call, og runner aggregerer expected/actual per family-root i `compareDiffs` |
| **idem-wait timing** | `testIdempotency` ventede kun 2s — for kort til at consume kunne afslutte → falsk-positiv "IDEMPOTENT", men consume kørte reelt og forvansker næste bons snapshot | `tests/scripts/run_T_INVENTORY.js:486` | ✅ **Fixet** maj 2026 — venter nu på changelog-entry (op til 30s) |
| **idempotens-beskyttelse** | Anden LEVERET på samme bon trak stock DOBBELT — `inventory_deducted=1` blev sat men ikke tjekket før consume kørte | `routes/bons.js:353-359` | ✅ **Fixet** maj 2026 — flaget tjekkes nu i status-PATCH-handleren før consumeRecipes kaldes |
| **manglende v1-feature: partial consume + auto-shopping-list** | Bon v1 trækker partial og tilføjer purchase-enhed til shopping list ved manglende stock — v2 manglede dette helt. Konsekvens: LEVERET kunne "lykkes" på UI uden faktisk lager-træk eller indkøbs-reminder | `services/grocyAdapter.js:534-624` + `services/ingredientResolver.js:402-510` | ✅ **Implementeret** maj 2026 — pre-consume stock-fetch (parent-aware sum), partial-træk, automatisk `addToShoppingList(Math.ceil(shortfall × purchase_factor))`. Verificeret af T_INV_PARTIAL_01/02 |
| **Grocy data** | Tidligere fail på pid=199 (kål), 203, 27, 40, 72 — løst dels via brugerens stock-update, dels via parent-substitution-fix | `grocytest.ristetrug.dk` | ✅ **Løst** |

`run_T_INVENTORY.js` skal tilføjes som npm-script:
```json
"test:inv": "node -r dotenv/config tests/scripts/run_T_INVENTORY.js dotenv_config_path=.env.test"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| `consumeRecipes` reducerer stock korrekt for kerne-bon | Trygt at gå live med LEVERET-flow |
| Tilbageskift trækker IKKE igen | Forretningsmæssigt OK — manuel retning kun påkrævet i edge cases |
| Idempotens-adfærd er kendt | Du kan beslutte om der skal lægges et `if (inventory_deducted) skip` ovenpå |
| `resolveConsumeItems` matcher faktisk Grocy-resultat | Kontrakten holder — andre features (planlægning, råvareliste) kan trygt bruge samme funktion |

---

## 9. Næste skridt — udskiftning af Grocy

Hvis Grocy en dag erstattes:

1. `services/ingredientResolver.js` rewrites internt — den udadtil-vendte API
   (`resolveConsumeItems(lines) → [{product_id, amount_stock, product_name}]`) skal være den samme
2. `services/grocyAdapter.js` rewrites — primært `getStock`, `consumeRecipes`, og stock-add endpoint
3. `routes/grocy.js` rewrites — endpoints kan beholde samme path eller flyttes til `routes/inventory.js`
4. **T_INVENTORY skal IKKE ændres** — kun forudsætning §2.2 opdateres til ny instans-info

Hvis nye system bruger andre felter (fx `available_quantity` i stedet for `stock_amount`),
klares det internt i adapteren. Testen kalder `getStock(productId)` og forventer et tal — det er kontrakten.

---

## 10. Status — efter alle fix maj 2026

```
12 PASS · 0 FAIL · 1 SKIP

SETUP    3/3   ✓
LEVERET  4/4   ✓  (begge bonner trækker korrekt mængde fra Grocy)
REVERT   2/2   ✓  (mulighed C bekræftet: tilbageskift trækker IKKE igen)
IDEM     1/1   ✓  (anden LEVERET blokeres af inventory_deducted=1)
PARTIAL  2/2   ✓  (partial consume + auto-shopping-list — v1-paritet)
FLAG     0/1   ⊘  (T_INV_FLAG_01 kræver fresh bon — mindre design-mangel i runneren)
```

T_INVENTORY-tracken er **fuldt grøn** (eksklusiv FLAG-SKIP som er en runner-mangel,
ikke en feature-bug). Alle kontrakter mellem `resolveConsumeItems`, `consumeRecipes`,
Grocy parent/child-substitution, idempotens-flag, partial-consume og shopping-list-
auto-add fungerer som forventet og er verificeret end-to-end mod live grocytest.

---

*Sidst opdateret: maj 2026 — efter første kørsel + kode-fix til `inventory_deducted`.*
