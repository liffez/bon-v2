# CLAUDE_INDKOB.md
> ⚠️ **HISTORISK — implementeret og deployet. Beskriver IKKE nuværende tilstand.**
> Aktuel tilstand: [`CLAUDE_INDKOB_ASIS.md`](CLAUDE_INDKOB_ASIS.md).
> Igangværende arbejde: [`indkob/`](indkob/) (Fase A = epic #471, Fase B, Fase C-skitse).
> Linjenumre i dette dokument er forældede — brug `grep`.

> Spec for shared/indkob.js — det centrale indkøbskomponent
> Erstatter shared/shopping_list.js + shared/bestilling.js fuldstændigt.
> Læs BON_V2_PRINCIPPER.md, bon_v2_datamodel_v2.md og CLAUDE_HORKRAM_INTEGRATION.md FØR du begynder.

---

## Baggrund og formål

Indkøbsliste og bestilling er ikke to adskilte flows — de er én arbejdsproces.
Den tidligere opdeling i `shopping_list.js` + `bestilling.js` skabte kunstig friktion
og manglende sammenhæng (bestilt-status vistes ikke i listen, init-problemer, etc.).

`indkob.js` samler det hele i ét komponent med ét state-objekt og én render-logik.

**Reference-implementeringer:** de tre prototyper i `tools/bestilling/` (`shopping.html`,
`bestilling.html`, `horkram-scraper.html`) **findes ikke længere i repoet** — de blev fjernet
efter porten. Den implementerede kode er `shared/indkob.js` + `shared/indkob_settings.js`;
mockup'en `docs/indkob_mockup_v3.html` er ligeledes væk.

---

## Arkitektur

### Mounting
```javascript
// kitchen/purchasing.html
initIndkob(document.getElementById('indkobContainer'));
```

Initialiseres **én gang**. Genbruger state ved tab-skift.
`purchasing.html` har to tabs: `[ Indkøb ]  [ Varemodtagelse ]`.

### Filstruktur
```
shared/indkob.js          ← NY (dette dokument)
shared/indkob.css         ← NY
kitchen/purchasing.html   ← OPDATERES (2 tabs, mount indkob)
```

`shared/shopping_list.js`, `shared/shopping_list.css`, `shared/bestilling.js`,
`shared/bestilling.css` **udgår** når indkob.js er verificeret.

---

## State-model

```javascript
// Alle globals præfikset _ib (indkob)

var _ibContainer       = null;

// ── Grocy data ────────────────────────────────────────────
var _ibShoppingList    = [];   // Grocy shopping_list items (inkl. userfields)
var _ibProducts        = {};   // product_id → product
var _ibBarcodes        = [];   // Grocy product_barcodes (alle)
var _ibQUnits          = {};   // qu_id → { name, namePlural }
var _ibLocations       = {};   // grocy shopping_location id → { id, name }

// ── V2 leverandør data ────────────────────────────────────
var _ibHandelssteder   = [];   // fra /api/purchasing/suppliers?location_id=
                               // én række pr. grocy_location_id
                               // { supplier_id, supplier_name, integration_type,
                               //   grocy_location_id, display_name, contact_email,
                               //   contact_phone, webshop_url, notes, is_active }

// ── Hoka live data ────────────────────────────────────────
var _ibHokaOk          = false;
var _ibFavCache        = [];   // [{varenummer, name, isAgreementItem, salesUnits, ...}]
var _ibFavLoaded       = false;
var _ibFavLoading      = false;

// ── Derived: leverandørgrupper ────────────────────────────
// Bygges af _ibBuildGroups() efter data er loaded + enriched
// Nøgle: grocy_location_id (String) eller '__none__' eller '__intern__'
var _ibGroups          = {};
// Struktur pr. gruppe:
// {
//   grocyLocationId:  String,
//   supplierId:       Number|null,
//   supplierName:     String,
//   displayName:      String,      // fra grocy_location_display_name || supplier_name
//   integrationType:  'api'|'email'|'manual'|'intern'|'none',
//   contactEmail:     String|null,
//   contactPhone:     String|null,
//   webshopUrl:       String|null,
//   notes:            String|null, // vises som undertekst i gruppe-header
//   items:            Array,       // se item-struktur nedenfor
// }
//
// Item-struktur:
// {
//   item:             Object,      // Grocy shopping_list item (primær)
//   allItems:         Array,       // alle sl-items for dette product_id
//   product:          Object,      // Grocy product
//   barcodes:         Array,       // matchede barcodes sorteret (foretrukken > aftale > billigst)
//   matched:          Boolean,
//   selectedBcIdx:    Number,      // valgt barcode-index
//   selectedBarcode:  Object|null,
//   need:             Number,      // aggregeret behov (sum af alle sl-items)
//   needUnit:         String,      // Grocy stock-enhed navn
//   qty:              Number,      // beregnet antal pakker
//   inCart:           Boolean,     // lagt i Hoka-kurv
//   isOrdered:        Boolean,     // ordered_varenr sat i Grocy
//   orderedAt:        String|null,
//   orderedSupplier:  String|null,
// }

// ── UI state ──────────────────────────────────────────────
var _ibOpenGroups      = {};   // grocy_location_id → Boolean (foldet ud/ind)
var _ibCartItems       = [];   // varer lagt i Hoka-kurv denne session
var _ibShowOrdered     = {};   // grocy_location_id → Boolean (vis bestilte)
var _ibPanelOpen       = null; // 'missing'|'expiring'|null
var _ibLinkPanelId     = null; // product_id med åbent kobling-panel
var _ibMoOpen          = null; // grocy_location_id med åben bestillings-dialog
var _ibBusy            = false;
```

---

## Data-sources og Grocy-integration

### Load ved init
```javascript
async function _ibLoadAll() {
    var results = await Promise.all([
        fetchShoppingList(),                    // GET /api/grocy/shopping-list
        fetchGrocyProducts(),                   // GET /api/grocy/products
        fetchProductBarcodes(),                 // GET /api/grocy/product-barcodes
        fetchGrocyQuantityUnits(),              // GET /api/grocy/quantity-units
        fetchShoppingLocations(),               // GET /api/grocy/shopping-locations
        fetchPurchasingSuppliers(),             // GET /api/purchasing/suppliers
        fetchHokaStatus().catch(() => ({ok:false})),
    ]);
    // ... map til state vars
}
```

### Grocy userfields der læses
På `shopping_list` items:
- `ordered_varenr` — bestilt varenummer
- `ordered_at` — tidspunkt for bestilling
- `ordered_qty` — bestilt antal
- `ordered_supplier` — leverandørnavn

Disse oprettes automatisk ved første kørsel via `_ibEnsureUserfields()`.

### Hoka snapshot-enrichment
Køres efter `_ibBuildGroups()`. Batch-kald til `/api/horkram/snapshots?ids=...`.
Sætter `bc._hoka` på hver barcode med:
- `isAgreementItem` — aftale-badge
- `salesUnits[]` — pakkeformer med `quantity` (antal base-enheder) og priser
- `isOrganic`, `countryCode` — badges
- `image` — produktbillede

Non-fatal: fejler enrichment virker indkøb med Grocy-data.

### Favorites-cache (baggrund)
`_ibLoadFavCache()` køres non-blocking efter første render.
Bruges i søgning ved kobling af umatchede varer.

---

## Gruppe-opbygning og barcode-sortering

### Primær leverandør
`product.shopping_location_id` → `_ibHandelssteder[].grocy_location_id`

### Barcode-matching
For en vare i gruppe `grocyLocationId` vises alle barcodes med:
1. `bc.shopping_location_id === grocyLocationId` (primær leverandør-barcode)
2. PLUS barcodes fra samme `supplier_id` men andre handelssteder (fx Inco Valby + Inco Frederiksberg)

**Dette er multi-leverandør per vare** — burgerlommer kan vise Serviwet, Hørkram og Inco
som tre chips, selvom produktets `shopping_location_id` er "Serviwet".

Barcode-sortering (foretrukken vises og pre-vælges):
```javascript
function _ibSortBarcodes(barcodes) {
    return barcodes.slice().sort((a, b) => {
        // 1. Foretrukken leverandør (is_preferred userfield)
        var aFav = a.userfields?.is_preferred === '1' ? 0 : 1;
        var bFav = b.userfields?.is_preferred === '1' ? 0 : 1;
        if (aFav !== bFav) return aFav - bFav;
        // 2. Aftale-vare (live fra _hoka)
        var aAft = a._hoka?.isAgreementItem ? 0 : 1;
        var bAft = b._hoka?.isAgreementItem ? 0 : 1;
        if (aAft !== bAft) return aAft - bAft;
        // 3. Billigste pris pr. kg
        var aP = _ibPricePerKg(a) || 9999;
        var bP = _ibPricePerKg(b) || 9999;
        return aP - bP;
    });
}
```

### Antal-beregning
Grundenhed er **kg** (Leif har sat alle varer til kg som stock-enhed i Grocy).
`salesUnits[].quantity` = antal kg pr. pakke.

```javascript
function _ibCalcQty(needKg, bc) {
    var packKg = _ibPackSizeKg(bc);
    return Math.max(1, Math.ceil(needKg / packKg));
}
```

---

## UI — Layout og struktur

### Sticky toolbar (øverst)
```
[Søg vare...]  [+ Tilføj vare]  [📉 Manglende (3)]  [⏰ Udløbende (2)]  |  [≡ Liste] [⊡ Fokus]
```

Toolbar er `position: sticky; top: 48px` (under kitchen topbar).
Manglende og Udløbende: tallene i pills opdateres dynamisk.

### Notifikations-paneler (under toolbar)
Manglende og Udløbende er **inline expandable panels** — ikke modaler.
Åbnes ved klik på toolbar-knap ELLER klik på banner.
Banner vises kun hvis der er forslag.

```
┌─ 📉 3 varer under minimumsgrænse ────────────────── [3 forslag] ›  ┐
│  (klik for at udvide)                                               │
└─────────────────────────────────────────────────────────────────────┘
```

Åbent panel viser liste med:
- Checkbox (valgt som default)
- Produktnavn + meta (min-grænse, lager, leverandør)
- Antal-felt (input + ± knapper) pre-udfyldt med (min - lager)
- "Vælg alle" · "Luk" · "Tilføj N valgte til listen"

### Accordion (liste-tilstand)
Én kort pr. leverandørgruppe.

**Gruppe-header:**
```
[IKON] Hørkram                    [4 klar] [1 umatched] [2 bestilt] [ca. 560 kr]  [Gå til kurv →]  ›
       hoka.dk · API-integration
```

Header-klik: fold ud/ind. Ikon farve efter integration_type:
- `api` → grøn (Hørkram)
- `email` → blå
- `manual` → grå
- `intern` → lilla (RR Produktion)

Handling i header:
- `api` → "Gå til kurv →" (grøn)
- `email`/`manual` → "Registrér bestilling" (blå)
- `intern` → "Opret produktionsbon →" (lilla)

**Gruppe-body sektioner (i rækkefølge):**
1. `KLAR TIL BESTILLING — N VARER`
2. `INGEN BARCODE HOS [NAVN] — N VARER`
3. `N VARER BESTILT ▸` (kollapseret, klik for at se)

### Vare-række

```
[Billede]  Smør, usaltet Lurpak   Behov: 3 kg
           [Aftale · 500g×20 stk · 89 kr · 8,9 kr/kg · Nr. 245801]  [2,5 kg · 42 kr · 16,8 kr/kg · Nr. 245802]
           = 10 kg · dækker 3 kg behov · 8,9 kr/kg valgt
           [🇩🇰 DK]
                                                          [−] [1 ↕] [+]  [Læg i kurv]
```

**Chips (inline pakkeform/leverandør-valg):**
- Vises direkte under varenavn
- Én chip per barcode (kombination af leverandør + pakkeform)
- Valgt chip: grøn baggrund
- Chip indhold:
  - Linje 1: `[Aftale]` eller `[Foretrukket]` badge (hvis relevant)
  - Linje 2: pakkeform-navn eller leverandørnavn
  - Linje 3: pris · pris-pr-kg · varenr.
  - Linje 4 (valgfri): leverandørinfo (levering, afhentning)

**Antal-kontrol:**
- `[−]` knap · `[input-felt]` · `[+]` knap
- Input-felt er direkte redigerbart (type=number, min=0)
- Antal genberegnes automatisk ved chip-skift

**Kalk-linje:**
- `= 10 kg · dækker 3 kg behov · 8,9 kr/kg valgt`
- Grøn hvis dækker, orange hvis over (spild), rød hvis under

**Badges:** `[🌿 Øko]` `[🇩🇰 DK]` `[Intern leverandør]`

**Produktbillede:** fra `bc._hoka.image` hvis tilgængeligt, ellers emoji/placeholder.

### Umatchede varer
Vises med "Kobl varenr." knap som åbner inline link-panel:

```
┌─ Link-panel ──────────────────────────────────────────────┐
│ Find varenr. på hoka.dk og indtast, eller søg:            │
│ [Søg / varenr. input ─────────────────────] [Søg]         │
│                                                            │
│ Fra dine favoritter:                                       │
│ [Timian frisk bundtet · ★ Aftale · 38 kr/kg] [+ Kobl]    │
│                                                            │
│ Øvrige resultater:                                         │
│ [Timian, tørret 20g · 22 kr/stk] [+ Kobl]                │
└────────────────────────────────────────────────────────────┘
```

Søgning: favorites-cache først (øjeblikkelig), catalog-API bagefter (asynkront).
Se `CLAUDE_HORKRAM_INTEGRATION.md` for detaljer.

### Bestilte varer (kollapseret sektion)
```
▸ 2 varer bestilt — vis
```
Klik: udvid. Viser varer med dæmpet styling + "Bestilt [dato] · [antal] · [varenr]" badge.
"Fortryd"-knap: sletter `ordered_*` userfields fra Grocy shopping_list item.

### Fokus-tilstand (toggle)
Én leverandørgruppe fylder hele skærmen.
Navigation: toolbar viser "‹ Alle leverandører" tilbage-knap.
Aktiveres ved at klikke på en gruppe i liste-tilstand mens fokus-toggle er aktiv.

---

## API-kald og Grocy-writes

### "Læg i kurv" (Hørkram)
```javascript
async function _ibAddToBasket(entry) {
    // 1. Kald Hoka
    await putHokaBasket([{
        varenummer:        bc.barcode,
        quantity:          entry.qty,
        salesUnitCode:     bc.userfields?.supplier_unit_code || su.code,
        salesUnitQuantity: parseFloat(bc.userfields?.supplier_unit_qty) || su.quantity,
    }]);
    // 2. Opdater state
    entry.inCart = true;
    _ibCartItems.push(entry);
    _ibRender();
}
```

### "Gå til kurv" (afslut Hørkram-bestilling)
```javascript
async function _ibFinishHokaOrder(group) {
    // 1. Opret purchase_order i V2
    await createPendingOrder({ supplier_id, grocy_location_id, lines });
    // 2. Sæt ordered_* userfields i Grocy (pr. shopping_list item)
    for (each cartItem) {
        await apiFetch('/grocy/userfields/shopping_list/' + item.id, {
            method: 'PUT',
            body: { ordered_at, ordered_qty, ordered_supplier, ordered_varenr }
        });
    }
    // 3. Åbn hoka.dk i ny fane
    window.open('https://www.hoka.dk/da-dk/checkout', '_blank');
    // 4. Reload shopping list data
    await _ibReloadShoppingList();
    _ibBuildGroups();
    _ibRender();
}
```

### "Marker valgt" + "Registrér bestilling" (manuel leverandør)
```javascript
async function _ibRegisterManualOrder(group) {
    // 1. Opret purchase_order i V2
    await createPendingOrder({ ... });
    // 2. Sæt ordered_* userfields i Grocy for valgte varer
    for (each selectedItem) {
        await apiFetch('/grocy/userfields/shopping_list/' + item.id, 'PUT', { ... });
    }
    // 3. Varer synker til "bestilt"-sektion
    await _ibReloadShoppingList();
    _ibBuildGroups();
    _ibRender();
}
```

### "Opret produktionsbon" (RR Produktion)
```javascript
async function _ibCreateProductionBon(entry) {
    // Opretter bon med type 'intern' og tilknytter opskrift fra Grocy
    await createBon({
        type:       'intern',
        recipe_id:  product.default_best_before_days, // eller grocy_recipe_id userfield
        note:       'Auto-oprettet fra indkøbsliste',
    });
    // Navigerer til bon-drawen
}
```

### Kobling (ny barcode i Grocy)
```javascript
async function _ibLinkBarcode(entry, hokaProduct) {
    // 1. Opret barcode i Grocy
    await apiFetch('/grocy/objects/product_barcodes', 'POST', {
        product_id:           entry.product.id,
        barcode:              hokaProduct.varenummer,
        shopping_location_id: parseInt(group.grocyLocationId),
        note:                 hokaProduct.name,
        last_price:           hokaProduct.pricePerUnit,
    });
    // 2. Sæt supplier_unit_code og pack_size fra salesUnits
    if (hokaProduct.salesUnits?.length) {
        await apiFetch('/grocy/userfields/product_barcodes/' + newId, 'PUT', {
            supplier_unit_code: defaultUnit.code,
            supplier_unit_qty:  String(defaultUnit.quantity),
        });
    }
    // 3. Sæt is_agreement_item hvis aftale
    if (hokaProduct.isAgreementItem) {
        await apiFetch('/grocy/userfields/product_barcodes/' + newId, 'PUT', {
            is_agreement_item: '1',
        });
    }
    // 4. Refresh barcodes + rebuild
    _ibBarcodes = await fetchProductBarcodes();
    _ibBuildGroups();
    await _ibEnrichSnapshots();
    _ibRender();
}
```

### Tilføj til liste (Manglende/Udløbende/Manuel)
```javascript
// Manglende: bruger godkender forslag
await addMissingProducts(); // eksisterende Grocy-endpoint
// Eller manuel tilføjelse:
await addShoppingListProduct(productId, qty);
// Efter begge: reload
await _ibReloadShoppingList();
```

---

## Leverandørtype-specifik rendering

| `integration_type` | Chip-handling | Hoved-knap | Bestil-dialog |
|--------------------|--------------|------------|---------------|
| `api` (Hørkram) | "Læg i kurv" per vare | "Gå til kurv →" (grøn) | Ingen — kurv er live |
| `email` | "Marker valgt" | "Registrér bestilling" (blå) | Kopiér / Send mail / Bekræft |
| `manual` | "Marker valgt" | "Registrér bestilling" (blå) | Kopiér / Ring / Bekræft |
| `intern` | "Opret bon →" | "Opret produktionsbon →" (lilla) | Opret bons / Tjek råvarer |

**Bestil-dialog for manuel leverandør** viser:
- Vareliste med leverandørnavn, varenr. og antal
- Leverandørens kontaktinfo (fra `suppliers` tabel via `_ibHandelssteder`)
- Knapper: `📋 Kopiér liste` · `✉ Send mail` · `📞 Ring` (hvis tlf) · `✓ Bekræft bestilt`

---

## Auto-genererede varenumre (INT-prefix)

Varer hos leverandører uden katalog (fx Oluf/Trykkerifriheden) kan kobles med
et auto-genereret internt varenummer:

```javascript
function _ibGenerateIntId() {
    // Finds højeste INT-XXXX og inkrementerer
    var existing = _ibBarcodes
        .map(b => b.barcode)
        .filter(b => /^INT-\d+$/.test(b))
        .map(b => parseInt(b.replace('INT-', '')));
    var max = existing.length ? Math.max(...existing) : 0;
    return 'INT-' + String(max + 1).padStart(4, '0');
}
```

Gemmes som normal barcode i Grocy med det genererede nummer.
Kan redigeres til et rigtigt varenummer hvis leverandøren tildeler et.

---

## Fortryd bestilling

"Fortryd"-knap på bestilte varer i kollapseret sektion:
1. Sletter `ordered_*` userfields fra Grocy shopping_list item
2. Opdaterer purchase_order linje i V2 (status → cancelled)
3. Varen flyttes tilbage til "Klar til bestilling"

---

## Settings-afhængigheder

Disse skal konfigureres i Settings inden indkob.js virker fuldt ud:

| Konfiguration | Kilde | Sættes i |
|--------------|-------|----------|
| `integration_type` pr. leverandør | V2 `suppliers` tabel | Settings → Leverandører |
| Grocy-location kobling | V2 `supplier_grocy_locations` | Settings → Leverandører |
| `is_preferred` på barcodes | Grocy barcode userfield | Indkøb inline (kobling) eller Settings |
| HORKRAM_USER / HORKRAM_PASS | .env | Server |
| Hoka scraping / bulk-kobling | horkram-scraper | Settings → Hørkram admin |
| Min-stock grænser | Grocy `min_stock_amount` | Settings → Produkter (batch) |

---

## Pris-visning — kr/kg som standard

Leif har sat kg som grundenhed på alle varer i Grocy.
Priser vises altid pr. kg (eller pr. liter for flydende varer):

```javascript
function _ibPricePerKg(bc) {
    // Fra live Hoka snapshot
    if (bc._hoka?.pricePerKg) return bc._hoka.pricePerKg;
    // Beregnet fra last_price + packSize
    var price = parseFloat(bc.last_price);
    var packKg = _ibPackSizeKg(bc);
    if (price && packKg) return Math.round((price / packKg) * 10) / 10;
    return null;
}
```

Chip viser: `89 kr · 8,9 kr/kg · Nr. 245801`
Calc-linje viser: `= 10 kg · dækker 3 kg behov · 8,9 kr/kg valgt`

---

## Init-flow

```javascript
async function initIndkob(el) {
    _ibContainer = el;
    _ibShowLoading();

    await _ibEnsureUserfields();   // Auto-opret ordered_* i Grocy hvis mangler
    await _ibLoadAll();            // Parallel load alle data-sources
    _ibBuildGroups();              // Byg leverandørgrupper
    await _ibEnrichSnapshots();    // Live Hoka-data (non-fatal)
    _ibRender();                   // Første render

    // Non-blocking baggrunds-tasks
    _ibLoadFavCache();             // Favorit-cache til søgning
}
```

---

## Fase-opdeling

### Fase 6 — Indkøb (dette dokument)
- [ ] `shared/indkob.js` — fuld implementering
- [ ] `shared/indkob.css` — styling (baseret på mockup `indkob_mockup_v3.html`)
- [ ] `kitchen/purchasing.html` — omskrives til 2 tabs, mount indkob
- [ ] `shared/api.js` — tilføj `_ibEnsureUserfields`-kaldte endpoints hvis mangler
- [ ] Verificér `routes/horkram.js` `/snapshots` endpoint (se CLAUDE_HORKRAM_INTEGRATION.md)

### Efter Fase 6
- [ ] `shared/shopping_list.js` + `shared/bestilling.js` udgår
- [ ] `shared/shopping_list.css` + `shared/bestilling.css` udgår
- [ ] Settings: Leverandør-admin side (Fase 6b)
- [ ] Settings: Produkter batch-editor (Fase 6b)

---

## Test og verifikation

**Kritiske test-scenarier:**

1. **Hoka bestilling end-to-end (grocytest)**
   - Varer på shopping_list → snapshot enrichment → aftale-chip pre-valgt → "Læg i kurv" × N → "Gå til kurv" → `ordered_*` sat i Grocy → varer viser "Bestilt" badge

2. **Manuel bestilling (Emballage)**
   - "Marker valgt" × N → "Registrér bestilling" → dialog med korrekt vareliste + leverandørinfo → "Bekræft bestilt" → `ordered_*` sat → varer i bestilt-sektion

3. **Kobling af umatched vare**
   - Søg i link-panel → favorites vises øjeblikkeligt → katalog bagefter → "+ Kobl" → barcode i Grocy → vare flyttes til klar-sektion

4. **Multi-leverandør chips (Burgerlommer)**
   - Foretrukket chip pre-valgt → skift til Inco → antal genberegnes → pris/kg opdateres

5. **Manglende-panel**
   - Banner vises kun hvis > 0 forslag → klik åbner panel → justér antal → "Tilføj valgte" → shopping_list opdateret → banner forsvinder

6. **Fortryd bestilling**
   - "Fortryd" på bestilt vare → `ordered_*` slettes fra Grocy → vare tilbage i klar-sektion

7. **Auto-genereret INT-varenummer (Oluf)**
   - Ny kobling uden varenummer → INT-XXXX genereres → gemmes i Grocy → vises i chip

**Go/no-go inden produktion:**
- [ ] Alle 7 test-scenarier grønne på grocytest
- [ ] `ordered_*` userfields verificeret i Grocy efter bestilling
- [ ] Snapshot enrichment verificeret (aftale-chips vises korrekt)
- [ ] Kurv-kald til Hoka verificeret (PUT /api/horkram/basket/add)
- [ ] grocytest-data nulstillet og bekræftet rent

---

## Checkliste til CLAUDE.md

Når implementering er færdig:
```
Fase 6 — Indkøb (shared/indkob.js):
- [x] shared/indkob.js — merged shopping_list + bestilling, accordion UI
- [x] shared/indkob.css
- [x] kitchen/purchasing.html — 2 tabs (Indkøb + Varemodtagelse)
- [x] Grocy userfields auto-opret (_ibEnsureUserfields)
- [x] Hoka snapshot enrichment + favorites cache
- [x] Multi-leverandør chips med kr/kg priser
- [x] Manglende + Udløbende inline panels
- [x] Manuel bestilling dialog (kopiér/mail/ring/bekræft)
- [x] RR Produktion gruppe med produktionsbon-flow
- [x] Auto-genererede INT-varenumre
- [x] shared/shopping_list.js + shared/bestilling.js udgår
```
