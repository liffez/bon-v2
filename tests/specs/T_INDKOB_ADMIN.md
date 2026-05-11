# T_INDKOB_ADMIN — Test-spec for admin: prisopdatering + produkt-mapping

> Test-spec for admin-flowet i Settings → Indkøb → Tab 3 (Hørkram):
> batch-snapshot → userfield-write, Dice bigram auto-matching af umappede
> produkter, udgået-detection via batch-snapshot, foretrukket-toggle adfærd,
> og dead-product-tracking som sideeffekt.
>
> Bygger oven på T_INDKOB_SETUP (suppliers, barcodes og userfields er allerede
> oprettet og testede). Disjoint fra T_INDKOB_LISTE og T_INDKOB_HORKRAM.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | `routes/horkram.js` READ-endpoints (health, search, snapshots, product, favorites, delivery-dates), `services/hokaParser.js` (normalisering + Dice scoring hvis tilstede), batch-import-flowet (snapshot → Grocy userfield-write), udgået-detection, foretrukket-toggle, cache-invalidering |
| **Hvad testes IKKE** | Hørkram bestilling (kurv-add, order-POST — T_INDKOB_HORKRAM). UI-flow i settings-tab (`shared/indkob_settings.js` rendering — Playwright, parkeret). Auto-mapping-UI (kun algoritmen testes — UI er ren rendering) |
| **Live mod Hørkram** | T_INDKOB_ADMIN kalder **live Hørkram-API** for read-operationer. Det er sikkert — vi køber intet. Hvis Hørkram er nede, springer testen over (SKIP) og logger det |
| **Forhold til T_INDKOB_SETUP** | Genbruger `T_INDKOB_pids.json` (samme 4 test-pids) og test-barcodes fra SETUP. T_INDKOB_SETUP skal være kørt grøn først så `pids.primary` har en kendt test-barcode |
| **Credentials** | `HORKRAM_USER` + `HORKRAM_PASS` skal være sat i `.env.test`. Hvis credentials mangler, fejler alle Hørkram-tests med 401 — runneren detekterer og SKIP'er hele tracket med klar besked |

---

## 2. Forudsætninger

### 2.1 Test-instans + credentials

- `grocytest.ristetrug.dk` aktiv (samme som tidligere tracks)
- `.env.test` indeholder gyldige `HORKRAM_USER` + `HORKRAM_PASS`
- Safety-check afviser kørsel hvis aktiv lokation ikke har "test" i URL

### 2.2 Test-pids — egne specifikke par (ikke shared fra LISTE/SETUP)

T_INDKOB_ADMIN bruger **sine egne specifikke pid+varenr-par** — ikke de
auto-valgte pids fra `T_INDKOB_pids.json`. Det er fordi ADMIN kræver:

- Mapped par der allerede eksisterer i Grocy (så vi kan teste batch-import mod
  eksisterende barcodes)
- Kendte Hørkram-varenumre der findes stabilt i Hørkram-katalog
- Mindst én vare med `is_agreement_item` så aftale-flow kan testes
- Mindst én kg-baseret vare så priskategori-konvertering kan testes

### 2.3 Test-par — Spinat og Brød Rug

Persisteres til `tests/fixtures/T_INDKOB_ADMIN_test_pairs.json`:

```json
{
  "version": 1,
  "verified_on_grocy_target": "grocycafe.ristetrug.dk (prod)",
  "verified_at": "2026-05-11T21:14:00Z",
  "note": "Pids og koblinger forventes identiske på grocytest. SETUP_04/05 verificerer.",
  "test_pairs": [
    {
      "label": "spinat",
      "horkram_varenr": "16991002",
      "horkram_name_contains": "babyspinat",
      "horkram_price_per_kg_dkk_ex_moms": 76.26,
      "grocy_pid": 28,
      "grocy_name": "Spinat",
      "qu_stock": "Kilo",
      "qu_purchase_examples": ["kasser (2 poser)", "poser"],
      "pack_size_stock_unit_kg": 0.5,
      "is_agreement_item": true,
      "is_organic": true,
      "is_frozen": false,
      "in_favorites": true,
      "co2e_per_unit": 0.43
    },
    {
      "label": "broed_rug",
      "horkram_varenr": "60097769",
      "horkram_name_contains": "Rugbrødsstykke, 64 x 120 g",
      "horkram_price_per_kg_dkk_ex_moms": 94.80,
      "horkram_price_per_pack_dkk_ex_moms": 728.03,
      "price_note": "Begge priser fra Hørkrams 'Min pris'-toggle: 94,80 / kg eller 728,03 / karton. Verificeret: 728.03 / 7.68 = 94.79 ≈ 94.80. Hørkram-priser er altid ex moms (matcher BON_V2_PRINCIPPER §6b cost_price-konvention)",
      "grocy_pid": 1,
      "grocy_name": "Brød Rug",
      "qu_stock": "Kilo",
      "qu_purchase_examples": ["kartoner"],
      "pack_size_stock_unit_kg": 7.68,
      "units_per_pack": 64,
      "unit_weight_kg": 0.12,
      "default_location": "Fryser",
      "is_agreement_item": true,
      "is_organic": true,
      "is_frozen": true,
      "in_favorites": true,
      "co2e_per_unit": 1.03,
      "qu_conversions_in_grocy": [
        { "from": "Antal", "to": "Kilo",   "factor": 0.12 },
        { "from": "Antal", "to": "Kasse",  "factor": 0.0156 },
        { "from": "Kasse", "to": "Kilo",   "factor": 10.8 },
        { "from": "Kasse", "to": "Antal",  "factor": 64 },
        { "from": "Kilo",  "to": "Antal",  "factor": 8.3333 },
        { "from": "Kilo",  "to": "Kasse",  "factor": 0.0926 }
      ],
      "data_inconsistency_note": "Grocy QU-konvertering siger '1 Kasse = 10.8 Kilo' men stregkode-mængde + 64×0.12 = 7.68 kg. Markeres som F12 — kan være gammel/test-data eller ægte bug"
    }
  ]
}
```

**Vigtigt:** De konkrete pids (28 og 1) blev verificeret på grocycafe (prod).
Grocytest er kopi af grocycafe, så koblingerne bør være identiske — men
SETUP_04 verificerer eksplicit at de findes på grocytest før test fortsætter.
Hvis de ikke gør (fx hvis grocytest er forældet), markeres som SETUP-fejl
med klar besked om at re-kopiere cafe-DB til grocytest.

### 2.4 Dice bigram-funktion — export-guard

**Bekræftet 11. maj 2026:** Funktionen hedder `_isStringSimilarity` og ligger i
[shared/indkob_settings.js:1713](../../shared/indkob_settings.js#L1713). Ren
browser-JS (var/function — ingen CommonJS-eksport, ingen ES-module).
Implementerer Dice-koefficient på bigrams med case-insensitive normalisering.

For at teste den isoleret tilføjes CommonJS export-guard på samme måde som
T_STOCK's `_icComputeCheckStatus` (`tests/specs/T_STOCK.md §4.5`):

```javascript
// nederst i shared/indkob_settings.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _isStringSimilarity };
}
```

Hvis export-guard ikke kan tilføjes (fx pga. UI-rendering-bivirkninger ved
require), springes algoritme-test (§4.4) over med klar besked. UI-flowet kan
stadig testes via API-respons.

### 2.5 Lokal grocytest-state ved start

Snapshot af userfields på pids.primary og dens T_INDKOB_SETUP-barcode tages før
hver write-test. Mønstret er det samme som T_STOCK og T_INDKOB_SETUP.

---

## 3. Strategi: snapshot → mutate → restore

### 3.1 For batch-import-flow

```
1. snapshot_uf_before for relevante barcodes + products
   (alle hk_*, supplier_price_per_kg, price_updated_at, is_agreement_item, etc.)

2. ACTION: kald batch-import-endpoint eller adapter-funktion
   → den læser Hørkram-snapshot
   → den skriver userfields til Grocy

3. ASSERT: forventede userfields persisterer

4. ROLLBACK: PUT alle userfields tilbage til snapshot-værdier

5. VERIFY: snapshot_uf_final == snapshot_uf_before
```

### 3.2 For Dice-algoritme (enhedstest)

```
1. import { _isStringSimilarity } from '../shared/indkob_settings' (via export-guard)
2. Konstruér kendte inputs (Grocy product navn + Hørkram-katalog-streng)
3. Kald → modtag score 0..1
4. ASSERT score matcher forventning (med tolerance 0.01)
```

Ingen Grocy-/Hørkram-kald — fuldt deterministisk.

### 3.3 Hvad gør runneren hvis Hørkram er nede

```
1. SETUP_03 kalder GET /api/horkram/health
2. Hvis 5xx eller timeout → SKIP hele Hørkram-relaterede sektioner
3. SETUP-cases der ikke kræver Hørkram (eksports, fixture-load) kører stadig
4. Rapport markeres "SKIPPED (Hørkram unavailable)"
```

---

## 4. Test-cases

### 4.1 SETUP-cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_SETUP_01** | `.env.test` har Hørkram-credentials | `process.env.HORKRAM_USER` og `HORKRAM_PASS` ikke tomme |
| **T_INDKOB_ADMIN_SETUP_02** | Test-par fixture loaded | `T_INDKOB_ADMIN_test_pairs.json` eksisterer med 2 par (spinat + broed_rug) |
| **T_INDKOB_ADMIN_SETUP_03** | Hørkram-API responderer | GET `/api/horkram/health` returnerer 200 (eller dokumentér 401/5xx → SKIP) |
| **T_INDKOB_ADMIN_SETUP_04** | Test-pids findes på grocytest | GET `/api/grocy/products` viser pid=28 (Spinat) og pid=1 (Brød Rug) som aktive. Hvis ikke, SETUP-fejl med besked om at re-kopiere cafe-DB |
| **T_INDKOB_ADMIN_SETUP_05** | Eksisterende barcode-koblinger findes | GET `/api/grocy/product-barcodes` viser entry for (pid=28, varenr=16991002) og (pid=1, varenr=60097769). Hvis manglende, dokumentér som finding — auto-mapping-tests bruger denne tilstand |
| **T_INDKOB_ADMIN_SETUP_06** | Test-varenumre findes på live Hørkram | GET `/api/horkram/product/16991002` og `/api/horkram/product/60097769` returnerer 200. Hvis ikke (udgået, ændret), opdatér fixture-filen |
| **T_INDKOB_ADMIN_SETUP_07** | hokaParser eksporterer relevante funktioner | `require('services/hokaParser')` har `parseProduct`, `parseSearchResults`, `parseFavoriteProducts`, `parseSnapshotToSummary` |

### 4.2 HORKRAM READ-endpoints — kontrakt-tests

Verificerer at vores adapter normaliserer Hørkram's respons korrekt. Alle er
read-only og kører mod live Hørkram.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_HRK_R_01** | GET `/api/horkram/search?q=spinat` | Array af produkter — `16991002` (babyspinat) findes blandt resultaterne. Hver entry har `varenr`, `name`, `price`, `pack_size` (parseSearchResults-format) |
| **T_INDKOB_ADMIN_HRK_R_02** | GET `/api/horkram/product/16991002` | Produkt med name indeholder "babyspinat", `co2e=0.43`, `is_organic=true`, `is_agreement=true` |
| **T_INDKOB_ADMIN_HRK_R_03** | GET `/api/horkram/product/60097769` | Produkt med name indeholder "Rugbrødsstykke", `co2e=1.03`, `is_organic=true`, `is_frozen=true` |
| **T_INDKOB_ADMIN_HRK_R_04** | GET `/api/horkram/product/00000000` (umuligt varenr) | 404 eller graceful tom respons — dokumentér |
| **T_INDKOB_ADMIN_HRK_R_05** | GET `/api/horkram/products/snapshots?ids=16991002,60097769` | Array af 2 snapshots med begge varer, hver har `current_price`, `pack_size`, `is_active`, `co2e` (parseSnapshotToSummary-format med Fase 6d's co2e-udvidelse) |
| **T_INDKOB_ADMIN_HRK_R_06** | GET snapshots med 25 ids (over max 20 — generér dummy varenumre eller gentag de kendte) | Auto-chunking sker, alle 25 returneres samlet (kendte returnerer data, ukendte returnerer tom/null) |
| **T_INDKOB_ADMIN_HRK_R_07** | GET `/api/horkram/favorites` | Liste af favorit-lister med id+name. Kan være tom |
| **T_INDKOB_ADMIN_HRK_R_08** | GET `/api/horkram/favorites/:id/all` for første favorit-liste | Auto-pagineret — begge test-varenumre (16991002, 60097769) findes i listen, in_favorites=true |
| **T_INDKOB_ADMIN_HRK_R_09** | GET `/api/horkram/delivery-dates` | Array af fremtidige leveringsdatoer |
| **T_INDKOB_ADMIN_HRK_R_10** | GET `/api/horkram/dropsize?subtotal=1200&date=<gyldig dato>` | Returnerer minimum-order-info. Dansk talformat parses korrekt ('1.500,00' → 1500) |

### 4.3 BATCH SNAPSHOT-IMPORT — flow

"Importer priser"-knappen fra Favoritter-tab. Tager en favorit-liste, henter
snapshots batch-vis, skriver alle hk_*-userfields + `supplier_price_per_kg` +
`price_updated_at` til Grocy.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_IMP_01** | Import-flow: snapshot for 16991002+60097769 → skriv til Grocy | pid=28 (Spinat) og pid=1 (Brød Rug) har product-userfields og barcode-userfields opdateret. `price_updated_at` matcher kørselstidspunkt (tolerance 60s) |
| **T_INDKOB_ADMIN_IMP_02** | `supplier_price_per_kg` udregnet korrekt for Spinat | Userfield `supplier_price_per_kg` ≈ 76.26 (tolerance 0.5 — Hørkram kan justere priser) |
| **T_INDKOB_ADMIN_IMP_02b** | `supplier_price_per_kg` for Brød Rug | Userfield `supplier_price_per_kg` ≈ 94.80 (ex moms, tolerance 0.5). Verificer at adapter ikke roder ex/inkl-moms sammen — det skal være ex moms iht. §6b |
| **T_INDKOB_ADMIN_IMP_03** | hk_co2e for Spinat ≈ 0.43, for Brød Rug ≈ 1.03 | Begge userfields sat. Manglende felter sættes ikke (ikke null-overskrivning af eksisterende) |
| **T_INDKOB_ADMIN_IMP_04** | hk_organic + is_agreement_item på barcodes | Begge varers `hk_organic='1'`, og barcode-userfield `is_agreement_item='1'` (matcher "Aftalevare"-badge på Hørkram) |
| **T_INDKOB_ADMIN_IMP_05** | Idempotens: kør import to gange | Anden kørsel opdaterer samme felter, ingen duplikat-userfields eller fejl |
| **T_INDKOB_ADMIN_IMP_06** | Partial fejl: hvis ét snapshot fejler, de andre fortsætter | Resultat-objekt viser per-pid success/fail-status. Failed pid har eksisterende userfields uændret |
| **T_INDKOB_ADMIN_IMP_07** | is_preferred BEVARES ved import | Hvis pid=28's barcode har `is_preferred='1'` før import, har den stadig `is_preferred='1'` efter. Import overskriver ikke admin-toggles |

### 4.4 DICE BIGRAM — auto-mapping algoritme

Forudsætter at export-guard er på plads (jf. §2.4). Tester selve scoringen
isoleret — UI-flowet er ren rendering der vises i §4.5.

Hvis funktion ikke kan importeres, alle BIGRAM-cases markeres SKIP.

| ID | Input | Forventet |
|----|-------|-----------|
| **T_INDKOB_ADMIN_BIGRAM_01** | `_isStringSimilarity('mælk øko 1 l', 'mælk økologisk 1 liter')` | Score > 0.5 (god match) |
| **T_INDKOB_ADMIN_BIGRAM_02** | `_isStringSimilarity('mælk', 'mælkechokolade')` | Score lavere — prefix matching alene ikke nok |
| **T_INDKOB_ADMIN_BIGRAM_03** | `_isStringSimilarity('', 'mælk')` | Score = 0 (tom streng — funktionen returnerer `0` ved tomt `a` eller `b`) |
| **T_INDKOB_ADMIN_BIGRAM_04** | `_isStringSimilarity('mælk', 'mælk')` | Score = 1 (perfekt match — short-circuit `if (a === b) return 1`) |
| **T_INDKOB_ADMIN_BIGRAM_05** | `_isStringSimilarity('MÆLK', 'mælk')` | Score = 1 (case-insensitive — `a.toLowerCase().trim()` på begge inputs) |
| **T_INDKOB_ADMIN_BIGRAM_06** | `_isStringSimilarity('ø', 'å')` | Score = 0 (`a.length - 1 < 1` → ingen bigrams genereres → `bigramsA.length === 0` → tidligt return 0) |
| **T_INDKOB_ADMIN_BIGRAM_07** | Symmetri: `_isStringSimilarity(a, b) === _isStringSimilarity(b, a)` for 3 par | Identisk score begge veje |

### 4.5 AUTO-MAPPING-FLOW

End-to-end test af "Ny kobling"-tab's auto-søg: tag et Grocy-produkt uden
HK-barcode, send navn til Hørkram-søg, returnér top-N kandidater sorteret efter
Dice-score.

**Strategi: midlertidig sletning af eksisterende barcode**

Spinat (pid=28) har allerede HK-barcode 16991002. For at simulere "umapped"
tilstand:
1. snapshot_bc = barcode-entry'en
2. DELETE barcode'en
3. Kør auto-søg-flow for pid=28
4. Verificér at "Salat babyspinat" returneres som top-kandidat
5. Genopret barcode'en (POST med samme felter som snapshot_bc)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_MAP_01** | Setup: snapshot+delete barcode for pid=28 (Spinat) | Barcode 16991002 væk fra GET. pid=28 er nu "umapped" |
| **T_INDKOB_ADMIN_MAP_02** | Auto-søg-flow: send "Spinat" som søgeterm til Hørkram | Kandidat-array returneres. "Salat babyspinat vasket, 500 g" er blandt top-5 |
| **T_INDKOB_ADMIN_MAP_03** | Top-kandidat har confidence > 0.5 for "Spinat" vs "Salat babyspinat" | Auto-mapping-UI kan trygt foreslå den |
| **T_INDKOB_ADMIN_MAP_04** | Cleanup: genopret barcode-kobling | Barcode 16991002 ↔ pid=28 reetableret med samme userfields som før |
| **T_INDKOB_ADMIN_MAP_05** | For "Brød Rug": søg returnerer Rugbrødsstykke 60097769 i top-N | Bekræfter at flow virker for begge test-par |

### 4.6 UDGÅET-DETECTION

Når en barcode-snapshot returnerer "not found" eller `is_active=false` fra
Hørkram, registreres det. Hvor det registreres er en finding — kan være:

- Userfield `hk_active='0'` på product_barcode
- Eller `hk_scraped_at` markerer at scraping forsøgt men tom respons
- Eller in-memory state i UI ved batch-kørsel (ingen persistens)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_DEAD_01** | Snapshot for kendt udgået varenr | Adapter returnerer entry med flag/marker for udgået. Dokumentér adfærd ved første kørsel |
| **T_INDKOB_ADMIN_DEAD_02** | Snapshot for ikke-eksisterende varenr | Adapter returnerer null eller tom entry. Skal ikke crashe |
| **T_INDKOB_ADMIN_DEAD_03** | Hvis udgået persisteres som userfield, verificér det | hk_active='0' eller tilsvarende. Hvis kun in-memory, dokumentér som observation |
| **T_INDKOB_ADMIN_DEAD_04** | Hvis dead-product-tabel/-log eksisterer, verificér at den modtager rækker | Skema dokumenteret ved første kørsel. Hvis ikke eksisterer, observation |

### 4.7 FORETRUKKET-TOGGLE

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_PREF_01** | Sæt `is_preferred='1'` på en barcode der har `is_preferred=''` | Userfield opdateret. Andre barcodes på samme product påvirkes IKKE — UI-sortering kan teoretisk vise to "Foretrukne" badges hvis ikke håndteret |
| **T_INDKOB_ADMIN_PREF_02** | Sæt `is_preferred='1'` på en barcode B, mens barcode A på samme product allerede har is_preferred='1' | Dokumentér adfærd: backend tillader to "Foretrukne" på samme product? Eller fjerner backend automatisk den gamle? |
| **T_INDKOB_ADMIN_PREF_03** | Skift fra is_preferred='1' til '' | Userfield clearet, badge forsvinder |

### 4.8 CACHE-INVALIDERING

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_CACHE_01** | Batch-import → GET barcodes umiddelbart efter | Nye hk_*-felter synlige uden delay (cache invalideret efter PUT) |
| **T_INDKOB_ADMIN_CACHE_02** | Batch-import → GET products | Nye supplier_price_per_kg/price_updated_at synlige uden delay |

### 4.9 CLEANUP

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_ADMIN_CLEANUP_01** | Userfields på pids.* restored til snapshot_uf_before | Diff på alle berørte userfields = 0 (eller tomme strenge ↔ null som forventet) |
| **T_INDKOB_ADMIN_CLEANUP_02** | Barcodes' userfields restored | Tilsvarende på barcode-niveau |
| **T_INDKOB_ADMIN_CLEANUP_03** | Hvis dead-product-tabel/-log eksisterer: testrækker fjernet | `WHERE varenr LIKE 'T_INDKOB%'` → 0 rows |
| **T_INDKOB_ADMIN_CLEANUP_04** | Cache-state | `clearCache()` kaldes som sidste skridt så næste kørsel starter friskt |

---

## 5. Konkret eksempel — T_INDKOB_ADMIN_IMP_01 step for step

```
Forudsætning: pids.primary har T_INDKOB_SETUP-barcode med varenr='5026801'
              (et kendt Hørkram-varenummer fra fixture)

1. snapshot_uf_before:
   - pids.primary's product-userfields: { hk_organic:'', supplier_price_per_kg:'', ... }
   - barcode's userfields: { is_preferred:'', hk_brand:'', ... }

2. ACTION: kald import-flow
   - Adapter henter snapshot for varenr=5026801 via Hørkram-API
   - Snapshot returnerer: {
       varenr: '5026801', name: 'Kaffe Økologisk 1 kg',
       price_per_unit: 89.50, pack_size: 1, unit: 'kg',
       is_organic: true, brand: 'Peter Larsen', country: 'DK',
       co2e: 2.3, energy_kj: 1234, ...
     }
   - Adapter normaliserer via parseSnapshotToSummary()
   - Adapter PUT'er userfields:
     - Til product (pids.primary):
       supplier_price_per_kg: '89.50'
       price_updated_at: '2026-05-11T11:30:00Z'
       hk_organic: '1', hk_country: 'DK', hk_co2e: '2.3', ...
     - Til barcode:
       hk_brand: 'Peter Larsen', hk_gtin: '...', hk_url: '...',
       hk_scraped_at: '2026-05-11T11:30:00Z'

3. GET userfields → match forventning:
   - supplier_price_per_kg='89.50' ✓
   - price_updated_at within 60s of kørselstidspunkt ✓
   - hk_co2e='2.3' ✓

4. ASSERT alle ovenstående ✓

5. ROLLBACK: PUT alle userfields tilbage til '' (eller snapshot-værdi)

6. VERIFY: GET → matcher snapshot_uf_before

PASS — hermetisk
```

---

## 6. Fejlsignaler og fortolkning

| Symptom | Sandsynlig årsag |
|---------|------------------|
| `GET /api/horkram/health` returnerer 401 | Hørkram-credentials forkerte eller udløbet. Tjek `.env.test` |
| `GET /api/horkram/health` returnerer 200 men search 401 | CSRF-token-renewal fejler. Tjek `services/horkramAdapter`'s cookie-jar-logik |
| `parseSnapshotToSummary` returnerer `co2e: undefined` | Snapshot fra Hørkram har ikke co2-felt for det varenr. Forventet — graceful fallback (ikke fejl) |
| Batch-import skriver `hk_co2e: 'undefined'` | Streng-konvertering går galt — `String(undefined)` skal kortsluttes til '' før PUT |
| `_isStringSimilarity` returnerer NaN | Tom streng eller ikke-streng input — funktionen kortslutter med `if (!a || !b) return 0`, så NaN bør ikke kunne opstå. Hvis det sker → bug i funktionen |
| Idempotent rerun fejler med 500 | Cache holder gammel barcode-liste — `_cache.delete('product_barcodes')` mangler i batch-flow |
| `is_preferred='1'` mister sin værdi efter batch | Batch overskriver alle userfields inkl. `is_preferred` selv hvis snapshot ikke leverede det. Skal kun PUT'e felter snapshot LEVERER data for |
| Dead-product detection fanger ikke kendt udgået vare | Hørkram returnerer måske 200 med tom snapshot, ikke 404. Tjek `is_active`-felt i parseSnapshotToSummary output |
| Rate limit fra Hørkram (429) under batch | Tilføj delay mellem snapshot-chunks (auto-chunking + sleep). Skal ikke køre uden break på 1000 produkter |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_INDKOB_ADMIN.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_INDKOB_ADMIN.js` | Test-runner | 🔲 |
| `tests/fixtures/T_INDKOB_ADMIN_test_pairs.json` | Kendte test-par: Spinat (28↔16991002) + Brød Rug (1↔60097769). Verificeret manuelt | 🔲 (skabes ved første kørsel hvis ikke eksisterer) |
| `tests/fixtures/T_INDKOB_pids.json` | Eksisterer fra LISTE/SETUP men bruges IKKE af ADMIN | — |
| `shared/indkob_settings.js` | CommonJS export-guard for `_isStringSimilarity` (bekræftet placering 11. maj 2026, linje 1713) | 🔲 |
| `tests/reports/T_INDKOB_ADMIN_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

npm-script:
```json
"test:run-indkob-admin": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_INDKOB_ADMIN.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Hørkram READ-endpoints svarer stabilt | UI-flows der henter snapshots, søger, lister favoritter virker pålideligt |
| Batch-import skriver userfields korrekt | "Importer priser"-knappen i Favoritter-tab er pålidelig — admin kan opdatere alle priser med ét klik |
| Auto-chunking håndterer >20 produkter | Store favorit-lister fejler ikke ved batch |
| Dice bigram returnerer rimelige scores | "Ny kobling"-flow viser de rigtige kandidater øverst |
| Foretrukket-toggle adfærd dokumenteret | Vi ved om backend håndterer "én foretrukken pr. produkt" eller om UI selv skal cleare andre |
| Udgået-detection adfærd dokumenteret | Vi ved om "Udgået"-badge i UI'en kommer fra persistente userfields eller in-memory state |
| Cache invalidering virker | Sequence-tests (import → GET → vis) viser nye data uden delay |
| Idempotens holder | Admin kan trygt køre batch-import flere gange uden at ødelægge eksisterende `is_preferred` o.l. |

---

## 9. Næste skridt efter T_INDKOB_ADMIN

| Track | Indhold |
|-------|---------|
| **T_INDKOB_HORKRAM** | Bestillingsflowet (kurv-add + order-POST + PO-mail-tråde) — sidste indkøbs-track |
| **T_VAREMODTAGELSE** | Atomisk POST /api/goods-receipts — bygger på alle 4 indkøbs-tracks |
| **T_V1_AFSTEMNING** | Parallel track — sammenligning af Bon v1 og v2 outputs |

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — skal tjekkes og noteres ved første kørsel

Disse punkter er åbne spørgsmål om faktisk adfærd. Runneren logger hvad den
observerer; efter første kørsel opdateres TEST_OBSERVATIONS med konkrete svar.

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F1** | §2.4 (Dice-funktion) | ✅ **Bekræftet 11. maj 2026**: funktionen hedder `_isStringSimilarity` og ligger i `shared/indkob_settings.js:1713`. Ren browser-JS — kræver CommonJS export-guard (jf. §2.4) for at kunne require'es fra runner. Hvis guard ikke kan tilføjes, SKIP BIGRAM-cases | — (lukket) |
| **F2** | §4.2 (HRK_R_04) | Hørkrams response på ugyldig varenr | Send `/api/horkram/product/00000000`. Notér: HTTP-kode, body-form (null, tom, error) |
| **F3** | §4.3 (IMP_02) | Leverer Hørkrams snapshot `price_per_kg` direkte? | Inspecér rå snapshot for varenr=16991002. Hvis felt direkte → brug det. Hvis ikke → `price_per_unit / pack_size_stock_unit` lokalt |
| **F4** | §4.3 (IMP_06) | Partial-failure: crasher adapter ved ét fejlende snapshot? | Send `/snapshots?ids=16991002,XXXXXXX`. Forventet: array af 2 hvor andet er null/error, ikke 500 på hele kaldet |
| **F5** | §4.3 (IMP_07) | Bevares `is_preferred` ved batch-import? | Sæt `is_preferred='1'` på spinat's barcode → kør import → tjek at den stadig er '1'. Hvis '': bug der skal rapporteres |
| **F6** | §4.6 (DEAD_01–04) | Udgået-detection-mekanisme — userfield, tabel, eller in-memory? | Hvis Hørkram returnerer `is_active=false`: leder vi efter et persisteret flag i Grocy efter batch? Eller forsvinder info efter session? |
| **F7** | §4.7 (PREF_02) | "Én foretrukken pr. produkt" — backend eller UI? | Sæt `is_preferred='1'` på TO barcodes for samme product. Tjek om backend afviser eller tillader. UI'en kan godt rendere to lilla badges |
| **F8** | §6 (rate limit) | Rate limit på Hørkram? | Send 30 snapshot-requests hurtigt. Notér evt. 429-respons + Retry-After-header |
| **F9** | §2.3 (verifikation) | Eksisterer pid=28 og pid=1 på grocytest, ikke kun grocycafe? | SETUP_04 tjekker. Hvis ikke → grocytest skal re-importeres fra cafe |
| **F10** | §2.3 (mapping persistens) | Eksisterer barcode-koblinger (16991002↔28) og (60097769↔1) på grocytest? | SETUP_05 tjekker. Hvis manglende → opret dem i et seed-script eller manuelt før test |
| **F11** | (overordnet) | **Bekræftet:** bestilling.js (60kb) er død kode. `initBestilling` kaldes ingen steder uden for filen selv. Erstattet af indkob.js men ikke slettet | Foreslå sletning som separat oprydning. shopping_list.js bør tjekkes på samme måde (også markeret som udgået i CLAUDE.md). Ikke blokerende for tests |
| **F12** | §2.3 (Brød Rug QU-data) | Grocy QU-konvertering '1 Kasse = 10.8 Kilo' er **bekræftet gamle v1-data** (Leif, maj 2026). Det rigtige er 7.68 kg = 64 × 0.12. Påvirker ikke pris-beregning hvis snapshot leverer pris pr. kg direkte, men kan forvirre andre QU-aware-flows | Ryddes op før T_INDKOB_ADMIN køres — se `PATCH_grocy_qu_broedrug_v1_cleanup.md` |
| **F13** | (feature-request) | Pris-opdatering bør **også opdatere QU-konverteringer** når Hørkram leverer ny pakke-størrelse | Leif (maj 2026): "det skal faktisk ændres i grocy når der opdateres priser". I dag opdaterer batch-import kun userfields. Forslag: hvis Hørkram-snapshot leverer `pack_size_stock_unit` der afviger fra Grocy's QU-konvertering, opdatér også konverteringen. Test-case skal tilføjes når feature er bygget |

---

*Oprettet: maj 2026 — afventer T_INDKOB_SETUP-runner. Test-par (Spinat + Brød Rug) verificeret manuelt på grocycafe + Hørkram d. 11. maj 2026. Opdateret 11. maj 2026 (sen aften): `diceScore` → `_isStringSimilarity` (faktisk navn fra `shared/indkob_settings.js:1713`). F1 lukket. F12 (Brød Rug QU) anvendt manuelt — se TEST_OBSERVATIONS #010.*
