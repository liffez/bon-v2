# T_INDKOB_LISTE — Test-spec for indkøbslisten (Grocy shopping_list-proxy)

> Test-spec for Bon v2's indkøbsliste — som er en proxy mod Grocys `shopping_list`
> entity. Tester læsning, manuel tilføjelse (smart + rå), fjernelse, bulk-flows
> (manglende/udløbne/forfaldne), userfield-CRUD på linjer, og clear.
>
> Disjoint fra T_STOCK (rører ikke samme produkter) og T_INVENTORY (rører ikke
> consumeRecipes-flowet, kun output-kontrakten på shopping_list).

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | `routes/grocy.js` proxy-endpoints for shopping_list + adapter-funktionerne i `services/grocyAdapter.js`. Inklusiv split-routing for userfields og to forskellige tilføjelses-veje (smart vs rå) |
| **Hvad testes IKKE** | UI-flow (`shared/indkob.js` rendering — Playwright, parkeret). Hørkram-bestilling (T_INDKOB_HORKRAM). Partial-consume → shopping_list-add (T_INVENTORY_PARTIAL). Varemodtagelses-cleanup af shopping_list (T_VAREMODTAGELSE) |
| **Kontrakt-baseret** | Tester direkte mod proxy-endpoints. Hvis Grocy udskiftes, opdateres kun adapter — test-cases er uændrede |
| **Forhold til T_STOCK** | T_STOCK tester direkte stock-mutation + userfields på products. T_INDKOB_LISTE tester shopping_list-entity og dens userfields (`ordered_*`). Helt disjoint produktrum |

---

## 2. Forudsætninger

### 2.1 Grocy test-instans

- `grocytest.ristetrug.dk` aktiv (samme som T_STOCK/T_INVENTORY)
- `default_grocy_location_id = 3` i settings
- Safety-check afviser kørsel hvis aktiv lokation ikke har "test" i URL

### 2.2 Shopping_list state ved test-start

`list_id = 1` er Grocy's default-liste. T_INDKOB_LISTE rører **kun list_id=1** og bruger
snapshot+restore-mønstret fra T_STOCK/T_INVENTORY: list snapshottes ved test-start,
muteres, og restores ved cleanup.

| Scenario | Behandling |
|----------|------------|
| Listen er tom ved test-start | OK — alle tests skaber selv det de bruger |
| Listen har eksisterende entries | OK — vi snapshotter dem og restorer ved cleanup, men opererer kun på vores test-pids |
| Listen er beskadiget fra forrige fejlende kørsel | `npm run test:reset-shopping-list` (ny script — se §7) tømmer via clearShoppingList og logger antal slettede entries |

### 2.3 Test-produkter — persistente på tværs af tracks

Disjoint fra T_STOCK (87, 89, 95, 205) og T_INVENTORY (Falafel, Kylling etc.).
Alle er aktive og ikke parent/child. Enhederne må gerne være **kg** (de fleste
Hørkram-varer er kg-baserede) — ikke krav om stk.

Pids vælges automatisk **ved første kørsel** via helper
`pickDisjointProducts(count=4, exclude=[...])`. Valget persisteres til
`tests/fixtures/T_INDKOB_pids.json` så:

- CI tjekker samme varer ved næste run
- Efterfølgende tracks (T_INDKOB_SETUP, _ADMIN, _HORKRAM, T_VAREMODTAGELSE)
  kan **genbruge samme pids** medmindre de bevidst kræver andre

```json
// tests/fixtures/T_INDKOB_pids.json (genereret ved første run)
{
  "version": 1,
  "selected_at": "2026-05-11T10:30:00Z",
  "grocy_target": "grocytest.ristetrug.dk",
  "pids": {
    "primary":   { "id": 123, "name": "Tomater økologisk", "qu_stock": "kg", "qu_purchase": "kasse" },
    "dedup":     { "id": 145, "name": "Mel hvede 5kg",     "qu_stock": "kg", "qu_purchase": "sæk"   },
    "bulk":      { "id": 167, "name": "Olivenolie 1L",     "qu_stock": "L",  "qu_purchase": "fl"    },
    "isolation": { "id": 189, "name": "Æbler røde",        "qu_stock": "kg", "qu_purchase": "kasse" }
  }
}
```

Hvis fixture-filen eksisterer ved senere kørsler, springes pick-helperen over og
de gemte pids bruges. Hvis et pid ikke længere er aktivt på grocytest, logger
runneren det og smider en SETUP-fejl indtil filen rettes eller slettes.

---

## 3. Strategi: snapshot → mutate → restore

### 3.1 Per test-case

```
1. snapshot_list_before = GET /api/grocy/shopping-list
   → array af { id, product_id, amount, note, userfields, ... }

2. ACTION: udfør test-action (add/remove/PUT/clear/bulk)

3. snapshot_list_after = GET /api/grocy/shopping-list

4. ASSERT: forventede entries findes/mangler i after, qty matcher

5. ROLLBACK:
   a) Slet alle entries på listen der har test-pids
   b) Genopret originale entries (POST /objects/shopping_list med snapshot-data)
   c) Genopret userfields hvis ændret

6. VERIFY ROLLBACK: list_final == list_before (sorteret efter id)
```

### 3.2 Per-case vs. end-of-run cleanup

- **Per-case**: rollback umiddelbart efter case for at undgå "sidste case" påvirker næste
- **End-of-run**: hvis en case fejler under rollback, logges manuel fix-instruktion

### 3.3 Float-tolerance

`FLOAT_TOL = 0.01` — samme som T_STOCK/T_INVENTORY. shopping_list-amount lagres som
text i Grocy; runneren parser via `parseFloat()` og sammenligner med tolerance.

**Bemærk:** Mange Hørkram-varer er kg-baserede, så decimal-amount (`'2.500'` etc.)
er normalt. Stick til tolerance — ikke heltals-sammenligning.

---

## 4. Test-cases

### 4.1 SETUP-cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_SETUP_01** | Endpoints svarer | GET `/api/grocy/shopping-list`, GET `/api/grocy/shopping-locations` returnerer 200 |
| **T_INDKOB_LISTE_SETUP_02** | Test-pids loadet fra fixture (eller udvalgt og gemt ved første kørsel) | `T_INDKOB_pids.json` eksisterer, alle 4 pids er aktive, ingen overlap med T_STOCK/T_INVENTORY |
| **T_INDKOB_LISTE_SETUP_03** | list_id=1 eksisterer | GET shopping-list responderer uden 404 (default-liste) |
| **T_INDKOB_LISTE_SETUP_04** | Adapter eksporterer alle relevante funktioner | `require('services/grocyAdapter')` har `getShoppingList`, `deleteShoppingListItem`, `addShoppingListProduct`, `removeShoppingListProduct`, `addMissingProducts`, `addExpiredProducts`, `addOverdueProducts`, `clearShoppingList`, `updateShoppingListItem`, `addToShoppingList` |

### 4.2 GET — read-funktioner

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_GET_01** | GET `/api/grocy/shopping-list` | Returnerer array. Hver entry har id, product_id, amount (string), note, userfields-objekt |
| **T_INDKOB_LISTE_GET_02** | GET `/api/grocy/shopping-locations` | Returnerer array af shopping-locations (kan være tom) |
| **T_INDKOB_LISTE_GET_03** | Ikke-cachet adfærd | Snapshot, add product, ny GET viser den med det samme (ingen 5s-cache som products) |

### 4.3 ADD — smart endpoint (`addShoppingListProduct`)

Bruger Grocy's `/stock/shoppinglist/add-product` der **dedupper**. Dette er den
**anbefalede vej** for alle nye kald — inkl. `consumeRecipes` partial-add efter
bug-fix (jf. §11 Finding).

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_ADD_01** | `addShoppingListProduct(pids.primary, 5, 1)` | Ny entry med product_id=primary, amount=5 |
| **T_INDKOB_LISTE_ADD_02** | Kald samme `addShoppingListProduct(pids.primary, 3, 1)` igen | **Eksisterende entry's amount = 5+3 = 8** (dedup-verifikation). INGEN ny entry oprettes |
| **T_INDKOB_LISTE_ADD_03** | `addShoppingListProduct` på pids.dedup med amount=2.5 (decimal kg) | Entry har amount=2.5 — float bevares. Hørkram-varer i kg er normalt |
| **T_INDKOB_LISTE_ADD_04** | Oprunding-kontrakt: simulér shortfall=1.3 kg med qu_purchase=5 (kg pr. sæk). Kald-site beregner `Math.ceil(1.3/5)*5 = 5` og sender til adapter | Entry oprettet med amount=5 (oprundet til hel purchase-enhed). Oprundings-ansvar ligger hos kald-site — adapter er rent forward |
| **T_INDKOB_LISTE_ADD_05** | `addShoppingListProduct(pids.primary, 4, 1, 'auto-tilføjet ved LEVERET')` | Entry har note='auto-tilføjet ved LEVERET'. Smart endpoint understøtter note direkte |
| **T_INDKOB_LISTE_ADD_06** | Note overskrives ved gentagne add: `addShoppingListProduct(pids.primary, 4, 1, 'note A')`, derefter `(pids.primary, 2, 1, 'note B')` | Eksisterende entry har amount=6 og note='note B'. Seneste note vinder (Grocy-adfærd) |
| **T_INDKOB_LISTE_ADD_07** | Ukendt list_id (fx 9999) | Returnerer 4xx eller 500 — dokumentér adfærd (observation, ingen assert om specifik kode) |

### 4.4 ADD — rå endpoint (`addToShoppingList`) — kontrakt-test only

Bruger direkte POST til `/objects/shopping_list` — **dedupper IKKE**. Bruges
historisk af `consumeRecipes` (skal udskiftes — jf. §11 Finding). Funktionen
testes for at dokumentere den eksisterende kontrakt, **ikke** som anbefalet brug.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_RAW_01** | `addToShoppingList([{product_id: pids.primary, amount: 5}])` | Ny entry, amount=5 |
| **T_INDKOB_LISTE_RAW_02** | Kald samme igen med `{product_id: pids.primary, amount: 3}` | **TO entries** for primary: én med 5, én med 3 (bevis at smart endpoint skal bruges i stedet) |
| **T_INDKOB_LISTE_RAW_03** | `addToShoppingList` med note-felt | Note persisterer på entry |

### 4.5 REMOVE — smart endpoint (`removeShoppingListProduct`)

Bruger Grocy's `/stock/shoppinglist/remove-product` der **reducerer qty**, ikke sletter entry.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_REMOVE_01** | Tilføj amount=10, kald `removeShoppingListProduct(pids.primary, 3, 1)` | Entry's amount = 10-3 = 7. Entry findes stadig |
| **T_INDKOB_LISTE_REMOVE_02** | Reducer med præcis hele qty (fra 7 → 0) | Entry fjernes eller forbliver med amount=0 — dokumentér Grocys adfærd |
| **T_INDKOB_LISTE_REMOVE_03** | Reducer mere end qty (fra 7 → -2) | Dokumentér Grocys adfærd — 4xx, klampes til 0, eller går negativ |

### 4.6 DELETE — direkte entry-sletning (`deleteShoppingListItem`)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_DEL_01** | DELETE `/api/grocy/shopping-list/:id` for en eksisterende entry | Entry forsvinder fra GET. Andre entries uændret |
| **T_INDKOB_LISTE_DEL_02** | DELETE for ikke-eksisterende id (fx 999999999) | Dokumentér: 404 eller 500 (jf. obs #002 — adapter mapper ikke 500→404) |
| **T_INDKOB_LISTE_DEL_03** | Sammenlign med REMOVE_02 | DELETE/:id fjerner entry helt — selv hvis amount > 0. Tydeliggør forskellen fra removeShoppingListProduct |

### 4.7 PUT — split-routing (`updateShoppingListItem`)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_PUT_01** | `updateShoppingListItem(id, { amount: 12 })` | Entry's amount=12. PUT mod `/objects/shopping_list/:id` |
| **T_INDKOB_LISTE_PUT_02** | `updateShoppingListItem(id, { note: 'test note' })` | Entry's note='test note'. PUT mod `/objects/shopping_list/:id` |
| **T_INDKOB_LISTE_PUT_03** | `updateShoppingListItem(id, { userfields: { ordered_at: '2026-05-11T10:00', ordered_qty: '5', ordered_supplier: 'Hørkram', ordered_varenr: '123456' } })` | Userfields persisterer. PUT mod `/userfields/shopping_list/:id` (separat endpoint) |
| **T_INDKOB_LISTE_PUT_04** | `updateShoppingListItem(id, { amount: 8, userfields: { ordered_qty: '8' } })` | **Begge** endpoints ramt — amount via objects, userfields via userfields. Verificer at begge persisterer |
| **T_INDKOB_LISTE_PUT_05** | Empty userfield: `updateShoppingListItem(id, { userfields: { ordered_at: '' } })` | Grocy returnerer null (jf. obs #001). Adapteren skal håndtere det |

### 4.8 BULK — manglende/udløbne/forfaldne

Disse er Grocys auto-tilføj-flows. Bulk-flow opretter entries for alle produkter der
matcher kriteriet — vi tester at det virker, ikke at vi får specifikke pids.

**Setup-helpers genbruges fra T_STOCK** via fælles modul
`tests/scripts/helpers/grocy_mutation.js` (refactor af eksisterende T_STOCK-helpers):
`setMinStock(pid, amount)`, `setBestBefore(pid, date)`, `setHverDag(pid, days, lastCheckedAt)`.
Alle har snapshot-baseret rollback.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_BULK_01** | `addMissingProducts(1)` efter `setMinStock(pids.bulk, current_stock + 10)` | pids.bulk tilføjes til listen med amount = differensen. Andre produkter under min også tilføjet |
| **T_INDKOB_LISTE_BULK_02** | `addOverdueProducts(1)` med add-and-remove-strategi: opret midlertidig stock-entry på pids.isolation med bb='2020-01-01', kald endpoint, verificér pid på liste, cleanup via setInventory(0). Bemærk: Grocy kategoriserer `best_before_date<today` som **overdue** (due_type=1), ikke **expired** (due_type=2). Test bruger derfor `/shopping-list/add-overdue` | Test-produktet tilføjes til listen. Cleanup fjerner stock-entry + shopping_list-entry |
| **T_INDKOB_LISTE_BULK_03** | Tidligere separat HverDag-overdue case — nu dækket af BULK_02 (samme endpoint, faktisk pid-på-liste-verifikation). HverDag-userfield er en lokal Bon v2-feature der testes af T_STOCK | Marker PASS med reference til BULK_02 |
| **T_INDKOB_LISTE_BULK_04** | Idempotens: kald `addMissingProducts(1)` to gange i træk | Anden gang opretter ikke duplikater (smart endpoint dedupper). Verificer ved at tælle entries for pids.bulk |

### 4.9 CLEAR

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_CLEAR_01** | Add 3 entries, kald `clearShoppingList(1)`, GET listen | Alle entries på list_id=1 er væk — INKLUSIVE eventuelle pre-existing entries. Det er en "nuke" |

**Strategi:** Hele listen snapshottes i SETUP_03 (alle entries med fuld userfields-data).
Efter CLEAR_01 rebuildes listen fra snapshot ved at POST'e hver oprindelig entry tilbage
+ PUT'e userfields. **Worst case:** Hvis runneren crasher mellem CLEAR og rebuild, er
list_id=1 tom på grocytest indtil næste manuelle handling. Acceptabelt fordi det er
test-instans, ikke prod.

### 4.10 SHOPPING_LOCATIONS

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_LOC_01** | GET `/api/grocy/shopping-locations` | Returnerer array. Hvis tom, log som observation (UI bruger måske ikke feltet) |
| **T_INDKOB_LISTE_LOC_02** | Cached: anden GET er hurtigere | t2 < t1/2 (10 min TTL — `cachedFetch` i `services/grocyAdapter.js:29` bruger default `ttlMs = 10 * 60 * 1000`). Fragilt over for netværksvariation — fallback til `_cache.get('shopping_locations')` direkte hvis runneren kører in-proc, ellers acceptér wide tolerance |

### 4.11 CLEANUP

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_LISTE_CLEANUP_01** | Alle test-entries fjernet | GET listen → ingen entries med product_id in pids.primary/dedup/bulk/isolation |
| **T_INDKOB_LISTE_CLEANUP_02** | Pre-existing entries restored | List_after == list_before (samme antal, samme product_ids, samme amounts) |
| **T_INDKOB_LISTE_CLEANUP_03** | Userfields på pre-existing entries restored | Hver entry's userfields matcher snapshot |
| **T_INDKOB_LISTE_CLEANUP_04** | Products' temporære setup ryddet | pids.bulk's `min_stock_amount`, pids.isolation's `HverDag`/`LastCheckedAt`, test-stock-entry's `best_before_date` — alle restored til original via shared helpers |

---

## 5. Konkret eksempel — T_INDKOB_LISTE_PUT_04 step for step

```
1. snapshot_list_before = GET /api/grocy/shopping-list
   → fx [{ id: 42, product_id: 87, amount: '3', userfields: {...} }, ...]

2. addShoppingListProduct(pids.primary, 5, 1)
   → response indicates ny entry id=99
   GET → entry 99 har amount='5', userfields={}

3. updateShoppingListItem(99, {
     amount: 8,
     userfields: {
       ordered_at: '2026-05-11T10:00:00',
       ordered_qty: '8',
       ordered_supplier: 'Hørkram',
       ordered_varenr: '123456'
     }
   })
   → Adapter splitter:
       PUT /objects/shopping_list/99 { amount: 8 }
       PUT /userfields/shopping_list/99 { ordered_at: ..., ordered_qty: ..., ... }

4. GET → entry 99 har amount='8', userfields={ ordered_at: ..., ordered_qty: '8', ... }

5. ASSERT:
   - amount == 8 (tolerance 0.01) ✓
   - userfields.ordered_at == '2026-05-11T10:00:00' ✓
   - userfields.ordered_supplier == 'Hørkram' ✓
   - userfields.ordered_varenr == '123456' ✓

6. ROLLBACK:
   - DELETE /api/grocy/shopping-list/99

7. VERIFY: GET listen == snapshot_list_before (samme entries, samme rækkefølge efter id)

PASS — hermetisk
```

---

## 6. Fejlsignaler og fortolkning

| Symptom | Sandsynlig årsag |
|---------|------------------|
| `addShoppingListProduct` opretter to entries i stedet for at dedupppe | Kalder `/objects/shopping_list` (rå) i stedet for `/stock/shoppinglist/add-product` (smart). Tjek adapter linje 420 |
| `updateShoppingListItem` med userfields → 404 fra Grocy | Grocy kræver eksisterende userfields-row før PUT. Skal POST'es første gang? Eller bruger Grocy upsert? Verificér ved kørsel |
| amount returneres som string ikke number | Grocy lagrer som text. `parseFloat()` i runner. Test bør ikke crashe på `'3' !== 3` |
| Bulk-flow returnerer 0 entries selvom min_stock er overskredet | Test-produktet har måske ikke `default_best_before_days` sat, eller stock-entry mangler. Tjek setup-helpers fra T_STOCK |
| CLEAR ramler hele Grocy shopping_list og rebuild fejler | Tjek rollback-rebuild i runner — hver entry skal POST'es tilbage + userfields PUT'es. Manuel fallback: re-importer cafe-DB til grocytest |
| Cleanup verify fejler | Pre-existing entry blev ændret af test — typisk hvis test-pid kolliderer med pre-existing. Runneren skal advare hvis test-pids overlapper med pre-existing entries (men ikke afvise — det er normalt for at runneren skal kunne mute samme pid) |
| Test-pid ikke længere aktiv på grocytest | `T_INDKOB_pids.json` peger på pid der er gået dead. Slet filen, runneren vælger en ny ved næste kørsel |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_INDKOB_LISTE.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_INDKOB_LISTE.js` | Test-runner | 🔲 |
| `tests/scripts/helpers/grocy_mutation.js` | Delt modul: `setMinStock`, `setBestBefore`, `setHverDag` med snapshot-rollback. Refactor af eksisterende T_STOCK-helpers | 🔲 |
| `tests/scripts/reset_shopping_list.js` | Helper til at tømme list_id=1 hvis forrige kørsel efterlod skæv state | 🔲 |
| `tests/fixtures/T_INDKOB_pids.json` | Persistente test-pids (genereres ved første run, genbruges af alle T_INDKOB_*-tracks) | 🔲 |
| `tests/reports/T_INDKOB_LISTE_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

npm-scripts:
```json
"test:run-indkob-liste": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_INDKOB_LISTE.js",
"test:reset-shopping-list": "node --env-file=.env.test --experimental-sqlite tests/scripts/reset_shopping_list.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| GET shopping-list responderer korrekt | UI'en kan trygt rendere listen ved load |
| Smart `add-product` dedupper | Manuel "+Tilføj vare"-knap i indkob.js kan trygt kaldes gentagne gange uden at oprette duplikater |
| Oprundings-kontrakt holder | Når `consumeRecipes` partial-add er fix'et til smart endpoint, vil shortfall-add oprette én entry pr. produkt og slå sammen ved næste add |
| Rå `addToShoppingList` opretter duplikater (kontraktdokumentation) | Beviser at den vej IKKE bør bruges fra nye kald — bug-fix i `consumeRecipes` er retfærdiggjort |
| `removeShoppingListProduct` reducerer kun qty | "Modtag 3 af 7"-flow virker korrekt — entry forbliver med amount=4 |
| `deleteShoppingListItem` fjerner helt | "Slet linje"-knap i UI virker som forventet |
| `updateShoppingListItem` split-routing | "Bestilt"-badge (sætter `ordered_*` userfields) virker uden at røre amount, og omvendt |
| Bulk-flows virker idempotent | Brugere kan klikke "📉 Tilføj alle manglende" gentagne gange uden duplikater |
| Clear er destruktiv på hele listen | Bekræftet — UI bør have confirm-dialog før clear |

---

## 9. Næste skridt efter T_INDKOB_LISTE

| Track | Indhold |
|-------|---------|
| **T_INDKOB_SETUP** | Suppliers CRUD, grocy-locations-kobling, product-barcodes, grundlæggende userfields |
| **T_INDKOB_ADMIN** | Batch prisopdatering, Dice bigram auto-matching, udgået-detection |
| **T_INDKOB_HORKRAM** | Bestillingsflowet (webshop-kurv + email-flow + PO-mail-tråde) |
| **T_VAREMODTAGELSE** | Atomisk POST /api/goods-receipts (receipt + addStock + shopping-list cleanup + webhook) |

---

## 10. Status — efter første kørsel

```
T_INDKOB_LISTE — 11. maj 2026 (kørsler 1–5)
38 PASS · 0 FAIL · 1 SKIP

Iteration:
  1. 20 PASS · 7 FAIL · 8 SKIP — product_amount-feltnavn forkert i runner
  2. 30 PASS · 2 FAIL · 7 SKIP — ADD_03 decimal + BULK_03 endpoint-mismatch
  3. 32 PASS · 0 FAIL · 7 SKIP — Grocy-afrunding accepteret, add-overdue valgt over add-expired
  4. 37 PASS · 0 FAIL · 2 SKIP — PUT/DELETE via rå adapter (omgår dedup)
  5. 38 PASS · 0 FAIL · 1 SKIP — BULK_02 implementeret via add-and-remove på pids.isolation

SKIP-årsag:
  T_INDKOB_LISTE_CLEAR_01 — destruktiv mod hele list_id=1 + rebuild-strategi
                            er kompleks. Udskudt indtil safe-rebuild verificeret

Vigtige fund:
  - Smart shopping_list endpoint dedupper på pid (forventet)
  - Grocy afrunder decimal-amount ved heltals-stock-enhed (Antal/Stk)
  - add-overdue er Grocy core (best_before_date<today), IKKE HverDag-userfield
  - /api/grocy/stock cacher 10 min — cache-clear nødvendigt før bb-state-tjek
```

---

## 11. Findings og bug-fixes der skal lande før / som del af T_INDKOB_LISTE

### Forudsætning #1 — `consumeRecipes` bruger rå shopping_list-endpoint (TEST_OBSERVATIONS #012)

| | |
|--|--|
| **Sted** | `services/grocyAdapter.js:631` (i `consumeRecipes`'s shortfall-handler) |
| **Symptom** | Partial-consume opretter en ny entry pr. partial-add — selv hvis samme produkt allerede mangler på listen. UI'en viser duplikater |
| **Årsag** | Bruger `grocyPost('/objects/shopping_list', {...})` i stedet for smart endpoint `/stock/shoppinglist/add-product` |
| **Fix** | (1) Udvid `addShoppingListProduct` med optional `note`-parameter. (2) Erstat det rå POST-kald med `addShoppingListProduct(productId, shortfallPurchase, 1, noteText)`. (3) Opdatér `tests/scripts/run_T_INVENTORY.js` T_INV_PARTIAL_02-assertion fra "ny entry-id eksisterer" til "amount-stigning ≥ shortfall_purchase" — ellers ramler den godkendte T_INVENTORY-suite (13/13) når patchen lander |
| **Patch** | `PATCH_consumeRecipes_smart_shopping_list.md` — tre ændringer |
| **Konsekvens for andre tests** | T_INV_PARTIAL_02 skal opdateres samtidig (Ændring 3 i patchen). T_INV_PARTIAL_01 + alle andre T_INVENTORY-cases er upåvirket |
| **Rækkefølge** | **Patch lander som første commit i T_INDKOB_LISTE-PR**, ikke efter — ellers låser specen forkert adfærd ind, og T_INV_PARTIAL_02 vil dryppe fra PASS til FAIL hvis grocytest har pre-existing entry for pid=72 |
| **TEST_OBSERVATIONS** | Logget som **#012** (åben). Flyttes til `lukket` når patchen er anvendt og T_INVENTORY igen kører 13/13 PASS |

### Forudsætning #2 — Brød Rug QU-konvertering (TEST_OBSERVATIONS #010)

Anvendt manuelt af Leif på grocytest 11. maj 2026. Påvirker ikke T_INDKOB_LISTE
direkte (pids er andre end pid=1), men er forudsætning for at T_INDKOB_ADMIN
giver pålidelige tal. Skal også køres på grocycafe inden cutover.

### Markeret undervejs i spec'en

| Reference | Note |
|-----------|------|
| §3.3 + ADD_03 | amount lagres som text i Grocy — parseFloat kræves |
| §4.4 (RAW_02) | Rå endpoint opretter duplikater — kontrakt-test, ikke anbefalet brug |
| §4.6 (DEL_02) | DELETE for ghost-id returnerer 500 fra Grocy — jf. obs #002 i TEST_OBSERVATIONS |
| §4.7 (PUT_05) | Empty userfield returneres som null — jf. obs #001 |
| §4.9 (CLEAR) | clear-endpoint er global og rydder ALT på list_id=1 — UI bør have confirm-dialog |

---

*Oprettet: maj 2026 — afventer første kørsel.*
