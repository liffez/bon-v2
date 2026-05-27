# CLAUDE_BESTILLING.md
> Spec for Fase 6 — Indkøb & Bestilling (komplet)
> Læs BON_V2_PRINCIPPER.md, bon_v2_datamodel_v2.md og bon_v2_zoner_og_layout.md FØR du begynder.

---

## Overblik

Bestillingsfunktionen dækker hele indkøbsflowet fra "varen mangler" til "varen er på lager":

```
Grocy shopping_list
  → Indkøbsliste (tab 1)  — allerede bygget: shared/shopping_list.js
  → Bestilling (tab 2)    — NY: shared/bestilling.js
  → Varemodtagelse (tab 3)— NY: shared/varemodtagelse.js
```

Shell-siden `kitchen/purchasing.html` eksisterer og har 3 tabs som placeholders.
Tab 1 er live. Tab 2 og 3 bygges i denne fase.

**Reference-implementering:** `tools/bestilling/bestilling.html` og `tools/bestilling/indkobsliste.html`
er de fungerende prototyper dette er portet fra. Brug dem aktivt til at forstå UX og logik.
Design og interaktionsmønstre herfra følges — tilpas kun tokens og API-kald til v2-konventioner.

---

## Workflow 1 — Bestilling

Formål: Tag varer fra Grocy indkøbslisten og læg dem i Hørkrams kurv, klar til manuel godkendelse.

```
BRUGER                          V2                              GROCY / HOKA
──────                          ──                              ────────────

1. Åbner "Bestilling"-tab
                                Henter shopping_list            → GET /objects/shopping_list
                                Henter produkter                → GET /objects/products
                                Henter barcodes                 → GET /objects/product_barcodes
                                Henter leverandører             → GET /api/purchasing/suppliers
                                Bygger supplierGroups pr. grocy_location_id

2. Ser leverandørkort
   (Hørkram, Metro, Inco...)
   Vælger "Hørkram"

3. Ser vareliste
   — matchede varer med pills og qty
   — umatchede varer nederst

4. Justerer evt. antal

5. Tapper "Læg i kurv" på vare
                                PUT /api/hoka/basket            → putBasketProducts([{productId, qty, salesUnit}])
                                Hoka bekræfter
                                Vare markeres grøn "I kurv"

6. Gentager trin 4-5
   for øvrige varer

   (valgfrit) Kobler umatchet vare:
   Søger på Hoka               GET /api/hoka/search?q=
   Vælger resultat             POST /grocy barcode oprettes
                                Vare flyttes til matchede

7. Alle ønskede varer i kurv
   Tapper "Gå til kurv →"
                                PUT /api/hoka/basket (final)
                                POST /api/purchasing/orders     → purchase_order oprettes (status: 'sent')
                                Opdater Grocy shopping_list     → ordered_at, ordered_qty, ordered_supplier, ordered_varenr
                                Åbner hoka.dk/checkout i ny fane

8. Godkender kurv på hoka.dk   (V2 er ikke involveret her)
   manuelt
```

**Vigtige detaljer:**
- V2 afgiver aldrig ordren — kun `putBasketProducts()`, aldrig `submitOrder()`
- `purchase_order` oprettes med status `'sent'` når brugeren trykker "Gå til kurv"
- Grocy `ordered_*` userfields sættes samtidig — indkøbslisten viser derefter "bestilt"
- Fejler et enkelt basket-kald vises toast, knappen nulstilles — resten af kurven er upåvirket

---

## Workflow 2 — Varemodtagelse

Formål: Match fysisk levering mod purchase_order, læg modtagne varer på lager i Grocy, fjern fra indkøbsliste.

```
BRUGER                          V2                              GROCY
──────                          ──                              ─────

1. Varer ankommer fysisk
   med følgeseddel

2. Åbner "Varemodtagelse"-tab
                                Henter åbne purchase_orders     → GET /api/purchasing/orders?status=sent
                                Viser liste over ventende ordrer

3. Vælger ordren
   (fx "Hørkram — tors 10. apr, 4 varer")
                                Viser varelinjer med:
                                — produktnavn
                                — bestilt antal (fra purchase_order_lines)
                                — modtaget: [pre-udfyldt = bestilt]
                                — skadet: [0]

4. Gennemgår følgeseddel
   — Alt ok: ingen ændringer
   — Mangler 1 smør: sætter modtaget = bestilt - 1
     → afvigelsestype sættes automatisk til 'short'
     → linjen markeres orange
   — Beskadiget vare: sætter skadet = 1
     → lager = modtaget - skadet

5. Tapper "Godkend modtagelse"
                                Bekræftelsesdialog:
                                "Dette opdaterer lageret i Grocy. Kan ikke fortrydes."

6. Bekræfter
                                POST /api/purchasing/receipts   → goods_receipt oprettes
                                POST /api/purchasing/receipts/:id/approve

                                For hver linje (atomisk, added_to_inventory flag):
                                  stockQty = received - damaged
                                  if stockQty > 0:
                                    POST /stock/products/{id}/add  → lager øges i Grocy
                                  DELETE /objects/shopping_list/{id} → linje fjernes fra Grocy

                                purchase_order status →
                                  'received' (ingen afvigelser)
                                  'partially_received' (afvigelser)

7. Ser succesvisning
   — N varer lagt på lager ✓
   — Evt. afvigelser listet
   — Knap: "Tilbage til indkøbsliste"
```

**Vigtige detaljer:**
- Standard er "alt ok" — brugeren rører kun linjer med afvigelse (minimal friktion)
- `added_to_inventory = 1` sættes atomisk per linje — dobbelt-godkendelse er uskadelig
- Fejler Grocy-kaldet for én linje: partial success, linjen markeres rød, brugeren kan re-approve den specifikke linje
- `quantity_damaged` trækkes fra lager men registreres på `goods_receipt_lines` til fremtidig statistik
- Grocy shopping_list-linje slettes kun hvis `added_to_inventory = 1` — aldrig før

---

## Arkitekturprincipper for denne fase

- **Grocy er master for produktdata, menuer og opskrifter.** Produkter, kategorier, opskrifter og varenumre oprettes og redigeres i Grocy — ikke i V2.
- **V2 skriver aktivt til Grocy via adapter** — det er en central del af flowet, ikke en undtagelse:
  - Priser, enheder, kalorier, CO2 på produkter og barcodes (via scraper + bestillingsflow)
  - `ordered_*` userfields på shopping_list (bestilt tidspunkt, mængde, leverandør, varenr.)
  - Slet linje fra shopping_list ved godkendt varemodtagelse
  - Tilføj til lager (add-stock) ved godkendt varemodtagelse
  - Alt via `grocyAdapter` — aldrig direkte HTTP fra frontend, aldrig direkte til Grocy DB
- **V2 er master for bestillinger og varemodtagelse.** `purchase_orders` og `goods_receipts` lever i v2 SQLite. Grocy kender ikke til disse — de er V2's forretningslag ovenpå Grocys lager.
- **Location-kontekst styrer Grocy-instans.** `location_id` bestemmer hvilken Grocy-instans der bruges (HQ=grocycafe, Trailer=grocytrailer, Test=grocytest). Styres via `locations`-tabellen og `grocyAdapter`.
- **Friktionsfri for brugeren.** Systemet skal gøre det let at gøre det rigtigt. Friktion = forkert lager.

---

## Database — rettelser til migration 005

Migration 005 (`db/migrations/005_purchasing.sql`) eksisterer. Den skal **ikke omskrives** — tilføj en ny migration `021_purchasing_v2.sql` med følgende:

```sql
-- 021_purchasing_v2.sql
-- Tilretninger til purchasing-skema baseret på endeligt design

-- ══════════════════════════════════════════════════════════════
-- LEVERANDØR ↔ GROCY SHOPPING_LOCATIONS
-- ══════════════════════════════════════════════════════════════
--
-- En leverandør (fx Inco) kan have FLERE handelssteder i Grocy
-- (fx "Inco Valby" og "Inco Frederiksberg").
-- Grocy shopping_locations er autoriteten — Bon v2 tilføjer
-- forretningsinformation ovenpå.
--
-- Én Grocy shopping_location tilhører præcis én supplier.
-- En supplier kan have mange Grocy shopping_locations.
--
-- Brugeren vælger aktivt handelssted i bestillingsflowet —
-- ét kort pr. grocy_location_id, ikke pr. supplier_id.

CREATE TABLE supplier_grocy_locations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id         INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    grocy_location_id   INTEGER NOT NULL,   -- shopping_locations.id i Grocy
    display_name        TEXT,               -- Valgfri override af Grocy-navn
    UNIQUE (grocy_location_id)
);

CREATE INDEX idx_sgl_supplier ON supplier_grocy_locations(supplier_id);

-- Udfyldes via Settings UI (Fase 6b):
-- 1. Hent shopping_locations fra Grocy API
-- 2. Bruger linker hver Grocy-lokation til en v2 supplier
-- 3. Gemmes som rækker i supplier_grocy_locations

-- ══════════════════════════════════════════════════════════════
-- purchase_orders: hvilket handelssted ordren er afgivet til
-- ══════════════════════════════════════════════════════════════
ALTER TABLE purchase_orders ADD COLUMN grocy_location_id INTEGER;
-- Grocy shopping_locations.id — fx "Inco Valby" specifikt.
-- Forskellig fra location_id som er Ristet Rugs egne lokationer (HQ/Trailer).

-- ══════════════════════════════════════════════════════════════
-- purchase_order_lines: Grocy-referencer til varemodtagelse
-- ══════════════════════════════════════════════════════════════
ALTER TABLE purchase_order_lines ADD COLUMN grocy_shopping_list_id INTEGER;
ALTER TABLE purchase_order_lines ADD COLUMN grocy_product_id INTEGER;
-- grocy_shopping_list_id: bruges til DELETE fra Grocy shopping_list ved godkendelse
-- grocy_product_id:       bruges til add-stock i Grocy ved godkendelse

-- ══════════════════════════════════════════════════════════════
-- SEED — leverandører
-- ══════════════════════════════════════════════════════════════
-- INSERT OR IGNORE: køres sikkert flere gange, dublerer ikke.
-- Nulstilling: DELETE FROM supplier_grocy_locations; DELETE FROM supplier_locations; DELETE FROM suppliers WHERE id IN (1,2,3);

INSERT OR IGNORE INTO suppliers (id, name, integration_type, notes)
VALUES
  (1, 'Hørkram', 'api',   'Bestilling via hoka.dk API. Kræver HOKA_USERNAME + HOKA_PASSWORD i .env.'),
  (2, 'Metro',   'email', 'Bestilling via e-mail.'),
  (3, 'Inco',    'email', 'Bestilling via e-mail. To handelssteder: Valby og Frederiksberg.');

-- Leverandør ↔ Ristet Rug-lokationer (HQ/Trailer)
-- location_id 1 = HQ, location_id 2 = Trailer — verificér med: SELECT * FROM locations
INSERT OR IGNORE INTO supplier_locations (supplier_id, location_id)
VALUES
  (1, 1),  -- Hørkram → HQ
  (1, 2),  -- Hørkram → Trailer
  (2, 1),  -- Metro → HQ
  (3, 1);  -- Inco → HQ

-- supplier_grocy_locations udfyldes IKKE i seed.
-- De er instans-specifikke (Grocy IDs varierer per installation).
-- Udfyldes via Settings UI efter at Grocy shopping_locations er hentet fra API.
```

**Nulstilling af seed-data (til test):**
```sql
DELETE FROM supplier_grocy_locations;
DELETE FROM supplier_locations WHERE supplier_id IN (1,2,3);
DELETE FROM suppliers WHERE id IN (1,2,3);
-- Kør migration igen for at genindsætte
```

---

## Backend — nye filer

### `routes/purchasing.js`

Mount i `server.js` som: `app.use('/api/purchasing', require('./routes/purchasing'));`

**Endpoints:**

```
GET  /api/purchasing/suppliers
     → Liste over handelssteder tilgængelige for brugerens Ristet Rug-location
     → Query: ?location_id=
     → JOIN supplier_locations ON sl.location_id = ?
     → JOIN supplier_grocy_locations ON sgl.supplier_id = s.id
     → Returnerer én række pr. grocy_location_id:
       { supplier_id, supplier_name, integration_type, contact_email,
         grocy_location_id, display_name, notes, is_active }
     → Inco returnerer 2 rækker (Valby + Frederiksberg) — begge supplier_id=3

GET  /api/purchasing/suppliers/grocy-locations
     → Henter alle shopping_locations fra Grocy + eksisterende koblingsstatus
     → Bruges af Settings UI
     → Response: [{ grocy_location_id, name, linked_supplier_id, linked_supplier_name }]

POST /api/purchasing/suppliers/grocy-locations
     → Opret/opdater kobling Grocy-lokation ↔ supplier
     → Body: { grocy_location_id, supplier_id, display_name? }
     → INSERT OR REPLACE INTO supplier_grocy_locations

DELETE /api/purchasing/suppliers/grocy-locations/:grocy_location_id
     → Fjern kobling

GET  /api/purchasing/orders
     → Liste over purchase_orders
     → Query: ?location_id=&status=&limit=20
     → JOIN suppliers + supplier_grocy_locations, returnerer ordre-oversigt inkl. handelssted-navn

GET  /api/purchasing/orders/:id
     → Enkelt purchase_order med alle lines
     → JOIN purchase_order_lines

POST /api/purchasing/orders
     → Opret ny purchase_order (status: 'draft')
     → Body: { location_id, supplier_id, grocy_location_id,
               expected_delivery_date, lines: [...] }
     → lines: [{ grocy_product_id, grocy_shopping_list_id, supplier_sku,
                 product_name, quantity_ordered, pack_unit, price_per_pack }]
     → Returnerer { id, ...ordre }

PATCH /api/purchasing/orders/:id
     → Opdater status, noter, expected_delivery_date
     → Body: { status?, notes?, sent_at?, sent_via? }

GET  /api/purchasing/receipts
     → Liste over goods_receipts
     → Query: ?location_id=&status=

GET  /api/purchasing/receipts/:id
     → Enkelt goods_receipt med alle lines

POST /api/purchasing/receipts
     → Opret goods_receipt (typisk fra en purchase_order)
     → Body: { location_id, purchase_order_id, receipt_date, lines: [...] }
     → lines: [{ purchase_order_line_id, grocy_product_id, grocy_shopping_list_id,
                 quantity_expected, quantity_received, quantity_damaged,
                 discrepancy_type, discrepancy_note }]

POST /api/purchasing/receipts/:id/approve
     → Godkend varemodtagelse → status: 'approved'
     → Trigger: for hver linje der er ok:
         1. POST til Grocy: /stock/products/{grocy_product_id}/add (quantity_received)
         2. DELETE til Grocy: /objects/shopping_list/{grocy_shopping_list_id}
     → Opdater purchase_order status → 'received' (eller 'partially_received')
     → Returnerer { approved: N, errors: [...] }
```

### `routes/hoka.js`

Mount i `server.js` som: `app.use('/api/hoka', require('./routes/hoka'));`
Wrapper rundt om `services/hokaAdapter.js`.

```
GET  /api/hoka/status
     → { configured: bool, authenticated: bool }
     → Kalder hokaAdapter.isConfigured() + getMe()

GET  /api/hoka/search?q=
     → Proxy til hokaAdapter.searchProducts(q)
     → Returnerer Hoka-format direkte (frontend normaliserer)

GET  /api/hoka/delivery-dates
     → hokaAdapter.getDeliveryDates()

PUT  /api/hoka/basket
     → Body: { products: [{ productId, quantity, salesUnit }] }
     → hokaAdapter.putBasketProducts(products)
     → Kaldes per vare efterhånden som brugeren lægger dem i kurven
     → V2 afgiver IKKE ordren — brugeren godkender selv på hoka.dk

GET  /api/hoka/orders
     → hokaAdapter.getOrders() — ordrehistorik (bruges til varemodtagelse)

GET  /api/hoka/product-snapshots?ids=1,2,3&date=2026-04-09
     → hokaAdapter.getProductSnapshots(ids, date)
     → Bruges til at hente aktuelle priser og tilgængelighed
```

**Credential-håndtering:** `HOKA_USERNAME` og `HOKA_PASSWORD` i `.env`. `hokaAdapter.js` er allerede klar og ligger i `services/hokaAdapter.js`. Kopier den til `services/hokaAdapter.js` fra `tools/bestilling/`.

---

## Frontend — nye filer

### `shared/bestilling.js` + `shared/bestilling.css`

Tab 2 i `kitchen/purchasing.html`. Port af `tools/bestilling/bestilling.html`.

**State-model:**
```javascript
const state = {
    locationId:            null,   // Ristet Rugs location (HQ/Trailer) — fra BonConfig
    grocyAPI:              null,   // Fra bonconfig:ready event
    shoppingList:          [],     // Grocy shopping_list items
    products:              {},     // Grocy products (id → product)
    barcodes:              [],     // Grocy product_barcodes
    quantityUnits:         {},     // Grocy quantity_units (id → unit)
    supplierHandelssteder: [],     // Fra /api/purchasing/suppliers — én række pr. grocy_location_id
    supplierGroups:        {},     // Bygget: grocy_location_id → gruppe
    currentGrocyLocationId: null,  // Valgt handelssted
    extraItems:            [],     // Manuelt tilføjede varenumre
    pendingOrder:          null,   // Gemt purchase_order
};
```

**Layout — to-kolonne desktop**

```
┌─────────────────────────────────────┬──────────────────┐
│ Topbar: [Hørkram] [Levering: dato]  │                  │
├─────────────────────────────────────│  Kurv til        │
│ Klar til bestilling (N varer)       │  Hørkram         │
│ ─────────────────────────────────── │  ─────────────── │
│ [Vare] [pills] [qty −/+] [Læg i kurv│  • Smør × 2     │
│ [Vare] [pills] [qty −/+] [I kurv ✓]│  • Fløde × 6    │
│ [Vare] [pills] [qty −/+] [Læg i kurv│                  │
│                                     │  ca. 450 kr      │
│ Ingen barcode (N varer)             │  ─────────────── │
│ ─────────────────────────────────── │  [Gå til kurv →] │
│ [Vare] [Kobl varenr.] [Spring over] │  [Se favoritter] │
└─────────────────────────────────────┴──────────────────┘
```

**UI-principper (godkendt i design-review):**

- **Løbende kurv** — varer lægges i kurven én ad gangen, ikke som én samlet batch til sidst. Kurv-kolonnen til højre viser hvad der er lagt i løbende.
- **Pakkeform-pills** — de godkendte barcodes vises som valgbare pills direkte på varen. Brugeren kan kun vælge forhåndsgodkendte pakkeformer — ingen fritekst-valg.
- **Qty pre-udfyldt** — antal hentes fra Grocy `shopping_list.amount`, rundet op til hele pakkeenheder. Brugeren justerer kun hvis nødvendigt.
- **Umatchede varer samlet nederst** — ikke blandet med bestillingsklare varer. To handlinger: "Kobl varenr." (inline søgning mod Hoka) eller "Spring over".
- **Ingen `submitOrder()`** — V2 afgiver aldrig ordren automatisk. Kun `putBasketProducts()`. Brugeren godkender selv på hoka.dk.
- **To afslutningsknapper** — "Gå til kurv på hoka.dk" (primær, åbner hoka.dk/checkout) og "Se favoritter på hoka.dk" (sekundær). Begge åbner i ny fane.
- **Kurv-status** — varen markeres grøn + "I kurv" tekst efter `putBasketProducts()` returnerer OK. Fejler kaldet vises toast og knappen nulstilles.
- **Ingen progress-view, ingen email-view** — ikke relevant for Hørkram API-flow.
- **`viewSuppliers`** er stadig første view — bruges hvis der er flere handelssteder på listen (fx Inco Valby + Metro). Fra leverandørvælgeren navigerer man til ordre-viewet for det valgte handelssted.

**Vigtige forskelle fra prototype → v2:**

| Prototype | V2 |
|-----------|-----|
| `state.api.call('/objects/shopping_list')` | Samme — via grocyAdapter proxy |
| `fetch('/api/horkram/basket/products', ...)` | `fetch('/api/hoka/basket', ...)` per vare |
| `fetch('/api/horkram/order', ...)` | Bruges ikke — brugeren godkender på hoka.dk |
| `fetch('/api/orders/pending', ...)` | `fetch('/api/purchasing/orders', ...)` |
| Leverandører fra Grocy `shopping_locations` userfields | Leverandører fra `/api/purchasing/suppliers` |
| `isHorkram()` checker navn/userfield | `group.integrationType === 'api'` |
| Én stor "Afgiv ordre"-knap til sidst | "Læg i kurv" per vare + "Gå til hoka.dk" til sidst |

**Leverandørgruppe-logik — `buildSupplierGroups()`:**

Prototype matchede via `product.shopping_location_id` → Grocy shopping_location navn.
V2 matcher via `product.shopping_location_id` → `supplierHandelssteder[].grocy_location_id`.

```javascript
function buildSupplierGroups() {
    // supplierHandelssteder er hentet fra /api/purchasing/suppliers
    // én række pr. grocy_location_id (Inco giver 2 rækker)
    const locMap = {};
    for (const h of state.supplierHandelssteder) {
        locMap[String(h.grocy_location_id)] = h;
    }

    const groups = {};
    for (const item of state.shoppingList) {
        const product = state.products[item.product_id];
        if (!product) continue;

        const grocyLocId = String(product.shopping_location_id || '__none__');
        const handelssted = locMap[grocyLocId];

        // Grupper pr. grocy_location_id — ét kort pr. handelssted
        if (!groups[grocyLocId]) {
            groups[grocyLocId] = {
                grocyLocationId:  grocyLocId,
                supplierId:       handelssted?.supplier_id || null,
                supplierName:     handelssted?.supplier_name || 'Ukendt',
                displayName:      handelssted?.display_name || handelssted?.supplier_name || 'Uden leverandør',
                integrationType:  handelssted?.integration_type || 'none',
                contactEmail:     handelssted?.contact_email || null,
                items: [],
            };
        }
        // ... resten som i prototype
    }
}
```

`isHorkram()` erstattes af: `group.integrationType === 'api'`
(generisk — virker for enhver fremtidig API-leverandør, ikke kun Hørkram)

**Barcode-sortering og aftalepriser:**

Første opslag er i Hørkrams favorit-liste. Varer fra favorit-listen har typisk aftalepriser.
Aftale-status styres af userfieldet `is_agreement_item` på `product_barcodes` i Grocy:

| Kilde | Handling |
|-------|----------|
| Hørkram scraper | Sætter automatisk `is_agreement_item = '1'` for alle favorit-liste produkter |
| Manuel override | Admin sætter `is_agreement_item = '1'` direkte i Grocy UI for andre barcodes |

Ét felt, én sandhed, to måder at sætte det på.
`hk_scraped_at` beholder sin separate rolle som sync-timestamp.

**Grocy setup:** Opret `is_agreement_item` som userfield på `product_barcodes`.
Type: `text_single_line`. Værdier: `'1'` (aftale) eller tom streng (ingen aftale).

Når en vare har flere barcodes (pakkeformer), sorteres de så aftale-varen vises først
og vælges som default:

```javascript
// I buildSupplierGroups() — sorter barcodes pr. produkt
function sortBarcodes(barcodes) {
    return barcodes.slice().sort((a, b) => {
        // 1. Aftale-varer først
        const aAft = a.userfields?.is_agreement_item === '1' ? 0 : 1;
        const bAft = b.userfields?.is_agreement_item === '1' ? 0 : 1;
        if (aAft !== bAft) return aAft - bAft;
        // 2. Derefter billigste pris
        const aP = parseFloat(a.last_price) || 9999;
        const bP = parseFloat(b.last_price) || 9999;
        return aP - bP;
    });
}

// selectedBcIdx: 0 — første barcode = aftale/billigste er altid default

// Aftale-check i frontend (simpelt, ét felt):
const isAftale = bc.userfields?.is_agreement_item === '1';
```

**Antal-beregning ved pakkeformsskift:**

Antal er altid i *antal pakker af den valgte pakkeform*. Systemet beregner
automatisk minimum antal pakker der dækker behovet:

```javascript
// pack_size_stock_unit = pakke-størrelse i stock-enhed (kg, liter, stk)
// Gemmes som userfield på barcoden af scraper
function calcQty(shoppingListAmount, barcode) {
    const packSize = parseFloat(barcode.userfields?.pack_size_stock_unit) || 1;
    return Math.ceil(shoppingListAmount / packSize);
}
```

Brugeren kan altid justere manuelt med ± bagefter. Systemet viser resultatet:
`= 20 kg · dækker 3 kg behov` eller `= 5 kg · +2 kg over` så brugeren
kan vurdere om det giver mening.

**Pill-visning:**

```
[Aftale · 500g×20  89 kr ✓]  [2,5 kg  112 kr]
 ↑ grøn aftale-badge           ↑ normal pill
```

Aftale-pills får et `Aftale`-badge og prisen vises i grøn. Normal pill vises
med grå tekst. Kun den valgte pill er highlighted.

**Nyt Grocy userfield på `product_barcodes`:**

`pack_size_stock_unit` (text_single_line) — pakke-størrelse i stock-enhed.
Eksempel: barcode for "kasse 500g × 20 stk" af smør → `pack_size_stock_unit = '10'` (10 kg).
Sættes af scraper ved import. Skal oprettes som brugerfeld i Grocy.

---

**Gemning af purchase_order efter ordre:**
```javascript
// POST /api/purchasing/orders
{
    location_id:            state.locationId,         // Ristet Rugs lokation (HQ/Trailer)
    supplier_id:            g.supplierId,
    grocy_location_id:      parseInt(g.grocyLocationId), // Specifikt handelssted
    expected_delivery_date: deliveryDate,
    sent_via:               g.integrationType,
    lines: matched.map(entry => ({
        grocy_product_id:        entry.product.id,
        grocy_shopping_list_id:  entry.item.id,
        supplier_sku:            bc.barcode,
        product_name:            entry.product.name,
        quantity_ordered:        entry.qty,
        pack_unit:               bc.note || quName(bc.qu_id) || 'stk',
        price_per_pack:          bc.last_price ? parseFloat(bc.last_price) : null,
    }))
}
```

### `shared/varemodtagelse.js` + `shared/varemodtagelse.css`

Tab 3 i `kitchen/purchasing.html`. Reference: `tools/bestilling/varemodtagelse.html` (prototype ikke vedlagt — beskrives funktionelt nedenfor).

**UX-flow:**

```
1. Vis liste over åbne purchase_orders (status: 'sent' eller 'confirmed')
   → Kort pr. ordre: leverandør, dato, antal linjer, forventet levering

2. Tap en ordre → åbn varemodtagelses-view
   → Liste over bestilte varer med:
       [ produktnavn ]  [ bestilt: N ]  [ modtaget: __ ]  [ skadet: __ ]
   → Standard: modtaget = bestilt (ingen afvigelse)
   → Brugeren ændrer kun hvis der er forskel

3. Afvigelsestyper (vælges per linje hvis qty_received ≠ qty_ordered):
   'short'      — vi fik færre end bestilt
   'over'       — vi fik flere end bestilt
   'damaged'    — varer er beskadigede
   'wrong_item' — forkert vare leveret
   'missing'    — varen kom slet ikke

4. Godkend-knap (kun aktiv når alle linjer er udfyldt)
   → POST /api/purchasing/receipts (gem goods_receipt)
   → POST /api/purchasing/receipts/:id/approve
       → For hver linje: Grocy add-stock + slet fra shopping_list
   → Succes-view med opsummering

5. Succes-view:
   → N varer lagt på lager ✓
   → N varer med afvigelse (listes)
   → Knap: "Tilbage til indkøbsliste"
```

**Vigtige UX-detaljer:**
- Standard er "alt ok" — brugeren skal kun røre de linjer der er afvigelse
- Godkend-knappen er stor og grøn, placeret i fixed bottom bar
- Afvigelse markeres med orange baggrund på linjen
- Skadet antal trækkes fra modtaget: lager = received - damaged

**Approve-endpoint logik (server-side):**
```javascript
// routes/purchasing.js — POST /api/purchasing/receipts/:id/approve
for (const line of receipt.lines) {
    const stockQty = line.quantity_received - line.quantity_damaged;
    if (stockQty > 0) {
        // Tilføj til Grocy lager
        await grocyAdapter.addStock(line.grocy_product_id, stockQty, locationId);
    }
    if (line.grocy_shopping_list_id) {
        // Fjern fra Grocy indkøbsliste
        await grocyAdapter.deleteShoppingListItem(line.grocy_shopping_list_id);
    }
}
// Opdater purchase_order status
const hasDiscrepancy = receipt.lines.some(l =>
    l.quantity_received !== l.quantity_expected || l.quantity_damaged > 0
);
await db.run(`UPDATE purchase_orders SET status = ? WHERE id = ?`,
    [hasDiscrepancy ? 'partially_received' : 'received', order.id]);
```

**grocyAdapter-tilføjelser der er nødvendige:**
```javascript
// services/grocyAdapter.js — tilføj:
async addStock(productId, quantity, locationId)
    // POST /stock/products/{productId}/add
    // Body: { amount: quantity, transaction_type: 'purchase' }

async deleteShoppingListItem(shoppingListId)
    // DELETE /objects/shopping_list/{shoppingListId}
    // Eksisterer muligvis allerede — verificér
```

---

## Integration i `kitchen/purchasing.html`

Tab-strukturen eksisterer. Tilpas tab 2 og 3:

```html
<!-- Tab 2: Bestilling -->
<div id="tab-bestilling" class="tab-panel">
    <!-- bestilling.js mountes her -->
    <div id="bestilling-root"></div>
</div>

<!-- Tab 3: Varemodtagelse -->
<div id="tab-varemodtagelse" class="tab-panel">
    <!-- varemodtagelse.js mountes her -->
    <div id="varemodtagelse-root"></div>
</div>
```

Script-load orden (i `purchasing.html`):
```html
<script src="../../shared/bestilling.js"></script>
<script src="../../shared/varemodtagelse.js"></script>
```

Tab-skift trigger reload af data i den aktiverede komponent.

---

## `.env` — nye nøgler

```env
# Hørkram (hoka.dk)
HOKA_USERNAME=din@email.dk
HOKA_PASSWORD=ditpassword
HOKA_BASE_URL=https://www.hoka.dk       # valgfri, default er denne
HOKA_LOGIN_PATH=/api/auth/login          # valgfri, default er denne
```

---

## Fase-opdeling

### Fase 6a — Bestilling (denne spec)
- [ ] Migration `021_purchasing_v2.sql`
- [ ] `services/hokaAdapter.js` kopieret til korrekt placering
- [ ] `routes/hoka.js` — API proxy
- [ ] `routes/purchasing.js` — orders + receipts endpoints
- [ ] `shared/bestilling.js` + CSS — port af prototype
- [ ] `shared/varemodtagelse.js` + CSS — ny implementering
- [ ] `kitchen/purchasing.html` — tab 2 + 3 aktiveret
- [ ] `grocyAdapter.js` — `addStock()` + `deleteShoppingListItem()` tilføjet

### Fase 6b — Leverandøradministration + Scraper (settings)

**Leverandøroversigt:**
- [ ] Settings-side: hent Grocy shopping_locations via `/api/purchasing/suppliers/grocy-locations`
- [ ] UI: link hver Grocy-lokation til en v2 supplier (dropdown)
- [ ] UI: rediger leverandørinfo (e-mail, telefon, kundenr., display_name)
- [ ] Gem via `POST /api/purchasing/suppliers/grocy-locations`
- [ ] Seed-nulstilling via UI (knap: "Nulstil leverandør-seed")

**Hørkram scraper (admin-funktion under Settings → Leverandører → Hørkram):**

Scraper er en engangs/periodisk admin-opgave — ikke en del af dagligt bestillingsflow.
Reference-implementering: `tools/bestilling/horkram-scraper.html` (fuldt fungerende).

UI-struktur i Settings:
```
Settings → Leverandører → Hørkram
  ├── Status: Sidst scraped: 7. apr 2026 (fra hk_scraped_at userfield på barcodes)
  ├── Antal koblet: 142 varer
  ├── [Kør scraper →]          ← port af horkram-scraper.html
  └── [Bulk-kobl ukoblede →]   ← port af horkram-bulk-link-patch
```

Tre niveauer:
| Type | Hvornår | Trigger | Hvad |
|------|---------|---------|------|
| Initial bulk-scrape | Én gang ved opstart | Admin-knap | Alle favorit-liste varer → Grocy barcodes |
| Pris-opdatering | Ugentlig | Admin-knap eller cron | Opdater `last_price` + `hk_*` + `pack_size_stock_unit` |
| Inline kobling | Ved behov | Bruger i bestilling | Enkelt produkt søges og kobles |

Scraper sætter disse felter på barcodes ved import:
- `last_price` — minimumspris fra favorit-listen (aftalepris hvis tilgængelig)
- `is_agreement_item` — altid `'1'` for favorit-liste produkter (kan også sættes manuelt i Grocy)
- `pack_size_stock_unit` — pakke-størrelse i stock-enhed (nyt felt — se ovenfor)
- `hk_scraped_at` — timestamp for seneste scraping
- `hk_*` næringsdatafelter på produktet
- `supplier_price_per_kg` + `price_updated_at` på produktet

Prissætning: scraper gemmer **min-prisen** fra salgsenhedslisten — typisk aftaleprisen.
Hvis varen ikke har aftale gemmes listeprisen.

### Fase 6c — Udvidelser (fremtid)
- [ ] `supplier_products`-tabel synkroniseret fra Hoka-scraper
- [ ] Dropsize-check inden ordreafgivelse
- [ ] CO2-rapport fra Hoka API
- [ ] E-mail ordrer via `mailService.js` (Metro/Inco)

---

## Test og verifikation

Dette afsnit er kritisk. Lager-data i Grocy er svær at undo — test grundigt inden produktion.

### Miljø
Alle test køres mod **grocytest**-instansen. Brug aldrig grocycafe eller grocytrailer til test.
`default_grocy_location_id` i `system_settings` skal pege på Test-lokationen under test.

### Trin 1 — Database og seed

```bash
# Verificér migration er kørt
sqlite3 bon-v2.db "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('suppliers','supplier_locations','supplier_grocy_locations','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines');"
# Forventet: 7 tabeller

# Verificér seed-data
sqlite3 bon-v2.db "SELECT id, name, integration_type FROM suppliers;"
# Forventet: 1=Hørkram (api), 2=Metro (email), 3=Inco (email)

sqlite3 bon-v2.db "SELECT supplier_id, location_id FROM supplier_locations;"
# Forventet: (1,1), (1,2), (2,1), (3,1)

sqlite3 bon-v2.db "SELECT count(*) FROM supplier_grocy_locations;"
# Forventet: 0 — udfyldes via Settings UI

# Verificér seed kan nulstilles og genindsættes
sqlite3 bon-v2.db "DELETE FROM supplier_grocy_locations; DELETE FROM supplier_locations WHERE supplier_id IN (1,2,3); DELETE FROM suppliers WHERE id IN (1,2,3);"
# Kør migration igen
sqlite3 bon-v2.db "SELECT count(*) FROM suppliers;"
# Forventet: 3
```

### Trin 2 — Hoka API

```bash
# Verificér konfiguration
curl http://localhost:3000/api/hoka/status
# Forventet: { "configured": true, "authenticated": true }

# Verificér søgning
curl "http://localhost:3000/api/hoka/search?q=smør"
# Forventet: array med produkter inkl. Id, DisplayName, SalesUnits

# Verificér leveringsdatoer
curl http://localhost:3000/api/hoka/delivery-dates
# Forventet: array med tilgængelige leveringsdatoer
```

### Trin 3 — Bestillingsflow (manuel test)

Kør mod grocytest. Sørg for at der er mindst 3 varer på shopping_list i grocytest inden test.

```
1. Åbn kitchen/purchasing.html → tab "Indkøbsliste"
   ✓ Varer vises fra grocytest

2. Skift til tab "Bestilling"
   ✓ Leverandørkort vises (Hørkram, evt. Metro/Inco)
   ✓ Antal varer pr. leverandør vises korrekt
   ✓ Matchede/umatchede varer tælles korrekt

3. Tap "Hørkram"
   ✓ Vareliste vises med korrekte varenumre (barcodes)
   ✓ Qty kan justeres op/ned
   ✓ Pakkeform-pills vises hvis flere barcodes pr. vare
   ✓ Umatchede varer vises i separat sektion

4. Test inline kobling (umatchet vare):
   ✓ Tap "🔗 Kobl" → søgepanel åbner
   ✓ Søg på produktnavn → resultater fra Hoka
   ✓ Tap "+ Kobl" → barcode oprettes i grocytest
   ✓ Varen flytter til "matchede" sektionen

5. Test ekstra vare:
   ✓ Indtast varenr. i "Tilføj ekstra vare" feltet
   ✓ Varen tilføjes til listen

6. Tap "Afgiv ordre via Hørkram →"
   ✓ Progress-view vises
   ✓ Kurv opdateres (PUT /api/hoka/basket)
   ✓ Ordre afgives (POST /api/hoka/order)
   ✓ grocytest shopping_list items får ordered_* userfields sat
   ✓ purchase_order oprettes i v2 DB (verificér: SELECT * FROM purchase_orders)
   ✓ Succes-view vises med ordrenummer

7. Verificér i grocytest:
   ✓ Shopping_list items har ordered_at, ordered_qty, ordered_supplier sat
   ✓ Indkøbsliste-tab viser "bestilt" status på varerne
```

### Trin 4 — Varemodtagelse (manuel test)

**VIGTIGT:** Test varemodtagelse med reelle Grocy-operationer på grocytest.
Lagerstand i grocytest skal noteres FØR test.

```
1. Åbn tab "Varemodtagelse"
   ✓ Ordre fra trin 3 vises som "Afventer modtagelse"
   ✓ Ordredetaljer vises (leverandør, dato, antal linjer)

2. Tap ordren
   ✓ Alle linjer vises med bestilt antal
   ✓ Modtaget-felt er pre-udfyldt med bestilt antal (default: alt ok)

3. Test scenarie A — Alt ok:
   ✓ Alle modtaget = bestilt
   ✓ Tap "Godkend modtagelse"
   ✓ Bekræftelsesdialog vises ("Er du sikker? Dette opdaterer lageret")
   ✓ Godkend
   
   Verificér i grocytest:
   ✓ Lagerstand for testprodukterne er øget med bestilt antal
   ✓ Shopping_list linjer er slettet
   ✓ purchase_order status = 'received' i v2 DB

4. Test scenarie B — Afvigelse (kræver ny ordre):
   ✓ Sæt én vare til modtaget = bestilt - 1
   ✓ Afvigelsestype sættes automatisk til 'short'
   ✓ Linjen markeres orange
   ✓ Godkend
   
   Verificér i grocytest:
   ✓ Lagerstand øget med modtaget antal (ikke bestilt)
   ✓ purchase_order status = 'partially_received'
   ✓ goods_receipt_lines har discrepancy_type = 'short'

5. Test scenarie C — Beskadiget vare:
   ✓ Sæt quantity_received = 5, quantity_damaged = 1
   ✓ Lager øges med 4 (received - damaged)
   ✓ discrepancy_type = 'damaged'
```

### Trin 5 — Fejlscenarier

```
A. Hoka ikke konfigureret (.env mangler):
   ✓ /api/hoka/status returnerer { configured: false }
   ✓ Bestillings-tab viser fejlbesked "Hørkram ikke konfigureret"

B. Hoka session udløbet:
   ✓ hokaAdapter re-logger automatisk ind
   ✓ Brugeren ser ingenting — transparent

C. Grocy utilgængelig under varemodtagelse:
   ✓ approve-endpoint returnerer partial success
   ✓ Response indeholder hvilke linjer der fejlede
   ✓ Frontend viser: "N varer lagt på lager, M fejlede — prøv igen"
   ✓ Fejlede linjer markeres i rødt, brugeren kan re-approve

D. Dobbelt-godkendelse (netværksfejl → brugeren trykker to gange):
   ✓ added_to_inventory flag på goods_receipt_lines forhindrer dobbelt Grocy-add
   ✓ Sæt added_to_inventory = 1 atomisk per linje, skip hvis allerede 1

E. Nulstilling af test-data:
   ✓ DELETE fra goods_receipts + purchase_orders rydder korrekt (CASCADE)
   ✓ grocytest shopping_list skal manuelt nulstilles i Grocy UI
```

### Trin 6 — Smoke-test script

Tilføj til `scripts/smoke-test.sh`:

```bash
echo "=== Bestilling / Hoka ==="
curl -sf "$BASE/api/hoka/status" | grep -q '"configured"' && ok "hoka/status" || fail "hoka/status"
curl -sf "$BASE/api/purchasing/suppliers?location_id=1" | grep -q '"id"' && ok "purchasing/suppliers" || fail "purchasing/suppliers"
curl -sf "$BASE/api/purchasing/orders?location_id=1" | grep -q '\[' && ok "purchasing/orders" || fail "purchasing/orders"
curl -sf "$BASE/api/purchasing/receipts?location_id=1" | grep -q '\[' && ok "purchasing/receipts" || fail "purchasing/receipts"
```

### Trin 7 — Go/no-go kriterier inden produktion

Alle disse skal være grønne inden grocycafe/grocytrailer bruges:

- [ ] Alle smoke-tests grønne
- [ ] Bestillingsflow gennemført fra ende til anden på grocytest
- [ ] Varemodtagelse scenarie A (alt ok) verificeret på grocytest
- [ ] Varemodtagelse scenarie B (afvigelse) verificeret på grocytest
- [ ] Fejlscenarie C (Grocy utilgængelig) verificeret
- [ ] Fejlscenarie D (dobbelt-godkendelse) verificeret
- [ ] `added_to_inventory` flag virker korrekt
- [ ] grocytest-data nulstillet og bekræftet rent

---

## Checkliste til CLAUDE.md

Når implementering er færdig, tilføj til CLAUDE.md under Fase 6:

```
- [x] Migration 021_purchasing_v2.sql
        — CREATE TABLE supplier_grocy_locations
        — ALTER TABLE purchase_orders ADD grocy_location_id
        — ALTER TABLE purchase_order_lines ADD grocy_shopping_list_id + grocy_product_id
        — Seed: suppliers + supplier_locations (INSERT OR IGNORE)
- [x] services/hokaAdapter.js — cookie-jar auth, putBasketProducts, submitOrder
- [x] routes/hoka.js — /api/hoka/* proxy
- [x] routes/purchasing.js — suppliers (inkl. grocy-locations), orders, receipts, approve
- [x] grocyAdapter.js — addStock(), deleteShoppingListItem() tilføjet
- [x] shared/bestilling.js + CSS — port af prototype, buildSupplierGroups pr. grocy_location_id
- [x] shared/varemodtagelse.js + CSS — goods_receipt flow med Grocy-integration
- [x] kitchen/purchasing.html — tab 2 + 3 aktiveret
```
