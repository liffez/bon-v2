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
- [ ] SQLite database oprettet med migrations
- [ ] Seed data indsat

### Blok B — Kerne-backend
- [ ] `db/migrations/001_core.sql` (status, adresser, lokationer)
- [ ] `db/migrations/002_customers.sql`
- [ ] `db/migrations/003_bons.sql`
- [ ] `db/migrations/004_changelog.sql`
- [ ] GET /api/bons/today
- [ ] GET /api/bons
- [ ] GET /api/bons/:id
- [ ] POST /api/bons
- [ ] PATCH /api/bons/:id/status
- [ ] PATCH /api/bons/:id/prep
- [ ] GET /api/sse
- [ ] Grocy adapter (læs opskrifter, lager)

### Blok C — Første views
- [ ] kitchen/today.html — Køkken I dag
- [ ] kitchen/later.html — Køkken Senere
- [ ] Kalender-view (shared)

---

## Næste opgave

> ✏️ Opdater denne sektion FØR du starter en ny session i Claude Code.

**Ingen aktiv opgave sat endnu.**

Eksempel på udfyldt:
```
OPGAVE: Opret migrations og seed
- Skriv db/migrations/001_core.sql (status_definitions, addresses, locations)
- Skriv db/migrations/002_customers.sql
- Skriv db/migrate.js der kører nye filer fortløbende
- Kør npm run setup og verificér med sqlite3
Acceptkriterium: `SELECT * FROM status_definitions` returnerer 9 rækker
```

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
