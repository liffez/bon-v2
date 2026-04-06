# CLAUDE_TILBUD.md — Tilbudsmodul

> Spec for tilbudsmodul i Bon v2 Office-zonen.
> Skrives som `office/views/tilbud.js` + `office/views/tilbud.css` + `routes/quotes.js`.
> Læs `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md` og `CLAUDE.md` inden du starter.

---

## Placering i systemet

**Sidebar:** Separat punkt — efter CRM, før Fakturering.

Tilbud er et salgsdokument-workflow (5-trins wizard + PDF + egen datatabel), ikke en CRM-visning. Det adskilles bevidst fra CRM men linkes derfra via deep links.

```
├── Dashboard
├── Bons
├── Kalender
├── Planlægning
├── CRM
│   ├── Pipeline
│   ├── Kunder
│   ├── Serviceopkald
│   └── Aktiviteter
├── Tilbud          ← separat punkt her
├── Fakturering
└── Rapporter
```

**Kobling til CRM sker via deep links:**
- Kunde 360° → "Opret tilbud" knap → `?view=tilbud&customer=ID`
- Pipeline-kort → "Se tilbud" → `?view=tilbud&id=QUOTE_ID`

**View-id:** `tilbud` — aktiveres via `data-view="tilbud"` i `office/index.html`

---

## Hvad der IKKE bygges i denne fase

- Mail-afsendelse med PDF som vedhæftning (fase 2)
- Logo embedded i PDF (fase 2)
- `#T-NNN` email-tag-routing i mailService (fase 2)

---

## 1. Migration: `db/migrations/020_quotes.sql`

Tabellerne `quotes` og `quote_lines` er defineret i `bon_v2_datamodel_v2.md`.

```sql
-- ==========================================
-- TILBUD
-- ==========================================

CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_number TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers(id),
    company_id INTEGER REFERENCES companies(id),
    price_category TEXT NOT NULL DEFAULT 'catering',
    quote_date DATE NOT NULL DEFAULT (DATE('now')),
    valid_until DATE,
    delivery_date DATE,
    delivery_time TEXT,
    pax INTEGER,
    delivery_type TEXT DEFAULT 'delivery',
    delivery_address_id INTEGER REFERENCES addresses(id),
    delivery_price REAL DEFAULT 0,
    delivery_note TEXT,
    template TEXT NOT NULL DEFAULT 'event'
        CHECK (template IN ('event', 'single', 'custom')),
    price_mode TEXT NOT NULL DEFAULT 'total'
        CHECK (price_mode IN ('total', 'block', 'line')),
    discount_percent REAL DEFAULT 0,
    total_price REAL,
    notes TEXT,
    customer_wishes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
    converted_to_bon_id INTEGER REFERENCES bons(id),
    created_by_user_id INTEGER REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quote_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    block_type TEXT,
    grocy_recipe_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'stk',
    unit_price REAL,
    cost_price REAL,
    line_total REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id);

-- Tilbudsnummer-tæller i settings
INSERT OR IGNORE INTO settings (key, value, description)
VALUES ('quote_number_next', '1', 'Næste tilbudsnummer (heltal)'),
       ('quote_number_prefix', 'T-', 'Præfiks for tilbudsnumre');
```

### Kolonneforklaring

| Kolonne | Formål |
|---------|--------|
| `price_category` | Kode som på bons (`catering`, `store`, `festival` etc.) — IKKE FK |
| `template` | Wizard-skabelon: `event` (blokke), `single` (flad liste), `custom` (fri tekst) |
| `price_mode` | Prisvisning i PDF: `total` (samlet), `block` (per blok), `line` (per linje) |
| `block_type` | Måltidsblok for event-skabelon: `morning`, `lunch`, `amsnack`, `pmsnack`, `null` |
| `customer_wishes` | Kundens ønsker/krav (f.eks. "ingen svinekød, 5 veganske") |
| `delivery_price` | Leveringspris (separat fra varerne) |
| `delivery_note` | Bud-info (f.eks. "Byekspressen") |
| `cost_price` (linjer) | Kostpris snapshot fra Grocy |

### Tilbudsnumre

**Format:** `{prefix}{nummer}` — f.eks. `T-42`, `T-43`.

- `quote_number_prefix` hentes fra settings (default `T-`)
- `quote_number_next` auto-inkrementeres ved oprettelse
- Tilbud opdateres in-place ved ændringer — ingen versionering
- `updated_at` tracker seneste ændring

---

## 2. Backend: `routes/quotes.js`

Mount i `server.js` som `/api/quotes` med `requireAuth('office')`.

### Endpoints

```
GET    /api/quotes              Liste (filtre: status, customer_id, q)
GET    /api/quotes/:id          Enkelt tilbud med linjer + kunde + firma
POST   /api/quotes              Opret nyt tilbud (returnér med quote_number)
PATCH  /api/quotes/:id          Opdater tilbud (alle felter)
DELETE /api/quotes/:id          Slet tilbud (kun draft)
POST   /api/quotes/:id/lines    Tilføj linje
PUT    /api/quotes/:id/lines/:lid  Opdater linje
DELETE /api/quotes/:id/lines/:lid  Slet linje
PATCH  /api/quotes/:id/status   Skift status { status }
POST   /api/quotes/:id/convert  Konvertér til bon → returnér { bon_id, bon_number }
GET    /api/quotes/next-number  { quote_number: 'T-42' }
```

### `GET /api/quotes` — response per tilbud

```json
{
  "id": 7,
  "quote_number": "T-42",
  "status": "draft",
  "template": "event",
  "quote_date": "2026-04-02",
  "valid_until": "2026-05-02",
  "delivery_date": "2026-05-15",
  "delivery_time": "11:30",
  "pax": 50,
  "total_price": 8450,
  "customer_name": "Marie Jensen",
  "company_name": "Dansk Arkitektur ApS",
  "converted_to_bon_id": null
}
```

Filtre:
- `?status=draft` — kommasepareret
- `?customer_id=12`
- `?q=arkitektur` — søger i quote_number, customer_name, company_name

### `GET /api/quotes/:id` — fuld quote med linjer

```json
{
  "id": 7,
  "quote_number": "T-42",
  "customer_id": 12,
  "company_id": 5,
  "price_category": "catering",
  "customer_name": "Marie Jensen",
  "customer_email": "marie@da.dk",
  "customer_phone": "23456789",
  "company_name": "Dansk Arkitektur ApS",
  "status": "draft",
  "template": "event",
  "price_mode": "total",
  "discount_percent": 0,
  "delivery_date": "2026-05-15",
  "delivery_time": "11:30",
  "delivery_type": "delivery",
  "delivery_address_id": 3,
  "delivery_address": "Vesterbrogade 42, 1620 København V",
  "delivery_price": 450,
  "delivery_note": "Byekspressen",
  "pax": 50,
  "total_price": 8450,
  "customer_wishes": "Ingen svinekød, 5 veganske",
  "valid_until": "2026-05-02",
  "notes": null,
  "lines": [
    {
      "id": 31,
      "block_type": "morning",
      "grocy_recipe_id": 42,
      "product_name": "Stjerneskud",
      "quantity": 25,
      "unit": "stk",
      "unit_price": 62,
      "cost_price": 28,
      "line_total": 1550,
      "sort_order": 0,
      "notes": null
    }
  ]
}
```

### `POST /api/quotes` — opret

- Generér `quote_number` fra settings (`quote_number_prefix` + `quote_number_next`)
- Inkrement `quote_number_next` i settings
- Beregn `valid_until` = `quote_date` + 30 dage (default, kan overrides i payload)
- Beregn `total_price` = sum(`line_total`) + `delivery_price` − rabat
- Gem linjer i `quote_lines` med `sort_order`
- Log changelog: `logChange({ entity_type: 'quote', entity_id: id, action: 'create', ... })`
- SSE broadcast: `quote_created`

### `PATCH /api/quotes/:id` — opdater

- Accepterer alle felter (partial update)
- Hvis `lines` er inkluderet: replace-all (slet eksisterende, indsæt nye)
- Genberegn `total_price` ved linje-ændringer
- Log changelog per ændret felt (som bons PATCH)
- SSE broadcast: `quote_updated`

### `POST /api/quotes/:id/convert` — konverter til bon

```javascript
// Server-side:
// 1. Hent quote med linjer
// 2. Opret bon via genbrug af helpers:
//    - customer_id, company_id, delivery_date, delivery_time,
//      pax, price_category, delivery_type, delivery_address_id, notes
//    - Status = NY
//    - Kopiér quote_lines → bon_lines (grocy_recipe_id, product_name, quantity, unit, unit_price, cost_price)
// 3. Opdater quote: converted_to_bon_id = ny bon id, status = 'accepted'
// 4. Log changelog på begge
// 5. SSE broadcast: bon_created + quote_updated
// Returnér: { bon_id, bon_number }
```

### SSE events (fase 1)

| Event | Data | Hvornår |
|-------|------|---------|
| `quote_created` | `{ id, quote_number }` | POST /api/quotes |
| `quote_updated` | `{ id, quote_number }` | PATCH + status + convert |

---

## 3. Frontend: `office/views/tilbud.js`

### Initialisering

```javascript
// Pattern som andre office views
export function initTilbud(opts) {
  // opts.customer_id → pre-load KundeSoeg med kunde (deep link fra CRM)
  // opts.id → åbn eksisterende tilbud i wizard
  // ingen opts → vis tilbudsliste
}
export function cleanupTilbud() {
  // Ryd event listeners, SSE handlers
}
```

Monteret i `office/index.html` via view-switcher — identisk med `initFakturering()` / `cleanupFakturering()`.

---

### Tilbudsliste (default view)

Når `data-view="tilbud"` aktiveres vises **først en liste** over eksisterende tilbud.

```
┌──────────────────────────────────────────────────────┐
│  Tilbud                           [+ Nyt tilbud]     │
│  ──────────────────────────────────────────────────  │
│  [Kladde] [Sendt] [Accepteret] [Afvist] [Alle]       │
├──────────────────────────────────────────────────────┤
│  T-42  Dansk Arkitektur   15/5   50 pax   Kladde     │
│  T-41  Janteloven Café    10/5   25 pax   Sendt      │
│  T-40  Privat             –      12 pax   Accepteret │
└──────────────────────────────────────────────────────┘
```

- Klik på row → åbn wizard med data pre-loaded (PATCH-mode)
- Klik "+ Nyt tilbud" → åbn wizard frisk (POST-mode)
- Status-filtre som toggle-knapper (localStorage persistens)
- SSE: `quote_created`/`quote_updated` → re-fetch liste

### Status-badges

```javascript
const STATUS_LABELS = {
  draft:    { label: 'Kladde',     color: '#8a8580' },
  sent:     { label: 'Sendt',      color: '#7594b3' },
  accepted: { label: 'Accepteret', color: '#6ab04c' },
  declined: { label: 'Afvist',     color: '#bc181b' },
  expired:  { label: 'Udløbet',    color: '#d7d1ca' },
};
```

---

### Wizardstruktur (5 steps)

```
[0: Skabelon] → [1: Kunde] → [2: Sammensæt] → [3: Priser] → [4: Preview/Gem]
```

Progressbar og navigation porteret fra `tilbud-standalone-v2.html`.

---

### Menudata fra Grocy

Erstat hardcodet MENU med API-kald:

```javascript
async function loadMenu() {
  const recipes = await apiFetch('/api/grocy/recipes');
  // Byg samme struktur: { 'Kategori': [{ id, name, unit, unitPrice, costPrice }] }
  const menu = {};
  for (const r of recipes) {
    const cat = r.category || 'Øvrige';
    if (!menu[cat]) menu[cat] = [];
    menu[cat].push({
      grocy_recipe_id: r.id,
      name: r.name,
      unit: r.unit || 'stk',
      unitPrice: r.prices?.[activePriceCategory] ?? r.prices?.catering ?? 0,
      costPrice: r.cost_price ?? 0,
    });
  }
  return menu;
}
```

`activePriceCategory` hentes fra tilbuddets `price_category` felt (default `'catering'`).

Cache: server-side i `grocyAdapter.js` (som alle andre Grocy-data). Ingen `window._cache`.

---

### Kundesøg

Erstat hardcodet kundesøg med **`KundeSoeg`-komponenten** (`shared/kunde_soeg.js`):

```javascript
const ks = new KundeSoeg(document.getElementById('kunde-soeg-container'), {
  onSelect: (data) => {
    selectedCustomer = data;
    loadOrderHistory(data.customer_id);
  }
});
```

Når kunde er valgt: vis event-felterne (dato, pax, leveringstid, kunde ønsker) under KundeSoeg.

---

### Ordrehistorik / Kopiér bon

Hent ordrehistorik fra eksisterende CRM-endpoint:

```javascript
async function loadOrderHistory(customerId) {
  const orders = await apiFetch(`/api/crm/customer-orders/${customerId}`);
  renderOrderHistory(orders);
}

async function copyBon(bonId) {
  const bon = await apiFetch(`/api/bons/${bonId}`);
  clearSelections();
  for (const line of bon.lines) {
    addItemToSelection({
      grocy_recipe_id: line.grocy_recipe_id,
      name: line.product_name,
      unit: line.unit,
      unitPrice: line.unit_price ?? 0,
      costPrice: line.cost_price ?? 0,
      quantity: line.quantity,
    });
  }
  goToStep(2); // Sammensæt
}
```

---

### DAWA adresseopslag

Genbrug eksisterende DAWA-implementering fra `shared/bon_drawer.js`. Gem valideret adresse via `POST /api/addresses` — samme flow som bon-drawer.

---

### Gem tilbud (step 4)

```javascript
async function saveQuote() {
  const payload = {
    customer_id: selectedCustomer?.customer_id ?? null,
    company_id: selectedCustomer?.company_id ?? null,
    price_category: activePriceCategory,
    template: tpl,
    delivery_date: ...,
    delivery_time: ...,
    pax: ...,
    delivery_type: ...,
    delivery_address_id: savedAddressId,  // fra POST /api/addresses
    delivery_price: ...,
    delivery_note: ...,
    price_mode: priceMode,
    discount_percent: ...,
    customer_wishes: ...,
    valid_until: ...,
    lines: collectLines(),
  };

  const isNew = !currentQuoteId;
  const url = isNew ? '/api/quotes' : `/api/quotes/${currentQuoteId}`;
  const method = isNew ? 'POST' : 'PATCH';
  const saved = await apiFetch(url, { method, body: JSON.stringify(payload) });
  currentQuoteId = saved.id;
  showToast(`Tilbud ${saved.quote_number} gemt`);
}
```

---

### Konvertér til bon

I step 4 (Preview) — "Opret som bon"-knap:

```javascript
async function convertToBon() {
  await saveQuote();
  const result = await apiFetch(`/api/quotes/${currentQuoteId}/convert`, { method: 'POST' });
  showToast(`Bon ${result.bon_number} oprettet`);
  switchView('bons', { highlight: result.bon_id });
}
```

---

## 4. PDF-generering

Behold eksisterende `genPDF()` fra `tilbud-standalone-v2.html` — portér logikken til `tilbud.js`. jsPDF loades fra CDN i `office/index.html`:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js"></script>
```

Logo i PDF: tekst "RISTET RUG" som i prototypen. Billedlogo udskydes til fase 2.

**Fonts:** Brug Bon v2 standard (Playfair Display + DM Sans). Ikke Fraunces.

---

## 5. `shared/api.js` — nye funktioner

```javascript
export async function fetchQuotes(params = {})          // GET /api/quotes?...
export async function fetchQuote(id)                    // GET /api/quotes/:id
export async function createQuote(data)                 // POST /api/quotes
export async function updateQuote(id, data)             // PATCH /api/quotes/:id
export async function deleteQuote(id)                   // DELETE /api/quotes/:id
export async function patchQuoteStatus(id, status)      // PATCH /api/quotes/:id/status
export async function convertQuoteToBon(id)             // POST /api/quotes/:id/convert
export async function fetchNextQuoteNumber()            // GET /api/quotes/next-number
```

---

## 6. `office/index.html` — ændringer

```html
<!-- I <head>: -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js"></script>

<!-- I sidebar: EFTER CRM-sektionen, FØR Fakturering: -->
<div class="sidebar-item" data-view="tilbud" onclick="switchView('tilbud')">
  📋 Tilbud
  <span class="sidebar-badge" id="badge-quotes"></span>
</div>

<!-- I view-container: -->
<div id="view-tilbud" class="view-panel" style="display:none;"></div>
```

Sidebar-badge viser antal `draft`-tilbud.

View-switcher kalder `initTilbud()` / `cleanupTilbud()` — samme mønster som `initFakturering()`.

**Deep link fra CRM** — tilføj i `office/views/crm-kunde360.js`:
```javascript
function openNewQuoteForCustomer(customerId) {
  switchView('tilbud', { customer_id: customerId });
}
```

---

## 7. `server.js` — mount

```javascript
const quotesRouter = require('./routes/quotes');
app.use('/api/quotes', requireAuth('office'), quotesRouter);
```

---

## Implementeringsrækkefølge

1. Migration `020_quotes.sql`
2. `routes/quotes.js` (alle endpoints)
3. Mount i `server.js` + SSE events
4. `shared/api.js` — 8 nye funktioner
5. `office/views/tilbud.css` — port af CSS fra prototype (brug design tokens, Playfair + DM Sans)
6. `office/views/tilbud.js` — tilbudsliste + wizard med Grocy-data, KundeSoeg, DAWA
7. `office/index.html` — sidebar-item + jsPDF CDN + view-panel + view-switcher
8. CRM deep links (Kunde 360° → "Opret tilbud")
9. Test: fuld flow (se testplan nedenfor)

---

## 8. Testplan

### 8a. Backend-verifikation (API)

Kør serveren (`node server.js`) og test endpoints manuelt eller med curl:

| # | Test | Kommando | Forventet |
|---|------|----------|-----------|
| 1 | Migration kører | Start server, tjek log | Ingen fejl, tabeller oprettet |
| 2 | Hent næste nummer | `GET /api/quotes/next-number` | `{ "quote_number": "T-1" }` |
| 3 | Opret tomt tilbud | `POST /api/quotes` med `{ "template": "event" }` | 201, returnerer id + quote_number |
| 4 | Opret med kunde + linjer | `POST /api/quotes` med customer_id, lines[] | 201, linjer gemt, total beregnet |
| 5 | Hent tilbud med linjer | `GET /api/quotes/:id` | Fuld response med lines[], kunde-join |
| 6 | Opdater tilbud | `PATCH /api/quotes/:id` med `{ pax: 60 }` | 200, changelog logget |
| 7 | Opdater med nye linjer | `PATCH /api/quotes/:id` med `{ lines: [...] }` | Gamle linjer slettet, nye indsat, total genberegnet |
| 8 | Tilføj enkelt linje | `POST /api/quotes/:id/lines` | 201, line_total beregnet |
| 9 | Slet linje | `DELETE /api/quotes/:id/lines/:lid` | 200, total genberegnet |
| 10 | Skift status | `PATCH /api/quotes/:id/status` med `{ "status": "sent" }` | 200, changelog, SSE event |
| 11 | Slet draft | `DELETE /api/quotes/:id` | 200 |
| 12 | Slet non-draft | `DELETE /api/quotes/:id` (status=sent) | 400/403 — kun drafts kan slettes |
| 13 | Filtrér liste | `GET /api/quotes?status=draft&q=test` | Kun matchende tilbud |
| 14 | Konvertér til bon | `POST /api/quotes/:id/convert` | 200, bon oprettet, quote.converted_to_bon_id sat |
| 15 | Konvertér allerede konverteret | `POST /api/quotes/:id/convert` (allerede konverteret) | 400 — kan ikke konvertere igen |
| 16 | Total med rabat | Opret med `discount_percent: 10`, 2 linjer á 1000 | total_price = (2000 + delivery) × 0.9 |
| 17 | Total med levering | Opret med `delivery_price: 450` | Leveringspris indgår i total |

### 8b. Frontend-verifikation (browser)

| # | Test | Handling | Forventet |
|---|------|----------|-----------|
| 1 | Sidebar-punkt synligt | Log ind som office-bruger | "Tilbud" i sidebar, korrekt placering |
| 2 | Tom liste | Klik Tilbud (ingen tilbud endnu) | Tom state med "+ Nyt tilbud" knap |
| 3 | Wizard åbner | Klik "+ Nyt tilbud" | Step 0 (Skabelon) vises |
| 4 | Skabelon-valg | Klik "Event" | Markeret, Næste-knap aktiveret |
| 5 | Kundesøg | Skriv kundenavn i step 1 | KundeSoeg dropdown med resultater |
| 6 | Ordrehistorik | Vælg kunde med ordrer | Ordrehistorik vises, "Kopiér" knap virker |
| 7 | Kopiér bon | Klik "Kopiér" på en ordre | Linjer kopieret til step 2, hop til Sammensæt |
| 8 | Menudata fra Grocy | Åbn step 2 (Sammensæt) | Kategorier + produkter fra Grocy, priser korrekte |
| 9 | Tilføj varer | Vælg produkt, sæt antal, tilføj | Linje tilføjet med korrekt pris |
| 10 | Block-type (event) | Tilføj varer i "Formiddag" og "Frokost" | Grupperet korrekt i preview |
| 11 | Prisvisning | Step 3: skift price_mode | Preview opdateres (total/block/line) |
| 12 | Rabat | Indtast 10% rabat | Total genberegnes korrekt |
| 13 | Leveringsadresse | Indtast adresse i step 1 | DAWA autocomplete, valideret adresse |
| 14 | Preview | Step 4: se preview | Alle data korrekt, PDF-knap synlig |
| 15 | Gem som kladde | Klik "Gem" | Toast, tilbud i listen med status "Kladde" |
| 16 | Genåbn tilbud | Klik på tilbud i listen | Wizard åbner med alle data pre-loaded |
| 17 | Rediger og gem | Ændr pax, gem igen | Opdateret, ingen nyt tilbudsnummer |
| 18 | PDF-generering | Klik "Download PDF" | PDF downloader med korrekt indhold |
| 19 | Konvertér til bon | Klik "Opret som bon" | Toast med bonnummer, navigerer til bon-liste |
| 20 | Konverteret bon | Åbn den nye bon i BonDrawer | Alle data fra tilbud kopieret korrekt |
| 21 | SSE opdatering | Åbn 2 browsere, opret tilbud i den ene | Listen opdateres i den anden |
| 22 | Deep link fra CRM | Klik "Opret tilbud" i Kunde 360° | Wizard åbner med kunde pre-loaded |
| 23 | Status-filtre | Klik "Sendt" filter | Kun sendte tilbud vises |
| 24 | Sidebar badge | Opret 3 kladder | Badge viser "3" |

### 8c. Edge cases

| # | Test | Forventet |
|---|------|-----------|
| 1 | Tilbud uden kunde | Kan gemmes (privat/ukendt) |
| 2 | Tilbud uden linjer | Kan gemmes som kladde, total = 0 |
| 3 | Delivery_price uden varer | Total = delivery_price |
| 4 | Discount 100% | Total = 0 (delivery_price rabatteres også) |
| 5 | Grocy utilgængelig | Wizard viser fejlbesked, kan ikke tilføje varer |
| 6 | Lang produktnavn | Tekst truncates i liste, fuld i preview |
| 7 | Udløbet tilbud | Vises med "Udløbet" badge i listen |

---

## Fase 2 (ikke i denne spec)

- Send mail med PDF som vedhæftning (via mailService)
- Logo i PDF (billedfil embedded)
- `#T-NNN` email-tag-routing i mailService
- Priskategori-valg per tilbud (med dropdown i step 1)
- Tilbud som "ghost"-blokke i kalender-view
