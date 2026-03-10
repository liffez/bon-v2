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
├── shared/           ← tokens.css, components.css, api.js, utils.js
├── kitchen/          ← MPA: index.html, today.html, later.html, ...
├── office/           ← SPA-shell: index.html + views/*.js
├── settings/         ← index.html (eget shell)
├── db/               ← migrate.js, seed.js, helpers, migrations/
├── assets/           ← logo.svg, icons/, fonts/
├── server.js         ← ÉN server
├── BonConfig.js
├── package.json
└── .env              ← aldrig i git
```

Nye filer placeres præcis der de hører hjemme — kopieres ikke.

---

## Vigtige regler

- **Changelog skrives af serveren** — aldrig af frontenden
- **Validering sker i serveren** — frontenden er convenience
- **Grocy læses via adapter** — skriv aldrig direkte til Grocy's database
- **SSE på `/api/sse`** — kitchen-views abonnerer her
- **Nye npm-pakker kræver godkendelse** — spørg først

---

## Status på hvad der er bygget

### Blok A — Fundament
- [x] Status-flow defineret
- [x] Datamodel finaliseret (bon_v2_datamodel_v2.md)
- [x] SQLite database oprettet med migrations (`db/migrations/001_core.sql`)
- [x] Seed data indsat (9 statusser, testdata med 4+ bons)

### Blok B — Kerne-backend
- [x] `db/migrations/001_core.sql` — Samlet migration (status, adresser, kunder, bons, changelog)
- [x] GET /api/bons/today
- [x] GET /api/bons
- [x] GET /api/bons/:id
- [x] POST /api/bons
- [x] PATCH /api/bons/:id/status (med dynamisk validering via `status_transitions`)
- [x] PATCH /api/bons/:id/prep
- [x] PATCH /api/bons/:id/kitchen-info
- [x] GET /api/sse (realtid med auto-reconnect)
- [ ] Grocy adapter (læs opskrifter, lager)

### Blok C — Første views
- [x] kitchen/today.html — Køkken I dag (fuldt dynamisk)
- [ ] kitchen/later.html — Køkken Senere
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
- [x] `shared/utils.js` — Status-mapping, dato-formattering, SSE-helper, `mapApiBonToCardData()`
- [x] `shared/api.js` — API-funktioner (fetch, patch status/prep/kitchen-info)
- [x] `BonConfig.js` — Status-definitioner (koder, labels, farver)
- [x] `BonConfigBar.js` — VIEW_WINDOWS per view

### kitchen/today.html — Features
- Dynamisk rendering fra API-data via `createCard(data, 'kitchen-today')`
- Filter-system: tap = 8s peek-preview, hold = permanent lock (IGANG/KLAR/VIS LEVEREDE)
- VIS LEVEREDE med tæller, eksklusivt filter
- Leveret-fading: IGANG/KLAR → LEV med 8s fortryd-countdown, fade-out animation
- Fortryd med SSE-suppress (undgår race condition ved optimistisk UI + SSE)
- Status-transitions: IGANG → KLAR → LEV + direkte IGANG → LEV og LEV → IGANG
- Prep-badge toggle med API-kald
- Køkkeninfo inline-edit (pill → textarea → gem)
- SSE realtidsopdatering af kort-status
- Sammentælling (aggregerer varer fra menu-items)

---

## Næste opgave

> ✏️ Opdater denne sektion FØR du starter en ny session i Claude Code.

Mulige næste trin:
- `kitchen/later.html` — Køkken Senere (genbruger bon_kort.js med view `kitchen-later`)
- Kalender-view
- Grocy adapter
- Persistering af grupper (gemmes i DB, ikke kun klient-side)

---

## API-base reference

```
GET  /api/bons/today
GET  /api/bons?date=&status=&q=&location=
GET  /api/bons/:id
POST /api/bons
PATCH /api/bons/:id/status       { status_code, user_id, force? }
PATCH /api/bons/:id/prep         { ingredients_ready, supplies_ready }
PATCH /api/bons/:id/kitchen-info { text }
GET  /api/bons/:id/changelog
GET  /api/sse
GET  /api/statuses
GET  /api/customers
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
