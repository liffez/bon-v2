# CLAUDE_HORKRAM_INTEGRATION.md
> ⚠️ **HISTORISK — port-spec fra fase 6a. Beskriver IKKE nuværende tilstand.**
> Parseren hedder i dag `services/hokaParser.js` (ikke `horkramParser.js`), og
> `settings/horkram.html` blev aldrig bygget — Hørkram-administrationen lever i
> `shared/indkob_settings.js` (Tab 3). Den aktive proxy er `routes/horkram.js`.
> Aktuel tilstand: [`CLAUDE_INDKOB_ASIS.md`](CLAUDE_INDKOB_ASIS.md) §8 + §9.

> Spec for genbrug af Hørkram-integration i Bon v2
> Læs CLAUDE_BESTILLING.md FØR denne fil.

---

## Overblik — hvad der allerede eksisterer

Tre filer udgør den komplette Hørkram-integration og skal genbruges maksimalt:

| Fil | Placering | Status |
|-----|-----------|--------|
| `proxy.js` | `routes/horkram.js` | Klar — port direkte |
| `parser.js` | `services/horkramParser.js` | Klar — port direkte |
| `horkram-scraper.html` | `settings/horkram.html` | Klar — port til settings |

**Simon: kopiér disse filer til de angivne placeringer. Ingen omskrivning af logik.**

---

## Vigtig arkitekturændring fra tidligere spec

To beslutninger i `CLAUDE_BESTILLING.md` er nu erstattet:

| Tidligere beslutning | Ny beslutning | Begrundelse |
|---------------------|---------------|-------------|
| Grocy userfield `is_agreement_item` på barcodes | **Ikke nødvendigt** | proxy.js detekterer det live fra Hoka API |
| Grocy userfield `pack_size_stock_unit` på barcodes | **Ikke nødvendigt** | `salesUnits[n].quantity` fra snapshot-svar giver det direkte |

Begge værdier kommer live fra `/api/horkram/snapshots` ved bestilling.
Ingen ekstra Grocy-konfiguration nødvendig.

---

## proxy.js → `routes/horkram.js`

Port direkte. Ændr kun:
- Filnavn: `proxy.js` → `routes/horkram.js`
- Env vars: `HORKRAM_USER` + `HORKRAM_PASS` (allerede i proxy.js — tilføj til `.env`)
- Mount i `server.js`: `app.use('/', require('./routes/horkram'));`
  (routes er allerede præfikset `/api/horkram/...` i proxy.js)

### Eksisterende endpoints (brug uændret)

```
GET  /api/horkram/health
     → { ok, configured, authenticated?, user? }
     → Bruges af bestilling.js til at vise forbindelsesstatus

GET  /api/horkram/product/:varenr
     → Fuldt produkt inkl. ernæring, allergener, salesUnits, isAgreementItem
     → Bruges af scraper (opslag-tab)

GET  /api/horkram/search?q=
     → Søgeresultater enriched med isAgreementItem via snapshots
     → Bruges af inline kobling i bestilling + scraper (ny kobling-tab)

GET  /api/horkram/snapshots?ids=1234,5678,...
     → Batch lightweight summaries inkl. isAgreementItem + salesUnits
     → Max 60 IDs pr. kald, chunker selv i 20 (hoka.dk limit)
     → KRITISK endpoint — bruges ved bestillingsflow (se nedenfor)

GET  /api/horkram/favorites
     → Alle favoritlister (custom + genererede)
     → Bruges af scraper (favoritter-tab) + settings admin

GET  /api/horkram/favorites/:id
     → Produkter i én liste, side N, enriched med isAgreementItem
     → Bruges af scraper

GET  /api/horkram/favorites/:id/all
     → Alle produkter i én liste, auto-pagineret, enriched
     → Bruges af initial bulk-scrape i settings admin

GET  /api/horkram/history/:varenr
     → Købshistorik — kan vise "sidst bestilt X antal"
     → Bruges af scraper (opslag-tab)
```

---

## parser.js → `services/horkramParser.js`

Port direkte. Ingen ændringer.

### Hvad parseren returnerer (relevant for bestilling)

**`parseSnapshotToSummary(snap)`** — bruges ved live beriging:
```javascript
{
    varenummer:      String,   // Hoka produkt-ID = barcode.barcode i Grocy
    name:            String,
    pricePerKg:      Number,   // Aftalepris/kg hvis aftale, ellers listepris
    listPricePerKg:  Number,   // Altid listepris
    salesUnits: [{             // Alle pakkeformer
        code:            String,  // 'st', 'ks', 'kg' etc.
        name:            String,  // 'stk', 'kasse' etc.
        quantity:        Number,  // Antal base-enheder i pakken ← pack_size
        salesPrice:      Number,  // Pris for denne pakkeform
        salesPricePerKg: Number,
        isDefault:       Boolean,
    }],
    netWeightKg:     Number,   // Nettovægt i kg
    baseUnitCode:    String,   // 'kg', 'l', 'st' etc.
    isAgreementItem: Boolean,  // TRUE = aftalevare ← ingen userfield nødvendig
    salesPriceSource: String,  // Tekst fx "Aftalepris"
    isOrganic:       Boolean,
    image:           String,   // URL til billede
    coolType:        String,   // 'frost', 'koeling', null
}
```

---

## Live beriging ved bestilling — det centrale flow

Når brugeren åbner bestilling for Hørkram, beriges alle barcodes med live Hoka-data
i ét batch-kald. Det giver altid aktuelle priser og korrekt aftalestatus.

```javascript
// I shared/bestilling.js — loadAll() efter Grocy-data er hentet

async function enrichWithHokaSnapshots(groups) {
    // Saml alle varenumre fra matchede barcodes
    const varenumre = [];
    for (const g of Object.values(groups)) {
        if (g.integrationType !== 'api') continue;
        for (const entry of g.items) {
            for (const bc of entry.barcodes) {
                if (bc.barcode) varenumre.push(bc.barcode);
            }
        }
    }
    if (!varenumre.length) return;

    // Ét batch-kald — max 60 IDs (proxy chunker selv)
    const res = await fetch(`/api/horkram/snapshots?ids=${varenumre.join(',')}`);
    if (!res.ok) return; // Non-fatal — bestilling virker uden beriging
    const data = await res.json();

    // Byg lookup: varenummer → snapshot
    const snapMap = {};
    for (const snap of (data.products || [])) {
        snapMap[snap.varenummer] = snap;
    }

    // Merge ind i groups
    for (const g of Object.values(groups)) {
        for (const entry of g.items) {
            for (const bc of entry.barcodes) {
                const snap = snapMap[bc.barcode];
                if (!snap) continue;
                bc._hoka = snap; // Gem snapshot på barcode
            }
            // Sorter barcodes: aftale først, derefter billigste
            entry.barcodes.sort((a, b) => {
                const aAft = a._hoka?.isAgreementItem ? 0 : 1;
                const bAft = b._hoka?.isAgreementItem ? 0 : 1;
                if (aAft !== bAft) return aAft - bAft;
                const aP = a._hoka?.pricePerKg || parseFloat(a.last_price) || 9999;
                const bP = b._hoka?.pricePerKg || parseFloat(b.last_price) || 9999;
                return aP - bP;
            });
        }
    }
}
```

### Antal-beregning fra salesUnits

`salesUnits[n].quantity` = antal base-enheder i pakken.
`baseUnitCode` = Hokas base-enhed ('kg', 'l', 'st').

```javascript
function calcQty(shoppingListAmount, bc) {
    const snap = bc._hoka;
    if (!snap) return Math.ceil(parseFloat(bc.amount) || 1);

    // Find salesUnit der matcher denne barcode (via bc.userfields.supplier_unit_code)
    const unitCode = bc.userfields?.supplier_unit_code;
    const unit = snap.salesUnits.find(u => u.code === unitCode)
               || snap.salesUnits.find(u => u.isDefault)
               || snap.salesUnits[0];

    if (!unit?.quantity) return Math.ceil(shoppingListAmount);

    // quantity = antal base-enheder pr. pakke (fx kasse med 20 stk = quantity 20)
    return Math.ceil(shoppingListAmount / unit.quantity);
}

// Vis-tekst: "= 20 kg · dækker 3 kg behov"
function calcLabel(qty, bc) {
    const snap = bc._hoka;
    if (!snap) return null;
    const unitCode = bc.userfields?.supplier_unit_code;
    const unit = snap.salesUnits.find(u => u.code === unitCode)
               || snap.salesUnits.find(u => u.isDefault)
               || snap.salesUnits[0];
    if (!unit) return null;
    const total = qty * unit.quantity;
    return `= ${total} ${snap.baseUnitCode || 'stk'}`;
}
```

### Aftale-badge

```javascript
// I pill-rendering:
const isAftale = bc._hoka?.isAgreementItem === true;
const pris = bc._hoka?.pricePerKg
    ? `${bc._hoka.pricePerKg} kr/kg`
    : (bc.last_price ? `${parseFloat(bc.last_price).toFixed(0)} kr` : null);

// Pill viser:
// [Aftale · Kasse 500g×20  89 kr/kg]  ← isAftale = true
// [Kasse 2,5 kg  112 kr/kg]            ← isAftale = false
```

---

## horkram-scraper.html → `settings/horkram.html`

Port til settings-zone. Bevar al logik og alle tabs uændret.

### Tabs i scraper (alle bevares)

| Tab | Funktion | Bruges af |
|-----|----------|-----------|
| Opslag | Slå enkelt varenr. op, se fuld produktdata, kobl til Grocy | Admin |
| Favoritter | Gennemgå favoritlister, bulk-import til Grocy barcodes | Admin (initial setup) |
| Ny kobling | Find Grocy-produkter uden Hørkram-barcode, søg og kobl | Admin (løbende) |
| Alle koblinger | Oversigt over alle koblede barcodes, rediger/slet | Admin |
| Øko-rapport | Oversigt over CO2 og øko-mærkning | Fremtidig |

### Ændringer ved port

Scraper bruger i dag `BonConfig.js` + `BonConfigBar.js` til Grocy-forbindelse.
I settings-zone erstattes dette med direkte kald til `/api/grocy/...` proxy.

Endpoint-navne ændres fra `/api/horkram/...` til det samme
(proxy.js bevarer navnene) — ingen ændring.

### Nye felter scraper skal gemme ved import

Scraper skal sætte følgende på `product_barcodes` userfields ved bulk-import:
```javascript
{
    supplier_unit_code: unit.code,       // 'st', 'ks', 'kg' — Hokas salgsenhed-kode
    supplier_unit_qty:  String(unit.quantity), // Antal base-enheder i pakken
    hk_scraped_at:      new Date().toISOString(),
    hk_image:           snap.image || '',
    hk_brand:           snap.brand || '',
    hk_country:         snap.countryCode || '',
    hk_organic:         snap.isOrganic ? '1' : '',
    hk_gtin:            product.gtin || '',
    hk_price_per_unit:  String(unit.salesPrice || ''),
    hk_markings:        snap.markingsText || '',
}
// OBS: is_agreement_item sættes IKKE her — bestemmes live fra snapshots ved bestilling
// OBS: pack_size_stock_unit sættes IKKE her — beregnes live fra salesUnits ved bestilling
```

### Grocy userfields der skal eksistere (product_barcodes)

Disse er allerede oprettet (ses i screenshots fra Grocy):
- `hk_allergens`, `hk_brand`, `hk_country`, `hk_gtin`, `hk_image`
- `hk_manufacturer`, `hk_markings`, `hk_organic`, `hk_price_per_unit`, `hk_scraped_at`, `hk_url`

Nødvendige tilføjelser — opret i Grocy under product_barcodes:
- `supplier_unit_code` (text_single_line) — Hokas salgsenhed-kode ('st', 'ks' etc.)
- `supplier_unit_qty` (text_single_line) — antal base-enheder pr. pakke

Disse to er nødvendige for at matche barcode → salesUnit i snapshots.

**`is_agreement_item` skal IKKE oprettes** — status hentes live.
**`pack_size_stock_unit` skal IKKE oprettes** — beregnes live fra `salesUnits`.

---

## Env-variabler

```env
# Hørkram (hoka.dk) — samme som proxy.js forventer
HORKRAM_USER=din@email.dk
HORKRAM_PASS=ditpassword
```

OBS: proxy.js bruger `HORKRAM_USER`/`HORKRAM_PASS` — ikke `HOKA_USERNAME`/`HOKA_PASSWORD`.
CLAUDE_BESTILLING.md skal opdateres til at bruge de korrekte navne.

---

## Fallback-strategi

Hoka API er ikke altid tilgængeligt (netværk, session udløbet, etc.).
Bestilling skal fungere uden live beriging — degraderet men ikke brudt:

```javascript
// enrichWithHokaSnapshots er non-fatal:
// Fejler den → barcodes har ingen _hoka → vises uden aftale-badge og live-pris
// Brugeren ser stadig alle varer og kan stadig bestille
// Qty pre-udfyldes fra shopping_list.amount / 1 (pakke)
// Pill-priser vises fra Grocy barcode.last_price (sidst scrapet pris)
```

---

## Scraper — købshistorik til "Sidst bestilt"-hint

`GET /api/horkram/history/:varenr` returnerer jeres historiske køb.
Kan bruges til at vise "Sidst bestilt: 4 stk · 12. feb" på vare-rækken.
Dette er en Phase 6c feature — notér som fremtidig forbedring.

---

## Opsummering: hvad Simon skal gøre

### Fase 6a — Port og mount

```
1. Kopier proxy.js  → routes/horkram.js
   Tilpas: ESM imports → CommonJS require hvis nødvendigt (tjek package.json "type")
   Mount i server.js: app.use('/', require('./routes/horkram'));

2. Kopier parser.js → services/horkramParser.js
   Ret import i routes/horkram.js til ny placering

3. Tilføj til .env:
   HORKRAM_USER=...
   HORKRAM_PASS=...

4. Opret 2 nye userfields i Grocy (product_barcodes):
   supplier_unit_code  (text_single_line)
   supplier_unit_qty   (text_single_line)

5. Implementer enrichWithHokaSnapshots() i shared/bestilling.js
   Kald efter buildSupplierGroups(), før renderSuppliers()
```

### Fase 6b — Scraper i settings

```
6. Kopier horkram-scraper.html → settings/horkram.html
   Erstat BonConfig/BonConfigBar med direkte /api/grocy/* kald
   Opdater scraper til at gemme supplier_unit_code + supplier_unit_qty
   Link fra Settings → Leverandører → Hørkram
```

### Hvad der IKKE skal bygges (løses af eksisterende kode)

- Session-håndtering og login → proxy.js
- Anti-forgery token → proxy.js
- Cookie-jar → proxy.js
- isAgreementItem detection → proxy.js + parser.js
- Snapshot chunking (max 20 pr. kald) → proxy.js
- Auto-paginering af favorit-lister → proxy.js (/all endpoint)
- Fuzzy matching ved bulk-kobling → horkram-scraper.html
- Bulk pris-opdatering → horkram-scraper.html
