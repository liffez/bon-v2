# CLAUDE_TEST_INDKOB.md
> Test- og verifikationsspec for Indkøbsmodulet (Fase 6b + 6c)
> Dækker: indkob.js · settings panel · Hørkram-integration · Grocy-integration · V2 backend · Mail · Office

---

## Principper

**Test-miljø:** Altid mod `grocytest.ristetrug.dk` — aldrig mod produktions-Grocy.
**Rækkefølge:** Integrationstest køres i den rækkefølge de er listet — senere tests afhænger af tidligere.
**Non-destructive:** Tests må tilføje data til grocytest, men skal efterlade systemet i en ren tilstand.
**Smoke-test** (`scripts/smoke-indkob.sh`) køres automatisk efter deployment.

---

## 1. Forudsætninger — check inden test starter

```bash
# Alle disse skal returnere OK inden du begynder
curl -s http://localhost:4321/api/horkram/health | jq .ok         # true
curl -s http://localhost:4321/api/grocy/products | jq length      # > 0
curl -s http://localhost:4321/api/purchasing/suppliers | jq length # > 0
```

| Check | Kommando | Forventet |
|-------|----------|-----------|
| Server kører | `curl localhost:4321/api/health` | `{"ok":true}` |
| Hoka credentials sat | `.env` har `HORKRAM_USER` + `HORKRAM_PASS` | — |
| grocytest tilgængeligt | `curl https://grocytest.ristetrug.dk/api/system/info` | HTTP 200 |
| Leverandører i DB | `sqlite3 data/bon.db "SELECT name,integration_type FROM suppliers"` | Hørkram, Inco, ... |

---

## 2. Hørkram-integration

### 2A — Auth og session

| # | Test | Forventning | Hvis fejl |
|---|------|-------------|-----------|
| 2A-1 | `GET /api/horkram/health` | `{ok:true, configured:true, hasSession:true}` | Check HORKRAM_USER/HORKRAM_PASS i .env |
| 2A-2 | `POST /api/horkram/login` (force re-login) | `{ok:true}` inden 5 sek | Anti-forgery token fejl — se login-flow i horkram.js |
| 2A-3 | Vent 31 min, kald derefter `GET /health` | Session fornyes automatisk | sessionCache.exp-logik fejler |
| 2A-4 | `GET /api/horkram/customers` (debug endpoint) | HTTP 200, array med kunder | Kundekontekst ikke sat efter login |

### 2B — Produkt-opslag

| # | Test | Forventning |
|---|------|-------------|
| 2B-1 | `GET /api/horkram/product/245801` | Parsed produkt med `name`, `varenummer`, `salesUnits[]`, `isAgreementItem` |
| 2B-2 | `GET /api/horkram/product/245801` — tjek `isAgreementItem` | `true` (Smør Lurpak er aftalevare) |
| 2B-3 | `GET /api/horkram/search?q=smør` | `{totalResults:>0, results:[...]}` med `isAgreementItem` på aftale-varer |
| 2B-4 | `GET /api/horkram/debug/245801` | `salesPriceSource.TrackingId === 'Fixed'` |

### 2C — Snapshots (kritisk for chip-sortering og priser)

```bash
# Test snapshot endpoint — BEMÆRK: /snapshots ikke /products/snapshots
curl "localhost:4321/api/horkram/snapshots?ids=245801,118342,334201"
```

| # | Test | Forventning |
|---|------|-------------|
| 2C-1 | Kald `/snapshots?ids=245801` | `{products:[{varenummer:'245801', isAgreementItem:true, salesUnits:[...]}]}` |
| 2C-2 | Kald med 25 IDs (over chunk-grænsen på 20) | Alle 25 returneret korrekt (auto-chunking virker) |
| 2C-3 | `products[0].salesUnits[0].quantity` | Skal være kg-antal (fx 10 for 500g×20 kasse) |
| 2C-4 | Ugyldigt varenr. i batch | Returneres ikke i results, ingen crash |

### 2D — Favoritter

| # | Test | Forventning |
|---|------|-------------|
| 2D-1 | `GET /api/horkram/favorites` | `{lists:[{id, name, type},...]}` — mindst 1 liste |
| 2D-2 | `GET /api/horkram/favorites/{id}` (side 1) | `{products:[...], totalPages:N, currentPage:1}` |
| 2D-3 | `GET /api/horkram/favorites/{id}/all` | Alle sider aggregeret, `isAgreementItem` enriched |
| 2D-4 | Favorit-liste med 2+ sider | `/all` returnerer alle produkter (auto-pagination virker) |

### 2E — Kurv (basket) — kræver aktiv Hoka-session

> ⚠️ Test 2E modificerer Hoka-kurven. Kør kun mod testbruger.

| # | Test | Forventning |
|---|------|-------------|
| 2E-1 | `GET /api/horkram/basket` | `{id:N, lineCount:N, lines:[...]}` |
| 2E-2 | `PUT /api/horkram/basket/add` med `{products:[{varenummer:'245801', quantity:1, salesUnitCode:'ks', salesUnitQuantity:10}]}` | `{ok:true, addedProducts:1, subtotal:N}` |
| 2E-3 | Kald `GET /api/horkram/basket` igen | lineCount øget med 1 |
| 2E-4 | Manglende CSRF-token (clear session, prøv basket add) | `{error:'Ingen CSRF-token...'}` — ikke 500 |
| 2E-5 | Forkert salesUnitCode | Hoka returnerer fejl — routes/horkram.js videresender den korrekt |

---

## 3. Grocy-integration

### 3A — Læsning

| # | Test | Forventning |
|---|------|-------------|
| 3A-1 | `GET /api/grocy/products` | Array med produkter, hvert med `shopping_location_id`, `min_stock_amount` |
| 3A-2 | `GET /api/grocy/product-barcodes` | Array med barcodes, hvert med `userfields` objekt |
| 3A-3 | `GET /api/grocy/shopping-list` | Array med shopping_list items, hvert med `userfields` |
| 3A-4 | `GET /api/grocy/shopping-locations` | Array med lokationer |
| 3A-5 | Barcode userfields indeholder `is_agreement_item`, `supplier_unit_code`, `supplier_unit_qty`, `is_preferred` | Alle fire felter til stede (selv om tomme) |

### 3B — Userfields auto-oprettelse (`_ibEnsureUserfields`)

> Disse tests kræver at de relevante userfields IKKE eksisterer i forvejen (test på frisk grocytest).

| # | Test | Forventning |
|---|------|-------------|
| 3B-1 | Kør `initIndkob()` på side uden userfields | `_ibEnsureUserfields()` opretter `ordered_at`, `ordered_qty`, `ordered_supplier`, `ordered_varenr` |
| 3B-2 | Kald `GET /api/grocy/objects/userfields?entity=shopping_list` | Alle 4 felter eksisterer |
| 3B-3 | Kør `initIndkob()` igen (felter eksisterer nu) | Ingen fejl, ingen duplikerede felter |

### 3C — Skriv: ordered_* userfields sættes ved bestilling

```bash
# Manuel test: bestil en vare og tjek at Grocy opdateres
# 1. Find et shopping_list item ID: GET /api/grocy/shopping-list → tag første items id
# 2. Kald indkob.js "Gå til kurv" for Hørkram
# 3. Tjek:
curl "localhost:4321/api/grocy/objects/shopping_list_items/{id}" | jq .userfields
```

| # | Test | Forventning |
|---|------|-------------|
| 3C-1 | Efter Hørkram-bestilling: `ordered_varenr` | Hokas varenummer (fx '245801') |
| 3C-2 | `ordered_at` | ISO timestamp, maks 5 sek gammel |
| 3C-3 | `ordered_qty` | Svarer til bestilt antal |
| 3C-4 | `ordered_supplier` | 'Hørkram' |
| 3C-5 | Fortryd bestilling | Alle 4 userfields slettet / tomme |

### 3D — Skriv: barcode-kobling

| # | Test | Forventning |
|---|------|-------------|
| 3D-1 | Kobl umatched vare til Hoka-varenr. | Ny barcode i Grocy med korrekt `product_id`, `barcode`, `shopping_location_id` |
| 3D-2 | `supplier_unit_code` sat | Matcher Hokas salesUnit code (fx 'ks') |
| 3D-3 | `supplier_unit_qty` sat | Korrekt antal kg pr. pakke |
| 3D-4 | Kobl samme varenr. til andet Grocy-produkt | Duplikat-dialog vises, ikke stille fejl |
| 3D-5 | Auto-genereret INT-varenummer (Oluf) | Format `INT-XXXX`, unikt, gemmes i Grocy |
| 3D-6 | Redigér INT-varenummer til rigtigt nummer | Barcode opdateres, INT-prefix fjernet |

### 3E — Skriv: produkt-batch-editor

| # | Test | Forventning |
|---|------|-------------|
| 3E-1 | Skift `shopping_location_id` på et produkt | Grocy opdateres via `PUT /api/grocy/objects/products/{id}` |
| 3E-2 | Skift `min_stock_amount` | Grocy opdateres |
| 3E-3 | Gem 5 ændringer på én gang | Alle 5 PUT-kald afsendt, alle returnerer 204 |
| 3E-4 | Én fejler (Grocy-timeout) | De øvrige 4 gemmes stadig, fejlbesked vises for den ene |
| 3E-5 | Fortryd alle ændringer | Tabel vises med originale værdier |

---

## 4. V2 Backend

### 4A — Purchase orders

| # | Test | Forventning |
|---|------|-------------|
| 4A-1 | Hørkram-bestilling → `GET /api/orders/pending` | Ny ordre med korrekt `supplier_id`, `grocy_location_id`, `lines[]` |
| 4A-2 | Manuel bestilling (Emballage) → pending orders | Ordre med `sent_via: 'manual'` |
| 4A-3 | Ordre-linjer har `grocy_product_id` + `grocy_shopping_list_id` | Bruges af varemodtagelse |
| 4A-4 | Fortryd bestilling → ordre-linje status | `cancelled` — ikke slettet |

### 4B — Suppliers API

| # | Test | Forventning |
|---|------|-------------|
| 4B-1 | `GET /api/purchasing/suppliers` | Alle aktive leverandører med `integration_type` |
| 4B-2 | `POST /api/purchasing/suppliers` (ny leverandør) | 201, ny row i DB |
| 4B-3 | `PATCH /api/purchasing/suppliers/{id}` | Opdateres korrekt |
| 4B-4 | `DELETE /api/purchasing/suppliers/{id}` med aktive koblinger | 409 eller deactivate — ikke hård sletning |
| 4B-5 | `integration_type: 'intern'` — Migration 032 | CHECK constraint accepterer 'intern' |

### 4C — Grocy-location koblinger

| # | Test | Forventning |
|---|------|-------------|
| 4C-1 | `POST /api/purchasing/suppliers/grocy-locations` | Kobling oprettet |
| 4C-2 | `GET /api/purchasing/suppliers` — linked data | `grocy_location_display_name` returneres |
| 4C-3 | `DELETE /api/purchasing/suppliers/grocy-locations/{id}` | Kobling fjernet |
| 4C-4 | Kobl samme Grocy-location til to leverandører | Fejl — én location = én leverandør |

---

## 5. indkob.js — UI-flows

### 5A — Init og loading

| # | Test | Hvordan | Forventning |
|---|------|---------|-------------|
| 5A-1 | Side loader uden fejl | Åbn `/kitchen/purchasing.html` | Loading-spinner → accordion med leverandørgrupper |
| 5A-2 | Snapshot enrichment sker | Åbn DevTools Network → filter på 'snapshots' | `GET /api/horkram/snapshots?ids=...` kald ses |
| 5A-3 | Favorites cache loader i baggrund | Vent 10 sek → filter på 'favorites' | Favorit-lister hentes efter initial render |
| 5A-4 | Tab-skift genbruger state | Skift til Varemodtagelse og tilbage | Ingen ny snapshot-fetch, data stadig der |
| 5A-5 | Hoka proxy offline | Sæt forkert credentials → reload | Indkøb virker stadig (uden aftale-badges), ingen crash |

### 5B — Chips og leverandørvalg

| # | Test | Forventning |
|---|------|-------------|
| 5B-1 | Foretrukken chip pre-valgt | Produkt med `is_preferred='1'` på en barcode → den chip er valgt ved load |
| 5B-2 | Aftale-chip vises korrekt | Produkt med aftalevare → chip har grøn [Aftale] badge |
| 5B-3 | Chip-skift genberegner antal | Skift fra 500g×20 til 2,5 kg → qty ændres automatisk |
| 5B-4 | Chip-skift opdaterer pris/kg | Calc-linje viser ny kr/kg |
| 5B-5 | Multi-leverandør chips (Burgerlommer) | Tre chips — Serviwet valgt som default (is_preferred) |

### 5C — Antal-kontrol

| # | Test | Forventning |
|---|------|-------------|
| 5C-1 | `−` knap | Reducerer med 1, stopper ved 0 |
| 5C-2 | `+` knap | Øger med 1 |
| 5C-3 | Direkte input `500` | Accepteres, calc-linje opdateres |
| 5C-4 | Input `0` | Tilladt — bruger kan sætte til 0 for at springe over |
| 5C-5 | Input `-1` eller bogstaver | Ignoreres / sættes til 0 |

### 5D — Hørkram bestillingsflow (end-to-end)

| # | Test | Forventning |
|---|------|-------------|
| 5D-1 | "Læg i kurv" — knap-state | Viser "..." mens kald kører, derefter "I kurv ✓" |
| 5D-2 | "Læg i kurv" — Grocy shopping_list item | `ordered_varenr` sat inden for 2 sek |
| 5D-3 | "Gå til kurv" — purchase_order oprettet | `GET /api/orders/pending` viser ny ordre |
| 5D-4 | "Gå til kurv" — hoka.dk åbner | `window.open` mod `https://www.hoka.dk/da-dk/checkout` |
| 5D-5 | Samme vare "Læg i kurv" to gange | Anden klik ignoreres (inCart = true) |
| 5D-6 | Hoka-API fejler ved basket-add | Toast med fejlbesked, knap reset til "Læg i kurv" |

### 5E — Manuel bestillingsflow

| # | Test | Forventning |
|---|------|-------------|
| 5E-1 | "Marker valgt" × 3 → "Registrér bestilling" | Dialog viser de 3 valgte varer med leverandørinfo |
| 5E-2 | "Kopiér liste" | Indhold kopieret til clipboard — format: navn · antal · varenr |
| 5E-3 | "Send mail" | mailto-link åbner med pre-udfyldt emne og vareliste |
| 5E-4 | "Bekræft bestilt" | `ordered_*` userfields sat i Grocy for alle valgte varer |
| 5E-5 | Varer flyttes til bestilt-sektion | Visning opdateret uden page reload |

### 5F — Kobling af umatchede varer

| # | Test | Forventning |
|---|------|-------------|
| 5F-1 | Link-panel åbner | Klik "Kobl varenr." → inline panel under varen |
| 5F-2 | Favorites-first søgning | Søg produktnavn → favorites vises øjeblikkeligt, catalog bagefter |
| 5F-3 | Manuel varenr. opslag | Skriv varenr. → "Hent →" → parsed produkt vises |
| 5F-4 | "+ Kobl" | Barcode oprettet i Grocy, vare flyttes til klar-sektion |
| 5F-5 | "Spring over" | Vare dæmpes, forsvinder ikke fra listen |
| 5F-6 | Kobl allerede-koblet varenr. | Duplikat-dialog: "Varenr. allerede koblet til [produkt] — flyt?" |

### 5G — Manglende og Udløbende paneler

| # | Test | Forventning |
|---|------|-------------|
| 5G-1 | Banner vises kun hvis > 0 forslag | 0 manglende → ingen banner |
| 5G-2 | Klik banner → panel åbner | Smooth expand, ikke modal |
| 5G-3 | Juster antal → klik Tilføj | Shopping_list opdateret i Grocy |
| 5G-4 | Vælg alle / fravælg | Alle checkboxes toggler |
| 5G-5 | Antal i toolbar-badge opdateres | Efter tilføjelse: "3 forslag" → "1 forslag" |

### 5H — RR Produktion

| # | Test | Forventning |
|---|------|-------------|
| 5H-1 | Intern gruppe vises med lilla ikon | Produkter med `integration_type: 'intern'` grupperes her |
| 5H-2 | "Opret bon →" per vare | `createBon({type:'intern',...})` — bon oprettes |
| 5H-3 | "Opret produktionsbons" (alle) | N bons oprettes, toast bekræfter |
| 5H-4 | Opskrift linkes til bon | Grocy `recipe_id` sat på bon hvis tilgængeligt |

---

## 6. Settings panel

### 6A — Slide-in panel

| # | Test | Forventning |
|---|------|-------------|
| 6A-1 | ⚙ åbner panel | Smooth slide-in fra højre, overlay bag ved |
| 6A-2 | ✕ eller overlay-klik lukker panel | Smooth slide-out |
| 6A-3 | Escape-tast lukker panel | Panel lukker |
| 6A-4 | Tab-skift i panel | Korrekt tab vises, state bevares |

### 6B — Leverandør-tab

| # | Test | Forventning |
|---|------|-------------|
| 6B-1 | Load leverandørliste | Alle aktive leverandører vises |
| 6B-2 | ✏ Rediger leverandør | Inline form med nuværende værdier |
| 6B-3 | Gem ændring | PATCH til V2 backend, tabel opdateres |
| 6B-4 | Tilføj ny leverandør | POST til backend, ny række i tabel |
| 6B-5 | Grocy-location dropdown | Viser alle Grocy shopping_locations |
| 6B-6 | Kobl Grocy-location | POST til supplier_grocy_locations, feedback |
| 6B-7 | Ukoblede lokationer markeres | Orange "Ikke koblet" badge |

### 6C — Produkter-tab (konfigurerbar tabel)

| # | Test | Forventning |
|---|------|-------------|
| 6C-1 | Tabel loader med default kolonner | Leverandør + Minimumsgrænse + Enhed vist |
| 6C-2 | Kolonne-chip toggle | Kolonne vises/skjules øjeblikkeligt |
| 6C-3 | Kolonnepræferencer huskes | localStorage — vises ved næste åbning |
| 6C-4 | Søg i produktnavn | Tabel filtrerer live |
| 6C-5 | Filter på leverandør | Viser kun produkter med den leverandør |
| 6C-6 | Skift shopping_location_id | Grocy PUT kald, felt valideret |
| 6C-7 | Skift min_stock_amount | Grocy PUT kald |
| 6C-8 | Ændret celle-indikator | Orange dot + gul rækkefarve |
| 6C-9 | Antal ændringer i bulk-bar | Tæller korrekt op/ned |
| 6C-10 | Gem alle ændringer | Alle PUT-kald afsendt, bar forsvinder |

### 6D — Hørkram-tab

| # | Test | Forventning |
|---|------|-------------|
| 6D-1 | Status-linje viser session-info | "Proxy OK · Session udløber om Xm" |
| 6D-2 | Opslag: varenr. → parsed produkt | Navn, pris, salesUnits vises |
| 6D-3 | Opslag: "Kobl til Grocy-produkt" | Grocy-produktsøgning → barcode oprettet |
| 6D-4 | Favoritter: liste over HK-lister | Count af koblet/ukoblet pr. liste |
| 6D-5 | "Importer priser" | Batch-snapshot → `last_price` opdateres på barcodes |
| 6D-6 | Ny kobling: liste over ukoblede | Alle Grocy-produkter uden HK-barcode |
| 6D-7 | Ny kobling: "Søg og kobl" | Auto-søg i Hoka, foreslår match |
| 6D-8 | Alle koblinger: foretrukken toggle | `is_preferred` userfield sættes i Grocy |
| 6D-9 | Alle koblinger: enhed-kode | `supplier_unit_code` + `supplier_unit_qty` sættes |
| 6D-10 | "Opdater priser nu" | Progress-bar, resultat-summary (opdateret/sprunget/fejl) |
| 6D-11 | "Planlæg daglig" | `system_settings` opdateres med cron-tid |

---

## 7. Office Settings

Settings-panelet skal fungere identisk i office-konteksten. Komponenterne er de samme — kun mounting er anderledes.

| # | Test | Forventning |
|---|------|-------------|
| 7-1 | Settings → Indkøb i office sidebar | Indkøbs-settings vises som fuld side (ikke slide-in) |
| 7-2 | Samme tre tabs | Leverandører · Produkter · Hørkram |
| 7-3 | Alle ændringer fra kitchen afspejles i office | Shared state via backend — ingen cache-inkonsistens |
| 7-4 | Office kan tilføje leverandør | POST virker fra office-kontekst |
| 7-5 | Kitchen tandhjul vises i office | Nej — ⚙ er kun i kitchen toolbar |

---

## 8. Mail-integration (manuel bestilling)

| # | Test | Forventning |
|---|------|-------------|
| 8-1 | "Send mail" i bestillingsdialog | mailto-link med korrekt modtager (fra `suppliers.contact_email`) |
| 8-2 | Mail-indhold | Emne: "Bestilling Ristet Rug · [dato]" · Body: vareliste med antal og varenr. |
| 8-3 | Leverandør uden email | "Send mail"-knap vises ikke |
| 8-4 | Leverandør med telefon | "📞 Ring"-knap vises med korrekt `tel:` link |
| 8-5 | Kopi til udklipsholder | Samme format som mail-body |

---

## 9. Smoke-test script

Kør dette efter deployment for hurtig verifikation:

```bash
#!/bin/bash
# scripts/smoke-indkob.sh
BASE="http://localhost:4321"
FAIL=0

check() {
  local desc=$1; local url=$2; local expect=$3
  local result=$(curl -s "$url")
  if echo "$result" | grep -q "$expect"; then
    echo "  ✓ $desc"
  else
    echo "  ✗ $desc — forventede '$expect'"
    echo "    Fik: $(echo $result | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

echo "=== Indkøb smoke-test ==="

echo "--- Hørkram ---"
check "Health" "$BASE/api/horkram/health" '"ok":true'
check "Snapshot endpoint (ikke /products/snapshots)" "$BASE/api/horkram/snapshots?ids=245801" '"varenummer"'
check "Search" "$BASE/api/horkram/search?q=smør" '"totalResults"'

echo "--- Grocy proxy ---"
check "Products" "$BASE/api/grocy/products" '"id"'
check "Barcodes" "$BASE/api/grocy/product-barcodes" '"barcode"'
check "Shopping list" "$BASE/api/grocy/shopping-list" '\['
check "Shopping locations" "$BASE/api/grocy/shopping-locations" '"id"'

echo "--- V2 backend ---"
check "Suppliers" "$BASE/api/purchasing/suppliers" '"supplier_id"'
check "Grocy locations" "$BASE/api/purchasing/suppliers/grocy-locations" '"locations"'
check "Pending orders" "$BASE/api/orders/pending" '\['

echo ""
if [ $FAIL -eq 0 ]; then
  echo "✓ Alle checks OK"
else
  echo "✗ $FAIL checks fejlede"
  exit 1
fi
```

---

## 10. Kendte edge cases og regressionsrisici

| Risiko | Område | Test |
|--------|--------|------|
| `/products/snapshots` vs `/snapshots` endpoint-navn | horkram.js + indkob.js | 2C-1, smoke-test |
| `ordered_*` userfields eksisterer ikke i fresh Grocy | _ibEnsureUserfields | 3B-1 |
| Samme Grocy-product med barcodes hos to lokationer grupperes forkert | _ibBuildGroups | 5B-5 |
| Session-cache udløber midt i basket-add | horkram.js auto-retry | 2A-3, 2E-4 |
| `integration_type: 'intern'` CHECK constraint ikke migreret | Migration 032 | 4B-5 |
| Kolonne-præferencer fra gammel session crasher ny tabel | localStorage format | 6C-3 |
| `is_preferred` userfield ikke oprettet i Grocy | barcodes-editor save | 6D-8 |
| Duplikat shopping_list items (samme product_id to gange) | _ibBuildGroups aggregering | 5A-1 |
| Hoka CSRF-token udløbet ved basket PUT | horkram.js re-login flow | 2E-4 |
| INT-varenummer allerede taget (race condition) | _ibGenerateIntId | 3D-5 |

---

## 11. Go/no-go inden produktion

Alle disse skal være grønne:

- [ ] Smoke-test script returnerer 0 fejl
- [ ] Test 2E-2 (basket add virker mod rigtig Hoka-konto)
- [ ] Test 3C-2 (ordered_at timestamp sættes korrekt i Grocy)
- [ ] Test 5D-3 (purchase_order oprettes i V2)
- [ ] Test 5F-4 (barcode-kobling oprettes i Grocy)
- [ ] Test 6C-10 (batch-gem af produkter)
- [ ] Test 6D-5 (pris-import fra favorit-liste)
- [ ] Test 7-3 (kitchen og office deler state via backend)
- [ ] Manuel end-to-end: tilføj 3 varer til Hørkram-kurv → bekræft på hoka.dk → se bestilt-badge i indkøbslisten
