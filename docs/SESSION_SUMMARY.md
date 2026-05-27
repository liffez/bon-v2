# Session-summary — 15. marts 2026
> Indsæt dette i CLAUDE.md under "Næste opgave" når ny chat startes.
> Slet den gamle "Næste opgave"-sektion og erstat med denne.

---

## Næste opgave

> ✏️ Opdateret 15. marts 2026.
>
> **Fase 1a–1d komplet.** Fase 1c (drawer) er i gang hos Simon.
> Næste specs klar til Simon: CLAUDE_FASE1D.md, CLAUDE_FASE1E.md, CLAUDE_FASE3A.md.
> Webhook-URL skal sættes i formbuilder + ny HTML publiceres til ristetrug.dk/bestil.
> Datamigration Bon v1 → v2 + ny server-deployment planlægges parallelt.

---

## Status — hvad der er bygget (opdateret)

### Fase 1a — Auth & Payment Types ✅
- Migration 011: payment_types-tabel + users.password_hash
- bcrypt, express-session, connect-sqlite3
- routes/auth.js — login (email+pw + PIN auto-detect), logout, me
- routes/payment_types.js
- shared/auth.js — requireAuth(role) middleware
- shared/login.html — fælles login, auto-detect (cifre→PIN, @→email+pw)
- shared/utils.js — checkAuth() guard i alle views
- Seed: admin@ristetrug.dk + kitchen@ristetrug.dk (PIN 1234)
- Session-varighed per rolle i settings (kitchen=365 dage)

### Fase 1b — Kunde/firma-søgekomponent ✅
- GET /api/customers?q= med firma-join
- POST /api/customers
- routes/companies.js (GET, GET/:id, POST)
- routes/cvr.js — GET /api/cvr/:cvr + søgning
- shared/kunde_soeg.js — 5 states, CVR-opslag, to-trins opret
- shared/kunde_soeg.css

### Fase 1c — Bon-opret modal + Drawer 🔧 I gang
- routes/price_categories.js
- routes/addresses.js
- PATCH /api/bons/:id (per-felt changelog + SSE)
- shared/bon_opret_modal.js — hurtig opret (kunde, dato, tid, type, pax, priskategori)
- shared/bon_drawer.js — fuld redigering, URL-sync (?bon=ID), dirty-tracking
  - Status-bar, levering, DAWA-adresse, kunde, køkken, firma, 4 noter
  - VARER-sektion med linjeliste + VarePicker
- Monteret i office/index.html + kitchen/calendar.html

### Fase 1d — Webhook + VarePicker ✅ (spec klar til Simon)
- routes/webhooks.js — POST /api/webhooks/bestilling
  - Honeypot, find/opret firma+kunde, EAN-udtræk, DAWA-parsing, bon NY
  - FIELD_MAP-konstant øverst — klar til dynamisk mapping i Fase 1e
- tools/bestilling_v2.html — f11 kontaktperson + f12 faktura/EAN
- shared/vare_picker.js — refaktoreret fra bon_kort.js
  - Bruges i bon_kort.js + bon_drawer.js
- shared/api.js — deleteBonLine()

### Fase 1e — Settings UI 🔲 (stub klar)
Se CLAUDE_FASE1E.md. Indeholder:
- Brugerstyring (opret, rediger, PIN-skift)
- Priskategorier + betalingstyper (labels)
- Session-varighed per rolle
- Grocy-konfiguration per lokation
- Mail-skabeloner
- Formbuilder integreret i settings (feltmapping dynamisk)

### Fase 3a — Office Listview 🔲 (spec klar)
Se CLAUDE_FASE3A.md. Indeholder:
- GET /api/bons udvidet (status_color, customer_name, company_name, unread_mail_count, delivery_event)
- Bonnummer-søgning fra start ved kun cifre
- Fem filtre: I DAG / NY / ULÆST MAIL / Dato / Alle
- To-linje rækkelayout med firma + bud-tidspunkt
- Kolonnevælger med localStorage
- Sortering på alle kolonner
- SSE in-place opdatering
- Responsiv (mobil < 768px)
- Belastningsoverblik ved dato-filter

---

## Køkken — view-status

| View | Status |
|------|--------|
| kitchen/today.html | ✅ Done |
| kitchen/later.html | ✅ Done |
| kitchen/calendar.html | ✅ Done |
| kitchen/index.html — Dashboard | 🔲 |
| Kategori-overblik | 🔲 |
| kitchen/recipes.html — Opskrifter | 🟡 Prototype |
| kitchen/stock.html — Lager | 🟡 Prototype |
| kitchen/goods-receipt.html — Varemodtagelse | 🟡 Prototype (mockup v2 klar) |
| kitchen/purchasing.html — Indkøbsliste | 🔲 |
| kitchen/orders.html — Bestilling | 🔲 |
| consumeRecipe() trigger ved LEVERET | 🔲 |
| SMTP udgående mail | 🔲 |

---

## Åbne beslutninger / afventer

| Punkt | Status |
|-------|--------|
| Ny server deployment (Hetzner/DO + Nginx + SSL) | ⏳ Planlægges |
| Datamigration Bon v1 → v2 (SQLite → SQLite) | ⏳ Planlægges |
| Formbuilder webhook-URL sat + HTML publiceret | ⏳ Afventer 1c done |
| Byekspressen credentials (sebastian@by-expressen.dk) | ⏳ Afventer Martin Ross |
| Virk ElasticSearch credentials | ⏳ Afventer erst.dk |
| Office kalender: fane i listview eller separat sidebar-punkt? | ❓ Ikke besluttet |

---

## Specfiler produceret i denne session

| Fil | Indhold |
|-----|---------|
| CLAUDE_FASE1A.md | Auth + payment_types migration |
| CLAUDE_FASE1B.md | Kunde/firma-søgekomponent |
| CLAUDE_FASE1C.md | Bon-opret modal + drawer |
| CLAUDE_FASE1D.md | Formbuilder webhook + VarePicker refaktorering |
| CLAUDE_FASE1E.md | Settings UI (stub) |
| CLAUDE_FASE3A.md | Office listview |
| BON_V2_HUSKELISTE.md | Visuelle krav + domæneviden til senere |
| bestilling_v2.html | Opdateret formular med f11 kontaktperson + f12 faktura/EAN |
