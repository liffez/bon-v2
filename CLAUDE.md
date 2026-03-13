# CLAUDE.md — Bon v2
> Læs dette FØR du skriver en eneste linje kode.
> Opdateres efter hver session under "Status" og "Næste opgave".

---
## Ved opstart — læs disse filer
- docs/BON_V2_PRINCIPPER.md
- docs/bon_v2_datamodel_v2.md
- docs/bon_v2_zoner_og_layout.md

---

## De tre autoritative dokumenter

Disse er sandheden. Al kode skal passe med dem.

| Dokument | Hvad det styrer |
|----------|-----------------|
| `docs/BON_V2_PRINCIPPER.md`      | Ufravigelige regler |
| `docs/bon_v2_datamodel_v2.md`    | Databaseskema       |
| `docs/bon_v2_zoner_og_layout.md` | Filstruktur, zoner  |
---


## Stack — ingen undtagelser

| Lag | Valg |
|-----|------|
| Backend | Node.js / Express |
| Database | SQLite via `better-sqlite3` |
| Frontend kitchen | Vanilla HTML/CSS/JS (MPA) |
| Frontend office | Vanilla JS + selektiv Vue.js |
| Realtid | SSE — aldrig polling, aldrig WebSockets |
| Styling | Vanilla CSS med tokens fra `shared/tokens.css` |

**Ingen React, ingen Tailwind, ingen Python, ingen ORM, ingen build-step.**

---

## Grocy-instans

Under udvikling bruges **grocytest** (`https://grocytest.ristetrug.dk/api`).
Skift til produktion (`grocycafe`) sker først ved release.

`default_grocy_location_id = 3` (Test) i settings-tabellen styrer dette.
Lokationer defineres i `locations`-tabellen: HQ=grocycafe, Trailer=grocytrailer, Test=grocytest.

---

## Kolonnenavne der ofte forveksles

| Korrekt navn | Må IKKE kaldes |
|--------------|----------------|
| `delivery_date` | `event_date` |
| `total_units` | `enheder` |
| `prep_ingredients_ready` | `prep_raavarer` |
| `prep_supplies_ready` | `prep_emballage` |
| `product_name` (på bon_lines) | `name` |
| `quantity` (på bon_lines) | `qty` |
| `status_id` FK → status_definitions | `status TEXT` |
| `delivery_address_id` FK → addresses | inline adressefelter |

---

## Filstruktur

```
bon-v2/
├── server.js         ← App setup, middleware, mount routes, listen — intet andet
├── routes/
│   ├── kitchen.js    ← GET /api/bons/today  (monteres FØR bons.js)
│   ├── bons.js       ← /api/bons/* (CRUD, status, lines, changelog, notifications)
│   ├── statuses.js   ← /api/statuses/*
│   ├── customers.js  ← /api/customers/*
│   └── settings.js   ← /api/settings/*
├── db/
│   ├── database.js   ← getDb() singleton (lazy init + migrations)
│   ├── helpers.js    ← logChange, handle, getBon, getBonLines, getStatusId, nextBonNumber
│   ├── migrate.js    ← Kører migrations fra db/migrations/
│   ├── seed.js       ← Testdata (11 bons, 7 kunder, 5 firmaer)
│   └── migrations/   ← 001_core.sql, ...
├── shared/
│   ├── sse.js        ← SSE router + broadcast(), sendTo() — named events
│   ├── tokens.css    ← Design tokens
│   ├── components.css
│   ├── bon_kort.js + bon_kort.css
│   ├── api.js        ← Frontend API-funktioner
│   └── utils.js      ← Status-mapping, connectSSE(), mapApiBonToCardData()
├── kitchen/          ← MPA: index.html, today.html, later.html, ...
├── office/           ← SPA-shell: index.html + views/*.js
├── settings/         ← index.html (eget shell)
├── assets/           ← logo.svg, icons/, fonts/
├── BonConfig.js
├── BonConfigBar.js
├── package.json
└── .env              ← aldrig i git
```

Nye filer placeres præcis der de hører hjemme — kopieres ikke.

---

## Vigtige regler

- **Changelog skrives af serveren** — aldrig af frontenden
- **Validering sker i serveren** — frontenden er convenience
- **Grocy læses via adapter** — skriv aldrig direkte til Grocy's database
- **SSE på `/api/sse`** — named events via `addEventListener`, aldrig `onmessage`
- **Route-filer bruger `getDb()`** — aldrig global `db`-variabel
- **`logChange({...})`** — objekt-API, aldrig positionelle argumenter
- **Nye npm-pakker kræver godkendelse** — spørg først

---

## Status på hvad der er bygget

### Blok A — Fundament
- [x] Status-flow defineret
- [x] Datamodel finaliseret (bon_v2_datamodel_v2.md)
- [x] SQLite database oprettet med migrations (`db/migrations/001_core.sql`)
- [x] Seed data (11 bons over 5 dage, 7 kunder, 5 firmaer, blandede statusser)

### Blok B — Kerne-backend
- [x] `db/migrations/001_core.sql` — Samlet migration (status, adresser, kunder, bons, changelog)
- [x] Backend refaktoreret: `server.js` → `routes/` + `db/` + `shared/sse.js`
- [x] `db/database.js` — `getDb()` singleton med lazy init + auto-migrations
- [x] `db/helpers.js` — `logChange`, `handle`, `getBon`, `getBonLines`, `getStatusId`, `nextBonNumber`
- [x] `shared/sse.js` — Named events, multi-client, heartbeat, `broadcast()` + `sendTo()`
- [x] `routes/kitchen.js` — GET /api/bons/today + GET /api/bons/later
- [x] `routes/bons.js` — CRUD, status (m/ triggers_json stub), prep, kitchen-info, lines, changelog, notifications
- [x] `routes/statuses.js` — GET statuses + transitions
- [x] `routes/customers.js` — GET customers
- [x] `routes/settings.js` — GET/PATCH settings
- [x] Grocy adapter (readonly) — `services/grocyAdapter.js` + `routes/grocy.js`

### Blok C — Første views
- [x] kitchen/today.html — Køkken I dag (fuldt dynamisk)
- [x] kitchen/later.html — Køkken Senere (fuldt dynamisk)
- [ ] Kalender-view (shared)

### Shared komponenter
- [x] `shared/bon_kort.js` + `shared/bon_kort.css` — Genbrugelig kort-komponent
  - Status-bar med klikbare knapper (styret af VIEW_WINDOWS i BonConfigBar.js)
  - Prep-checks (Råvarer / Emballage badges)
  - Kunde-sektion med fold-ud detaljer
  - Køkkeninfo pill (lukket: viser tekst + ✎, klik åbner inline textarea, Gem/Annuller)
  - Menu-liste med grupper (select-mode → vælg items → Gruppér → titel + note)
  - Drag-and-drop af grupper og items
  - Leveret-fading med fortryd-overlay (8s countdown)
  - Sammentællings-panel
  - Action-bar med modulære knapper
- [x] `shared/utils.js` — Status-mapping, dato-formattering, `connectSSE()` (named events), `mapApiBonToCardData()`
- [x] `shared/api.js` — API-funktioner (fetch, patch status/prep/kitchen-info)
- [x] `shared/modal.js` + `shared/modal.css` — Genbrugelig modal-komponent
  - `openModal({ title, bodyHtml })` / `closeModal()` API
  - Luk med ×, overlay-klik eller Escape
  - `showHistorik(cardId)` — henter changelog via API, viser formateret med danske labels
  - `showBonInfo(cardId)` — fuld bon-detalje med kunde, linjer, priser (moms-beregning)
  - `showRavarer(cardId)` — ingrediensbehov med lagerstatus fra Grocy
    - Grupperet efter Grocy `ingredient_group` (Emballage sidst)
    - Status-dots (🔴 mangler / 🟡 lav / 🟢 ok) per ingredient
    - Søgefelt til filtrering
    - Indkøbsliste-knap (🛒) — tilføjer til Grocy shopping_list i purchase-enhed
    - `recipes_pos.amount` er i stock-unit, konverteres stock→display via `quantity_unit_conversions`
- [x] `BonConfig.js` — Status-definitioner (koder, labels, farver)
- [x] `BonConfigBar.js` — VIEW_WINDOWS per view

### kitchen/today.html — Features
- Dynamisk rendering fra API-data via `createCard(data, 'kitchen-today')`
- Filter-system: tap = 8s peek-preview, hold = permanent lock (IGANG/KLAR/VIS LEVEREDE)
- VIS LEVEREDE med tæller, eksklusivt filter
- Leveret-fading: IGANG/KLAR → LEV med 8s fortryd-countdown, fade-out animation
- Fortryd med SSE-suppress (undgår race condition ved optimistisk UI + SSE)
- Status-transitions: GODKENDT/IGANG/KLAR → LEV (alle kan springe direkte) + LEV → IGANG (fortryd)
- Prep-badge toggle med API-kald
- Køkkeninfo inline-edit (pill → textarea → gem)
- SSE realtidsopdatering via named events (`bon_status`, `notification`)
- Sammentælling (aggregerer varer fra menu-items)
- Historik-knap åbner shared modal med changelog
- Løbende ur i header (synkroniseret til hele minutter, tabular-nums)
- Kiosk-mode: fullscreen + skjul topbar (KIOSK-knap, `?kiosk` URL-param, Escape lukker)

### kitchen/later.html — Features
- Dynamisk rendering fra API-data via `createCard(data, 'kitchen-later')`
- Grupperet efter `delivery_date` med dato-overskrifter og bon-tæller per dag
- Tilbud (`is_offer=1`) vises i separat sektion nederst
- Ingen filter-bar, ingen statusknapper (VIEW_WINDOWS = [])
- Prep-badge toggle med API-kald
- Køkkeninfo inline-edit (pill → textarea → gem)
- SSE realtidsopdatering: kort fjernes ved terminal status (LEVERET/AFLYST)
- Count badge opdateres ved ændringer
- Samme action-knapper som today: Tilføj vare, Send flyver, Send mail, Råvarer, Kort, Historik, Sammentælling
- Select-mode + sammentællings-panel (identisk med today)
- Historik-knap åbner shared modal med changelog

---

## Næste opgave

> ✏️ Opdateret 13. marts 2026.
>
> **Blok C køkken-views er færdige.** Opgave 1–5 done.
> Næste store opgave er Opgave 6 (Kalender/Indkøb/Bestilling).
> Småting til senere: Pris-visning i Råvarer som setting, Kort erstattes af logistik-modul.

---

### ~~OPGAVE 1 (done): Action-knap `+` Tilføj vare~~

**Formål:** Tilføj menupunkter til en bon direkte fra Grocy-opskrifter.
Løser også at seed-data har forkerte produktnavne — herefter er Grocy kilden til sandhed.

---

#### 1a. Migration: `db/migrations/007_price_category.sql`

```sql
ALTER TABLE bons ADD COLUMN price_category TEXT NOT NULL DEFAULT 'store'
    CHECK (price_category IN ('store','catering','festival','produktion','waiste'));
```

Seed-data i `db/seed.js`: fordel eksisterende 11 bons på `store` og `catering`.

---

#### 1b. Backend: Opdater `GET /api/grocy/recipes`

Returnér følgende felter per opskrift (kun `sellable = 1`):

```json
{
  "id": 42,
  "name": "Kyllingen",
  "category": "01 Sandwich",
  "unit": "stk",
  "unit_number": 1,
  "prices": {
    "store":      94,
    "catering":   94,
    "festival":   98,
    "produktion":  0,
    "waiste":      0
  },
  "cost_price": 23.55,
  "co2e": 0.42
}
```

Mapping fra Grocy userfields:
| Felt | Grocy userfield |
|------|----------------|
| `category` | `grupper` |
| `unit` | `recipeunit` |
| `unit_number` | `recipeunitnumber` |
| `prices.store` | `SalespriceStore` |
| `prices.catering` | `SalespriceCatering` |
| `prices.festival` | `SalespriceFestival` |
| `prices.produktion` | `SalespriceProduktion` |
| `prices.waiste` | `SalespriceWaiste` |
| `cost_price` | `costprice` |
| `co2e` | `Co2e` |
| (filter) | `sellable = 1` |

**Tilføj også** `price_category` til responset fra `GET /api/bons/:id`.

---

#### 1c. Backend: Opdater `POST /api/bons/:id/lines`

Request body:
```json
{
  "grocy_recipe_id": 42,
  "product_name": "Kyllingen",
  "category": "01 Sandwich",
  "quantity": 12,
  "unit": "stk",
  "special_request": "uden løg",
  "unit_price": 94,
  "cost_price": 23.55,
  "co2e": 0.42
}
```

Server gemmer alle felter som **snapshot** — værdier må ikke slås op igen bagefter.
Server beregner `line_total = quantity × unit_price`.
Server kalder `logChange(...)` og broadcaster SSE-event `bon_updated`.

---

#### 1d. Frontend: Picker i `shared/bon_kort.js`

**Placering:** Inline under `.bon-actions` — ikke modal, ikke popup.
Åbnes/lukkes ved klik på `+`-knappen. Lukkes også ved Escape.

**Layout — to kolonner:**
```
┌─────────────────────────────────────────┐
│ [01 Sandwich]  Falaflen        94 kr    │
│ [02 Salat   ]  "Tunen"         94 kr  ← valgt
│ [03 Kager   ]  Fisken          94 kr    │
│ [04 Slider  ]  Frikadellen     94 kr    │
│ ...            ...                      │
└─────────────────────────────────────────┘
```

- Venstre kolonne: kategorier hentet fra API, sorteret som de kommer fra Grocy
- Højre kolonne: varer i valgt kategori — navn + salgspris fra bonens `price_category`
- Priser kan skjules via toggle-knap øverst i pickeren (huskes i `localStorage`)
- Første kategori vælges automatisk ved åbning

**Trin 2 — inline expand under valgt vare:**
```
  Kyllingen   94 kr
  ┌──────────────────────────────┐
  │  [−]  12  [+]   × Kyllingen │
  │  Extra info: ____________    │
  │  [GEM]  [AFBRYD]             │
  └──────────────────────────────┘
```

- `+`/`−` knapper, minimum 1
- Tal kan redigeres direkte (click-to-edit input)
- "Extra info" → `special_request`
- GEM → `POST /api/bons/:id/lines` → luk picker → bon-kort re-renderes via SSE
- AFBRYD → luk expand, vare afmarkeres

**Vigtigt:** Pickeren kender bonens `price_category` og viser korrekt salgspris.
Prisen der gemmes på linjen er snapshot fra det tidspunkt brugeren trykker GEM.

---

### ~~OPGAVE 2 (done): Action-knap `ℹ Info`~~

**Formål:** Vis fuld bon-detalje i modal — til kontoret og køkkenet når man hurtigt vil se alt.

Genbruger `shared/modal.js` — `openModal({ title, bodyHtml })`.
Henter `GET /api/bons/:id` og renderer: kunde, firma, adresse, alle linjer med priser, betalingstype, køkkeninfo, notes.
**Kræver:** Korrekte bon_lines (dvs. Opgave 1 skal være done først).

---

### ~~OPGAVE 3 (done): Action-knap `🗺 Kort`~~

Simpel Google Maps-link fra `.customer-address`. Erstattes af logistikmodul senere.

---

### ~~OPGAVE 4 (done): Action-knap `📦 Råvarer`~~

**Formål:** Vis ingrediensbehov for alle linjer på bonen, med lagerstatus fra Grocy.

Åbner i `shared/modal.js`.

**Data:** Kald `GET /api/grocy/recipes/:id/ingredients` for hver linje med `grocy_recipe_id`,
skalér mængder med `quantity` fra bon_lines.
Kombiner med `GET /api/grocy/stock` for lagerstatus.

**Visning — grupperet efter status:**
```
● MANGLER (røde)     ← øverst, kræver handling
● LAV (orange)
● OK (grønne)        ← sammenfoldelige
─────────────────────────────────────────────
Vare              Behov       Lager    [+liste]
Falaffel          35 stk      0 stk     🛒
Kyllingefilet     2,4 kg      8,2 kg
```

- `[+liste]` knap per rød/lav vare → tilføjer til Grocy shoppinglist
- Kostpris aggregeret i bunden (eks. moms)
- Salgspris aggregeret i bunden (inkl. moms, fra bonens price_category)

**Kræver:** At bon_lines har korrekte `grocy_recipe_id` (dvs. Opgave 1 skal være done først).

---

### ~~OPGAVE 5 (done): `kitchen/today.html` efterbehandling~~
- Løbende ur i header (højrejusteret, `--color-text-dim`, tabular-nums, synk til hele minutter)
- Kiosk-mode (fullscreen, skjul topbar, toggle via KIOSK-knap + `?kiosk` URL-param, Escape lukker)

---

### OPGAVE 6 (bagefter): Kalender-view (shared)

**Moduloversigt (se `bon_v2_zoner_og_layout.md` sektion 3):**
- Indkøb = `kitchen/purchasing.html` — liste + hvad afventer
- Bestilling = `kitchen/orders.html` — PO, leverandørpriser, varemodtagelse (faner)
- Varemodtagelse er en fane i Bestilling — 2 trin: Fødevarekontrol → Lager (Grocy)

---

## API-base reference

```
GET    /api/bons/today                                   routes/kitchen.js
GET    /api/bons/later?days=28                            routes/kitchen.js
GET    /api/bons?date=&status=&q=&location=              routes/bons.js
GET    /api/bons/:id                                     routes/bons.js
POST   /api/bons                                         routes/bons.js
PATCH  /api/bons/:id/status     { status_code, user_id } routes/bons.js
PATCH  /api/bons/:id/prep       { ingredients_ready, supplies_ready }
PATCH  /api/bons/:id/kitchen-info { text }
POST   /api/bons/:id/lines                               routes/bons.js
PUT    /api/bons/:id/lines/:lid                          routes/bons.js
DELETE /api/bons/:id/lines/:lid                          routes/bons.js
GET    /api/bons/:id/changelog                           routes/bons.js
POST   /api/bons/:id/notifications                       routes/bons.js
GET    /api/bons/:id/notifications                       routes/bons.js
GET    /api/sse                                          shared/sse.js
GET    /api/statuses                                     routes/statuses.js
GET    /api/statuses/:code/transitions                   routes/statuses.js
GET    /api/customers                                    routes/customers.js
GET    /api/customers/:id                                routes/customers.js
GET    /api/settings                                     routes/settings.js
PATCH  /api/settings/:key                                routes/settings.js
GET    /api/grocy/recipes                                routes/grocy.js → grocyAdapter
GET    /api/grocy/recipes/fulfillment                    routes/grocy.js → grocyAdapter
GET    /api/grocy/recipes/:id/ingredients                routes/grocy.js → grocyAdapter
GET    /api/grocy/products                               routes/grocy.js → grocyAdapter
GET    /api/grocy/stock                                  routes/grocy.js → grocyAdapter
DELETE /api/grocy/cache                                  routes/grocy.js (ryd cache)
```

---

## Status-flow

```
NY → VENTER → GODKENDT → IGANG → KLAR → LEVERET → FAKTURERET → AFSLUTTET
                                              ↘ BETALT
Fra alle: → AFLYST
```

Med `force: true` kan admin sætte hvilken som helst status.
POS-ordrer (Zettle) sættes direkte til BETALT.

---

## Designsystem — nøglefarver

```css
--brand-primary:       #8e631f;   /* Ristet Rug brun */
--brand-primary-light: #f1e6b2;   /* Gul/creme */
--color-background:    #f5f4f2;
--color-border:        #d7d1ca;
```

Body-klasse: `zone-kitchen` eller `zone-office` — styrer touch vs. desktop densitet.

---

*Sidst opdateret: marts 2026*
