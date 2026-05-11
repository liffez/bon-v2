# T_INDKOB_SETUP — Test-spec for varemodtagelses-setup (suppliers, koblinger, barcodes)

> Test-spec for det fundamentale setup der gør varemodtagelsen mulig:
> leverandører (Bon v2 master), grocy-location-koblinger, produkt-barcodes
> (Grocy master, kobler Bon v2-leverandører til Grocy-produkter), og indkøbs-
> relaterede userfields på `products` og `product_barcodes`.
>
> Bygger oven på T_INDKOB_LISTE (genbruger samme test-pids og shared helpers).
> Disjoint fra T_INDKOB_LISTE's primære test-cases — rører ikke shopping_list.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | `routes/purchasing.js` (suppliers CRUD + grocy-locations link/unlink) og `routes/grocy.js` (product-barcodes CRUD) + adapter-funktionerne for barcodes og produkt-userfields i `services/grocyAdapter.js`. Inkluderer CHECK-constraints, soft-delete-adfærd og cache-invalidering |
| **Hvad testes IKKE** | UI-flow (`shared/indkob_settings.js` rendering — Playwright, parkeret). Hørkram-bestilling (T_INDKOB_HORKRAM). Hørkram-batch-prisopdatering (T_INDKOB_ADMIN). Duplikat-detection-admin-UI (kun selve database-delen testes — UI er ren rendering) |
| **Forhold til T_INDKOB_LISTE** | Genbruger `T_INDKOB_pids.json` for test-produkter. Bruger samme `grocy_mutation.js` helpers hvor relevant. Tester ikke shopping_list — det er T_INDKOB_LISTE's job |
| **Forhold til T_VAREMODTAGELSE** | T_INDKOB_SETUP verificerer at fundamentet eksisterer — T_VAREMODTAGELSE verificerer at goods-receipts-flowet **bruger** fundamentet korrekt |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `grocytest.ristetrug.dk` aktiv (samme som tidligere tracks)
- `default_grocy_location_id = 3` i settings
- Safety-check afviser kørsel hvis aktiv lokation ikke har "test" i URL
- Test-DB (`data/test.db`) seedet via `seed_planning.sql`

### 2.2 Test-pids — genbrug fra T_INDKOB_LISTE

Hvis `tests/fixtures/T_INDKOB_pids.json` eksisterer, bruges samme 4 pids
(primary, dedup, bulk, isolation). Hvis filen mangler, kaldes
`pickDisjointProducts(...)` som genererer den — samme adfærd som T_INDKOB_LISTE.

### 2.3 Test-suppliers og test-barcodes — alle med præfiks

Alle test-data har **navne med præfiks `T_INDKOB_SETUP_`** og slettes ved cleanup.
Det gælder:

| Entitet | Præfiks | Hvor |
|---------|---------|------|
| Suppliers | `T_INDKOB_SETUP_<rolle>` | `suppliers.name` i Bon v2-DB |
| Barcodes | `T_INDKOB_SETUP_<varenr>` | `product_barcodes.barcode` på grocytest |
| Notes på rækker | `T_INDKOB_SETUP test` | Diverse `notes`/`description`-felter |

Hvis runneren finder pre-existing test-rækker fra en tidligere fejlende kørsel,
ryddes de op før test starter.

### 2.4 Integration_type-værdier (CHECK constraint)

Bon v2 understøtter præcis 5 integration-typer på `suppliers.integration_type`:

| Værdi | Adfærd i bestilling |
|-------|---------------------|
| `'api'` | Hørkram kurv-flow (`PUT /api/horkram/basket`) |
| `'email'` | Mail-flow (`POST /api/orders/pending { send_email: true }`) |
| `'manual'` | Kopiér/ring-flow (kun UI-instruktion) |
| `'webshop'` | Åbn URL (ingen API) — kræver `webshop_url` sat |
| `'intern'` | Produktionsbon — kun i V2, eksisterer ikke i Grocy |

CHECK-constraint skal afvise alle andre værdier.

---

## 3. Strategi: snapshot → mutate → restore

### 3.1 For Bon v2-tabeller (suppliers, supplier_grocy_locations)

```
1. snapshot_db = SELECT * FROM <table>
2. ACTION: POST/PATCH/DELETE via /api/purchasing/*
3. ASSERT: GET viser ændring som forventet
4. CLEANUP: DELETE test-rækker direkte via SQL (bypass soft-delete hvor relevant)
5. VERIFY: SELECT viser at kun T_INDKOB_SETUP-rækker er fjernet, pre-existing uændret
```

### 3.2 For Grocy product_barcodes

```
1. snapshot_bc_before = GET /api/grocy/product-barcodes
2. ACTION: POST/DELETE via /api/grocy/product-barcodes
3. ASSERT: ny barcode findes / sletning gennemført
4. ASSERT cache-invalidering: GET retunerer den nye state med det samme
5. CLEANUP: DELETE test-barcodes via deleteProductBarcode
6. VERIFY: barcode-listen matcher snapshot_bc_before
```

### 3.3 For Grocy userfields

```
1. snapshot_uf_before = GET userfields for test-pid eller test-barcode
2. PUT userfields med test-værdier
3. GET → match assertions
4. PUT med snapshot_uf_before-værdier (restore)
5. VERIFY: userfields matcher snapshot
```

Samme mønster som T_STOCK §4.4 — kan genbruge `restoreUserfields` helper.

---

## 4. Test-cases

### 4.1 SETUP-cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_SETUP_01** | Test-DB seedet | `SELECT COUNT(*) FROM suppliers` > 0 (mindst RR Produktion fra Migration 032) |
| **T_INDKOB_SETUP_SETUP_02** | Test-pids loadet fra fixture | `T_INDKOB_pids.json` eksisterer, 4 pids aktive på grocytest |
| **T_INDKOB_SETUP_SETUP_03** | Endpoints svarer | GET `/api/purchasing/suppliers`, GET `/api/grocy/product-barcodes` returnerer 200 |
| **T_INDKOB_SETUP_SETUP_04** | Migration 030 + 032 anvendt | Schema for `suppliers` har `webshop_url`-kolonne. CHECK på `integration_type` inkluderer `'webshop'` og `'intern'` |
| **T_INDKOB_SETUP_SETUP_05** | Adapter eksporterer relevante funktioner | `grocyAdapter` har `getProductBarcodes`, `createProductBarcode`, `updateProductBarcode`, `updateProductBarcodeUserfields`, `deleteProductBarcode`, `updateProduct` |

### 4.2 SUPPLIERS — CRUD

Tester `routes/purchasing.js` fulde CRUD: GET liste, GET/:id, POST, PATCH, DELETE (soft).

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_SUP_01** | POST `/api/purchasing/suppliers` med minimal body `{name: 'T_INDKOB_SETUP_api', integration_type: 'api'}` | 201, returneret supplier har auto-id og `is_active=1` |
| **T_INDKOB_SETUP_SUP_02** | GET `/api/purchasing/suppliers/:id` for ny supplier | Returneret entry matcher POST-body |
| **T_INDKOB_SETUP_SUP_03** | POST med alle 5 integration_types (api, email, manual, webshop, intern) | Alle 5 accepteres, returnerer 201 |
| **T_INDKOB_SETUP_SUP_04** | POST med ugyldig integration_type (fx 'ftp') | 400 — CHECK-constraint afviser |
| **T_INDKOB_SETUP_SUP_05** | POST med integration_type='webshop' men uden webshop_url | Dokumentér adfærd: accepteres uden URL (UI håndterer) eller 400 |
| **T_INDKOB_SETUP_SUP_06** | PATCH supplier med ny `contact_email`, `notes` | Felter opdateret. Andre felter uændret |
| **T_INDKOB_SETUP_SUP_07** | DELETE supplier (soft delete) | 200, men supplier findes stadig i DB med `is_active=0` |
| **T_INDKOB_SETUP_SUP_08** | GET `/api/purchasing/suppliers?location_id=1` efter soft-delete | Slettede suppliers IKKE i default-respons |
| **T_INDKOB_SETUP_SUP_09** | GET `/api/purchasing/suppliers?location_id=1&include_inactive=1` (hvis støttet) | Soft-deleted suppliers vises. Hvis flag ikke understøttes, dokumentér som finding |

### 4.3 SUPPLIER_GROCY_LOCATIONS — kobling

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_SGL_01** | GET `/api/purchasing/suppliers/grocy-locations` | Returnerer array med kobling-status — hver supplier viser hvilke grocy_location_ids den er knyttet til |
| **T_INDKOB_SETUP_SGL_02** | POST kobling: `{supplier_id: <test>, grocy_location_id: 3}` | 201, kobling oprettet |
| **T_INDKOB_SETUP_SGL_03** | POST samme kobling igen (duplikat) | Dokumentér: 409, 400 eller silent 201? — ingen krav, kun observation |
| **T_INDKOB_SETUP_SGL_04** | DELETE kobling via `/api/purchasing/suppliers/grocy-locations/:id` | 200, kobling fjernet |
| **T_INDKOB_SETUP_SGL_05** | GET filtrering `?location_id=3` på suppliers | Returnerer kun suppliers koblet til grocy_location=3 |

### 4.4 PRODUCT_BARCODES — CRUD

Grocy-entity der kobler `(product_id, supplier-varenr)`. Bruges af `shared/indkob.js`
til at finde leverandør-pris for et produkt + sortere chips efter præference.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_BC_01** | POST `/api/grocy/product-barcodes` med `{product_id: pids.primary, barcode: 'T_INDKOB_SETUP_001', note: 'test'}` | 201, returneret barcode har id |
| **T_INDKOB_SETUP_BC_02** | GET `/api/grocy/product-barcodes` efter POST | Ny barcode findes. Cache er invalideret (returneret med det samme, ikke 5-min-cache) |
| **T_INDKOB_SETUP_BC_03** | POST duplikat på samme product_id+barcode | Dokumentér Grocys adfærd: 400 eller silent 200 |
| **T_INDKOB_SETUP_BC_04** | DELETE `/api/grocy/product-barcodes/:id` | 200, barcode forsvinder fra GET. Cache invalideret |
| **T_INDKOB_SETUP_BC_05** | DELETE for ikke-eksisterende id | Dokumentér: 404 eller 500 (jf. obs #002) |
| **T_INDKOB_SETUP_BC_06** | Genbrug af samme barcode på andet produkt | Dokumentér Grocys adfærd — barcode-værdi unik pr. (supplier, varenr)? Eller globalt? |

### 4.5 PRODUCT_BARCODE_USERFIELDS — indkøbs-felter

Tester `updateProductBarcodeUserfields` for de 5 indkøbs-relevante userfields.

| ID | Userfield | Action | Forventet |
|----|-----------|--------|-----------|
| **T_INDKOB_SETUP_BCUF_01** | `is_preferred` | PUT `{is_preferred: '1'}` på test-barcode | GET viser is_preferred='1'. UI vil rendere lilla "Foretrukket"-badge |
| **T_INDKOB_SETUP_BCUF_02** | `is_agreement_item` | PUT `{is_agreement_item: '1'}` | GET viser '1'. UI vil sortere chip foran billigste |
| **T_INDKOB_SETUP_BCUF_03** | `supplier_unit_code` | PUT `{supplier_unit_code: 'ks'}` | GET viser 'ks'. Bruges ved Hoka basket-add |
| **T_INDKOB_SETUP_BCUF_04** | `supplier_unit_qty` | PUT `{supplier_unit_qty: '5'}` | GET viser '5' (antal base-enheder pr. salesUnit) |
| **T_INDKOB_SETUP_BCUF_05** | `pack_size_stock_unit` | PUT `{pack_size_stock_unit: '5.000'}` | GET viser '5.000' kg (fallback ved manglende live snapshot) |
| **T_INDKOB_SETUP_BCUF_06** | Empty userfield rollback | PUT `{is_preferred: ''}` | GET returnerer null (jf. obs #001). UI behandler null som "ikke sat" |
| **T_INDKOB_SETUP_BCUF_07** | Multi-felt batch | PUT med alle 5 felter på én gang | Alle 5 persisterer, kan læses tilbage |

### 4.6 PRODUCT_USERFIELDS — indkøbs-felter på selve produktet

Tester `updateProduct` og userfield-PUT for indkøbs-felter på `products`-entity
(disjoint fra T_STOCK's `HverDag/LastCheckedAt/LastCheckedUnit`).

| ID | Userfield | Action | Forventet |
|----|-----------|--------|-----------|
| **T_INDKOB_SETUP_PUF_01** | `supplier_price_per_kg` | PUT på pids.primary | GET viser værdien. Bruges af UI til kg-pris-sortering |
| **T_INDKOB_SETUP_PUF_02** | `price_updated_at` | PUT med ISO timestamp | GET viser timestamp. Bruges til "stale price"-detection |
| **T_INDKOB_SETUP_PUF_03** | `updateProduct` — `min_stock_amount` | PUT på pids.primary | Product har min_stock_amount opdateret. Bruges af bulk add-missing |
| **T_INDKOB_SETUP_PUF_04** | `updateProduct` — `shopping_location_id` | PUT på pids.primary | Product knyttet til en shopping_location (Grocy concept, ikke supplier-location-kobling) |

### 4.7 CACHE-INVALIDERING

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_CACHE_01** | GET barcodes → POST ny → GET igen | Anden GET returnerer den nye uden delay (cache invalideret af `_cache.delete('product_barcodes')`) |
| **T_INDKOB_SETUP_CACHE_02** | DELETE barcode → GET | Slettet barcode er væk uden delay |
| **T_INDKOB_SETUP_CACHE_03** | PUT userfields på barcode → GET via `getProductBarcodes` | Userfield-ændringen synlig i næste GET (cache invalideret) |

### 4.8 DUPLICATE_DETECTION — Migration 031

`duplicate_candidates`-tabel logger barcode-flytninger til admin-review. Verificerer
at tabel eksisterer og kan modtage rækker, men admin-UI testes ikke.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_DUP_01** | Schema-tjek: `duplicate_candidates`-tabel eksisterer | `PRAGMA table_info(duplicate_candidates)` returnerer kolonner |
| **T_INDKOB_SETUP_DUP_02** | INSERT en test-row direkte | Row eksisterer i tabellen efter INSERT |
| **T_INDKOB_SETUP_DUP_03** | Tabellen har forventede kolonner | Mindst: id, old_product_id, new_product_id, barcode, created_at, resolved_at |

### 4.9 CLEANUP

| ID | Action | Forventet |
|----|--------|-----------|
| **T_INDKOB_SETUP_CLEANUP_01** | Alle T_INDKOB_SETUP-suppliers slettet | `SELECT COUNT(*) FROM suppliers WHERE name LIKE 'T_INDKOB_SETUP_%'` = 0 (hard delete via SQL, ikke soft) |
| **T_INDKOB_SETUP_CLEANUP_02** | Alle test-grocy-locations koblinger fjernet | `SELECT COUNT(*) FROM supplier_grocy_locations WHERE supplier_id IN (slettede)` = 0 |
| **T_INDKOB_SETUP_CLEANUP_03** | Alle T_INDKOB_SETUP-barcodes slettet fra grocytest | GET barcodes viser ingen `T_INDKOB_SETUP_`-præfiks |
| **T_INDKOB_SETUP_CLEANUP_04** | Userfields på pids.* restored | snapshot_uf_before == userfields nu (på alle 4 test-pids og deres barcodes) |
| **T_INDKOB_SETUP_CLEANUP_05** | duplicate_candidates test-rækker slettet | `SELECT COUNT(*)` på test-rækker = 0 |

---

## 5. Konkret eksempel — T_INDKOB_SETUP_BCUF_07 step for step

```
Test-barcode oprettet i BC_01: id=88, product_id=pids.primary, barcode='T_INDKOB_SETUP_001'

1. snapshot_uf_before = GET userfields for barcode 88
   → {} (tom — nyoprettet)

2. updateProductBarcodeUserfields(88, {
     is_preferred:       '1',
     is_agreement_item:  '1',
     supplier_unit_code: 'ks',
     supplier_unit_qty:  '5',
     pack_size_stock_unit: '5.000'
   })
   → PUT /userfields/product_barcodes/88 med alle 5 felter

3. GET /api/grocy/product-barcodes (cache-invalideret efter PUT)
   → find entry id=88
   → entry.userfields == {
       is_preferred: '1',
       is_agreement_item: '1',
       supplier_unit_code: 'ks',
       supplier_unit_qty: '5',
       pack_size_stock_unit: '5.000'
     }

4. ASSERT alle 5 felter matcher ✓

5. ROLLBACK:
   updateProductBarcodeUserfields(88, {
     is_preferred:       '',
     is_agreement_item:  '',
     supplier_unit_code: '',
     supplier_unit_qty:  '',
     pack_size_stock_unit: ''
   })
   → Grocy returnerer null for alle (jf. obs #001)

6. CLEANUP_03 senere: DELETE barcode 88 helt

PASS — hermetisk
```

---

## 6. Fejlsignaler og fortolkning

| Symptom | Sandsynlig årsag |
|---------|------------------|
| POST supplier med integration_type='webshop' fejler med 400 | Migration 030 ikke anvendt — CHECK-constraint mangler `'webshop'` |
| POST supplier med integration_type='intern' fejler med 400 | Migration 032 ikke anvendt |
| Soft-delete af supplier returnerer 404 ved efterfølgende GET | `routes/purchasing.js` filtrerer `is_active=1` for hårdt — overvej `?include_inactive` flag |
| Cache returnerer gamle barcodes efter POST | `_cache.delete('product_barcodes')` mangler i createProductBarcode (allerede tilstede ifølge grocyAdapter.js linje 477, men verificér) |
| `updateProductBarcodeUserfields` returnerer 404 | Userfield-entity skal måske eksistere først. Grocy upsert? Verificér ved første kørsel |
| `supplier_grocy_locations` POST opretter to rækker for samme par | Duplikat-prevention mangler — UNIQUE(supplier_id, grocy_location_id) constraint? |
| `supplier_unit_code` returneres tom efter PUT | Grocy lagrer som null hvis tom streng — `parseUserfield(uf)` skal håndtere null/'' ens (jf. T_STOCK obs #001) |
| Test-rækker dukker op i `duplicate_candidates` efter cleanup | Tabellens trigger logger ALLE barcode-flytninger, også test'enes. Tilføj eksplicit cleanup på `duplicate_candidates` med test-præfix-filter |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_INDKOB_SETUP.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_INDKOB_SETUP.js` | Test-runner | 🔲 |
| `tests/scripts/helpers/grocy_mutation.js` | Genbruges fra T_INDKOB_LISTE (samme delte modul) | 🔲 (oprettes som del af T_INDKOB_LISTE) |
| `tests/fixtures/T_INDKOB_pids.json` | Genbruges fra T_INDKOB_LISTE | 🔲 (oprettes som del af T_INDKOB_LISTE) |
| `tests/reports/T_INDKOB_SETUP_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

npm-script:
```json
"test:run-indkob-setup": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_INDKOB_SETUP.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Suppliers CRUD virker incl. soft-delete | Settings → Indkøb → Leverandører (Tab 1) kan trygt opdatere data uden at miste historik |
| CHECK på integration_type holder | Forkerte værdier i bestillings-flow afvises på DB-niveau før de når UI |
| webshop_url accepteres | webshop-typer kan oprettes med URL til "åbn i ny fane"-flow |
| grocy-locations link/unlink virker | Settings kan trygt koble suppliers til Grocy-locations — fundament for at indkøbslisten kan vise korrekt leverandørgruppe |
| Product-barcodes CRUD med cache-invalidering | "+ Ny kobling" og "Slet kobling" i admin-UI virker uden at vise gamle data |
| 5 indkøbs-userfields persisterer på barcodes | `is_preferred`/`is_agreement_item`-sortering i indkob.js vil rendere chips i korrekt rækkefølge |
| `supplier_unit_code`/`supplier_unit_qty` persisterer | Hoka basket-add (T_INDKOB_HORKRAM) har korrekte salesUnit-værdier |
| `duplicate_candidates` modtager rækker | Admin-flow for duplikat-håndtering har fundament — UI testes separat hvis nødvendigt |

---

## 9. Næste skridt efter T_INDKOB_SETUP

| Track | Indhold |
|-------|---------|
| **T_INDKOB_ADMIN** | Batch prisopdatering, Dice bigram auto-matching, udgået-detection |
| **T_INDKOB_HORKRAM** | Bestillingsflowet (webshop-kurv + email-flow + PO-mail-tråde) |
| **T_VAREMODTAGELSE** | Atomisk POST /api/goods-receipts (receipt + addStock + shopping-list cleanup + webhook) — bygger på alle 4 indkøbs-tracks |

---

## 10. Status — efter første kørsel

```
T_INDKOB_SETUP — 11. maj 2026
47 PASS · 0 FAIL · 0 SKIP (første kørsel grøn)

Dækker:
  - 5 SETUP-cases (DB, fixture, endpoints, schema, adapter)
  - 9 SUPPLIERS CRUD-cases (alle 5 integration_types + soft-delete)
  - 5 SGL (grocy-locations link/unlink)
  - 6 BC (product-barcodes CRUD + cache-invalidering)
  - 7 BCUF (barcode userfields — alle 5 indkøbs-felter + batch + tom-restore)
  - 4 PUF (product userfields — supplier_price_per_kg, price_updated_at,
    min_stock, shopping_location)
  - 3 CACHE (dækket implicit af BC + BCUF)
  - 3 DUP (duplicate_candidates schema-tjek + INSERT)
  - 5 CLEANUP (hard-delete via SQL, restore userfields)

Nye observations (logget i TEST_OBSERVATIONS):
  - #013: route POST /suppliers falder tilbage til 'manual' ved ugyldig type
  - #014: supplier_grocy_locations INSERT OR REPLACE → silent 200 ved duplikat
  - #015: Grocy 500 ved duplikat (pid, barcode) — relateret #002
```

---

## 11. Findings markeret undervejs i spec'en

| Reference | Note |
|-----------|------|
| §4.2 (SUP_05) | webshop-type uden webshop_url — dokumentér Bon v2-adfærd. Spec siger "kræver" men constraint i DB validerer måske ikke. Hvis ikke, observation til UI-validering |
| §4.2 (SUP_09) | `?include_inactive`-flag — kun observation om det understøttes. Hvis ikke, kan være feature-request |
| §4.3 (SGL_03) | Duplikat-kobling — dokumentér adfærd. Hvis silent 201, kan UI'en oprette tomme duplikater |
| §4.4 (BC_03) | Duplikat barcode på samme produkt — dokumentér Grocys adfærd. Kan være kilde til duplikat-detection-flow |
| §4.4 (BC_06) | Barcode unikhed — er det globalt eller pr. supplier? Påvirker hvordan UI'en kan tillade samme varenr på to leverandører |
| §4.5 (BCUF_06) | Empty userfield returneres som null — samme som T_STOCK obs #001 |
| §4.8 (DUP_03) | Schema for `duplicate_candidates` — dokumentér de faktiske kolonner ved første kørsel hvis de afviger fra forventning |

---

*Oprettet: maj 2026 — afventer T_INDKOB_LISTE-runner og pids.json. Kan implementeres parallelt da scope er disjoint.*
