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
- [ ] Grocy adapter (læs opskrifter, lager)

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

---

## Næste opgave

> ✏️ Opdater denne sektion FØR du starter en ny session i Claude Code.
### 2. `historik`-knap

Ingen nye backend-endpoints nødvendige — `GET /api/bons/:id/changelog` eksisterer.

- Knap i action-bar på bon-kort åbner en modal
- Modal henter og viser changelog for bonen i kronologisk rækkefølge
- Samme modal-komponent genbruges til `info`-knap senere
- Implementeres i `shared/bon_kort.js`

---

### 3. Grocy adapter — readonly

**Fil:** `services/grocyAdapter.js`

#### Arkitektur
- Én fil — ikke en route. Eksporterer funktioner der kaldes fra routes.
- Henter Grocy-URL og API-nøgle fra `locations`-tabellen via `location_id`
- I første omgang: brug altid den lokation der svarer til `system_settings.default_grocy_location_id`
- Multi-lokation pr. bruger/bon udskydes til et senere tidspunkt

#### Caching
- In-memory `Map` med 10 minutters TTL pr. cache-nøgle
- Ingen aktiv invalidering — acceptabelt da data ikke er kritisk realtidsdata
- Cache nulstilles ved server-restart
```js
// Eksempel på cache-pattern
const cache = new Map(); // { key: { data, expires } }

function getCached(key) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

function setCached(key, data, ttlMs = 10 * 60 * 1000) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}
```

#### Funktioner der skal implementeres
```js
getRecipes()
// GET /api/objects/recipes
// Returnerer alle opskrifter

getRecipeIngredients(recipeId)
// GET /api/objects/recipes_pos?query[]=recipe_id=<id>
// Returnerer ingredienser for én opskrift

getProducts()
// GET /api/objects/products
// Returnerer alle produkter (bruges til navne-lookup)

getStock()
// GET /api/stock
// Returnerer lagerstatus for alle produkter
```

#### Routes der eksponerer adapteren

Tilføj i ny fil `routes/grocy.js`:
```
GET /api/grocy/recipes              → getRecipes()
GET /api/grocy/recipes/:id/ingredients → getRecipeIngredients(id)
GET /api/grocy/products             → getProducts()
GET /api/grocy/stock                → getStock()
```

Monteres i `server.js` som `/api/grocy`.

#### Ikke i denne omgang
- `consumeRecipe()` — udskydes til `triggers_json`-handleren er klar
- Multi-lokation pr. bruger — udskydes
- Skriveoperationer til Grocy — udskydes


### 1b. `kitchen/today.html` — efterbehandling

Små tilføjelser til det eksisterende view.

#### Løbende ur i header
Vis aktuelt tidspunkt ved siden af datoen i page-headeren:
```
Tor 12. marts  5 bons tilbage          14:23
```

- Placering: højrejusteret i samme linje som dato/tæller
- Stil: `--color-text-dim`, `--font-size-s` — diskret, ikke fremhævet
- Opdateres hvert minut med `setInterval`
- Kun på `today.html` — ikke på `later.html`
```js
function updateClock() {
  const now = new Date();
  document.getElementById('live-clock').textContent =
    now.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 60000);
```

#### Kiosk-mode
- Aktiveres via URL-parameter `?kiosk=1` eller knap i headeren (samme knap toggler frem/tilbage)
- Skjuler topbar (`display: none` på `.kitchen-topbar`)
- Kalder `document.documentElement.requestFullscreen()` ved aktivering
- Kalder `document.exitFullscreen()` ved deaktivering
- Knappen i headeren vises altid — også i kiosk-mode — så man kan komme ud igen

### Prioriteret rækkefølge

**1. Action-knapper (ingen Grocy-dependency)**
- `info` — vis bon-detalje/changelog i modal
- `kort` — åbn Google Maps med leveringsadressen
- `historik` — vis changelog for bon

**2. Grocy adapter (readonly)**
- `GET /api/grocy/products` — produktliste
- `GET /api/grocy/stock` — lagerstatus
- `GET /api/grocy/recipes` — opskrifter
- Fundament for alt videre Grocy-arbejde

**3. Action-knap: `+` Tilføj vare**
- Kræver Grocy adapter
- Søg i Grocy-produkter, tilføj til bon_lines

**4. Kalender-view (shared)**

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
