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
| Database | SQLite via `node:sqlite` (indbygget Node 22+) |
| Frontend kitchen | Vanilla HTML/CSS/JS (MPA) |
| Frontend office | Vanilla JS + selektiv Vue.js |
| Realtid | SSE — aldrig polling, aldrig WebSockets |
| Styling | Vanilla CSS med tokens fra `shared/tokens.css` |

**Ingen React, ingen Tailwind, ingen Python, ingen ORM, ingen build-step, ingen native npm-pakker.**

---

## Grocy-instans

Under udvikling bruges **grocytest** (`https://grocytest.ristetrug.dk/api`).
Skift til produktion (`grocycafe`) sker først ved release.

`default_grocy_location_id = 3` (Test) i settings-tabellen styrer dette.
Lokationer defineres i `locations`-tabellen: HQ=grocycafe, Trailer=grocytrailer, Test=grocytest.

**Smartplan:** OAuth2 via `SMARTPLAN_CLIENT_ID` + `SMARTPLAN_CLIENT_SECRET` i `.env`.
API base: `https://api.smartplanapp.io/v2`. Token-endpoint: `/o/token/`.

**Mail:** 2 SMTP-transports + 2 IMAP-mailboxes via Simply.com (port 993, implicit TLS):

| Transport | Afsender | Bruges til | `.env`-variable |
|-----------|----------|------------|-----------------|
| `smtp` (bon@) | bon@ristetrug.dk | Ordrebekræftelser, bon-relateret mail | `SMTP_PASSWORD` |
| `smtp_kontakt` (kontakt@) | kontakt@ristetrug.dk | Leverandør-bestillinger, CRM-mail | `SMTP_KONTAKT_PASSWORD` |

Mail-skabeloner i `mail_templates`-tabellen:
- `booking_confirmation` — ordrebekræftelse til kunde ({{kundeNavn}}, {{bonNummer}}, ...)
- `order_email` — bestilling til leverandør ({{leverandoer}}, {{vareliste}}, {{leveringsdato}})

`smtpPrefix`-parameter i `sendMail()` styrer transport: `'smtp'` = bon@, `'smtp_kontakt'` eller `'kontakt'` = kontakt@.
IMAP polling hvert 5. minut — router mails via `#B{num}` og `#K{num}` tags i emne.

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
│   ├── kitchen.js    ← GET /api/bons/today, /later, /calendar  (monteres FØR bons.js)
│   ├── bons.js       ← /api/bons/* (CRUD, status, lines, changelog, notifications)
│   ├── statuses.js   ← /api/statuses/*
│   ├── customers.js  ← /api/customers/*
│   ├── settings.js   ← /api/settings/*
│   ├── notifications.js ← /api/notifications/*
│   ├── smartplan.js  ← /api/smartplan/* (shifts, employees)
│   ├── auth.js       ← /api/auth/* (login, pin, logout, me)
│   ├── payment_types.js ← /api/payment-types
│   ├── price_categories.js ← /api/price-categories
│   ├── addresses.js  ← /api/addresses (POST)
│   ├── webhooks.js   ← /api/webhooks/bestilling (ingen auth)
│   ├── attachments.js ← /api/attachments (upload/download)
│   ├── users.js      ← /api/users (admin CRUD)
│   ├── mail.js       ← /api/mail/* (admin, skabeloner + test)
│   ├── dashboard.js  ← /api/dashboard/* (today, stats, top-products, weather)
│   ├── invoices.js   ← /api/invoices/queue (fakturerings-arbejdsliste)
│   ├── horkram.js    ← /api/horkram/* (Hørkram API proxy: basket, search, orders)
│   ├── purchasing.js ← /api/purchasing/* (suppliers, grocy-locations CRUD)
│   ├── orders.js     ← /api/orders/* (purchase_orders CRUD + mail-tråd per PO)
│   ├── receiving.js  ← /api/receiving/complete (legacy fusion-endpoint, bruges ikke af ny varemodtagelse)
│   ├── goods-receipts.js ← /api/goods-receipts/* (varemodtagelse v3: FVST + lager)
│   └── staff.js      ← /api/staff/* (medarbejder-CRUD)
├── services/
│   ├── grocyAdapter.js       ← Grocy API adapter med cache + CRUD + consume + barcodes
│   ├── hokaAdapter.js        ← Hørkram (hoka.dk) API adapter med cookie-jar auth
│   ├── ingredientResolver.js ← Rekursiv ingrediens-opløsning inkl. underopskrifter
│   ├── smartplanAdapter.js   ← Smartplan OAuth2 adapter (shifts + worklogs + employees)
│   ├── mailService.js        ← SMTP afsendelse + IMAP polling + tag-routing
│   ├── goodsReceiptWebhook.js ← Whiteboard webhook for varemodtagelse (fire-and-forget)
│   └── quConvert.js          ← Grocy quantity unit conversions
├── db/
│   ├── database.js      ← getDb() singleton (lazy init + migrations)
│   ├── compat.js        ← openDb() wrapper + transaction() helper (node:sqlite kompatibilitet)
│   ├── session-store.js ← Express session store baseret på node:sqlite
│   ├── helpers.js       ← logChange, handle, getBon, getBonLines, getStatusId, nextBonNumber, auth-helpers
│   ├── migrate.js       ← Kører migrations fra db/migrations/
│   ├── seed.js          ← Testdata (11 bons, 7 kunder, 5 firmaer)
│   └── migrations/      ← 001_core.sql, ...
├── shared/
│   ├── sse.js        ← SSE router + broadcast(), sendTo() — named events
│   ├── tokens.css    ← Design tokens
│   ├── components.css
│   ├── bon_kort.js          ← Adfærd og state (status, DnD, select, groups, editing)
│   ├── bon_kort_builder.js  ← DOM-bygning (createCard, VIEW_MODULES, VIEW_ACTIONS, _build*)
│   ├── bon_kort.css
│   ├── calendar.js + calendar.css  ← Kalender/liste komponent
│   ├── planning.js + planning.css  ← Planlægningsbon (aggregering, vagtplan, action-knapper)
│   ├── flyver.js + flyver.css      ← Nødbesked-system
│   ├── modal.js + modal.css        ← Genbrugelig modal (historik, info, råvarer)
│   ├── vare_picker.js + vare_picker.css ← Standalone VarePicker (bruges i kort + drawer)
│   ├── bon_opret_modal.js + bon_opret_modal.css ← Hurtig bon-oprettelse
│   ├── bon_drawer.js + bon_drawer.css   ← Bon-detalje drawer (fuld redigering)
│   ├── kunde_soeg.js + kunde_soeg.css   ← Kunde/firma-søgekomponent
│   ├── dashboard_chart.js + dashboard_chart.css ← Custom canvas legoklods-chart
│   ├── recipe_viewer.js + recipe_viewer.css    ← Opskrift-browser (ingredienser, consume)
│   ├── recipe_designer.js + recipe_designer.css ← Opskrift-editor (CRUD mod Grocy)
│   ├── stock_overview.js + stock_overview.css  ← Lageroversigt (filtre, status-pills, inline-edit)
│   ├── inventory_check.js + inventory_check.css ← Fysisk optælling (multi-unit, progress, summary)
│   ├── indkob.js + indkob.css                  ← Indkøb (merged: indkøbsliste + bestilling, accordion UI)
│   ├── indkob_settings.js + indkob_settings.css ← Indkøbsindstillinger (3 tabs: leverandører, produkter, Hørkram)
│   ├── varemodtagelse.js + varemodtagelse.css  ← Varemodtagelse v3 (fødevarekontrol + Grocy lager, touch-first)
│   ├── supplier_inbox.js                      ← Leverandørpost (office sidebar-view + kitchen Post-tab)
│   ├── kitchen-topbar.html         ← Fælles topbar for kitchen-views
│   ├── api.js        ← Frontend API-funktioner
│   ├── utils.js      ← Status-mapping, connectSSE(), mapApiBonToCardData(), scrollToBonHash()
│   ├── auth.js       ← requireAuth() middleware (server-side)
│   └── login.html    ← Fælles login-side (PIN + email auto-detect)
├── kitchen/          ← MPA: index.html, today.html, later.html, vagtplan.html, ...
├── office/           ← SPA-shell: index.html + views/*.js
├── mobile/           ← Mobil-shell: index.html + views/*.js (touch-first, bottom nav)
│   ├── index.html    ← Shell + 5-tab bottom nav + view-router
│   ├── login.html    ← PIN-pad login (bruger-vælger → PIN)
│   ├── manifest.json ← PWA manifest (standalone)
│   ├── mobile.css    ← Mobilspecifik CSS
│   └── views/        ← bons.js, modtag.js, crm.js, oversigt.js
├── settings/         ← index.html (eget shell)
├── assets/           ← logo.svg, icons/, fonts/
├── scripts/
│   ├── set-password.js        ← Sæt password for bruger (engangsbrug)
│   ├── sync-v1.js             ← Daglig sync fra Bon v1 (cron)
│   ├── merge-ean-duplicates.js ← Merger firmaer med samme EAN
│   ├── enrich-cvr.js          ← CVR-berigelse via Virk ES + NemHandel
│   └── fix-cvr.js             ← Manuel CVR-rettelse
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
- **Standalone scripts bruger `openDb()`** fra `db/compat.js` — aldrig `DatabaseSync` direkte
- **Transactions via `transaction(db, fn)`** — aldrig `db.transaction()` (eksisterer ikke i node:sqlite)
- **`logChange({...})`** — objekt-API, aldrig positionelle argumenter
- **Nye npm-pakker kræver godkendelse** — spørg først, og ingen native/compiled pakker

---

## Grocy userfields (skal oprettes manuelt i Grocy)

Disse userfields skal eksistere i Grocy for at systemet fungerer korrekt.
Oprettes under Grocy → Manage master data → Userfields.

### product_barcodes (entity: product_barcodes)

| Userfield | Type | Bruges af | Beskrivelse |
|-----------|------|-----------|-------------|
| `is_agreement_item` | text_single_line | Indkøb (chips) | `'1'` = aftalepris. Sættes af Hørkram scraper eller fra live snapshot. Aftale-chips sorteres fremfor billigste. |
| `pack_size_stock_unit` | text_single_line | Indkøb (beregning, fallback) | Pakke-størrelse i stock-enhed (kg). Fallback når live snapshot ikke er tilgængeligt. |
| `supplier_unit_code` | text_single_line | Indkøb → Hoka kurv | Hokas salesUnit code (fx `'ks'`, `'st'`). Bruges ved PUT /api/horkram/basket/add. Sættes ved barcode-kobling. |
| `supplier_unit_qty` | text_single_line | Indkøb → Hoka kurv | Antal base-enheder pr. salesUnit. Bruges sammen med supplier_unit_code. |
| `is_preferred` | text_single_line | Indkøb (chip-sortering) | `'1'` = foretrukken leverandør for dette produkt. Vises med lilla "Foretrukket" badge. Sorteres allerførst — før aftale og pris. |
| `hk_scraped_at` | text_single_line | Hørkram scraper | ISO timestamp for seneste scraping af denne barcode. |

### recipes (entity: recipes)

| Userfield | Type (Grocy) | Bruges af | Beskrivelse |
|-----------|-------------|-----------|-------------|
| `grupper` | preset-checklist | Opskrifter, VarePicker | Kategori/gruppe (fx "01 Sandwich", "02 Salat") |
| `recipeunit` | preset-checklist | Opskrifter | Opskrift-enhed (stk, portion) |
| `recipeunitnumber` | number-decimal | Opskrifter | Antal enheder pr. opskrift |
| `SalespriceStore` | number-decimal | VarePicker | Salgspris butik |
| `SalespriceCatering` | number-decimal | VarePicker | Salgspris catering |
| `SalespriceFestival` | number-decimal | VarePicker | Salgspris festival |
| `SalespriceProduktion` | number-integral | VarePicker | Salgspris produktion |
| `SalespriceWaiste` | number-integral | VarePicker | Salgspris waiste |
| `sellable` | checkbox | VarePicker | Salgbar (vises i picker) |
| `sellableZettle` | checkbox | POS | Salg via Zettle |
| `Co2e` | number-decimal | VarePicker | CO2-aftryk per enhed |
| `costprice` | number-decimal | VarePicker | Kostpris (fallback — primært bruges Grocy fulfillment `costs`) |
| `Oeko` | checkbox | VarePicker | Økologisk markering |

### products (entity: products)

| Userfield | Type (Grocy) | Bruges af | Beskrivelse |
|-----------|-------------|-----------|-------------|
| `HverDag` | text-single-line | Lageroptælling | Interval i dage for check-frekvens |
| `LastCheckedAt` | datetime | Lageroptælling | ISO timestamp for sidst-tjekket |
| `LastCheckedUnit` | text-single-line | Lageroptælling | Hvilken fysisk enhed der sidst blev talt |
| `Co2e` | number-decimal | VarePicker | CO2-aftryk per enhed |
| `supplier_price_per_kg` | text_single_line | Hørkram scraper | Indkøbspris pr. kg fra leverandør |
| `price_updated_at` | text_single_line | Hørkram scraper | Timestamp for prisopdatering |
| `hk_organic` | text_single_line | Hørkram scraper | Økologisk status fra Hørkram |
| `hk_country` | text_single_line | Hørkram scraper | Oprindelsesland fra Hørkram |
| `hk_allergens` | text_single_line | Hørkram scraper | Allergener fra Hørkram |

### shopping_list (entity: shopping_list)

| Userfield | Type | Bruges af | Beskrivelse |
|-----------|------|-----------|-------------|
| `ordered_at` | text_single_line | Bestilling | ISO timestamp for hvornår varen blev bestilt |
| `ordered_qty` | text_single_line | Bestilling | Bestilt antal |
| `ordered_supplier` | text_single_line | Bestilling | Leverandørnavn |
| `ordered_varenr` | text_single_line | Bestilling | Leverandørens varenummer |

---

## Status på hvad der er bygget

### Blok A — Fundament
- [x] Status-flow defineret
- [x] Datamodel finaliseret (bon_v2_datamodel_v2.md)
- [x] SQLite database oprettet med migrations (`db/migrations/001_core.sql`)
- [x] Seed data (11 bons over 5 dage, 7 kunder, 5 firmaer, blandede statusser)

### Blok B — Kerne-backend
- [x] Migrations 001–010 (core, bons, events, crm, purchasing, views, kitchen_transitions, price_category, notification_client_reads, smartplan_settings)
- [x] Backend refaktoreret: `server.js` → `routes/` + `db/` + `shared/sse.js`
- [x] `db/database.js` — `getDb()` singleton med lazy init + auto-migrations
- [x] `db/helpers.js` — `logChange`, `handle`, `getBon`, `getBonLines`, `getStatusId`, `nextBonNumber`
- [x] `shared/sse.js` — Named events, multi-client, heartbeat, `broadcast()` + `sendTo()`
- [x] `routes/kitchen.js` — GET /api/bons/today, /later, /calendar
- [x] `routes/bons.js` — CRUD, status (m/ triggers_json stub), prep, kitchen-info, lines, changelog, notifications
- [x] `routes/statuses.js` — GET statuses + transitions
- [x] `routes/customers.js` — GET customers
- [x] `routes/settings.js` — GET/PATCH settings
- [x] `routes/notifications.js` — GET /api/notifications/unread
- [x] `routes/smartplan.js` — GET /api/smartplan/shifts, /employees, DELETE /cache
- [x] Grocy adapter (readonly) — `services/grocyAdapter.js` + `routes/grocy.js`
- [x] Smartplan adapter — `services/smartplanAdapter.js` (OAuth2, shifts + worklogs)
- [x] `services/quConvert.js` — Grocy quantity unit conversions

### Blok C — Første views
- [x] kitchen/today.html — Køkken I dag (fuldt dynamisk)
- [x] kitchen/later.html — Køkken Senere (fuldt dynamisk)
- [x] Kalender-view (shared) — `kitchen/calendar.html` + `shared/calendar.js` + `shared/calendar.css`

### Shared komponenter
- [x] `shared/bon_kort.js` + `shared/bon_kort_builder.js` + `shared/bon_kort.css` — Bon-kort komponent (splittet: builder = DOM-bygning, bon_kort = adfærd/state)
  - Status-bar med klikbare knapper (styret af VIEW_WINDOWS i BonConfigBar.js)
  - Prep-checks (Råvarer / Emballage badges)
  - Kunde-sektion med fold-ud detaljer
  - Køkkeninfo pill (lukket: viser tekst + ✎, klik åbner inline textarea, Gem/Annuller)
  - Menu-liste med grupper (select-mode → vælg items → Gruppér → titel + note)
  - Drag-and-drop af grupper og items
  - Leveret-fading med fortryd-overlay (8s countdown)
  - Sammentællings-panel
  - Action-bar med modulære knapper
- [x] `shared/calendar.js` + `shared/calendar.css` — Kalender/liste komponent
  - Månedsoversigt med 8-kolonne grid (uge + man–søn + total)
  - Liste-view med sortérbare kolonner (toggle med localStorage)
  - Status-filtre fra BonConfig (toggle on/off)
  - Workload-totaler per dag/uge (`total_units > 0 ? units : pax`)
  - Smartplan bemanding: kompakt `👤 N` badge med tooltip (tid + fornavn)
  - Bon-klik → info-modal med "Gå til bon →" navigation
  - SSE realtidsopdatering
  - Graceful degradation uden Smartplan
  - Søgefelt i liste-view (bon#, kunde, firma)
- [x] `shared/utils.js` — Status-mapping, dato-formattering, `connectSSE()` (named events), `mapApiBonToCardData()`, `scrollToBonHash()`, `getClientId()`, `checkAuth()`
- [x] `shared/api.js` — API-funktioner (fetch, patch status/prep/kitchen-info, flyver)
- [x] `shared/flyver.js` + `shared/flyver.css` — Flyver-system (urgente beskeder)
  - `sendFlyver(cardId)` — send-modal med textarea
  - `initFlyverBanner()` — globalt blinkende rødt banner for ulæste flyvere
  - `handleFlyverSSE(data)` — realtid via SSE, afsender ekskluderes
  - Detail-modal med bon-data, navigation mellem køede flyvere, "Forstået"-kvittering
  - Auto-kvittering for afsender (server-side)
  - `getClientId()` — UUID i localStorage som midlertidig identitet (fremtidskompatibel med auth)
- [x] `shared/modal.js` + `shared/modal.css` — Genbrugelig modal-komponent
  - `openModal({ title, bodyHtml })` / `closeModal()` API
  - Luk med ×, overlay-klik eller Escape
  - `showHistorik(cardId)` — henter changelog via API, viser formateret med danske labels
  - `showBonInfo(cardId|bonId, opts)` — fuld bon-detalje med kunde, linjer, priser (moms-beregning)
    - Fra kalender: `showBonInfo(bonId, { showGotoButton: true })` → navigerer til today/later + scroll-highlight
  - `showRavarer(cardId)` — ingrediensbehov med lagerstatus fra Grocy
    - Grupperet efter Grocy `ingredient_group` (Emballage sidst)
    - Status-dots (🔴 mangler / 🟡 lav / 🟢 ok) per ingredient
    - Søgefelt til filtrering
    - Indkøbsliste-knap (🛒) — tilføjer til Grocy shopping_list i purchase-enhed
    - `recipes_pos.amount` er i stock-unit, konverteres stock→display via `quantity_unit_conversions`
- [x] `shared/kitchen-topbar.html` — Fælles topbar for kitchen-views (logo, nav, kalender-link)
- [x] `shared/tokens.css` — Design tokens (farver, spacing, typografi)
- [x] `shared/components.css` — Fælles komponent-styles
- [x] `shared/auth.js` — `requireAuth()` middleware (server-side, rolle-baseret)
- [x] `shared/login.html` — Fælles login-side (PIN + email/password auto-detect, rolle-baseret redirect)
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

### kitchen/calendar.html — Features
- Kalender-view: månedsoversigt med bons på datoer (8-kolonne grid: uge + man–søn + total)
- Liste-view: sortérbar tabel med alle bons i måneden (toggle via localStorage)
- Status-filtre: farvede knapper fra BonConfig, toggle on/off
- Workload-totaler per dag og uge (bruger `total_units` hvis > 0, ellers `pax`)
- Smartplan-integration: `👤 N` badge per dag med hover-tooltip (navne + vagttider)
- Bon-klik åbner info-modal med "Gå til bon →" knap
- "Gå til bon →" navigerer til today.html (i dag/fortid) eller later.html (fremtid), scroller til bon og highlighter med 4s puls-animation
- Måned-navigation ◀/▶
- I dag markeret med outline
- Dage uden for måneden dæmpet
- SSE realtidsopdatering
- API: `GET /api/bons/calendar?year=&month=&status=`
- Smartplan adapter: `services/smartplanAdapter.js` + `routes/smartplan.js`
  - OAuth2 auth (client_credentials grant) med token-cache
  - Kombinerer `/shifts/` (fremtidige) + `/worklogs/` (arkiverede) for fuld dækning
  - Normalisering: `owner.first_name/last_name`, `jobtype.title`, `location.title`

### Fase 1a — Auth & Payment Types
- [x] Migration 011: `payment_types`-tabel + `users.password_hash`
- [x] npm: bcryptjs, express-session (ingen native pakker)
- [x] Session-middleware i `server.js` (SQLiteStore → `db/sessions.db`)
- [x] `routes/auth.js` — POST login (email+pw), POST pin, POST logout, GET me
- [x] `routes/payment_types.js` — GET /api/payment-types
- [x] `shared/auth.js` — `requireAuth(role)` middleware
- [x] `db/helpers.js` — hashPassword, verifyPassword, getUserByEmail, getUserById
- [x] `shared/login.html` — Fælles login med auto-detect (cifre→PIN, @→email+password)
- [x] `shared/utils.js` — `checkAuth()` auth-guard
- [x] Auth-guard i alle views: kitchen/today, kitchen/later, kitchen/calendar, office
- [x] `scripts/set-password.js` — CLI-script til at sætte passwords
- [x] Seed-brugere: Admin (admin@ristetrug.dk) + Køkken (kitchen@ristetrug.dk, PIN 1234)
- [x] Session-varighed konfigurerbar per rolle via settings

### Fase 1b — Kunde/firma-søgekomponent
- [x] `GET /api/customers?q=` udvidet med firma-join (company_name, cvr, payment_type, price_category)
- [x] `POST /api/customers` — opret ny kunde
- [x] `routes/companies.js` — GET `/`, GET `/:id`, POST `/`
- [x] `routes/cvr.js` — GET `/api/cvr/:cvr` (CVR-opslag) + GET `/api/cvr/search?q=` (søg på firmanavn)
- [x] `shared/kunde_soeg.js` — Genbrugelig søgekomponent med 5 states (IDLE, SEARCHING, RESULTS, SELECTED, CREATING)
  - Live-søgning med debounce (250ms, min 2 tegn)
  - Resultater med firma + kontaktperson
  - Valgt kunde som pill med ✕-knap
  - Opret ny: to-trins flow (Firma → Kontakt) med CVR-opslag
  - Privatkunde-checkbox (springer firma-trin over)
  - `onSelect` callback med customer_id, company_id, payment_type etc.
- [x] `shared/kunde_soeg.css` — Styling med designsystem-tokens
- [x] `office/test-kunde-soeg.html` — Testside

### Fase 1c — Bon-opret modal + Bon-detalje drawer
- [x] `routes/price_categories.js` — GET /api/price-categories
- [x] `routes/addresses.js` — POST /api/addresses
- [x] `routes/bons.js` — PATCH /:id (alle felter, per-felt changelog) + SSE broadcast på POST
- [x] `shared/bon_opret_modal.js` + CSS — Hurtig bon-oprettelse (kunde, dato, tid, type, pax, priskategori)
- [x] `shared/bon_drawer.js` + CSS — Fuld redigering af bon i drawer fra højre
  - Status-bar, levering (dato/tid/type/DAWA-adresse), kunde (KundeSoeg), dagskontakt
  - Køkken (pax, enheder, priskategori, betaling), firma, noter (4 textareas)
  - Dirty-tracking, confirm ved ugemte ændringer, URL-sync (?bon=ID)
  - SSE realtidsopdatering (bon_updated, bon_status)
- [x] Monteret i office/index.html + kitchen/calendar.html
- [x] "Rediger" knap i kalender info-modal → åbner drawer

### Fase 1d — Formbuilder webhook + VarePicker refaktorering
- [x] `routes/webhooks.js` — POST /api/webhooks/bestilling (altid 200)
  - Honeypot-tjek, påkrævede felter (f2, f7_date, f7_time)
  - Find/opret firma + kunde (email-match)
  - EAN-udtræk fra f12 (13 cifre via regex)
  - DAWA-adresse parsing fra validatedAddress JSON
  - Bon-oprettelse med status NY, changelog + SSE broadcast
  - Dagskontakt (f11_navn/f11_tlf → day_contact_name/day_contact_phone)
- [x] `tools/bestilling_v2.html` — f12 textarea tilføjet (Faktura info / EAN)
- [x] `shared/vare_picker.js` + CSS — Standalone VarePicker klasse
  - Refaktoreret fra inline picker i bon_kort.js (~280 linjer fjernet)
  - Constructor: `{ bonId, priceCategory, container, viewName, onAdded }`
  - Recipe fetch + cache, kategori-navigation, item-selection, expand-form, POST
  - Bruges i bon_kort.js (lazy VarePicker-instanser) + bon_drawer.js (VARER-sektion)
- [x] Drawer: VARER-sektion med linjeliste, "+ Tilføj vare" knap, slet-linje
- [x] `db/helpers.js` — getBon() joiner price_categories for price_category_code
- [x] `shared/api.js` — deleteBonLine() tilføjet
- [x] Smartplan-loading gjort asynkron i kalender (renderes bagefter)

### Fase 3A — Office Listview
- [x] `routes/bons.js` — GET /api/bons udvidet med server-side filtre, sortering, pagination
  - Kommasepareret status-filter, `date=today` special case, smart search (cifre→prefix, tekst→contains)
  - SORT_WHITELIST mod SQL injection, `unread_mail=1` filter
  - Nye joins: price_categories, subqueries for unread_mail_count + latest_delivery_event
  - Nye felter: delivery_time, courier_arrival_time, total_price, payment_type, delivery_method, etc.
- [x] `office/views/bons-list.js` — Komplet listview-komponent
  - Mutex-filtre: I DAG (default), NY, ULÆST MAIL, Dato-picker, Alle
  - Debounced søgning (300ms), ESC rydder
  - Kolonnevælger med localStorage persistens
  - Sortering via header-klik med localStorage persistens
  - To-linje rækker (kunde+firma, bon#+status med rowspan)
  - Pax/Enheder kombineret kolonne ("25 / 60 enh.")
  - Bud-kolonne med leveringsmetode-ikon (🚲/🚕/🚛/🏠) + budtidspunkt, hover viser label
  - Belastningsoverblik for enkelt-dags views
  - Smartplan bemanding (async, non-blocking) for I DAG og dato-filter
  - SSE: bon_created/bon_updated → re-fetch
  - Klik → åbner BonDrawer
- [x] `office/index.html` — Monteret listview, CSS, SSE-handlers, Settings-link + Log ud-knap i topbar

### Fase 1e — Settings UI + Mail
- [x] Migration 013: `mail_templates`, `customer_mails`, `bon_mails.matched_by`, settings seed (SMTP/IMAP/signatur/formbuilder/session)
- [x] Migration 014: SMTP kontakt@ settings seed
- [x] npm: nodemailer, imapflow
- [x] `services/mailService.js` — SMTP afsendelse (2 transports: bon@ + kontakt@) + IMAP polling + tag-routing (#B/#K)
  - `parseTag(subject)` — regex for `#B{num}` og `#K{num}`
  - `renderTemplate(body, vars)` — `{{variabel}}` substitution + signatur
  - `sendMail({ to, subject, bodyText, bonId, smtpPrefix })` — SMTP send, gem i bon_mails
  - `sendFromTemplate({ templateKey, to, vars, bonId })` — skabelon-baseret afsendelse
  - `pollMailbox(config)` — IMAP polling, route via tags til bon_mails/customer_mails
  - `startPolling()` — interval-baseret polling for bon@ og kontakt@
- [x] `routes/users.js` — CRUD (admin-only): GET/POST/PATCH + POST password
- [x] `routes/mail.js` — Mail-skabeloner (admin-only): GET/PATCH templates + POST test
- [x] `routes/price_categories.js` — Udvidet med POST/PATCH (admin-only)
- [x] `routes/payment_types.js` — Udvidet med POST/PATCH (admin-only)
- [x] `routes/webhooks.js` — DEFAULT_FIELD_MAP eksport
- [x] `routes/settings.js` — GET /api/settings/locations
- [x] `server.js` — Mount /api/users, /api/mail + startPolling()
- [x] `shared/api.js` — 14 nye funktioner (users, mail, settings, price-cats, pay-types, locations)
- [x] `settings/index.html` — Fuld Settings UI med 7 sektioner:
  - Brugere (CRUD, rolle, aktiv-toggle, password)
  - Priskategorier (label-redigering, opret ny)
  - Betalingstyper (label-redigering, opret ny)
  - Grocy (read-only lokationer, test-forbindelse)
  - Mail (2× SMTP: bon@ + kontakt@, 2× IMAP, signatur, skabelon med variabel-tags, test-mail)
  - Formbuilder (feltmapping redigering, nulstil til standard)
  - System (6 nøgler: company_name, bon_number_prefix/next, pax_per_box, session_duration)
- [x] `.env` / `.env.example` — SMTP_PASSWORD, SMTP_KONTAKT_PASSWORD, IMAP_BON_PASSWORD, IMAP_KONTAKT_PASSWORD

### Fase 3B — Dashboards
- [x] `routes/dashboard.js` — Dashboard API med 3 endpoints:
  - `GET /api/dashboard/today` — dagsoverblik, totals, categories, alerts, prep, MTD KPIs
  - `GET /api/dashboard/stats` — individuelle bons per dag for legoklods-chart, forrige-år data, Smartplan shifts
  - `GET /api/dashboard/top-products` — top produkter MTD (enheder + kr)
- [x] `shared/dashboard_chart.js` — Custom canvas legoklods-chart (erstattet Chart.js)
  - `initDashboardChart()` — søjlediagram med individuelle bon-bricks, hover-tooltip, touch-support
  - `initAccumChart()` — akkumuleret area chart under søjlediagram
  - `buildStaffBadges()` — Smartplan medarbejder-badges under chart
  - `buildChartLegend()` — kategori-legend
  - Enheder/Kr toggle, forrige-år dashed overlay, i dag highlight
- [x] `shared/dashboard_chart.css` — Chart styling (canvas, staff badges, tooltip, toggle, prod-table)
- [x] `kitchen/index.html` — Komplet redesign:
  - 2-kolonne grid: venstre (I dag + Prep), højre (chart 260px + 3×2 nav-kort grid)
  - Brun topbar med logo, dato, vagt-pills, vejr, vagtplan-badge
  - Open-Meteo vejr-integration (ingen API-nøgle)
  - SSE realtidsopdatering
- [x] `kitchen/vagtplan.html` — Ny side: ugeoversigt med Smartplan-vagter
  - 7-kolonne grid, uge-navigation, auth-beskyttet
  - Bruger `/api/smartplan/shifts` API
- [x] `office/views/dashboard.js` — Komplet redesign:
  - KPI strip (Omsætning MTD, Enheder MTD, Åbne bons, Ufaktureret) med YoY delta
  - Legoklods-chart med Enheder/Kr toggle + forrige-år overlay + akkumuleret chart
  - Top produkter tabel, I dag + Prep cards, CRM panels (Ring tilbage + Seneste aktivitet)
  - Topbar: dato + vagt-pills + vejr
- [x] `office/index.html` — Dark sidebar med nav-grupper, Chart.js CDN fjernet

### Ingrediens-resolver (underopskrifter)
- [x] `services/ingredientResolver.js` — Delt service for ingrediens-aggregering
  - Rekursiv opløsning af underopskrifter via Grocy `recipes_nestings`
  - `collectSubRecipeIngredients()` mønster fra bontools recipe-viewer
  - Visited-set forhindrer cirkulære referencer
  - Bruges af både `GET /api/bons/:id/ingredients` og `GET /api/bons/planning/ingredients`
  - **To niveauer** returneres i ét kald: `{ production, raw }`
    - Produktion: direkte ingredienser + underopskrifter som kompakte rækker (beregnet vægt i gram)
    - Råvarer: alt fladt — underopskrifters ingredienser rekursivt opløst
  - Bagudkompatibelt: `ingredients`/`groups` på top-level = raw-niveau
- [x] `services/grocyAdapter.js` — `getRecipeNestings()`, `getRecipesRawMap()` tilføjet
- [x] Duplikeret aggregeringslogik fjernet fra `routes/bons.js` + `routes/kitchen.js`
- [x] `shared/modal.js` — Råvarer-modal med toggle: 🔧 Produktion / 📦 Råvarer
  - Segmented control, default Produktion
  - Underopskrifter vises som gyldne rækker med navn + vægt
  - Toggle re-renderer uden ny API-kald
  - Virker i både enkelt-bon og planlægnings-råvarer

### UI-rettelser (marts–april 2026)
- [x] Flyver-banner z-index fikset (blokerede ikke længere topbar-navigation)
- [x] Kalender statusfiltre: toggle én ad gangen (ikke eksklusivt), fyldte farver=aktiv, gennemsigtig=inaktiv
- [x] "Ny bon"-knap flyttet fra topbar til kalender/liste view-specifik placering
- [x] Dashboard topbar: vagt-pills fjernet (vises allerede i vagtplan-kort)
- [x] Dashboard: "Åbn vagtplan →" link i stedet for Smartplan-link
- [x] Seed-data udvidet med flere bons for bedre test-dækning
- [x] Gradient på kitchen dashboard gjort lysere
- [x] `shared/bon_kort.js` splittet → `bon_kort_builder.js` (DOM) + `bon_kort.js` (adfærd)
- [x] Vagtplan: pills viser kun fornavn (ikke fuldt navn), jobtype-label fjernet
- [x] CRM Kunde 360°: sentiment-valg synligt for alle aktivitetstyper (ikke kun opkald)
- [x] IMAP-porte rettet fra 143 → 993 i settings (Simply.com kræver implicit TLS)

### Fase 3D — Planlægningsbon
- [x] `GET /api/bons/planning?from=&to=&status=` — bons med inline lines for client-side aggregering
- [x] `GET /api/bons/planning/ingredients?ids=` — merged ingrediensbehov for flere bons i ét kald
- [x] `shared/planning.js` + `shared/planning.css` — hovedkomponent
  - Periode-valg med uge-navigation (◀/▶)
  - Status-filtre med localStorage persistens
  - Bon-liste med checkboxes, "Vælg alle"/"Fravælg alle"
  - Client-side aggregering (grocy_recipe_id nøgle, fallback product_name+unit)
  - Aggregeret produktionsoversigt-tabel
  - Action-knapper: Råvarer (multi-bon merged via planning/ingredients endpoint) + Sammentælling (modal)
  - Vagtplan-toggle foroven (kollapset default, Smartplan shifts per dag)
  - SSE realtidsopdatering
- [x] `kitchen/planning.html` — kitchen shell med topbar
- [x] `office/views/planning.js` — office wrapper
- [x] Monteret i office sidebar + view-switcher
- [x] `shared/api.js` — `fetchBonsPlanning()` + `fetchPlanningIngredients()`

### Fase 4 — Opskrifter + Lager-forbrug
- [x] **Consume-fix**: `resolveConsumeItems()` i ingredientResolver.js
  - Per-produkt forbrug via `POST /stock/products/{id}/consume` (erstatter broken recipe-level consume)
  - Inkl. underopskrifter rekursivt + emballage
  - Partial success ved fejl (fortsætter med næste produkt)
- [x] **Grocy write-proxy**: `grocyPut()`, `grocyDelete()` + 9 CRUD-funktioner i grocyAdapter
  - Recipes, positions (ingredienser), nestings (underopskrifter)
  - Cache-invalidering efter writes
  - 12 nye routes i grocy.js (POST/PUT/DELETE)
- [x] `POST /api/grocy/consume` — consume via recipe lines (auto-consume ved LEVERET)
- [x] `POST /api/grocy/consume-products` — consume via per-produkt mængder (recipe viewer)
- [x] `shared/api.js` — ~20 nye Grocy CRUD-funktioner
- [x] `kitchen/recipes.html` — Komplet opskrift-side med to tabs:
  - **Viewer tab**: Opskrift-browser portet fra bontools recipe-viewer
    - Søgning, kategori-chips, opskriftsliste
    - Detaljevisning med portionsskalering, ingredienser med lagerstatus
    - Underopskrifter med klikbar navigation + navigation-stack
    - Træk fra lager med toast notification + pæne fejlbeskeder
  - **Designer tab**: Opskrift-editor portet fra bontools recipe-designer
    - Start-skærm med Tilpas/Ny valg
    - Recipe picker med søgning og kategori-chips
    - Editor: ingrediens-tabel med inline steppers, underopskrifter, noter
    - Gem (PUT) og Gem som ny (POST) via Grocy write-proxy
    - Autocomplete produkt-søg med lagerstatus-dots
- [x] `shared/recipe_viewer.js` + `shared/recipe_viewer.css`
- [x] `shared/recipe_designer.js` + `shared/recipe_designer.css`
- [x] Kitchen topbar: MERE dropdown standardiseret på alle views (Opskrifter + Vagtplan)
- [x] Dashboard: Opskrifter-kort linker til `/kitchen/recipes.html`

---

### Fase 5 — Lager (Stock Overview + Inventory Check)
- [x] Backend: `setInventory()`, `getLocations()`, `getProductGroups()`, `updateProductUserfields()`
- [x] Routes: `POST /api/grocy/stock/:id/inventory`, `GET /api/grocy/locations`, `GET /api/grocy/product-groups`, `PUT /api/grocy/products/:id/userfields`
- [x] `kitchen/stock.html` — Shell med to tabs:
  - **Lageroversigt tab**: Produkt-grid med filtre, status-pills (udløbet/lav), inline-redigering
  - **Optælling tab**: Fysisk lageroptælling per lokation/enhed
    - Konfigurerbare fysiske enheder (KØL-1, FRYS-2 etc.)
    - Smart sortering: prioritet → check-status (HverDag overdue/soon) → udløb → sidst-tjekket
    - `HverDag` userfield: interval i dage, beregner overdue/soon/ok/neutral status
    - `LastCheckedUnit` vises i "Sidst: dato (enhed)" + bruges til checkedTodayHere logik
    - Check-badges: ⏰ overdue (rød) og ⏳ soon (orange) med tooltip
    - ✔ godkend (ét klik) / ⏭ skip (huskes per enhed)
    - Expand med brøk-knapper (¼ ½ ¾)
    - Opsummeringsmodal med afvigelser + batch-gem
- [x] `shared/stock_overview.js` + `shared/stock_overview.css`
- [x] `shared/inventory_check.js` + `shared/inventory_check.css`
- [x] Dashboard Lager-kort linker til `/kitchen/stock.html`
- [x] Lager tilføjet i MERE dropdown på alle kitchen views

### Fase 6 — Indkøb & Bestilling

#### Fase 6 — Fundament (komplet)
- [x] **Backend Grocy proxy-endpoints** i `routes/grocy.js`:
  - `GET /api/grocy/shopping-list`, `DELETE /api/grocy/shopping-list/:id`
  - `POST /api/grocy/shopping-list/add-product`, `remove-product`, `add-missing`, `add-expired`, `add-overdue`, `clear`
  - `GET /api/grocy/shopping-locations`
  - `GET/POST /api/grocy/product-barcodes`, `PUT /api/grocy/shopping-list/:id`
  - `PUT /api/grocy/products/:id/userfields`
- [x] **`routes/purchasing.js`** — leverandør-/grocy-location management
  - `GET /api/purchasing/suppliers?location_id=` — leverandører med grocy-locations
  - `GET/POST /api/purchasing/suppliers/grocy-locations` — kobling-status + link
  - `DELETE /api/purchasing/suppliers/grocy-locations/:id` — unlink
- [x] **`routes/horkram.js`** — komplet selvstændig Hørkram proxy (ingen hokaAdapter-afhængighed)
  - Anti-forgery CSRF-token, cookie-jar auth, auto-retry ved 401/403
  - `GET /api/horkram/snapshots?ids=` — batch snapshot, max 20 pr. kald, auto-chunking
  - `PUT /api/horkram/basket/add` — CSRF-token + auto-basket-ID + salesUnit
  - `GET /api/horkram/favorites/:id/all` — auto-pagineret favorit-hentning
  - `GET /api/horkram/product/:varenr`, `/search`, `/favorites`, `/delivery-dates`, `/orders`
  - Env-vars: `HORKRAM_USER` + `HORKRAM_PASS`
- [x] **`services/hokaParser.js`** — normaliserer Hoka API-data (parseProduct, parseSearchResults, parseFavoriteProducts, parseSnapshotToSummary)
- [x] **`services/grocyAdapter.js`** — `getProductBarcodes()`, `createProductBarcode()`, `updateShoppingListItem()`
- [x] **Migration 030_purchasing_v2.sql** — `supplier_grocy_locations`, `webshop_url`, `integration_type` udvidet med `'webshop'`
- [x] **Migration 031_duplicate_candidates.sql** — duplikat-logging ved barcode-flytning
- [x] **Duplikat-detection** — Settings → Duplikater admin-oversigt med filter + action-knapper
- [x] **`shared/varemodtagelse.js`** + `varemodtagelse.css` — **Omskrevet i v3** (se Fase 6g nedenfor)
- [x] **Grocy QU-verifikation** — `recipes_pos.amount` er i stock-units (korrekt)
- [x] `shared/api.js` — alle purchasing/hoka/barcodes/orders/receiving-funktioner

#### Fase 6b — Nyt indkøbskomponent `shared/indkob.js` (komplet)
> Spec: `docs/CLAUDE_INDKOB.md` · Mockup: `docs/indkob_mockup_v3.html`

- [x] **`shared/indkob.js`** — merged indkøbsliste + bestilling, accordion UI
  - State-prefix: `_ib` · Entry: `initIndkob(containerEl)`
  - Init-flow: `_ibLoadAll` → `_ibBuildGroups` → `_ibEnrichSnapshots` → `_ibRender` → `_ibLoadFavCache` (non-blocking)
  - **Sticky toolbar**: Søg · + Tilføj vare · 📉 Manglende (N) · ⏰ Udløbende (N) · ≡/⊡ toggle
  - **Accordion** med Fokus-visning, fire leverandørgruppe-typer (api/email/manual/intern)
  - **Chips** med sortering: `is_preferred` → aftale → billigst/kg
  - **Multi-leverandør per vare** (fx Burgerlommer: Serviwet + Hørkram + Inco)
  - **Manuel bestilling**: kopiér/mail/ring-dialog med "Send & bestil" knap
  - **Intern (RR Produktion)**: produktionsbon-flow
  - **Kobling af umatchede varer**: inline link-panel, INT-varenumre
  - **PO mail-tråde**: SSE-drevet ulæst-badge + inline mail-compose
- [x] **`shared/indkob.css`**
- [x] **`kitchen/purchasing.html`** — 3 tabs: `[ Indkøb ]  [ Varemodtagelse ]  [ Post ]`
- [x] **Migration 032**: `integration_type` CHECK udvides med `'intern'`, RR Produktion seeded
- [x] `shared/shopping_list.js` + `shopping_list.css` + `bestilling.js` + `bestilling.css` **udgår**


#### Fase 6c — Settings: Indkøbsindstillinger (komplet)
> Spec: `docs/CLAUDE_SETTINGS_INDKOB.md` · Mockup: `docs/settings_mockup.html`
> Test: `docs/CLAUDE_TEST_INDKOB.md` sektionerne 6A–6D + 7

- [x] **Migration 032**: `integration_type` CHECK udvides med `'intern'`, RR Produktion seeded
- [x] **`routes/purchasing.js`** — fuld CRUD: GET/:id, POST, PATCH, DELETE (soft delete)
- [x] **`shared/indkob_settings.js`** + `indkob_settings.css` — fælles settings-komponent (1400 linjer, 43 funktioner)
  - Entry: `initIndkobSettings(containerEl, { mode: 'panel'|'page' })`
  - State-prefix: `_is`
  - **Tab 1 — Leverandører**: CRUD-tabel med type-badges, inline edit-form, Grocy-location auto-save kobling
  - **Tab 2 — Produkter**: kolonne-chips (localStorage), filter (søg + leverandør), dirty-tracking, bulk-save (max 5 concurrent)
  - **Tab 3 — Hørkram**: 4 sub-tabs (Opslag, Favoritter, Ny kobling, Alle koblinger)
    - Opslag: smart søg (tal→direkte lookup, tekst→søgning), produktkort med link/pris-actions
    - Favoritter: lister med "Importer priser" (batch snapshot→userfields)
    - Ny kobling: Grocy-produkter uden HK-barcode, auto-søg med confidence-scoring (Dice bigram)
    - Alle koblinger: tabel med foretrukket-toggle, udgået-detection via batch snapshots
  - Batch prisopdatering med progress-bar, dead-product tracking som sideeffekt
  - Udgået-warning: rød "Udgået" badge, banner, sorteret øverst
- [x] **`kitchen/purchasing.html`** — ⚙ gear-knap i tab-bar, slide-in panel (880px), overlay, Escape lukker
- [x] **`settings/index.html`** — "Indkøb" nav-punkt (admin), lazy init i page-mode

#### Fase 6d — E-mail ordrer + dropsize + CO2 (komplet)
- [x] Migration 033: `order_email` mail-skabelon i `mail_templates`
- [x] `GET /api/horkram/dropsize?subtotal=N&date=ISO` — proxy til Hoka dropsize API
  - Parser dansk talformat (`"1.500,00"` → 1500)
  - Gult banner under Hørkram-gruppe hvis minimum ikke nået
  - Advarsel kun — bestilling blokeres ikke
- [x] SMTP ordremail til leverandør via `kontakt@`-transport
  - `POST /api/orders/pending` udvid med `send_email: true`
  - Renderer `order_email` skabelon med `{{leverandoer}}`, `{{vareliste}}`, `{{dato}}`, `{{leveringsdato}}`
  - Sender via `mailService.sendFromTemplate()`, sætter `sent_via='email'` + `sent_at`
  - Frontend: "Send & bestil" knap erstatter separate "Send mail" + "Bekræft bestilt"
  - Leverandører uden email: fallback til manuelt flow (Kopiér + Ring + Bekræft)
- [x] CO2 per vare + total i Hørkram-grupper
  - `hokaParser.parseSnapshotToSummary()` udvidet med `co2e` felt
  - Per-vare: grøn `🌱 X,X kg CO₂e` badge (via `_ibGetBadges`)
  - Gruppe-header: samlet CO2 pill `🌱 49,9 kg CO₂e`
  - Graceful: varer uden CO2-data viser intet

#### Fase 6e — Indkøb bugfixes, sporbarhed, varemodtagelse-forberedelse (komplet)
> Spec: `docs/CLAUDE_INDKOB_6E.md`

- [x] Migration `035_indkob_fixes.sql`
- [x] Fix 1: `shared/indkob.js` — `_ibGotoCart` `lines` → `items`
- [x] Fix 2: `routes/orders.js` — `barcode_value` på `purchase_order_lines`
- [x] Fix 3: `routes/horkram.js` — kurv mixed-format fix (se `docs/FIX_horkram_basket.md`)
- [x] Fix 4: `shared/indkob_settings.js` — "Alle koblinger" grupperet per produkt + tilføj pakstørrelse
- [x] Fix 4: `routes/grocy.js` — `DELETE /api/grocy/product-barcodes/:id`
- [x] Fix 4: `services/grocyAdapter.js` — `deleteProductBarcode()`
- [x] Fix 5: `goods_receipts` + `goods_receipt_items` + `webhook_log` tabeller (migration 035)
- [ ] Verificering: multi-barcode chips på grocytest

#### Fase 6f — Leverandørpost (komplet)
> Spec: `docs/CLAUDE_LEVERANDOR_MAIL.md`

- [x] Migration 034: `mail_threads.purchase_order_id` + `purchase_orders.mail_thread_id`
- [x] Tag-prefix `po-` i settings (harmoniseret med `b-`, `t-`, `k-`)
- [x] `utils/mail-parser.js` — PO-tag parsing + buildTag support
- [x] `services/mailService.js` — `purchaseOrderId` i sendMail/sendFromTemplate, IMAP `#po-` routing, SSE `po_mail_received`/`po_mail_sent`
- [x] `routes/orders.js` — 4 nye endpoints (GET/POST mail, PATCH read, GET mail-threads), `unread_mail` subquery, PO-tag + thread ved `send_email`
- [x] `shared/supplier_inbox.js` — Office view (to-kolonne: liste + tråd-preview + svar)
- [x] `office/index.html` — "Leverandørpost" sidebar-punkt med ulæst-badge, view-registration, SSE
- [x] `kitchen/purchasing.html` — "Post" tab med supplier_inbox.js, ulæst-badge, SSE
- [x] `shared/indkob.js` — mail-badge på bestilt-sektion, inline tråd-expand, SSE handler
- [x] `shared/indkob_settings.js` — "Bestillingsmail" label + placeholder + hint
- [x] `shared/api.js` — `fetchOrderMailThread`, `sendOrderReply`, `markOrderMailRead`, `fetchOrderMailThreads`, `deleteProductBarcode`
- [x] Bonus: "Søg i Hørkram-katalog" label i link-panel, "Læg i kurv" for Hørkram-barcodes uanset gruppe

#### Fase 6g — Varemodtagelse v3 + Staff (komplet)
> Spec: `docs/CLAUDE_VAREMODTAGELSE_v3.md` · Mockup: `docs/varemodtagelse_v4.html`

- [x] Migration 036: `goods_receipts` + `goods_receipt_items` nyt skema (to temperaturer, FVST-toggles, afvigelse, receipt_number)
- [x] Migration 037: `staff`-tabel (medarbejdernavne, adskilt fra auth-brugere)
- [x] Migration 038: `smartplan_id` + `source` på staff
- [x] Migration 039: `received_by_name` TEXT på goods_receipts
- [x] `routes/goods-receipts.js` — 5 endpoints:
  - `GET /users` — aktive brugere til dropdown
  - `POST /photo` — busboy foto-upload til `/data/uploads/receipts/`
  - `POST /` — opret receipt + sekventiel Grocy addStock + shopping list cleanup + webhook
  - `GET /` — liste med from/to/supplier/location filtre
  - `GET /:id` — detalje inkl. items
- [x] `services/goodsReceiptWebhook.js` — Whiteboard webhook (fire-and-forget, link-only foto)
- [x] `routes/staff.js` — CRUD for manuelle medarbejdere (GET/POST/PATCH/DELETE)
- [x] `shared/varemodtagelse.js` — komplet ny UI fra mockup v4:
  - Touch-first (max 500px), to sektioner: Fødevarekontrol + Lager
  - Bruger-dropdown: merger staff + Smartplan employees (som Whiteboard)
  - Leverandør-dropdown: matcher suppliers mod Grocy shopping list `ordered_supplier`
  - Temperaturer (køl+frys) med toggles, live badges (OK/FEJL), auto-afvigelse
  - FVST-toggles (dato, mærkning, emballage)
  - Foto-upload (kamera/fil), afvigelse-sektion (radioknapper + note)
  - Lager: "Godkend alt" / "Juster enkeltvis", varekort med qty+status
  - Per-vare regler: ok→addStock+slet, delvis→addStock+reducer, missing→behold
  - Validering, success overlay med per-vare Grocy-resultater
- [x] `shared/varemodtagelse.css` — styling fra mockup v4
- [x] `services/smartplanAdapter.js` — `getEmployees()` fikset til at udtrække fra shifts (ikke /employees/)
- [x] `settings/index.html` — Medarbejdere-sektion (tilføj/omdøb/aktiver/ejer-toggle)
- [x] `server.js` — mount goods-receipts + staff routes, statisk `/uploads/receipts/`
- [x] End-to-end verificeret: Grocy addStock + shopping list cleanup + DB-registrering

### Fase 7 — CRM-modul
- [x] Migration 019: `crm_activities` genskabt med `service_call`/`result`/`sentiment`, `bons.is_internal`, `companies.is_internal`
- [x] 4 SQL views: `v_service_calls_pending`, `v_callbacks_pending`, `v_hard_to_reach`, `v_call_stats_weekly`
- [x] `routes/crm.js` — 13 endpoints portet fra Python-prototype:
  - `GET /api/crm/stats` — KPIs (service-kald, callbacks, reach rate, bons i dag)
  - `GET /api/crm/briefing` — Daglig briefing (max 6 prioriterede items)
  - `GET /api/crm/suggestions` — Smart forslag (overdue, sæson, leads, tilbud, dormant)
  - `GET /api/crm/service-calls?days=` — Ventende service-kald
  - `GET /api/crm/customers?stage=&q=&category=` — Kundeliste med filtre
  - `GET /api/crm/customer/:id` — 360° profil (stats, ordrer, aktiviteter, produkter)
  - `GET /api/crm/customer-orders/:id` — Ordrehistorik med linjer
  - `POST /api/crm/activity` — Log aktivitet (call, service_call, note, meeting, task, followup)
  - `PATCH /api/crm/customer/:id/stage` — Opdater stadie (lead/active/dormant/vip)
  - `GET /api/crm/callbacks` — Ventende callbacks + svære at nå
  - `GET /api/crm/dormant` — Sovende kunder
  - `GET /api/crm/call-log` — Opkaldslog med sentiment-filter
  - `GET /api/crm/call-stats` — Ugentlig statistik, per-bruger, resultater
- [x] `office/views/crm-dashboard.js` — CRM Dashboard:
  - KPI-strip (5 kort), daglig briefing, smart forslag med ring/profil-knapper
  - Service-kald ventende med kunde-navigation
  - SSE: `crm_activity_created` → auto-refresh
- [x] `office/views/crm-kunde360.js` — Kunde 360°:
  - Søgning med stage-filtre (VIP/Aktive/Sovende/Leads)
  - 2-kolonne profil: kundeinfo + stage-badge + nøgletal + top produkter
  - 4 tabs: Ordrer, Aktivitet, Tilbud, Mail
  - Aktivitetslog med type/result/sentiment-emojis + tidslinje
  - Mail compose med pre-filled email + mail-historik fra bons
  - Stage-ændring via dropdown
- [x] `office/views/crm-inbox.js` — CRM Indbakke:
  - 2-panel: mail-liste + preview
  - Actions: Link til Bon (nummer-søg), Link til Kunde (KundeSoeg), Ignorer
  - Bruger eksisterende `GET/PATCH /api/mail/unmatched` endpoints
- [x] Office sidebar: 3 CRM-punkter aktiveret (CRM, Kunder, Indbakke)
- [x] SSE-handlers: `crm_activity_created`, `crm_stage_changed`, `mail_unmatched`
- [x] `shared/api.js` — 16 nye CRM + dashboard wrapper-funktioner

### Mail-fixes (marts 2026)
- [x] `mailService.js` — attachment INSERT: `filepath`→`file_path`, `content_type`→`mime_type`
- [x] `mail.js` — unmatched linking: manglende `to_email` parameter
- [x] `kitchen/today.html` + `later.html` — tilføjet `components.css` (mail-toast var usynlig)
- [x] Mail toast viser `bon_number` i stedet for `bon_id`
- [x] `office/views/dashboard.js` — erstattet rå `fetch()` med `apiFetch()` + fejlvisning
- [x] `routes/kitchen.js` — calendar-endpoint manglede `unread_mail_count` subquery
- [x] Mail-badge ✉ størrelse øget (20px bon-kort, 2em kalender/liste)
- [x] Office zone font-size øget: 13px→14px / 15px→16px

### Office CRM redesign (marts 2026)
- [x] Typografi: Playfair Display (headings/KPI-tal) + DM Sans (body) via Google Fonts
- [x] `shared/tokens.css` — `--font-heading`, `--font-body`, sentiment-farver (`--color-sentiment-pos/neu/neg`)
- [x] `office/index.html` — Sidebar varmere brun (#6B4C2A), guld accent, "Bon v2 · Office" subtitle
  - Team-links aktive: Vagtplan → `/kitchen/vagtplan.html`, Whiteboard → `whiteboard.ristetrug.dk`, SOP → `sop.ristetrug.dk`
  - Sidebar badge-support (`.sidebar-badge` klasse)
- [x] `office/views/dashboard.js` — CRM-placeholder erstattet med:
  - Ring tilbage panel (callbacks med avatar-initialer)
  - Seneste aktivitet feed (farvede dots + timestamps)
  - KPI-tal: Playfair Display 28px med hover
- [x] `office/views/crm-dashboard.js` — Komplet redesign:
  - 2-kolonne grid: hovedindhold + side-paneler
  - Pipeline board (Lead / Tilbud sendt / Forhandling / Vundet) med kategori-filtre
  - Callbacks panel med gradient-avatarer
  - Aktivitetsfeed med farvede dots
  - Hover-reveal actions på smart forslag
  - Service-kald: 📞 tel: + 📧 mailto: ghost-knapper
- [x] `office/views/crm-kunde360.js` — Komplet redesign:
  - Avatar-tile med gradient initial (52px)
  - Sentiment trendline (6 prikker, fortolkningsbanner, sammenfatning)
  - Stat strip over tabs: Ordrer, Omsætning, Stemning (emoji), Næste event (Playfair Display)
  - Typiske produkter som farvede chips
  - Hurtig note inline textarea
  - Aktivitetstimeline: farvede ikon-cirkler med connector-linjer, card-layout, who-badges
  - Filter chips: Alle, Opkald, Noter, Møder, Med smiley
  - Månedsdividere i timeline
  - Sentiment-badges med danske labels (God/Neutral/Dårlig)
- [x] `office/views/crm-inbox.js` — Keyboard navigation (↑↓), focus-states, bedre styling
- [x] `routes/crm.js` — `GET /api/crm/pipeline` + `PATCH /api/crm/pipeline/:id/move` + `customer_email` i service-calls
- [x] `shared/api.js` — `fetchCrmPipeline()` + `movePipelineCard()` tilføjet
- [x] Pipeline drag-drop: HTML5 drag API, visuelt feedback, status-opdatering via API
- [x] Opret kunde flow på Kunder-siden:
  - "+ Ny kunde" knap med toggle til formular
  - CVR-opslag via navn eller nummer (cvrapi.dk), autofyld alle firma-felter
  - Privatkunde-checkbox springer firma over
  - DAWA autocomplete adresse-validering (api.dataforsyningen.dk)
  - Opret → POST companies + POST customers → navigér til Kunde 360°
- [x] `office/views/bons-list.js` — SSE guard fix (_blUpdateFilterButtons null-check)

### Fase 8 — Fakturering
- [x] `routes/invoices.js` — `GET /api/invoices/queue` (pending + done + summary)
  - Pending: LEVERET + payment_type = 'invoice', sorteret ældste først
  - Done: FAKTURERET/AFSLUTTET, seneste 60 dage (optional via `?include_done=1`)
  - Summary: pending_count, pending_amount, ean_count, done_count_month, done_amount_month
  - Inline bon_lines per bon, formatBon() med nested customer/company/address
- [x] `routes/companies.js` — `PATCH /api/companies/:id/economic` (e-conomic firma-nr med changelog)
- [x] `routes/customers.js` — `PATCH /api/customers/:id/economic` (e-conomic kontakt/kunde-nr med changelog)
- [x] `server.js` — Mount `/api/invoices`
- [x] `shared/api.js` — `fetchInvoiceQueue()`, `patchCompanyEconomic()`, `patchCustomerEconomic()`
- [x] `office/views/fakturering.js` + `fakturering.css` — Komplet master-detail view
  - Summary-strip (4 kort: afventer, beløb, EAN, faktureret denne måned)
  - Liste-panel (380px) med aldersprikker (grøn 0–3d / orange 4–7d / rød 8+d)
  - Søgning med debounce, filtrerer på bon_number + kunde + firma
  - Afventer-sektion (ældste øverst) + Faktureret-sektion (dæmpet, gennemstreget)
  - Auto-select første afventer bon ved load
  - Detail-panel: read-only bon med levering, kunde/firma, e-conomic inline-edit, ordre, varer, noter
  - E-conomic inline-edit: firma-nr + kontakt-nr (firma) eller kunde-nr (privat), Enter/Escape/Gem/Annuller
  - "Markér faktureret" med custom confirm-dialog + valgfrit fakturanummer
  - Fakturanummer gemmes i invoice_note
  - Fade-animation ved markering + auto-select næste bon
  - e-conomic teaser ("integration kommer")
  - "Åbn bon" → åbner BonDrawer
  - SSE realtidsopdatering (bon_status, bon_updated, bon_created)
- [x] `office/index.html` — Sidebar aktiveret (data-view="fakturering"), guld badge med pending count
  - View-switcher: `initFakturering()` / `cleanupFakturering()`
  - SSE-handlers: `_faktHandleSSE` på bon_created/bon_updated/bon_status

### Fase 9 — Tilbudsmodul
- [x] Migration 020–023: `quotes`/`quote_lines` tabeller (midlertidigt) → omskrevet til `is_offer=1` på bons
  - 022: `offer_template`, `offer_price_mode`, `offer_discount_percent` på bons + `block_type` på bon_lines
  - 023: `TILBUD` status i `status_definitions` med transitions (→ GODKENDT, → AFLYST, → NY)
- [x] **Arkitektur: tilbud = bon med `is_offer=1`** — fungerer med hele det eksisterende system
  - Tilbud bruger TILBUD-status (ikke NY) → korrekt filtrering i alle views
  - T-nummerserie via `quote_number_prefix` + `quote_number_next` i settings
  - Bons-listen (`GET /api/bons`) ekskluderer `is_offer=1`
  - CRM ordrer/stats ekskluderer `is_offer=1`
  - Konvertering = `UPDATE SET is_offer=0, offer_status='won', status_id=GODKENDT`
- [x] `routes/quotes.js` — 11 endpoints (opererer på bons med `is_offer=1`):
  - CRUD: GET liste (filtre: status, customer_id, q), GET /:id med linjer, POST, PATCH, DELETE (kun draft)
  - Linjer: POST/PUT/DELETE /:id/lines/:lid
  - Status: PATCH /:id/status (draft/sent/won/lost/expired)
  - Convert: POST /:id/convert → sæt is_offer=0
  - Next-number: GET /next-number
- [x] `office/views/tilbud.js` + `tilbud.css` — Tilbudsliste + 5-trins wizard
  - **Liste**: status-filtre (Kladde/Sendt/Vundet/Tabt), søgning, klik åbner wizard
  - **Step 0**: Skabelon (Event/Enkeltbestilling)
  - **Step 1**: Kunde & levering — KundeSoeg, dagskontakt, dato, tid, pax, enheder,
    leveringstype/-metode, DAWA-adresse, priskategori, betaling, noter (kundeønsker, faktura, køkken, intern)
  - **Step 2**: Sammensæt — Grocy-recipes, event-blokke (morgen/snack/frokost), single-liste, fritekst-items
  - **Step 3**: Priser — prismode (total/blok/linje), rabat, gyldighed, levering, pristabel
  - **Step 4**: Preview + Gem + Download PDF + Konvertér til bon
  - Alle steps klikbare for eksisterende tilbud, ordrehistorik med kopiér-bon
- [x] PDF-generering med Ristet Rug logo (base64 PNG fra `assets/logo-b64.txt`)
- [x] `office/index.html` — Sidebar "Tilbud" punkt (efter CRM, før Drift), jsPDF CDN, view-switcher, SSE
- [x] `shared/api.js` — 8 nye funktioner (fetchQuotes, createQuote, updateQuote, deleteQuote, patchQuoteStatus, convertQuoteToBon, fetchNextQuoteNumber)
- [x] CRM Kunde 360° — Tilbud-tab henter via quotes API, "+ Opret tilbud" deep link
- [x] Kitchen later-view: `OR b.is_offer = 1` tilføjet (tilbud vises uanset bon-status)
- [x] Kalender: tilbud vises med TILBUD-status badge

### Fase 9b — Tilbud v2 (konfigurerbare blokke, pax pr. blok, PDF-forbedringer)
- [x] Migration 024: `offer_note`, `offer_block_metadata` på bons
- [x] Migration 025: `company_cvr`, `company_address`, `company_phone`, `company_email` i settings
- [x] `offer_block_types` setting (JSON-array med key, label, sort_order) — konfigurerbare blok-typer
- [x] `settings/index.html` — Tilbud-sektion med blok-type editor (omdøb, tilføj, slet, rækkefølge)
- [x] `office/views/tilbud.js`:
  - Blok-types hentes fra settings ved init (cached i modulscope, ikke ved hvert step-skift)
  - Pax pr. blok i step 1 (event-skabelon) — tom = global pax
  - Pax-pill på blok-headers i step 2
  - Kundenote textarea i step 3 (vises på PDF, adskilt fra interne noter)
  - Blokpris pr. pax i pristabel (kun block/line mode)
  - Pris pr. pax for enkeltbestillinger (ikke kun event)
  - Leveringsadresse med ugedag på preview + PDF
  - Firmaoplysninger i footer (CVR, adresse, email fra settings)
- [x] `routes/quotes.js` — `offer_note` + `offer_block_metadata` i POST/PATCH/GET
- [x] CRM Kunde 360° — klik på tilbud åbner wizard
- [x] `window.switchView` global (tilgængelig for CRM deep links)

### Mail-vedhæftninger + tilbuds-fixes (april 2026)
- [x] npm: `busboy@^1.6.0` (rent JS, ingen native)
- [x] `routes/attachments.js` — **NY FIL**: upload (multipart/busboy) + download endpoints
  - `POST /api/attachments/upload` — max 10 MB, PDF/billeder/Office tilladt
  - `GET /api/attachments/:id/download` — generisk attachment
  - `GET /api/attachments/mail/:id/download` — mail attachment
- [x] `server.js` — mount `/api/attachments`
- [x] `services/mailService.js` — `sendMail()` udvid med `attachments = []` parameter
  - Resolver `attachment_id` → `file_path` via `attachments`-tabel
  - Sætter `has_attachments` flag på `mail_messages`
  - Inserter `mail_attachments`-rækker for historik
  - Sender via nodemailer (native attachment-support)
- [x] `routes/bons.js` — POST /:id/mail accepterer `attachments[]` med validering (max 5, integer IDs)
- [x] `shared/api.js` — `uploadAttachment()`, `mailAttachmentUrl()`, `attachmentUrl()`
- [x] `shared/bon_drawer.js` — "📎 Vedhæft"-knap, fil-upload, pills, send med attachments, visning i mail-historik
- [x] `shared/bon_drawer.css` — attachment pill/knap/historik styling
- [x] `office/views/crm-kunde360.js` — samme attachment-mønster i CRM Kunde360 mail-compose
- [x] `office/views/tilbud.js` — "✉ Send til kunde" i step 4 (genererer PDF → upload → mail)
- [x] Tilbuds-fix: `pax` ReferenceError i `_tBuildStats()` der crashede step 2 rendering
- [x] Tilbuds-fix: `_tNewQuote()` nulstiller `_tMenu` for friske priser
- [x] Kostpris-fix: `getRecipes()` henter nu fra Grocy fulfillment (`costs`) i stedet for gammelt `costprice` userfield
- [x] jsPDF selvhostet i `assets/jspdf.umd.min.js` (CDN 2.5.2 returnerede 404)
- [x] Spec-opdateringer: `CLAUDE_MAIL.md` (sekt. 14–15), `CLAUDE_MAIL_IMPL.md`, `CLAUDE_TILBUD.md` Fase 2

### CRM Service-kald opgradering (april 2026)
- [x] Service-kald listen opgraderet fra simpel liste til interaktivt workflow
  - Dage-dropdown (7/10/14/21/30) med live reload
  - Pax + pris inline per række
  - Farvede dage-badges (grøn 0–3d, gul 4–7d, rød 8+d)
  - Ring-knap: åbner `tel:` link (Mac telefon-app) + inline log-form
  - Håndteret quick-knap (✓) markerer direkte som done
  - Ordrehistorik expand (seneste 5 ordrer med linjer + special_request)
  - Log-form med resultat (6 valg), stemning (3 valg) og note
  - Kunder uden telefonnummer → "Log" knap (kun form)
- [x] CRM dashboard layout: Service-kald øverst → Pipeline → Smart forslag nederst
- [x] `routes/crm.js` — `special_request` tilføjet til customer-orders query

### Firma-oprydning og CVR-berigelse (april 2026)
- [x] Migration 029: `legal_name` på companies (juridisk navn fra CVR)
- [x] `scripts/merge-ean-duplicates.js` — Merger firmaer med samme EAN
  - Beholder firma med flest bons, gemmer alternative navne i notes
  - Flytter kunder og bons, overtager kontaktinfo
  - 91 EAN-grupper, 250 firmaer slettet (1230 → 980)
- [x] `scripts/enrich-cvr.js` — CVR-berigelse via Virk ElasticSearch + NemHandel
  - Strategi 1: EAN → NemHandel (GLN→CVR, sikrest for institutioner)
  - Strategi 2: Kendte institutioner via email-domæne
  - Strategi 3: Virk ES navnesøgning med fuzzy matching (ingen rate limit)
  - Juridiske suffixer (I/S, A/S, ApS etc.) ignoreres i similarity
  - Gemmer CVR + legal_name, rører ikke eksisterende data
  - Review-log i `data/cvr-enrich-log.json`
  - 167 via NemHandel + ~455 via Virk ES = 622 firmaer med CVR
- [x] `scripts/fix-cvr.js` — Manuel CVR-rettelse (--id, --search, --list, --clear)
- [x] `routes/invoices.js` — `legal_name` i API-response
- [x] `office/views/fakturering.js` — Viser legal_name under firmanavn (når forskelligt)
- [x] `scripts/sync-v1.js` — Opdateret til at bevare CVR-data og håndtere EAN-merges
  - Company-mapping: v1_id → EAN-match → ny insert
  - Firmaer med CVR: kun adresse opdateres (navn/ean/notes bevares)
  - `resolveV2CompanyId()` bruges i customers og bons
  - Forhindrer at EAN-mergede firmaer genopstår som dubletter
- [x] `.env.example` — `VIRK_ES_USER` + `VIRK_ES_PASS` tilføjet

### Fase 10 — Mobil Shell
- [x] Migration 040: `mobile_pin_enabled`, `mobile_pin_min_length` settings
- [x] `routes/auth.js` — PIN-endpoint udvidet med `user_id` parameter (bagudkompatibelt)
  - In-memory lockout: 3 fejl → 30s spærring per bruger
  - Nyt public endpoint `GET /api/auth/pin-users` (aktive brugere med PIN)
- [x] `mobile/login.html` — Touch-venlig PIN-pad login
  - Bruger-grid → PIN-input (72px knapper) → session → redirect
  - Lockout-nedtælling, ryst-animation ved fejl
  - Desktop-detect: "Åbn fuld version?" banner
- [x] `mobile/index.html` — Shell med 5-tab bottom nav + view-router
  - Header: logo + brugernavn + logout dropdown
  - Bottom nav: Bons, Modtag, CRM, Overblik, Mig
  - Offline-banner (online/offline events)
  - URL-state: `?view=` + `?bon=` for deep-linking
  - PWA: manifest.json (standalone, add-to-homescreen)
- [x] `mobile/views/bons.js` — Bonliste + bon-detalje
  - To tabs: I dag / I morgen (parallelle API-kald)
  - Kompakte kort: tid, kunde, bonnr, status-badge, enheder
  - Detalje: kunde (tel:/maps-link), levering, adresse, varer, køkkeninfo
  - Statusskift med transitions + haptic feedback
- [x] `mobile/views/modtag.js` — Varemodtagelse wrapper
  - Kalder `initVaremodtagelse(container)` direkte — ingen ændringer i shared-kode
  - Auth håndteres i shell inden montering
- [x] `mobile/views/crm.js` — CRM mobil
  - Service calls: liste med Ring/Udført knapper, inline note-form
  - Kundeliste: fuld alfabetisk liste + søgefelt med debounce
  - Kundekort: kontaktinfo, seneste ordrer, log samtale
- [x] `mobile/views/oversigt.js` — Travlhed + Smartplan
  - 3 kort: I dag / I morgen / Overmorgen (bons, enheder, status-badges)
  - Smartplan vagter: fornavn + møde-/sluttid
- [x] `mobile/mobile.css` — Komplet mobilspecifik CSS
  - Bottom nav med safe-area padding (notch)
  - Touch-targets (min 44px), bonliste-kort, detalje, CRM, overblik
- [x] `login.html` — Mobil-detect banner (ikke-blokerende, "Nej tak" huskes)

### Fase 10b — Roller & Rettigheder
- [x] Migration 041: `users`-tabel genskabt med `kitchen_personal` i role CHECK + `modules_json` kolonne
  - Views (`v_active_notifications`) droppes/genskabes for at undgå SQLite RENAME-blokering
- [x] Settings-rækker: `role_permissions_*` per rolle (JSON i settings-tabellen), `session_days_kitchen_personal`
- [x] `shared/auth.js` — `userCan(user, module)` med 60s cache + `invalidatePermCache()`
  - Per-bruger overrides via `modules_json` på users
- [x] `routes/auth.js` — `GET /me` returnerer `permissions` objekt (6 moduler: crm, tilbud, okonomi, rapporter, settings, modtag)
- [x] `routes/settings.js` — `GET/PATCH /api/settings/role-permissions/:role` (admin-only, admin kan ikke begrænses)
- [x] `login.html` + `server.js` — `kitchen_personal` → `/mobile/` redirect
- [x] `mobile/index.html` — Dynamisk nav baseret på `permissions` (NAV_DEFS med `requires` per tab)
- [x] `settings/index.html` — Permission matrix UI (roller × moduler, checkboxes, admin read-only)
  - `kitchen_personal` tilføjet i rolle-dropdown ved bruger-oprettelse/redigering
- [x] `shared/api.js` — `fetchRolePermissions()` + `patchRolePermissions()`

### Fase 11 — Ugeoversigt
- [x] Migration 042: `capacity_ratio_enabled`, `capacity_threshold_low/green/yellow`, `production_start_time` settings
- [x] `routes/schedule.js` — `GET /api/schedule/week?from=&to=&status=`
  - Bons: delivery_date BETWEEN, valgfrit status-filter (default: alle ekskl. AFLYST), is_offer=0
  - Smartplan shifts: grupperet per dag med initialer + timer
  - Lager-status: per bon `grocy_recipe_id` tjek (ok/missing/no_lines)
  - Kapacitetsberegning (kører altid): dagsniveau workload/persontimer
    - Produktionsvindue: `production_start_time` → seneste pickup/delivery (min 1 time)
    - Persontimer: vagters overlap med produktionsvinduet
    - `day_ratio = total_workload / available_person_hours`
    - Workload: `total_units > 0 ? total_units : pax` (som kalenderen)
  - Feature-flag `capacity_ratio_enabled` styrer kun om detaljerede slot-data returneres
  - Tærskelværdier fra settings: blå < 20, grøn < 35, gul < 45, rød ≥ 45
- [x] `server.js` — mount `/api/schedule`
- [x] `office/views/ugeoversigt.js` — Komplet ugeoversigt-view
  - Uge-navigation (◀/▶/I dag), ISO ugenummer + datointerval
  - Status-filterknapper (BonConfig, toggle on/off, localStorage persistens)
  - 8-kolonne grid (label + 7 dage) × 3 rækker (Produktion/Personale/Lager)
  - I dag-kolonne fremhævet, weekend dæmpet
  - Status-badges (grøn/orange/rød) + ratio-chip per celle
  - Klik på kolonne → dagdetalje under grid
    - 3-kolonne panel: bonliste, vagtliste med avatarer, lager per bon
    - Kapacitets-advarsel ved højt ratio
    - Footer: "Åbn planlægning →" + "Se alle bonner"
  - SSE realtidsopdatering (debounced re-fetch)
- [x] `shared/schedule.css` — Ugeoversigt styling baseret på mockup + filterknapper
- [x] `office/index.html` — Sidebar "Ugeoversigt" punkt, view-registrering, SSE-handlers
- [x] `shared/api.js` — `fetchScheduleWeek(from, to, status)`
- [x] `settings/index.html` — Kapacitetsplanlægning-sektion
  - Forklaringsboks med formel og eksempel
  - Produktionsstart tid-input (default 08:00)
  - Feature-flag toggle + 3 tærskelfelter (synlige når toggle on), auto-save

### Sync-v1 timezone-fix
- [x] `scripts/sync-v1.js` — `parseV1Date()` fikset fra UTC til lokal tid
  - V1 gemmer tider i UTC, men de repræsenterer dansk lokal tid (CET/CEST)
  - Rettet fra `toISOString()` (UTC) til `getHours()`/`getMinutes()` (lokal)
  - Alle pickup/delivery-tider var forskudt 1-2 timer — nu korrekte
  - Kræver `--full` sync efter deploy for at rette eksisterende data

## Næste opgave

> ✏️ Opdateret 12. april 2026.
>
> **Fase 1a–1e + 3A + 3B + 3D + 4 + 5 + 6 (komplet inkl. 6g) + 7 (CRM) + Office CRM redesign + 8 (Fakturering) + 9 (Tilbud) + Mail-vedhæftninger + CRM service-kald + Firma-oprydning + 10 (Mobil Shell) + 10b (Roller & Rettigheder) + 11 (Ugeoversigt) komplet.**
>
> **Næste sprint:** Priser i planlægningsbon.
> Så er Bon v1 klar til nedlukning.
>
> **Åbne afhængigheder:**
> - DMI API-nøgle (vejr på dashboards) — Leif finder frem til eksisterende nøgle (Open-Meteo bruges midlertidigt)
> - ~~Bon v1-datamigration~~ — sync-v1.js kører dagligt via cron, CVR-beriget
> - Byekspressen credentials — ryk sebastian@by-expressen.dk
> - Formbuilder webhook-URL + HTML til ristetrug.dk/bestil — sættes når 1c er stabilt
> - Whiteboard API URL — `https://whiteboard.ristetrug.dk` (localhost til test)
> - ~~Hørkram credentials~~ — `HOKA_USERNAME` + `HOKA_PASSWORD` sat i `.env`
> - CVR review: ~622 auto-matchede firmaer bør gennemgås for fejl (brug `fix-cvr.js`)
> - Inco credentials — til webshop-login (har også API, men bruges ikke endnu)
> - `services/hokaAdapter.js` — bruges ikke af bestillingsflowet (erstattet af proxy-logik i `routes/horkram.js`). Review om den skal slettes eller beholdes til andre formål.
>
> **Åbne design-beslutninger:**
> - Priser i planlægningsbon: setting `show_prices_in_planning` (default false)
>   Styrer om salgspris/kostpris/margin vises i planlægningsbon.
>   Implementeres som setting i settings-tabellen, bruges i planning.js til at vise/skjule priskolonner.
> - shared/-mappe opdeling i undermapper — udskydes til senere refaktorering
> - ~~orders.js migrering fra JSON-fil til SQLite~~ — routes/orders.js bruger SQLite (tools/bestiliing/orders.js JSON-version er deprecated)
>
> **Beslutninger taget:**
> - Kalender er separat sidebar-punkt i office (ikke fane i listview)
> - Planlægning er separat sidebar-punkt i office + topbar-link i kitchen
> - Ingrediens-opløsning inkluderer underopskrifter rekursivt (emballage og levering vises nederst, ikke skjult)
> - Lager-forbrug: per-produkt consume (ikke recipe-level), inkl. emballage
> - Grocy QU: `recipes_pos.amount` er i stock-units, `qu_id` er display-enhed — DB skal IKKE ændres
> - Indkøbsliste bruger purchase-enhed med oprunding ved tilføjelse til Grocy shopping list
> - Fakturering og Rapporter er separate sidebar-punkter (ikke tabs)
> - Rapporter bruger custom canvas chart (som dashboard), ikke Chart.js — genbrug `initDashboardChart()` og `initAccumChart()` fra `shared/dashboard_chart.js`
> - Rapporter: LEVERET medtages i omsætningstal (ikke kun terminal-statusser) + is_offer og is_internal ekskluderes
> - Rapporter: revenue = `SUM(bl.quantity * bl.unit_price)` (linje-sum), IKKE `b.total_price`
> - Dashboard bør også filtrere `is_offer`/`is_internal` fra revenue-tal (rettes sammen med rapporter)
> - Tilbud = bon med `is_offer=1` (ikke separat tabel) — integrerer med kalender, planlægning, CRM pipeline
> - Tilbud er separat sidebar-punkt i office (efter CRM, før Drift)
> - Tilbud bruger TILBUD-status (dedikeret status_definition) — ikke NY
> - Tilbudsnumre bruger separat T-nummerserie (quote_number_prefix + quote_number_next)
> - Mail-vedhæftninger: separat upload-endpoint (`/api/attachments/upload`) → `attachment_id` reference i JSON mail-send
> - To attachment-tabeller: `attachments` (generisk) + `mail_attachments` (mail-specifik) — begge bruges ved udgående mail
> - busboy (rent JS) til multipart parsing — godkendt npm-pakke
> - jsPDF selvhostet i `assets/` (CDN ustabil)
> - Kostpris fra Grocy fulfillment `costs` (beregnet fra ingredienser), ikke `costprice` userfield
> - Firma-dedup: EAN-merge først (sikkert), derefter CVR-berigelse — merge IKKE på CVR (afdelinger under samme juridiske enhed er separate firmaer)
> - CVR-opslag: Virk ElasticSearch (primær, ingen rate limit) + NemHandel (EAN) + cvrapi.dk (fallback, har rate limit)
> - `legal_name` på companies: juridisk navn fra CVR, vises i fakturering
> - sync-v1.js: bevarer CVR/legal_name/notes ved update, matcher på EAN for mergede firmaer
> - Bestilling: `siteId` i JS = Ristet Rugs lokation (HQ/Trailer), `grocyLocationId` = Grocy shopping_location — DB-kolonner forbliver `location_id`/`grocy_location_id`
> - Bestilling: ét leverandørkort pr. `grocy_location_id` (ikke pr. supplier) — Inco har 2 handelssteder = 2 kort
> - Bestilling: `integration_type` driver adfærd — `api` (Hørkram kurv), `webshop` (åbn URL), `email`/`manual` (kopiér/mail/ring), `intern` (produktionsbon)
> - Bestilling: V2 afgiver ALDRIG ordren — kun `putBasketProducts()`, brugeren godkender på hoka.dk
> - Bestilling: inline leverandør-kobling i indkøbsvisning (link-panel med favorites-first søgning)
> - Indkøb: `shopping_list.js` + `bestilling.js` erstattes af `indkob.js` — kunstig opdeling fjernes
> - Indkøb: to tabs i purchasing.html — `[ Indkøb ]` og `[ Varemodtagelse ]` (3 tabs → 2)
> - Indkøb: accordion som standard, toggle til fokus-visning per leverandørgruppe
> - Indkøb: chips (inline pakkeform/leverandør) efter varenavn — ikke separate pills nedenunder
> - Indkøb: multi-leverandør per vare via chips — Burgerlommer viser Serviwet + Hørkram + Inco
> - Indkøb: barcode-sortering — `is_preferred` → aftale → billigst pr. kg
> - Indkøb: pris pr. kg som standard (Grocy har kg som grundenhed på alle varer)
> - Indkøb: auto-genererede INT-varenumre for leverandører uden katalog (fx Oluf/Trykkerifriheden)
> - Indkøb: `integration_type: 'intern'` på suppliers (RR Produktion) — kun i V2, ikke Grocy
> - Indkøb: bestilte varer forbliver på listen med "Bestilt"-badge + dato, kollapseret i bunden af gruppe
> - Indkøb: Manglende + Udløbende er inline expandable banners (mini-lister, ikke modaler)
> - Varemodtagelse: delvis modtagelse reducerer Grocy shopping_list qty (slet IKKE hele linjen)
> - Varemodtagelse v3: `POST /api/goods-receipts` (ét kald) — erstatter gammel `receiving/complete`
> - Varemodtagelse: fødevarekontrol + Grocy lager i ét flow, data fra shopping list (ikke PO)
> - Varemodtagelse: Whiteboard notificeres via webhook (link-only foto), fejl blokerer ikke
> - Staff-tabel: manuelle medarbejdere, merged med Smartplan employees i frontend (som Whiteboard)
> - Staff: `received_by_name` TEXT snapshot (ikke FK), Smartplan-brugere gemmes ikke i DB
> - Settings: indkøbsindstillinger er ét fælles komponent (`indkob_settings.js`) monteret to steder — slide-in panel i kitchen (⚙ knap), fuld side i office Settings → Indkøb
> - Settings: kitchen-panel er zone-aware (viser kun indkøbs-relevante settings), office viser det samme + systemindstillinger
> - Settings produkter: konfigurerbar tabel med kolonne-chips — præferencer gemmes i localStorage
> - Settings Hørkram: prisopdatering er manuelt trigger ("Opdater nu") + valgfri daglig cron via `system_settings`
> - ~~`routes/purchasing.js` mangler CRUD endpoints~~ — implementeret i Fase 6c
> - Hoka basket PUT format: `SalesUnit: { Code, Quantity }` — bekræftet fra hoka.dk's egen frontend (IKKE `SalesUnitIndex`). Eksisterende varer i kurven re-sendes UDEN SalesUnit (Hoka bevarer den valgte enhed). Nye varer sendes med SalesUnit fra snapshot. Basket-ID caches i `sessionCache.basketId`. PUT erstatter hele kurven → altid merge eksisterende + nye.
> - Ordremail til leverandør: rigtig SMTP via kontakt@ristetrug.dk (ikke mailto-link). Sendes automatisk ved "Send & bestil". Skabelon `order_email` redigerbar i Settings → Mail.
> - Dropsize: advarsel kun (gult banner), blokerer IKKE bestilling. Parser Hoka's danske talformat.
> - CO2: vises per vare (🌱 badge) + samlet i gruppe-header. Data fra Hoka snapshot `Co2Equivalent`.
> - Ugeoversigt: selvstændigt office-view (ikke tab i kalender) — `office/views/ugeoversigt.js`
> - Ugeoversigt: kapacitetsberegning kører ALTID (dagsniveau: workload/persontimer). Feature-flag styrer kun detaljerede slots.
> - Ugeoversigt: workload = `total_units > 0 ? total_units : pax` (som kalenderen)
> - Ugeoversigt: produktionsvindue = `production_start_time` → seneste pickup/delivery, minimum 1 time
> - Ugeoversigt: status-filtre med localStorage persistens — brugeren vælger selv (default: alle ekskl. AFLYST)
> - Sync-v1: `parseV1Date()` bruger lokale getters (ikke UTC `toISOString`) — v1 gemmer UTC men repræsenterer dansk lokal tid

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

### ~~OPGAVE Flyver (done): Nødbesked-system~~

**Formål:** Send urgente beskeder fra en bon, modtages som blinkende rødt banner på alle kitchen-views.

- `shared/flyver.js` + `shared/flyver.css` — send-modal, banner, detail-modal, SSE-handler
- `db/migrations/009_notification_client_reads.sql` — client_id på notification_reads
- `routes/notifications.js` — GET /api/notifications/unread
- `routes/bons.js` — POST .../notifications/:nid/read + logChange + auto-kvittering for afsender
- `shared/utils.js` — `getClientId()` (UUID i localStorage, fremtidskompatibel med auth)
- Flyver-entries i historik med ✈-ikon

---

### ~~Refaktorering: Split bon_kort.js (done)~~
- [x] `shared/bon_kort_builder.js` — DOM-bygning (VIEW_MODULES, VIEW_ACTIONS, createCard, 12 _build* funktioner)
- [x] `shared/bon_kort.js` — Adfærd/state (buildStatusBar, setStatus, DnD, select, kitchen-edit, picker, sammentælling)
- [x] HTML-filer opdateret (today.html, later.html)



### ~~OPGAVE 6 (done): Indkøb & Bestilling~~

**Implementeret som Fase 6a.** Se "Fase 6 — Indkøb & Bestilling" sektionen ovenfor.
`kitchen/purchasing.html` har 3 tabs: Indkøbsliste, Bestilling, Varemodtagelse.
Bestilling og Varemodtagelse er nye i denne fase.

---

## API-base reference

```
GET    /api/bons/today                                   routes/kitchen.js
GET    /api/bons/later?days=28                            routes/kitchen.js
GET    /api/bons/calendar?year=&month=&status=            routes/kitchen.js
GET    /api/bons/planning?from=&to=&status=              routes/kitchen.js
GET    /api/bons/planning/ingredients?ids=               routes/kitchen.js
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
GET    /api/grocy/recipes-nestings                       routes/grocy.js → grocyAdapter
GET    /api/grocy/recipes-pos/all                        routes/grocy.js → grocyAdapter
POST   /api/grocy/recipes                                routes/grocy.js (opret opskrift)
PUT    /api/grocy/recipes/:id                            routes/grocy.js (opdater opskrift)
PUT    /api/grocy/recipes/:id/userfields                 routes/grocy.js (opdater userfields)
POST   /api/grocy/recipes-pos                            routes/grocy.js (tilføj ingrediens)
PUT    /api/grocy/recipes-pos/:id                        routes/grocy.js (opdater ingrediens)
DELETE /api/grocy/recipes-pos/:id                        routes/grocy.js (slet ingrediens)
POST   /api/grocy/recipes-nestings                       routes/grocy.js (tilføj underopskrift)
PUT    /api/grocy/recipes-nestings/:id                   routes/grocy.js (opdater underopskrift)
DELETE /api/grocy/recipes-nestings/:id                   routes/grocy.js (slet underopskrift)
POST   /api/grocy/consume                                routes/grocy.js (consume via recipe lines)
POST   /api/grocy/consume-products                       routes/grocy.js (consume via per-produkt)
DELETE /api/grocy/cache                                  routes/grocy.js (ryd cache)
GET    /api/smartplan/shifts?from=&to=                    routes/smartplan.js
GET    /api/smartplan/employees                           routes/smartplan.js
DELETE /api/smartplan/cache                               routes/smartplan.js
POST   /api/bons/:id/notifications/:nid/read             routes/bons.js
GET    /api/notifications/unread?client_id=               routes/notifications.js
POST   /api/auth/login          { email, password }      routes/auth.js
POST   /api/auth/pin            { pin, user_id? }        routes/auth.js
GET    /api/auth/pin-users                               routes/auth.js (public)
POST   /api/auth/logout                                  routes/auth.js
GET    /api/auth/me                                      routes/auth.js
GET    /api/payment-types                                routes/payment_types.js
GET    /api/companies?q=                                 routes/companies.js
GET    /api/companies/:id                                routes/companies.js
POST   /api/companies                                    routes/companies.js
GET    /api/cvr/:cvr                                     routes/cvr.js
GET    /api/cvr/search?q=                                routes/cvr.js
GET    /api/price-categories                             routes/price_categories.js
POST   /api/addresses                                    routes/addresses.js
PATCH  /api/bons/:id            { ...fields }            routes/bons.js
DELETE /api/bons/:id/lines/:lid                          routes/bons.js
POST   /api/webhooks/bestilling  (ingen auth, altid 200) routes/webhooks.js
GET    /api/users                                       routes/users.js (admin)
POST   /api/users                                       routes/users.js (admin)
PATCH  /api/users/:id                                   routes/users.js (admin)
POST   /api/users/:id/password                          routes/users.js (admin)
GET    /api/mail/templates                               routes/mail.js (admin)
PATCH  /api/mail/templates/:key                          routes/mail.js (admin)
POST   /api/mail/test                                    routes/mail.js (admin)
GET    /api/settings/locations                           routes/settings.js
GET    /api/dashboard/today                              routes/dashboard.js
GET    /api/dashboard/stats?days_back=&days_forward=     routes/dashboard.js
GET    /api/dashboard/top-products?from=&to=             routes/dashboard.js
GET    /api/dashboard/weather                            routes/dashboard.js (placeholder)
GET    /api/crm/pipeline?category=                      routes/crm.js
PATCH  /api/crm/pipeline/:id/move  { column }          routes/crm.js
POST   /api/price-categories                             routes/price_categories.js (admin)
PATCH  /api/price-categories/:id                         routes/price_categories.js (admin)
POST   /api/payment-types                                routes/payment_types.js (admin)
PATCH  /api/payment-types/:id                            routes/payment_types.js (admin)
GET    /api/invoices/queue?include_done=1                routes/invoices.js
PATCH  /api/companies/:id/economic                       routes/companies.js
PATCH  /api/customers/:id/economic                       routes/customers.js
GET    /api/quotes                                       routes/quotes.js (is_offer=1 bons)
GET    /api/quotes/next-number                           routes/quotes.js
GET    /api/quotes/:id                                   routes/quotes.js
POST   /api/quotes                                       routes/quotes.js (opret tilbud)
PATCH  /api/quotes/:id                                   routes/quotes.js (opdater tilbud)
DELETE /api/quotes/:id                                   routes/quotes.js (kun draft)
POST   /api/quotes/:id/lines                             routes/quotes.js
PUT    /api/quotes/:id/lines/:lid                        routes/quotes.js
DELETE /api/quotes/:id/lines/:lid                        routes/quotes.js
PATCH  /api/quotes/:id/status                            routes/quotes.js
POST   /api/quotes/:id/convert                           routes/quotes.js (tilbud → bon)
POST   /api/attachments/upload                             routes/attachments.js (multipart)
GET    /api/attachments/:id/download                       routes/attachments.js
GET    /api/attachments/mail/:id/download                  routes/attachments.js
GET    /api/purchasing/suppliers?location_id=               routes/purchasing.js
GET    /api/purchasing/suppliers/grocy-locations            routes/purchasing.js
POST   /api/purchasing/suppliers/grocy-locations            routes/purchasing.js
DELETE /api/purchasing/suppliers/grocy-locations/:id        routes/purchasing.js
GET    /api/horkram/health                                 routes/horkram.js
GET    /api/horkram/search?q=                              routes/horkram.js
GET    /api/horkram/products/snapshots?ids=&date=          routes/horkram.js
PUT    /api/horkram/basket                                 routes/horkram.js
GET    /api/horkram/delivery-dates                         routes/horkram.js
POST   /api/horkram/order                                  routes/horkram.js
GET    /api/horkram/orders                                 routes/horkram.js
GET    /api/orders/pending                                 routes/orders.js
GET    /api/orders/pending/:id                             routes/orders.js
POST   /api/orders/pending                                 routes/orders.js
PUT    /api/orders/pending/:id                             routes/orders.js
DELETE /api/orders/pending/:id                             routes/orders.js
GET    /api/orders/archive                                 routes/orders.js
GET    /api/orders/pending/:id/mail                        routes/orders.js
POST   /api/orders/pending/:id/mail                        routes/orders.js
PATCH  /api/orders/pending/:id/mail/read                   routes/orders.js
GET    /api/orders/mail-threads?unread_only=               routes/orders.js
POST   /api/receiving/complete                             routes/receiving.js (legacy)
GET    /api/receiving/log                                  routes/receiving.js (legacy)
GET    /api/goods-receipts/users                           routes/goods-receipts.js
POST   /api/goods-receipts/photo                           routes/goods-receipts.js
POST   /api/goods-receipts                                 routes/goods-receipts.js
GET    /api/goods-receipts                                 routes/goods-receipts.js
GET    /api/goods-receipts/:id                             routes/goods-receipts.js
GET    /api/staff                                          routes/staff.js
POST   /api/staff                                          routes/staff.js (admin)
PATCH  /api/staff/:id                                      routes/staff.js (admin)
DELETE /api/staff/:id                                      routes/staff.js (admin)
GET    /api/grocy/product-barcodes                         routes/grocy.js
POST   /api/grocy/product-barcodes                         routes/grocy.js
DELETE /api/grocy/product-barcodes/:id                     routes/grocy.js
PUT    /api/grocy/shopping-list/:id                        routes/grocy.js
GET    /api/schedule/week?from=&to=                        routes/schedule.js
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
