# CLAUDE.md — Bon v2
> Læs dette FØR du skriver en eneste linje kode.
> Opdateres efter hver session under "Status" og "Næste opgave".

---
## Ved opstart — læs disse filer
- docs/BON_V2_PRINCIPPER.md (specielt sektion 6b+6c — moms-doktrin)
- docs/bon_v2_datamodel_v2.md
- docs/bon_v2_zoner_og_layout.md
- docs/CLAUDE_TILBUD_PRIS.md (hvis du rører pris/moms eller tilbud)
- docs/CLAUDE_KONTAKTER.md (hvis du rører CRM, firmaer eller kontaktpunkter)
- docs/CLAUDE_MOMS_AUDIT.md + CLAUDE_MOMS_AUDIT_AUTO.md (audit-værktøjer + automatisering)
- docs/CLAUDE_CO2.md (hvis du rører CO₂ — F0–F7 er bygget; §1 kildehierarki + §3 `na` + §7 motor)
- docs/CLAUDE_ECONOMIC_ADAPTER.md (spec — ikke bygget endnu)
- docs/CLAUDE_MENU_AGENT.md (spec — ikke bygget endnu)

### Scan for nye specs
Kør `ls docs/CLAUDE_*.md docs/**/CLAUDE_*.md 2>/dev/null` ved sessionsstart for at
se ALLE eksisterende specs — ikke kun dem listet ovenfor. Læs dem der er relevante
for opgaven. Når brugeren refererer "min spec til X", er den næsten altid en
`docs/CLAUDE_X*.md`-fil — find og læs den før du gætter.

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
**Produktion kører på `grocy-hq`** (`https://grocy-hq.ristetrug.dk/api`) — det er dér al
CO₂-data, faktorer og opskrifter ligger.

`default_grocy_location_id` i settings-tabellen styrer hvilken der er aktiv. En frisk
database seedes til **3 (Test)** — en ny installation må aldrig som default skrive i
produktions-Grocy. Skift via Settings → Grocy ("Sæt som aktiv"), ikke via SQL.

Lokationer i `locations`-tabellen: **HQ=grocy-hq** (produktion), Trailer=grocytrailer,
Test=grocytest. Produktion har desuden en `cafe`-lokation = `grocycafe` = **den gamle
HQ-instans** (udfaset — læs den ikke som "HQ"). `.env` har nøgler til begge:
`GROCY_HQ_*` (grocy-hq) og `GROCY_CAFE_*` (grocycafe).

> ⚠️ Historisk fælde: HQ pegede tidligere på `grocycafe`. Både denne fil og
> `001_core.sql` sagde det længe efter flytningen, så hver frisk dev-DB pegede forkert
> (401) og CO₂-rapporten viste 0 % dækning. Rettet 16. juli 2026.

**Lokalt login (udvikling/browser-test):** Det rigtige `admin@ristetrug.dk`-password er
ikke kendt. Brug i stedet en dedikeret lokal test-admin:
`dev@ristetrug.dk` / `dev1234` (PIN `9999`, rolle admin). Den ligger i den lokale
`data/bon.db` (ikke i git) og persisterer mellem sessioner. Genskab/nulstil med
`npm run dev-admin` (`scripts/dev-admin.js` — idempotent, nægter at køre i production).
Test mod **syntetiske** data og ryd op bagefter — dev-DB'en har rigtige kunde-/mail-data.

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
IMAP polling hvert 5. minut — router mails via `#b-{num}` (bon) og `#k-{num}` (kunde) tags i emne. Tag-præfikserne styres af `mail_tag_*_prefix`-settings (bon `b-`, tilbud `t-`, kunde `k-`, indkøbsordre `po-`, leverandør `s-`) — adskilt fra bon-nummerets visnings-præfiks (`bon_number_prefix`, fx `B`).

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
│   ├── staff.js      ← /api/staff/* (medarbejder-CRUD)
│   ├── reports.js    ← /api/reports/* (rapporter: summary, monthly, top-customers, categories)
│   ├── cashflow.js   ← /api/cashflow/* (admin-only: CSV-upload, fakturaer, match, analyse)
│   ├── embed.js      ← /embed/bestilling, /embed/config, /embed/menus/:id (public, indlejres i WordPress)
│   ├── contact-points.js ← /api/contact-points/* (CRUD + toggle-public for kontaktpunkter)
│   ├── flags.js      ← /api/flags/* (entity_flags CRUD + ack/dismiss — påmindelser på kunder/firmaer)
│   └── delivery.js   ← /api/delivery/* (vehicles, booking, /calculate, /health, ruter — Spor 1+2)
├── services/
│   ├── grocyAdapter.js       ← Grocy API adapter med cache + CRUD + consume + barcodes
│   ├── hokaAdapter.js        ← Hørkram (hoka.dk) API adapter med cookie-jar auth
│   ├── ingredientResolver.js ← Rekursiv ingrediens-opløsning inkl. underopskrifter
│   ├── smartplanAdapter.js   ← Smartplan OAuth2 adapter (shifts + worklogs + employees)
│   ├── mailService.js        ← SMTP afsendelse + IMAP polling + tag-routing
│   ├── goodsReceiptWebhook.js ← Whiteboard webhook for varemodtagelse (fire-and-forget)
│   ├── receiptSchema.js      ← FVST-skemaet hentet fra Whiteboard (tavle → cache → indbygget)
│   ├── booking_template.js   ← Render template + variabler + cost-estimat (Spor 1)
│   ├── delivery_log.js       ← Booking-events + actual cost + sync delivery_method (Spor 1)
│   ├── routing.js            ← ORS vej-routing (getDistance/getRoute) + geo_calculations-cache (Spor 2)
│   ├── geocode.js            ← DAWA-geokodning af adresser (Spor 2)
│   ├── delivery_calc.js      ← Single-bon leverings-forslag: afstand + vogn-anbefaling (Spor 2)
│   ├── route_planner.js      ← Rute-orchestrator: computeRoute/applyRouteProposal (Spor 2)
│   ├── contactExtractor.js   ← Parse pasted HTML/tekst for emails+telefoner (paste-flow til scraping)
│   ├── companyMatcher.js     ← matchCompany (CVR → EAN → e-mail → navnelighed), similarity, normalizeName
│   ├── orderCompanyResolver.js ← Hvilket firma en web-/formular-bestilling lander på (#567+#607) — delt af web-orders + webhooks
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
│   ├── sse.js        ← SSE router + broadcast(), sendTo() — named events. 'connected' bærer serverens build-id
│   ├── tokens.css    ← Design tokens
│   ├── components.css
│   ├── bon_kort.js          ← Adfærd og state (status, DnD, select, groups, editing)
│   ├── bon_kort_builder.js  ← DOM-bygning (createCard, VIEW_MODULES, VIEW_ACTIONS, _build*)
│   ├── bon_kort.css
│   ├── calendar.js + calendar.css  ← Kalender/liste komponent
│   ├── planning.js + planning.css  ← Planlægningsbon (aggregering, vagtplan, action-knapper)
│   ├── logistik.js + logistik.css  ← Leveringsoversigt + rute-planlægning + Leaflet-kort + live-mode (Spor 2, delt køkken/office)
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
│   ├── manual_booking_modal.js + manual_booking_modal.css ← Bestil bud-modal (Spor 1: clipboard + URL)
│   ├── flag_strip.js                          ← Påmindelses-strip i bon-drawer (CLAUDE_KUNDE_FLAGS.md)
│   ├── kitchen-topbar.html         ← Fælles topbar for kitchen-views
│   ├── api.js        ← Frontend API-funktioner
│   ├── utils.js      ← Status-mapping, connectSSE(), mapApiBonToCardData(), scrollToBonHash(), "ny version"-bjælken
│   ├── moms.js       ← Moms-helpers (inclToExcl, momsOfIncl, computeMomsFields) — eksponeres som window.Moms i browser
│   ├── bon_lines.js  ← mergeLines() — slår ens bon-linjer sammen til visning/eksport, eksponeres som window.BonLines
│   ├── contactPoints.js ← syncPrimaryCache, clearOtherPrimaries, promoteNextPrimary, validateContactValue
│   ├── auth.js       ← requireAuth() middleware (server-side)
│   └── login.html    ← Fælles login-side (PIN + email auto-detect)
├── kitchen/          ← MPA: index.html, today.html, later.html, vagtplan.html, ...
├── office/           ← SPA-shell: index.html + views/*.js
├── mobile/           ← Mobil-shell: index.html + views/*.js (touch-first, bottom nav)
│   ├── index.html    ← Shell + 5-tab bottom nav + view-router
│   ├── login.html    ← PIN-pad login (bruger-vælger → PIN)
│   ├── manifest.json ← PWA manifest (standalone)
│   ├── mobile.css    ← Mobilspecifik CSS
│   └── views/        ← bons.js, modtag.js, lager.js, crm.js, oversigt.js, levering.js (courier-mobil)
├── settings/         ← index.html (eget shell)
├── assets/           ← logo.svg, icons/, fonts/
├── utils/
│   ├── buildId.js             ← Build-id ud fra nyeste mtime i klient-mapperne (driver "ny version"-beskeden)
│   └── mail-parser.js         ← PO-tag parsing + buildTag
├── scripts/
│   ├── set-password.js        ← Sæt password for bruger (engangsbrug)
│   ├── sync-v1.js             ← Daglig sync fra Bon v1 (cron)
│   ├── merge-ean-duplicates.js ← Merger firmaer med samme EAN
│   ├── enrich-cvr.js          ← CVR-berigelse via Virk ES + NemHandel
│   ├── fix-cvr.js             ← Manuel CVR-rettelse
│   └── backfill-geocode.js    ← Geokoder addresses uden coords via DAWA (Spor 2)
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
- **Statisk serving er en allowlist** — nye offentlige mapper skrives ind i
  `PUBLIC_DIRS` i server.js. Mount aldrig en mappe der også indeholder kode
  eller data (`express.static(__dirname)` lagde engang `data/bon.db` frit)
- **Standalone scripts bruger `openDb()`** fra `db/compat.js` — aldrig `DatabaseSync` direkte
- **Transactions via `transaction(db, fn)`** — aldrig `db.transaction()` (eksisterer ikke i node:sqlite)
- **`logChange({...})`** — objekt-API, aldrig positionelle argumenter
- **Nye npm-pakker kræver godkendelse** — spørg først, og ingen native/compiled pakker
- **Datoer: brug `todayISO()` / `offsetISO()` — aldrig `new Date().toISOString()`**
  - `new Date().toISOString().slice(0,10)` giver **UTC**-datoen. Mellem midnat og kl. 02
    dansk sommertid peger den på I GÅR. Fejlen viser sig kun om natten, så den opdages
    næsten aldrig — den har ramt bon-listens "I DAG"-filter, køkkenets dato-overskrift,
    tilbuds gyldighedsdato, fakturaers betalingsdato og optællingens session-nøgle.
  - Backend: `const { todayISO, offsetISO } = require('../db/helpers');`
  - Frontend: `todayISO()` · `offsetISO(n)` · `dateToISO(d)` fra `shared/utils.js`
  - Begge er forankret i `Europe/Copenhagen`, så frontend og backend altid er enige —
    og en tablet med forkert tidszone giver stadig den rigtige danske dato.
  - **Dato-aritmetik skal gå gennem `offsetISO()`.** Mønsteret
    `d = new Date(); d.setDate(d.getDate() + n); d.toISOString()` er lokal aritmetik
    efterfulgt af UTC-udtræk og er forkert på samme måde.
  - Pre-commit-hook (`scripts/check-utc-date.sh`) blokerer nye forekomster. Er UTC
    bevidst korrekt (versionsstempel, filnavn), så skriv `// utc-ok: <hvorfor>` på linjen.
  - Dækket af `tests/dato.test.js`, som **pinner tidspunktet** — ellers ville testen
    bestå 22 timer i døgnet uanset om koden var rigtig.
- **Moms-håndtering (autoritativ regel — sektion 6b+6c i `BON_V2_PRINCIPPER.md`)**
  - Grocy salgspriser ER incl. moms (alle `Salesprice*`-userfields på `recipes`)
  - Grocy råvarepriser + `costprice` (recipe fulfillment `costs`) er ex moms
  - `bon_lines.unit_price`, `bon_lines.line_total`, `bons.total_price`, `bons.delivery_price` er **INCL. moms**
  - `bon_lines.cost_price` er **EX moms**
  - **Undtagelse — `bon_lines.moms_included = 0`** (migration 104, kun udgiftslinjer på events):
    linjen ligger EX moms. Tjek ALTID flaget når en udgiftsbon skal omregnes; `total_price`
    er da ikke incl moms. To forbrugere gør det korrekt, hver på sin måde:
    `computeEventExpenses` (routes/events.js) summerer til ex moms til P&L'en, og
    `momsLoeft` (routes/cashflow.js) løfter til incl moms fordi banken flytter bruttokroner.
    Flaget er binært og kan IKKE udtrykke *momsfri* (0 %) — se issue #317.
  - Frontends regner ALDRIG selv moms — de bruger:
    - Pre-beregnede felter fra API (`total_incl_moms`, `total_excl_moms`, `moms_amount`)
    - Helpers fra `shared/moms.js` (også eksponeret som `window.Moms`): `inclToExcl`, `momsOfIncl`, `computeMomsFields`
    - Server-side: `db/helpers.js` re-eksporterer samme helpers
  - **Ingen magic `* 1.25` / `* 0.25` / `/ 1.25` uden for `shared/moms.js` og `tests/`** — pre-commit-hook blokerer det
  - E-conomic kræver linje-priser EX moms — `inclToExcl()` ved konvertering (jf. `CLAUDE_ECONOMIC_ADAPTER.md`)
  - Test-bonen T-5: 23.650 incl → 18.920 ex + 4.730 moms (i `tests/moms_audit_e2e.test.js`)
  - 7 visningsregler for labels (`Total inkl. moms`, `(ex moms)` osv.) i sektion 6c
- **Ens bon-linjer slås sammen — `shared/bon_lines.js` (`mergeLines`)**
  - `POST /api/bons/:id/lines` lagde historisk én række pr. "Tilføj"-klik, så samme vare
    kunne ligge som fx 6 × "1× Kartoflen slider". Kortet skjulte det med sin egen
    visnings-merge (`_sortAndMergeMenu` i `shared/utils.js`), mens mail, info-modal,
    pakkeliste og fakturaudkast viste de rå rækker — kunden fik 18 linjer à 1 stk.
  - Ruten slår nu sammen ved indsættelse (samme vare, pris, kategori, enhed, ingen
    gruppe, intet særønske). Gamle bons har stadig dublet-rækker i DB.
  - **Derfor: enhver flade der viser linjer for et menneske kører gennem
    `mergeLines()`** — mail (3 kopier af `_buildMailVars`/`buildVars`),
    info-modal, pakkeliste, flyver, fakturerings-tabel, e-conomic-udkast, mobil.
    To endpoints merger server-side, fordi flere frontends spiser samme svar:
    `GET /api/crm/customer-orders/:id` (kundekort i office + mobil) og
    chauffør-rutens `stops[].items` i `routes/delivery.js`.
    Editorer (bon-drawer) viser bevidst rå rækker — man skal kunne slette den enkelte.
  - **Særønsker slås ALDRIG sammen** — også to identiske. Et særønske er en
    selvstændig besked til køkkenet.
  - Dækket af `tests/bon_lines.test.js` (`node --test tests/bon_lines.test.js`)
  - **Oprydning af gamle dublet-rækker**: `scripts/merge-duplicate-bon-lines.js`
    (dry-run som standard, `--apply` skriver). Tager backup via `VACUUM INTO`,
    kører i én transaktion og ruller alt tilbage hvis antal stk eller linjesum
    flytter sig på blot én bon. Fakturerede bons fredes medmindre
    `--include-invoiced` — deres linjer skal matche den sendte faktura.
- **Historikken må aldrig dumpe maskin-payloads** (`_buildChangelogEntry` i `shared/modal.js`)
  - `changelog` bærer både menneske-ændringer og revisionsspor for maskiner.
    `grocy_consume` skriver hele results-arrayet (30+ produkter) i `new_value`, og den
    generiske gren viste det råt — én entry fyldte modalen og skjulte al anden historik.
  - `grocy_consume` har nu sin egen renderer (`_buildConsumeDetail`): tællende
    opsummering + produktlisten i en foldet `<details>`. Håndterer rå array,
    `{state,results}`-indpakning og sentinel'en `event_prep_owns_stock`.
  - Den generiske gren afkorter værdier ved 300 tegn (`_clipChangelogValue`), så den
    næste maskin-payload ikke gentager problemet.
  - `notes` vises under ændringen — booking- og leverings-entries lægger forklaringen
    der og kun rå id'er i `new_value` ("Køretøj: 7").

---

## Opgave- og projekt-tracking (GitHub)

Opgaver, bugs og projekter trackes i **GitHub issues** på `liffez/bon-v2` (etableret 2. juni 2026).
Tidligere lå det spredt i denne fils "Åbne afhængigheder", MEMORY.md og docs/-mapper — nu ét sted.

- **Board:** GitHub Projects "Bon v2" — <https://github.com/users/liffez/projects/3>
  - Kolonner (Status-felt): `Backlog` · `Klar` · `I gang` · `Review` · `Done`
- **Labels:** `deploy`, `afventer-ekstern`, `bug`, `sikkerhed`, `tech-debt`, `test`, `feature`, `projekt` (epic)
- **Epics** (`projekt`-label) = store projekter, hver med fase-checkliste. De fleste har
  en spec i `docs/` — enten en mappe eller en enkelt fil:
  - #81 Festival / multi-lokation (`docs/festival/`)
  - #82 Form Builder (`docs/formbuilder/`)
  - #83 Kunde-portal (`docs/kunde-portal/`)
  - #88 CO₂-aftryk pr. bon + ESG-datagrundlag (`docs/CLAUDE_CO2.md` + `docs/co2/`)
  - #232 CRM-triks — top-of-mind køer (`docs/CLAUDE_CRM_TRIKS.md`)
  - #259 Leverings- & adressedata-oprydning (`docs/delivery/`)
  - #264 Aggregerede vare-egenskaber på bon — allergener + diæt + øko% (ingen samlet
    spec; trackes via sub-issues #260–262)
  - #272 Mellemprodukter — forecast (RR) vs. lav-hvis-mangler (`docs/CLAUDE_HURTIG_PRODUKTION.md`)
  - #471 Indkøb Fase A — salgsenhed, pris, leveringsdato (`docs/indkob/CLAUDE_INDKOB_FASE_A.md`)
  - #555 Køkken-kiosk — fastmonteret touchskærm med dagsrytme (`docs/CLAUDE_KIOSK.md`)
  - docs/-specs forbliver source-of-truth; epics linker til dem og tracker fremdrift via checkbokse.
  - Listen her går let bagud. Den aktuelle er:
    `gh issue list --state open --limit 200 --json number,title,labels --jq '.[] | select(.labels|map(.name)|index("projekt")) | "#\(.number) \(.title)"'`
    (`--label projekt` og `--search` returnerer pt. tomt — GitHubs søgeindeks svarer ikke
    for dette repo, mens direkte listning virker.)

**Arbejdsgang:**
- Ny bug/opgave dukker op → opret et issue (ikke kun en note i chat eller docs)
- Når noget løses → `Closes #N` i PR-bodyen lukker issuet automatisk ved merge, eller kryds fase-checkbox af
- Relaterede issues grupperes via GitHub **sub-issues** (parent/child) — fx delopgaver under en epic

---

## Deploy-flow

Standard-arbejdsgang ved slutningen af en Claude Code-session der har lavet ændringer:

> **STOP-regel — luk ALDRIG en opgave ned af dig selv.**
> Claude må **ikke** committe, pushe, oprette PR, merge eller på anden måde betragte
> arbejdet som færdigt/afsluttet, før brugeren udtrykkeligt har sagt til.
> Når koden er klar: opsummér hvad der er lavet, og **spørg** om der skal committes/pushes/PR'es.
> Vent på et klart "ja" (eller en specifik instruktion) før du kører nogen af kommandoerne nedenfor.
> Hold sessionen åben og afvent næste besked — afslut den ikke selv.

> **TEST FØR MERGE (standard fra 10. juni 2026):** Brugeren tester ændringen i drift
> FRA BRANCHEN, FØR der merges. Merge er ALTID sidste skridt, efter godkendelse i drift.
>
> **MERGE SLETTER ALDRIG BRANCHEN (opdateret 15. juni 2026):** Brug `gh pr merge --squash`
> UDEN `--delete-branch`. Tidligere slettede merge branchen → worktreen → sessionen forsvandt
> netop når brugeren opdagede noget der skulle rettes. Nu overlever branch + worktree + session
> merge. Branch-oprydning er et SEPARAT, bevidst trin (se "Branch-oprydning" nedenfor) — aldrig
> en bivirkning af merge.
>
> **Claude leverer ALTID de præcise terminal-kommandoer** brugeren skal køre på
> Hetzner ved hvert trin (test fra branch / hent rettelser / skift tilbage til main) —
> kopier-klar med det rigtige branch-navn indsat, så brugeren ikke selv skal regne
> git-flowet ud.

**Claude gør — KUN efter brugerens go:**
```bash
git commit -m "..."                                    # commit-besked beskriver hvad + hvorfor
git push -u origin <branch>                            # branch er typisk claude/<navn>
gh pr create --base main --title "..." --body "..."    # PR-body fungerer som changelog
# ── STOP: vent på at brugeren har testet fra branchen og godkendt i drift ──
gh pr merge --squash                                   # SIDSTE skridt — UDEN --delete-branch (sessionen overlever)
```

**Bruger gør (SSH'et ind på Hetzner-serveren som `leif`):**

*Trin 1 — test fra branchen (før merge):*
```bash
cd ~/bon-v2                                # = /home/leif/bon-v2
git fetch origin
git checkout claude/<branch>               # Claude indsætter det rigtige branch-navn
sudo systemctl restart bon-v2              # kun ved kode-ændringer (ikke kun docs)
```

*Trin 2 — hvis Claude pusher rettelser til samme branch undervejs:*
```bash
cd ~/bon-v2
git pull                                   # branchen tracker allerede origin
sudo systemctl restart bon-v2
```

*Trin 3 — efter godkendelse og Claudes merge → tilbage til main:*
```bash
cd ~/bon-v2
git checkout main
git pull
sudo systemctl restart bon-v2              # main = det testede + squash, genstart for en sikkerheds skyld
```

**Branch-oprydning (separat trin — aldrig ved merge):** Fordi merge ikke længere sletter
branchen, hober merged branches sig op på origin. Ryd op bevidst, i ro — ikke midt i en session.
Kør status-scriptet for at se hvad der kan slettes:

```bash
cd ~/bon-v2 && ./scripts/status.sh
```

Det viser server-branch + deployet commit, branches hvis indhold allerede er i main (kan
trygt slettes, med kopier-klare `git push origin --delete`-linjer) og branches med ændringer
der IKKE er i main (tjek før sletning). Ren git — ingen `gh`/intet at installere (serveren har
ikke `gh`). Bemærk: pga. squash-merge kan `git branch --merged` IKKE bruges — scriptet tjekker
i stedet om branchens egne ændringer allerede ligger i main (syntetisk commit-tree + `git cherry`).

**Forbehold ved branch-test:** branches med nye `db/migrations/`-filer kører migrationen
ved restart — vær påpasselig med at hoppe frem/tilbage mellem branch og main ved
migrations-PR'er (migrationen ruller IKKE tilbage ved checkout af main). Husk også
hård browser-refresh (Cmd+Shift+R) efter deploy — JS/CSS kan være cachet.

> ⚠️ **Genstart ÉN gang, og vent.** `systemctl restart` flere gange hurtigt efter
> hinanden kan starte to server-processer oven i hinanden, som begge kører
> migrationerne. Det væltede produktionen 20. august 2026 (se "Migrations er
> alt-eller-intet" nedenfor). Tjek med `systemctl is-active bon-v2` i stedet for
> at genstarte igen.

**Regler:**
- Migrations kører automatisk ved server-start. Hvis commit'en indeholder en ny `db/migrations/`-fil → genstart kræves
- Settings-ændringer der peger på Grocy/Smartplan/SMTP kræver ikke genstart (læses ved hver brug eller har egen cache-invalidation)
- Hvis PR'en kun rører `docs/`, `*.md` eller `tests/` → ingen `git pull` på server nødvendig

**Hvilke tests kan køres HVOR (vigtigt — spar dig selv turen):**

| Type | Kommando | Server? | Hvorfor |
|---|---|---|---|
| Pure runnere | fx `npm run test:run-optaelling` | ✅ ja | Ingen server, ingen Grocy, ingen DB — kører hvor som helst |
| Track-runnere | `test:run-*`, `test:inv` m.fl. | ⚠️ nej | Kræver `.env.test` + `test.db` + testserver på 4322 + grocytest |
| UI-tests | `test:ui*` (Playwright) | ❌ **nej** | `@playwright/test` er en **devDependency** og er ikke installeret i drift. Den ville trække ~150 MB Chromium ned på produktionsmaskinen. Kør dem lokalt. |

`npm run test:ui-optaelling` på serveren giver `sh: 1: playwright: not found` — det er
**forventet og korrekt**, ikke en fejl der skal rettes. UI-tests hører til på
udviklingsmaskinen (eller i CI), ikke på Hetzner.

**Track-runnere skal logge ind (siden #316).** Den globale auth-gate på `/api` betyder at
enhver klient — også en test-runner — skal have en session, ellers svarer alt 401 og
runneren dør ved første kald. Brug den delte helper, ikke en ny kopi:

```js
const { login, withSession } = require('./helpers/login');

let _session = null;
async function doLogin() {
    _session = withSession(SERVER_URL, await login(SERVER_URL));
}
async function api(method, pathPart, body = null) {
    if (!_session) throw new Error('api() kaldt før doLogin()');
    return _session(method, pathPart, body);
}
```

`await doLogin()` kaldes tidligt i `main()`. **Husk også de rå `fetch()`-kald** — de går
uden om `api()` og rammer gaten (fanget i T_PLAN, hvor to tests fik 401 i stedet for 400).

Runnere der taler direkte til DB eller adapteren (T_DB, T_ECON, T_ECONOMIC, T_GROCY,
T_RECONCILE) rører aldrig `/api` og er upåvirkede.

**`.env.test` hører ikke på serveren.** Den er gitignored og er et udviklingsartefakt.
Tjek med `ls -la ~/bon-v2/.env.test` og slet den hvis den er der.

Fælden er konkret: `.env.example` er skabelonen for **produktion** og sætter
`NODE_ENV=production` + `DB_PATH=./data/bon.db`. Gør man `cp .env.example .env.test` —
den nærliggende bevægelse, når der ikke findes en test-skabelon — peger "testmiljøet"
dermed på driftens database. Præcis dét var sket på Hetzner (#338).

Brug derfor **`.env.test.example`** som udgangspunkt. Den sætter `DB_PATH=./data/test.db`,
`NODE_ENV=test` og `GROCY_API_URL` mod grocytest — de tre `safety_check` kigger efter.

`npm run test:migrate` er siden #338 garderet med `--require-test-env`, som kalder
`safety_check` og afbryder (exit 2) hvis `NODE_ENV`/`DB_PATH`/`GROCY_API_URL` ikke peger på
test. Guarden er **opt-in via flaget**, fordi `db/migrate.js` også bruges legitimt i
produktion — `npm run migrate` og server-start er uændrede.

**Datoer i tests: brug `todayISO()` fra `db/helpers.js`,** ikke `new Date().toISOString()`.
UTC-datoen er gårsdagens mellem midnat og kl. 02 i dansk sommertid, så en test der sætter
`delivery_date = TODAY` og spørger efter `/today` fejler kun om natten. Ramte T_KITCHEN_TODAY;
~20 andre steder i test-runnerne har stadig mønstret (se #133).

Lokalt, første gang:
```bash
npm i -D @playwright/test && npx playwright install chromium
npm run test:ui-optaelling
```

Det du reelt skal teste **på serveren**, er selve UI'et i browseren. Playwright-spec'en er
en sikkerhedssnor for fremtidige ændringer — ikke en erstatning for at kigge på det i drift.

**Issue-lukning (commit ≠ luk):**
- `Closes #N` i PR-bodyen → **kun** når issuet er fuldt løst af denne ændring (features, bugs, tech-debt). Lukker automatisk ved squash-merge til `main` — aldrig på en løs commit.
- `Refs #N` → når PR'en kun rører *en del* af et issue (fx en delopgave under et epic) uden at afslutte det. Lukker ikke.
- Deploy-/ops-/`afventer-ekstern`-/sikkerheds-issues lukkes **manuelt** efter den fysiske handling er bekræftet (server-kommando kørt, credential roteret, ekstern nøgle modtaget) — aldrig af en commit. Eksempel: #69 (malware-postinstall) — kode-fjernelsen er committet, men issuet forbliver åbent indtil credential-rotation + server-oprydning er gjort.

**Bagudkompat hvis flowet kommer galt af sted:**
- Hvis `gh pr merge` fejler med "main is already used by worktree": PR'en er sandsynligvis allerede merged via UI eller en anden måde — tjek med `gh pr view <num> --json state`
- Hvis Hetzner pull fejler med merge-conflict: nogen har lavet ændringer direkte på serveren — undersøg med `git log origin/main..HEAD`

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
| `hk_brand` | text_single_line | Hørkram scraper | Brand fra Hørkram-katalog. |
| `hk_country` | text_single_line | Hørkram scraper | Oprindelsesland fra Hørkram. |
| `hk_gtin` | text_single_line | Hørkram scraper | GTIN/EAN fra Hørkram. |
| `hk_image` | text_single_line | Hørkram scraper | URL til produktbillede. |
| `hk_manufacturer` | text_single_line | Hørkram scraper | Producent fra Hørkram. |
| `hk_markings` | text_single_line | Hørkram scraper | Mærkninger (Ø-mærke, Fairtrade osv.). |
| `hk_organic` | text_single_line | Hørkram scraper | Økologisk status fra Hørkram. |
| `hk_allergens` | text_single_line | Hørkram scraper | Allergener fra Hørkram. |
| `hk_price_per_unit` | text_single_line | Hørkram scraper | Pris pr. salgsenhed fra Hørkram. |
| `hk_url` | text_single_line | Hørkram scraper | Direkte link til produktet på hoka.dk. |

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
| `Co2e` | number-decimal | VarePicker, CO₂-modul | CO₂-aftryk pr. enhed. **Udfyldes IKKE i hånden** — det er F5-motorens cache, skrevet af `scripts/co2-f5-compute.js --apply` (Σ ingrediens-kg × faktor). Kun komplette opskrifter får et tal; resten står tomt (ærligt). Frontenden fryser værdien på `bon_lines.co2e` ved bon-oprettelse. |
| `costprice` | number-decimal | VarePicker | Kostpris (fallback — primært bruges Grocy fulfillment `costs`) |
| `Oeko` | checkbox | VarePicker | Økologisk markering |

### products (entity: products)

| Userfield | Type (Grocy) | Bruges af | Beskrivelse |
|-----------|-------------|-----------|-------------|
| `HverDag` | text-single-line | Lageroptælling | Interval i dage for check-frekvens |
| `LastCheckedAt` | datetime | Lageroptælling, lageroversigt, varemodtagelse | ISO timestamp (UTC, `Z`) for sidst-tjekket. Skrives af optællingens "Gem og luk", varemodtagelsen (#336) og lageroversigtens "Gem" — også uden ændring (#613). |
| `LastCheckedUnit` | text-single-line | Lageroptælling | Hvilken fysisk enhed der sidst blev talt. **Kun optællingen (og varemodtagelsen) skriver den** — lageroversigten kender ikke den fysiske enhed og rører den aldrig (#613). |
| `co2e_per_kg` | number-decimal | CO₂-modul (F1+) | Resolvet CO₂-faktor, kg CO₂e/kg. Fyldes ved import (F4/F3). |
| `co2e_source` | text-single-line | CO₂-modul (F1+) | `klimadb` \| `material` \| `supplier` \| `manual` \| `na` |
| `co2e_klima_id` | text-single-line | CO₂-modul (F1+) | CONCITO Ra-ID (NULL hvis ikke fødevare) |
| `co2e_material` | text-single-line | CO₂-modul (F1+) | Emballage-materiale (`pap`, `LDPE`, …) — NULL for fødevarer |
| `co2e_version` | text-single-line | CO₂-modul (F1+) | Kildeversion (fx `CONCITO v1.2`) |
| `Co2e_OLD` | number-decimal | (deprecated) | Tidligere `Co2e` — bevist upålideligt (blandede enheder). Omdøbt i CO₂ F1, læses ikke. Erstattet af `co2e_per_kg`. |
| `supplier_price_per_kg` | text_single_line | Hørkram scraper | Indkøbspris pr. kg fra leverandør |
| `price_updated_at` | text_single_line | Hørkram scraper | Timestamp for prisopdatering |
| `hk_organic` | text_single_line | Hørkram scraper | Økologisk status fra Hørkram |
| `hk_country` | text_single_line | Hørkram scraper | Oprindelsesland fra Hørkram |
| `hk_allergens` | text_single_line | Hørkram scraper | Allergener fra Hørkram |
| `hk_co2e` | text_single_line | Hørkram scraper | CO2-aftryk pr. enhed fra Hørkram. |
| `hk_energy_kj` | text_single_line | Hørkram scraper | Energi (kJ) pr. 100g/100ml. |
| `hk_energy_kcal` | text_single_line | Hørkram scraper | Energi (kcal) pr. 100g/100ml. |
| `hk_fat` | text_single_line | Hørkram scraper | Fedt pr. 100g/100ml. |
| `hk_fat_saturated` | text_single_line | Hørkram scraper | Mættet fedt pr. 100g/100ml. |
| `hk_carbs` | text_single_line | Hørkram scraper | Kulhydrater pr. 100g/100ml. |
| `hk_sugar` | text_single_line | Hørkram scraper | Sukkerarter pr. 100g/100ml. |
| `hk_fiber` | text_single_line | Hørkram scraper | Kostfibre pr. 100g/100ml. |
| `hk_protein` | text_single_line | Hørkram scraper | Protein pr. 100g/100ml. |
| `hk_salt` | text_single_line | Hørkram scraper | Salt pr. 100g/100ml. |

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
  - `parseTag(subject)` — regex for `#b-{num}` og `#k-{num}` (præfikser fra settings)
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

#### Fase 6h — Indkøb: samlet liste + opret/kobl (komplet)
> Spec: `docs/CLAUDE_INDKOB_6H.md` · Mockup: `docs/indkob_mockup_6h.html`
> Løser fire driftsproblemer: leverandør-opdeling for tidligt, to "Hørkram"-blokke (Convi),
> ingen klar vej til nye varer, varenummer-opslag skjult i Settings.

- [x] **Del 1 — To views** i `shared/indkob.js`: ny primær toggle `Samlet liste` / `Klar til bestilling`
  (default Samlet, persisteres i `localStorage` nøgle `ib_view_mode`)
  - **Samlet liste** (`_ibRenderCombined`): flad arbejds-/tjek-liste grupperet efter
    produktkategori (Grocy `product_group_id` → navn via `/api/grocy/product-groups`).
    Hver række: navn · behov · destinations-tag (`→ Hørkram` / `⚠ mangler leverandør`) · qty-stepper.
    Footer: `N varer på listen · M mangler leverandør`. Ingen leverandørblokke, ingen kurv.
  - Qty-stepper justerer købsmængden = `shopping_list.amount` (debounced PUT pr. produkt
    via `updateShoppingListItem`; ved flere sl-linjer pr. produkt justeres den primære
    så summen rammer det indtastede).
  - **Fokus** er nu underfunktion af `Klar til bestilling` (vises kun i det view) — ikke en
    sidestillet tredje knap. Bestillingsviewet er uændret (leverandørblokke, chips, kurv).
- [x] **Del 2 — Kanal-labels** (`_ibBuildGroups` + `_ibRenderGroup`): label-opløsning
  `grocy_location_display_name → Grocy-lokationsnavn → leverandørnavn` (manglende fallback-led
  tilføjet). Kanal-undertekst (`købes via X · kanal: Y`) vises når labelen afviger fra
  leverandør/kanal — undertrykt for `__none__`-gruppen.
- [x] **Del 3 — Opret/kobl-drawer** (`_ibOpenDrawer` m.fl.): body-appended drawer (overlever
  `_ibRender`). Toolbar-knap `+ Opret/kobl` (separat fra `+ Tilføj vare`, der stadig søger
  eksisterende Grocy-varer). To trin:
  - Trin 1: find Hørkram-varenummer — søg (`fetchHokaSearch`) eller manuel indtastning.
  - Trin 2 Gren A (eksisterende vare): `createProductBarcode` + `addShoppingListProduct`.
    409 `BARCODE_DUPLICATE` → pæn besked.
  - Trin 2 Gren B (helt ny vare): genbruger `shared/product_create.js` via ny `onCreated`-hook
    (`initProductCreate(el, { barcode, onCreated })`) — draweren lægger på liste + lukker bagefter.
- [x] **Del 4 — "Kobl →" genvej** fra umatched linjer: Samlet liste's `⚠ mangler leverandør`-rækker
  og bestillingsviewets `Uden leverandør`-blok får `Kobl →` → åbner draweren i couple-mode
  (trin 2 låst til den kendte Grocy-vare, trin 1 forudfyldt + auto-søgt med varenavnet).
  Umatchede varer i en *rigtig* leverandørgruppe beholder det inline link-panel (har
  INT-varenummer-generering som draweren ikke har).
- [x] **Del 5 — Varenummer-validering**: ny `lookupHokaVarenr()` i `shared/api.js` (genbruger
  eksisterende `GET /api/horkram/product/:varenr` — ingen ny route). Manuelt indtastet nummer
  valideres mod Hørkram; ukendt nummer advarer (`⚠ … du kan stadig koble`) men blokerer ikke.
- [x] `shared/api.js` — `apiFetch` vedhæfter nu `err.status` + `err.code` (additiv ændring)
  så 409 `BARCODE_DUPLICATE` kan skelnes client-side.
- [x] `shared/indkob.css` — Samlet liste-rækker + drawer-styling.
- [x] `kitchen/purchasing.html` + `office/index.html` — loader `product_create.{js,css}` (draweren bruger den).
- [x] Browser-verificeret på grocytest: Samlet liste (kategorier/qty-persist), view-toggle,
  drawer (Hørkram-søg + manuel + Gren A/B), couple-mode, varenummer-validering.

#### Fase 6h-revision — én liste, to grupperinger (komplet)
> Driftsfeedback efter 6h: det to-view-split (tjek-view vs. bestil-view) genskabte
> præcis to-liste-problemet `indkob.js` oprindeligt forenede. Rettet til ÉN
> handlingsbar liste med to grupperinger.

- [x] Toggleren relabeled fra "Samlet liste / Klar til bestilling" til
  **"Efter kategori" / "Efter leverandør"** — ikke længere tjek-view vs. bestil-view,
  men to grupperinger af *samme* handlingsbare liste.
- [x] Kategori-visningen (`_ibRenderCombined`) genbruger nu den fulde handlingsrække
  `_ibRenderItem` (chips, antal, "Læg i kurv"/"Marker valgt"/"Kobl") — begge
  grupperinger er fuldt handlingsbare. Den simple tjek-række `_ibRenderCombinedRow`
  + `cmb-qty`-maskineriet er fjernet. `_ibRenderItem` fik 3. param `showSupplier`
  der viser et `→ leverandør`-tag i kategori-visningen.
- [x] **Sticky bund-bar** (`_ibRenderBottomBar` omskrevet) viser per-leverandør
  staged: `Hørkram · 4 i kurv · Gå til kurv →`. api+supplierId → `goto-cart` direkte;
  email/manual → `bb-finalize` (hopper til leverandør-gruppering + åbner bestil-dialog);
  kurv-varer i en ikke-api-koblet gruppe → `⚠ Kurv ikke klar` (cart-blocked modal).
  Vises i begge grupperinger.
- [x] **Søgefelt-fokus-bug rettet**: `_ibRender()` gemmer nu aktivt input + markør-
  position og gendanner det efter `innerHTML`-replace (samme mønster som scroll).
  Tidligere mistede søgefeltet fokus efter hvert tegn pga. den debounced re-render.
- [x] "+ Tilføj vare"-panelet flyttet op øverst i `_ibRenderPanels` (var skjult under
  Manglende/Udløbende-bannerne).
- [x] Browser-verificeret: fokus bevares under søgning, kategori-visning har fulde
  handlingsrækker, "Læg i kurv" virker fra kategori-visningen, bund-bar samler staged.
  (Grøn "Gå til kurv"-finalize kunne ikke klik-testes — grocytest har ingen api-koblede
  leverandører; koden falder korrekt tilbage til "⚠ Kurv ikke klar".)

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
  - Konvertering = **ny bon pr. dag** (`source_quote_id` → tilbuddet), tilbuddet bliver
    liggende som bilag: `offer_status='won'` + `offer_locked_at`. `is_offer` skifter aldrig
    værdi på en levende række (migration 146 — se "vundet betyder ikke forsvundet")
- [x] `routes/quotes.js` — 11 endpoints (opererer på bons med `is_offer=1`):
  - CRUD: GET liste (filtre: status, customer_id, q), GET /:id med linjer, POST, PATCH, DELETE (kun draft)
  - Linjer: POST/PUT/DELETE /:id/lines/:lid
  - Status: PATCH /:id/status (draft/sent/won/lost/expired)
  - Convert: POST /:id/convert → opret bon(s), lås bilaget · Lås: POST /:id/lock + /:id/unlock
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

### Priser i planlægningsbon
- [x] Migration 043: `show_prices_in_planning` setting (default '0')
- [x] `shared/planning.js` — pris-toggle knap i toolbar
  - Henter setting fra server ved init, persisterer via `patchSetting()`
  - Moms-toggle (m/moms ↔ u/moms) i kolonneheader — salgspriser divideres med 1.25
  - 6 kolonner: Antal, Vare, Kategori, Stk-pris, Kostpris, Total
  - Footer i faktura-format: Netto, Moms 25%, Total inkl. moms, Kostpris, Margin %
  - Margin beregnes korrekt på salg u/moms vs. kostpris u/moms
- [x] `shared/planning.css` — vat-toggle knap, subtotal/margin styling
- [x] `settings/index.html` — "Vis priser i planlægningsbon" toggle under System

### Hjælpesystem
- [x] `shared/help-system.js` (~370 linjer) — HelpSystem + MapMode moduler
  - Selector-baseret mapping (CSS-selectorer i JSON, ikke data-attributter)
  - H = hjælpepanel med nummererede badges + sidepanel
  - Ctrl+Shift+H = kortlægningstilstand (klik element → udfyld tekst → gem)
  - Auto-genereret CSS-selector (id > klasser > nth-child)
  - SPA-support via `HelpSystem.setPage(key, name)`
  - Floating `?`-knap nederst højre
- [x] `shared/help-system.css` (~230 linjer) — overlay, badges, panel, tooltip, mapping-UI
- [x] `routes/help.js` — GET/POST `/api/help-content` (POST admin-only)
- [x] `data/help-content.json` — hjælpetekster for 9 kitchen-sider + planlægning
- [x] Integreret i 9 kitchen HTML-filer + office SPA (dynamisk setPage ved view-switch)
- [x] Kopieret til Whiteboard-projektet med 18 hjælpetekster for tavle-siden

### Whiteboard Sidekick
- [x] `shared/sidekick.js` — to-trins overlay i kitchen-zone
  - Trin 1: Flydende ikon med badge (antal uafsluttede opgaver)
  - Trin 2: Sidepanel (320px) — dagens opgaver, hurtig-tilføj, beskeder
  - "Åbn Whiteboard" knap i panel-header åbner den rigtige app i ny fane (`window.open(whiteboardBase, '_blank', 'noopener')`) — tidligere fuld-skærms-overlay fjernet, da den genskabte Whiteboard-UI og mistede funktionalitet (SOP-visning, drag-drop, kalender mv.)
  - Cross-origin fetch til Whiteboard API (`WHITEBOARD_BASE_URL`)
  - Config via `/api/sidekick/config` (env vars)
  - Polling hvert 30s (kun når mode === 'panel')
  - Optimistisk UI + 8s fortryd-toast ved opgave-afslutning
  - Hurtig-tilføj opgave direkte fra panelet
  - Lydløs degradering ved manglende config eller API-fejl
- [x] `shared/sidekick.css` — whiteboard-palette, ikon, panel
- [x] `routes/sidekick.js` — GET `/api/sidekick/config`
- [x] Integreret i `kitchen/today.html` + `kitchen/index.html`
- [x] `.env.example` — `WHITEBOARD_BASE_URL`, `SOP_BASE_URL`

### Web-bestillinger (webhook fra hjemmesiden)
- [x] Migration 044: `web_orders`-tabel + `web_order_confirmation` mail-skabelon + `webhook_secret` setting
- [x] `routes/web-orders.js` — webhook + API
  - `POST /webhook/bestilling` — modtager formular-data (nyt felt-format: `first_name`, `email`, `delivery_date` osv.)
  - Honeypot-tjek, valgfri secret-validering via settings
  - Find/opret firma + kunde (email-match), EAN-udtræk, DAWA-adresse
  - Opret bon (status NY) + gem i `web_orders` (med `bon_id` reference)
  - Send bekræftelsesmail via `web_order_confirmation`-skabelon (bonnummer, dato, tid, pax, adresse)
  - SSE broadcast `bon_created` med `source: 'web_order'`
  - `GET /` — liste over web-bestillinger (status-filter)
- [x] `server.js` — webhook mountet med CORS for `ristetrug.dk` / `www.ristetrug.dk`
- [x] `docs/bestilling (1).html` — opdateret (secret fjernet fra klient-kode)
- [ ] Formbuilder (`docs/formbuilder.html`) skal tilpasses og integreres i Bon v2:
  - Nyt felt-format (`first_name`, `email` i stedet for `f2`, `f3`)
  - Cutoff-advarsel ("timer tilbage") som valgfri toggle (ikke altid på)
  - Bestillingsfrist som valgfri feature
  - localStorage (husk kontaktinfo) i genereret output
  - Validerings-highlight (røde felter) i genereret output
  - Checkbox-validering i genereret output
  - Integreres i Bon v2 admin/settings

### Web-bestillinger (webhook + bekræftelsesmail)
- [x] Migration 044: `web_orders`-tabel + `web_order_confirmation` mail-skabelon + `webhook_secret` setting
- [x] Migration 045: Fix mail-skabeloner til at bruge `{{tag}}` variabel (sikrer korrekt IMAP-routing)
- [x] `routes/web-orders.js` — **NY FIL**: webhook + historik
  - `POST /webhook/bestilling` — modtager formulardata cross-origin, honeypot-check, find/opret firma+kunde, opret bon (status NY), fire-and-forget bekræftelsesmail, SSE broadcast
  - `GET /` — liste over web-ordrer med status-filter
- [x] `server.js` — webhook monteret med CORS middleware (ristetrug.dk + bestil-form.netlify.app)
- [x] `services/mailService.js` — `sendFromTemplate` injicerer `{{tag}}` fra context, `sendMail` undgår dobbelttag
- [x] `routes/bons.js` — NaN-fix i mail context (`parseInt` på bon_number med bogstav-prefix)
- [x] `docs/bestilling (1).html` — Formular med 5 UX-forbedringer:
  - localStorage gem/gendan mellem sessioner
  - Validerings-highlighting på ugyldige felter
  - Checkbox-validering (GDPR)
  - Fjernet "timer tilbage"-advarsel
  - Rettet tak-besked

### Embed-bestillingsformular (maj 2026)
> Spec: `docs/formbuilder/CLAUDE_BESTILLING_FORM.md`
> Erstatter JotForm på `ristetrug.dk/bestil`. iframe på `bon.ristetrug.dk/embed/bestilling` indlejret via DIVI Code Module.

- [x] Migration 058: 8 `bestilling.*` settings (base-koordinat, cutoff, leveringszoner, menu-JSON som setting)
- [x] `routes/embed.js` — public endpoints:
  - `GET /embed/bestilling?menu=<id>` — selve formen (CSP `frame-ancestors` for ristetrug.dk)
  - `GET /embed/config` — cutoff + leveringszoner + delivery_days + cutoff_days som JSON
  - `GET /embed/menus/:id.json` — menu fra `settings.bestilling.menu_<id>` (60s cache)
- [x] `public/embed/bestilling.html` — single-file (~900 linjer), ingen build-step:
  - Loader CFG fra `/embed/config` + menu fra `/embed/menus/standard.json` ved init
  - "Sådan virker det" foldout, quick-chips (count + text), inline menu-picker med allergen-toggle
  - Sandwichvalg med subtekst (Køkkenet blander / Eget valg)
  - DAWA autocomplete + OSRM-baseret leveringsestimat (fra public/`bestilling (1).html`)
  - Cutoff-logik: `cutoff_lead_days` tæller kun gennem dage i `cutoff_days` (CSV ugedage); `delivery_days` styrer hvilke ugedage der tager imod levering — så weekend kan slås til/fra som åben dag
  - Smart-append: struct-header `--- Valgte retter ---` indsættes kun ved fritekst
  - Strukturet `menu_items: [{id, count}]` sendes parallelt med wishes-tekst (klar til automatisering)
  - postMessage høj-resizer baseret på `.form-wrap.offsetHeight` (undgår viewport-feedback-loop)
- [x] `routes/web-orders.js` udvidet:
  - `buildCustomerWishes(data)` — samler `Sandwichvalg: <label>` + wishes + `[Form: <menu_id> v<version>]`-marker
  - Modtager `delivery_extra` → `bons.delivery_notes`
  - `_form_meta` + `menu_items[]` gemmes i `web_orders.raw_data` (JSON)
  - Bagudkompatibel: nuværende `docs/bestilling (1).html` virker uændret
- [x] `routes/settings.js` — menu CRUD (admin):
  - `GET /api/settings/bestilling/menu/:id` — hent menu-JSON
  - `PUT /api/settings/bestilling/menu/:id` — gem med validering (duplikat-check, kategori-FK, auto-bump version)
- [x] `settings/index.html` — Bestilling — Menu sektion (admin):
  - **Åbningstider og deadline-editor** (cutoff-time, lead-days, delivery_days + cutoff_days som 7 ugedags-checkboxes hver)
  - **Kilde til menu**-toggle: Manuel / Live fra Grocy (radio, auto-saves)
  - **Manuel-mode editor:**
    - Kategorier: redigér id/navn, op/ned, slet (advarsel ved tilknyttede items), opret
    - Items grupperet per kategori: navn, tags-checkboxes (vegan/veg/gf/fisk/kød), allergens-tekstfelt, aktiv-toggle, op/ned, slet, opret
    - Klient-side validering inden gem; toast på success/fejl
    - JSON forhåndsvisning (foldout)
    - **⬇ Importér fra Grocy**-knap → modal med 118+ Grocy-retter, søg/filter, "Vælg alle"-knap per kategori, "Skjul allerede importeret"-toggle, opretter nye kategorier automatisk, beskytter mod dubletter
  - **Grocy-mode editor:** info-banner med liste over brugte userfields (`sellable`, `grupper`, `bestil_tags`, `bestil_allergens`, `bestil_skjul`) + read-only forhåndsvisning, hint om at bruge Manuel + import for kuration
- [x] Migration 059: `bestilling.menu_source` setting (`'manual'` | `'grocy'`, default `'manual'`)
- [x] `routes/embed.js` udvidet:
  - `GET /embed/menus/:id.json` tjekker `menu_source`-setting; Grocy-mode kalder `grocyAdapter.getRecipes()`, mapper sellable=1 + grupper-userfield → kategorier, stable IDs `r{recipe_id}`, optionelle userfields `bestil_tags`/`bestil_allergens`/`bestil_skjul`
  - Auto-fallback til manuel hvis Grocy fejler
  - `GET /embed/grocy-preview` (auth-required) — tvunget Grocy-render, bruges af import-modal
- [x] `assets/icons/wheat.svg` — RR-logo brugt i embed-form-header (mask-baseret CSS, hvid på brun baggrund)
- [x] `shared/bon_drawer.{js,css}` — UX-forbedring: status-flash er nu en grøn pille i 3.5s (var 12px tekst i 1.5s) + permanent hint under status-bar: "Status gemmes automatisk når du klikker en knap. Brug 'Gem' nederst til de øvrige felter."
- [x] `docs/wordpress_divi_snippet.html` — kopier-klar HTML til DIVI Code Module
- [x] `public/embed/test-harness.html` — lokal WordPress-mock til iframe-test
- [x] End-to-end verificeret: form → webhook → bon med korrekt sandwichvalg + chips + valgte retter + form-meta + menu_items i raw_data

### Mail-skabelon management (april 2026)
- [x] `routes/mail.js` — 2 nye endpoints:
  - `POST /api/mail/templates` — opret ny skabelon (admin, key-validering, duplikat-check)
  - `DELETE /api/mail/templates/:key` — slet brugerdefinerede skabeloner (system-skabeloner beskyttet)
  - `PATCH` udvidet med `label`-opdatering
- [x] `shared/api.js` — `createMailTemplate()` + `deleteMailTemplate()`
- [x] `settings/index.html` — Mail → Skabeloner komplet redesign:
  - Dropdown-selector (som bon-draweren) i stedet for alle kort på én gang
  - Editor: label, emne, brødtekst med klikbare variabel-tags per skabelon-type
  - Gem/Test/Slet knapper (system-skabeloner kan ikke slettes)
  - "+ Ny skabelon" knap med opret-form (nøgle + label)
  - Kontekst-variabler: `booking_confirmation`, `web_order_confirmation`, `order_email` har hver sit sæt

### Fase 12 — Rapporter
- [x] `routes/reports.js` — 8 endpoints:
  - `GET /api/reports/summary` — YTD KPIs (omsætning, ordrer, gns. ordreværdi, ufaktureret)
  - `GET /api/reports/monthly` — 12-måneders historik (i år + forrige år)
  - `GET /api/reports/top-customers` — Top 10 kunder (omsætning/antal)
  - `GET /api/reports/categories` — Priskategori-fordeling
  - `GET /api/reports/monthly-table` — Måned-for-måned KPI-tabel
  - `GET /api/reports/lego` — Pax-kategori legoklods-sammenligning
  - `GET /api/reports/cumulative` — Multi-år akkumuleret omsætningskurve
  - `GET /api/reports/top-categories` — Top 10 produktkategorier (enheder)
- [x] `office/views/rapporter.js` + `rapporter.css` — Komplet rapportview
  - KPI-strip (4 kort) med YoY-delta
  - Månedsoversigt bar chart med Kr/Enh toggle
  - Legoklods stacked chart med måned-vælger (max 2 måneder)
  - Akkumuleret omsætningskurve (multi-år)
  - Top kunder med sorterbar toggle (Omsætning/Antal)
  - Kategori-fordeling med stacked bar + tabel
  - Månedstabel med delta-farver
- [x] `shared/dashboard_chart.js` — 3 nye chart-funktioner (initMonthlyBarChart, initLegoStackedChart, initMultiYearAccumChart)
- [x] `shared/api.js` — 8 fetchReports*-funktioner
- [x] Office sidebar: Rapporter under Økonomi-gruppen

### PIN-management + Mobil auto-redirect (april 2026)
- [x] Migration 046: `mobile_pin` kolonne på `users` (separat fra tablet `pin`)
- [x] `routes/auth.js` — mobil-login tjekker `mobile_pin` (fallback til `pin`)
  - `source: 'mobile'` parameter, pin-users endpoint returnerer begge typer
- [x] `routes/users.js` — `mobile_pin` i GET/POST/PATCH
- [x] `settings/index.html` — klikbare PIN-celler (tablet + mobil), inline-redigering
  - Mobil-PIN felt ved opret-bruger
- [x] `login.html` — auto-redirect til `/mobile/login.html` for touch + smal skærm
  - `?desktop=1` eller localStorage `preferDesktop` forhindrer redirect
- [x] `mobile/login.html` — sender `source: mobile`, "Åbn fuld version" sætter preferDesktop

### CVR-berigelse (april 2026)
- [x] 429 firmaer beriget automatisk (380 NemHandel EAN + 49 kendte institutioner)
- [x] 224 firmaer beriget via Virk ES review (manuel gennemgang)
- [x] **653 af 1.232 firmaer har CVR (53%)**
- [x] `scripts/enrich-cvr.js` — udvidet med `--safe-only`, `--export-review`
  - Eksporterer `cvr-virk-review.json` + `cvr-unmatched.json`
- [x] `scripts/import-cvr-review.js` — importér godkendte matches fra review
- [x] `tools/cvr-review.html` — interaktiv review-side:
  - Tab 1: Virk auto-matches med søg/filtrer/sortér/godkend
  - Tab 2: Umatchede firmaer med inline Virk ES søgning + manuel kobling
  - Eksport inkluderer auto-matches + manuelle koblinger
- [x] `routes/cvr.js` — `GET /api/cvr/virk-search` (Virk ES proxy for live søgning)
- [x] `server.js` — `/data/` statisk serving for review JSON-filer

### Sync-v1 timezone-fix
- [x] `scripts/sync-v1.js` — `parseV1Date()` fikset fra UTC til lokal tid
  - V1 gemmer tider i UTC, men de repræsenterer dansk lokal tid (CET/CEST)
  - Rettet fra `toISOString()` (UTC) til `getHours()`/`getMinutes()` (lokal)
  - Alle pickup/delivery-tider var forskudt 1-2 timer — nu korrekte
  - Kræver `--full` sync efter deploy for at rette eksisterende data

### Fase 13 — Cashflow
- [x] Migration 047: `cf_transactions`, `cf_invoices`, `cf_meta` tabeller
- [x] `routes/cashflow.js` — 12 admin-only endpoints:
  - CSV-upload med Bankdata-parser (Nykredit/Fælles Kassen format)
  - Match-logik: beløb ±2% + fakturanr i tekst → confidence score, auto-match ≥70
  - Faktura CRUD (opret/opdater/slet/markér betalt)
  - Stats (saldo, udestående, forfaldne, forventet 30d)
  - Weekly chart-data (8 uger: modtaget/forventet/overdue)
  - Analyse (YTD kumulativ fra bons, pax-segmenter, heatmap, betalingsadfærd)
- [x] `office/views/cashflow.js` + `cashflow.css` — 2-tab view:
  - **Overblik**: 4 metric-kort, stale-badge, ugechart, fakturaliste med CRUD, upload, umatchede transaktioner, "forfalder snart"
  - **Analyse**: YTD canvas-chart (3 år + sandwich-toggle), pax-segmenter (stacked bars), sæsonvarme heatmap, betalingsadfærd per kunde
- [x] Office sidebar: "Pengestrøm" under Økonomi-gruppen
- [x] `shared/api.js` — 13 cashflow API-funktioner

### Mail chat-boble layout (april 2026)
- [x] Alle 6 mail-visninger konverteret fra lineær liste til chat-boble layout
  - Indgående: venstrejusteret, lys blå (#f0f4f8), afrundet bund-venstre
  - Udgående: højrejusteret, lys grøn (#f0f7f0), afrundet bund-højre
  - Fjernet `← →` pile og `📥📤` emojis — retning vises via boble-position
- [x] Ændrede filer: `bon_kort.css`, `bon_kort.js`, `bon_drawer.js`, `modal.js`, `supplier_inbox.js`, `indkob.css`, `indkob.js`, `crm-kunde360.js`

### Opret produkt (kitchen/stock.html tab 3)
- [x] 4 nye Grocy proxy-endpoints i [routes/grocy.js](routes/grocy.js): `GET /userfields`, `POST /products`, `POST /quantity-unit-conversions`, `POST /stock/:id/add`
- [x] [services/grocyAdapter.js](services/grocyAdapter.js): `createProduct()`, `createQuConversion()`, `getUserfields()`, `addToStockFull()` (udvidet `addToStock` med pris + transaction_type)
- [x] [shared/api.js](shared/api.js): `fetchGrocyUserfields()`, `postGrocyProduct()`, `postGrocyQuConversion()`, `postGrocyStockAdd()`
- [x] [shared/product_create.js](shared/product_create.js) + [shared/product_create.css](shared/product_create.css) — komponent med 3 sektioner (Grunddata · Workflow · Stregkode/varenummer foldout)
- [x] [kitchen/stock.html](kitchen/stock.html) — 3. tab "Opret produkt", URL-håndtering: `?tab=create&barcode=<ean>` deep-links til pre-fill (Hørkram-lookup udfylder navn/pris/salgsenhed)
- [x] Dynamic userfield-detection: `HverDag` (check-interval) + `Co2e` vises kun hvis de findes på products-entity i Grocy
- [x] Stock-QU restricted til Kilo/Antal/Stk (vægt-/CO2-beregninger fremover)
- [x] Pris-mode toggle (Total/Pr. enhed) — total deles med antal ved submit for korrekt pris pr. stock-enhed
- [x] QU-konvertering callout når purchase ≠ stock + live "≈ N kasser"-hint på lager-amount
- [x] Navne-duplikat fuzzy match mod cached products (advarsel inden submit)
- [x] No-rollback med warnings: produkt beholdes selv hvis QU-konvertering/userfields/barcode/lager fejler
- [x] Verificeret end-to-end på grocytest (produkt id 216 oprettet via UI)
- [x] Genvej fra Varemodtagelse: "+ Opret nyt produkt i Grocy"-knap under "+ Tilføj vare manuelt" på lager-trinnet, åbner `kitchen/stock.html?tab=create` i ny fane (target=_blank, noopener)
- [x] Genvej fra Indkøbsliste: "+ Opret nyt produkt"-link nederst-højre i "+ Tilføj vare"-panelet, samme target-mønster (åbner i ny fane)

### Supplier-mail (fri kommunikation med leverandører)
- [x] Migration 052: `mail_threads.supplier_id` (nullable FK), `mail_tag_supplier_prefix='s-'` setting
- [x] [utils/mail-parser.js](utils/mail-parser.js): parse `#s-NN` tags, route `'supplier'`, `buildTag` understøtter supplier
- [x] [services/mailService.js](services/mailService.js): `supplierId` parameter på `sendMail()` + `sendFromTemplate()`, IMAP-routing matcher `#s-NN` til supplier-tråde, SSE `supplier_mail_received`/`supplier_mail_sent`
- [x] [routes/purchasing.js](routes/purchasing.js): 5 nye endpoints (`GET/POST /suppliers/:id/mail`, `PATCH /suppliers/:id/mail/read`, `GET /suppliers/:id/mail-threads`, `GET /suppliers/mail-overview`)
- [x] [shared/api.js](shared/api.js): `fetchSupplierMail`, `fetchSupplierMailThreads`, `sendSupplierMail`, `markSupplierMailRead`, `fetchSupplierMailOverview`
- [x] [shared/indkob.js](shared/indkob.js): "✉ Skriv til leverandør"-knap på hver gruppe-header (uafhængigt af integration_type), inline tråd + compose-form med modtager/emne/besked, ulæst-badge i pills, SSE-handler for live opdatering
- [x] **Quick-jump strip** øverst på Indkøb: leverandør-pills (farvet venstrekant per integration-type) — klik scroller til gruppe + flash-animation. Gør det nemmere at finde leverandører når der er mange grupper
- [x] [shared/supplier_inbox.js](shared/supplier_inbox.js): kategori-filter (Alle typer / 📦 Bestillinger / ✉ Generel), kombinerer PO-tråde og supplier-tråde i samme liste, sender svar via korrekt endpoint baseret på tråd-type
- [x] [office/index.html](office/index.html) + [kitchen/purchasing.html](kitchen/purchasing.html): SSE-handlers for `supplier_mail_received`/`supplier_mail_sent`, Post-tab badge tæller begge typer
- [x] [shared/indkob_settings.js](shared/indkob_settings.js): "✉ Skriv mail"-knap på hver leverandør i Settings → Indkøb → Leverandører — åbner indkøbssiden i ny fane med `?supplier_mail=<id>` og auto-foldud af supplier-mail panel
- [x] Verificeret end-to-end: mail sendt med tag `#s-1`, supplier-tråd #10 oprettet, vises i både Indkøb-tabben (Hørkram-gruppen) og Office Leverandørpost (med ✉ Generel-filter)
- [x] **Ny mail-modal i Leverandørpost**: "+ Ny mail"-knap i toolbar → modal med leverandør-dropdown, til-felt, emne, besked. Auto-pre-fill fra `contact_email`, fokuserer emne ved valg. Sender via samme endpoint som inline-flow. Auto-select af nyoprettet tråd efter send.
- [x] **Notes-email-parsing (chips)**: `parseEmailsFromNotes()` helper i [shared/utils.js](shared/utils.js) udtrækker emails + labels fra leverandørens fri-tekst noter. Chips vises i compose-formularen (både inline og modal) — klik fylder "Til"-feltet. Genkender mønstre som "Navn — email@x.dk" og falder tilbage til domæne-baseret label hvis ingen prefix. Bruges fx på Emballage-leverandøren hvor flere mini-leverandører deler én Grocy-lokation.
- [x] **SVG mail-ikon**: ny `mailIcon(size)` helper i [shared/utils.js](shared/utils.js). Erstatter ✉ unicode-emoji på små badges/knapper hvor den var næsten usynlig — bon-mail-badge på bon-kort + kalender, gruppe-mail-pill, supplier-mail-knap, filter-knap "Generel", PO-mail icon, Settings-knap. Ikonet arver `currentColor` og fungerer på alle baggrundsfarver. Større emojis (📦, 🌱, 🛒, 🔧) bevares som de er.

### Fase 14 — Booking-modul (komplet — M1–M12 + M5b/c)

> Spec: `docs/CRM_Booking_Spec_v2.md` + rettelser i `docs/CRM_Booking_Spec_v2_PATCH.md`
>
> To separate offentlige flows der erstatter HubSpot-mødebooking:
> - **Smagsprøve** (`booking/smagning.html` → `/book/smagning`) — kalender-baseret, konfigurerbare mødetyper
> - **Kontakt** (`booking/kontakt.html` → `/book/kontakt`) — formular uden kalender, opretter task på Ring-tilbage-listen
>
> Siderne ligger i `booking/` og mountes offentligt i `server.js` (`/book/:slug`).
> De lå i `tools/` indtil september 2026 — men `/tools` kom bag login med #581,
> og nginx på prod svarer 404 på `/tools/`. Kundeflader hører ikke hjemme i en
> mappe med interne værktøjer; det gjorde linket i Settings til en 404.

- [x] Migration 051: `meeting_types`, `contact_reasons`, `booking_tokens`, `page_templates` + 7 nye kolonner på `crm_activities` (`meeting_type_id`, `contact_reason_id`, `duration_min`, `guest_count`, `event_type`, `booked_via`, `reminder_sent_at`)
- [x] 4 mail-skabeloner seedet (`booking_smagning_confirmation`, `booking_smagning_reminder`, `booking_kontakt_confirmation`, `booking_internal_notification`) + 4 page-templates (intro/thankyou × 2)
- [x] 18 booking-settings (slot-logik, ejer, tokens, erindring, master-toggles)
- [x] **Felter pr. mødetype** (migration 170). `Antal gæster` og `Eventtype` lå
  hardkodet i booking-formularen og blev vist for alle mødetyper — men en
  smagning er altid til to personer og har intet event at vælge.
  `meeting_types.fixed_guest_count` (NULL = spørg kunden, et tal = skjul
  feltet og registrér tallet) og `meeting_types.asks_event_type` styrer det
  nu, redigerbart i Settings → Mødetyper. Backend læser værdierne fra
  databasen ved indsendelse, så en manipuleret POST ikke kan sende noget
  andet. Migrationen sætter kun `smagning` (2 gæster, ingen eventtype);
  øvrige typer er uændrede.
- [x] **To base-URL'er, ikke én** (migration 169). `booking_public_url_base`
  hed "public", men bygger office-links i interne mails (`bookingMatcher`,
  `web-orders`) og er fallback for Lobo-webhooken (`delivery`) — den er
  appens base. Da den blev sat til et pænt kundedomæne, pegede sælgernes
  CRM-links ind i kundens kontaktformular. `booking_customer_url_base` er
  nu kundernes base og bruges kun af `{{booking_link}}` og URL-visningen i
  Settings. Tom værdi = brug app-basen, så opsætninger uden pænt domæne
  opfører sig som før.
  Settings advarer hvis App URL-base peger på et andet domæne end det man
  sidder på — fejlen er sket to gange, fordi feltet står hvor "Public
  URL-base" plejede at stå. Advarslen er tavs på localhost.
- [x] `routes/booking.js` — public + admin endpoints
  - `GET /meeting-types` + `/contact-reasons` + `/page-templates/:key` (returnerer `{available:false, reason}` ved disabled/unconfigured i stedet for 503 — patch P3)
  - `GET /slots?date=&meeting_type=` (slot-beregning, 10/10 testcases)
  - `POST /webhook/booking-smagning` + `POST /webhook/booking-kontakt` (CORS via samme middleware som web-orders)
  - Admin CRUD for meeting_types/contact_reasons/page_templates (kun admin-rolle)
- [x] `services/bookingMatcher.js` — `computeSlotsForDate()`, `isSlotStillFree()`, `matchOrCreateCustomer()`, `resolveSalesOwner()`
  - Slot-beregning respekterer: blokerede ugedage, min/max dage frem, eksisterende meetings, buffer-zoner omkring bons (pickup_time/delivery_time)
  - Race-condition guard: re-tjek + INSERT i transaction
- [x] `booking/smagning.html` (`/book/smagning`) — kalender med navigation, slot-grid, formular, intro/thankyou fra page_templates, localStorage pre-fill, honeypot
- [x] `booking/kontakt.html` (`/book/kontakt`) — kontaktårsag-grid, formular, samme stil
- [x] **Patch P1 anvendt**: `done_at IS NULL` som "planlagt", `result='callback'` for ring-tilbage tasks (matcher 019-skema og `v_callbacks_pending` view) — ingen `outcome`-kolonne tilføjet
- [x] **Patch P2 anvendt**: race-condition guard + slot-algoritme med buffer-zoner mod bons
- [x] **Patch P3 anvendt**: GET-endpoints returnerer 200 med `{available:false, reason}` i stedet for 503 (kun submit-webhooks 503'er)
- [x] CRM Dashboard udvidet:
  - `GET /api/crm/meetings/upcoming` endpoint
  - "Kommende bookede møder"-panel (full-width, viser tid + kunde + mødetype + gæster + booking-kilde)
  - Briefing-tæller "🤝 X bookede møder denne uge"
  - SSE re-loader automatisk ved `crm_activity_created`
- [x] CRM Kunde 360° udvidet:
  - "Næste event"-stat inkluderer nu fremtidige meetings (ikke kun bons), prefixet med mødetype-emoji
  - Meeting-aktiviteter i timeline er klikbare → modal med fuld detalje (status, dato, tid, varighed, mødetype, gæster, eventtype, booket via, sælger, besked + "Markér som afholdt"-knap)
  - Timeline viser mødetidspunkt (🗓️ dato kl tid) i stedet for create-tidspunkt for meetings
  - `PATCH /api/crm/activity/:id/done` endpoint (sætter `done_at`)
  - `crm_activities`-query joiner nu `meeting_types` + `contact_reasons` for label/emoji
- [x] Browser-verificeret end-to-end: kunde booker → DB → SSE → CRM Dashboard + Kunde 360° opdaterer live
- [x] **M7 (komplet)**: `mailService.js` udvidet — `generateBookingToken()` med P4-idempotens (genbruger ubrugt token hvis udløb > `booking_token_reuse_min_days`) + `{{booking_link}}` rendering i `renderTemplate(body, vars, ctx)` + `sendFromTemplate` videregiver `bookingFlow`/`bookingIntent`/`smtpPrefix` (sidstnævnte fixer pre-eksisterende drop-bug så `routes/orders.js` rent faktisk bruger `kontakt@`). Mail-vars-builders + `sendInternalNotification` i `services/bookingMatcher.js`. Begge webhook-handlers sender nu kunde-bekræftelse via `kontakt@` med `#k-NNN` thread-tag og intern notif til sælger (springes ved token-flow + når `booking_notify_owner_enabled=0`). Verificeret via `scripts/test-m7a.js` (idempotens, link-rendering, manglende-context fallback) + `scripts/test-m7-bcd.js` (vars-builders, smagning + kontakt confirmation, intern notif inkl. token-flow + toggle-off).
- [x] **M8 (komplet)**: Kort URL `GET /b/:token` (302 redirect til `/book/:flow` + 410/400 for ukendt/ugyldigt token) i `routes/booking-redirect.js` mountet på `/b`. Token info-endpoint `GET /api/booking/token/:token` returnerer customer + intent_meeting_type + sales_user, bumper `open_count` + sætter `opened_at` (ikke ved redirect — kun ved JS-lookup, så ingen dobbelt-tælling). `booking/smagning.html` + `booking/kontakt.html` udvidet med token pre-fill (kontakt-felter + intent-mødetype auto-vælges + personlig velkomst-banner med title-cased navne). Token videregives ved submit → `handleSmagningBooking` + `handleKontaktBooking` sætter `booked_via='token_link'`, marker token forbrugt, springer intern notif over. `sendBookingMails` passer `userId: ownerId` til `sendFromTemplate` så `{{booking_link}}` i bekræftelsesmail bindes til samme sælger som håndterede bookingen. `mailService` rendrer `{{booking_link}}` som kort URL `${baseUrl}/b/${token}`. Verificeret via 24 asserts i `scripts/test-m8.js` (HTTP mod spawned server) + live-test mod hotmail/anne@ristetrug.dk med rigtig SMTP.
- [x] **M9 (komplet)**: [scripts/booking-reminders.js](scripts/booking-reminders.js) cron-script + `buildReminderVars` helper i `services/bookingMatcher.js`. Scriptet kører hver hele time via cron, exit'er stille hvis `booking_reminder_enabled !== '1'` eller hvis nuværende time ≠ `booking_reminder_send_at_time`. Når den kører: finder smagning-meetings N dage frem (`booking_reminder_days_before`), filtrerer på `done_at IS NULL` + `reminder_sent_at IS NULL` + kunde har email, sender `booking_smagning_reminder` via `smtp_kontakt`, opdaterer `reminder_sent_at`. Cron-config (deploy): `0 * * * * cd /home/leif/bon-v2 && node --experimental-sqlite scripts/booking-reminders.js >> logs/reminders.log 2>&1`. Verificeret via 25 asserts i `scripts/test-m9.js`.
- [x] **M10 (komplet)**: To nye admin-sektioner i [settings/index.html](settings/index.html) — "Booking — Smagsprøve" og "Booking — Kontakt". Smagsprøve indeholder: master-toggle + URL-display, mødetyper-tabel med inline CRUD (label/varighed/bookable/aktiv/ikon, +Ny), slot-logik (min/max dage, arbejdstid, granularitet, buffer før/efter event, spærrede ugedage), standardejer-dropdown fra users, public URL-base, token TTL + reuse, erindringsmail (toggle + dage før + sendetidspunkt), notifikations-toggle, page templates editor for `intro_smagning` + `thankyou_smagning`. Kontakt-sektion: master-toggle + URL, kontaktårsager-tabel (CRUD), page templates for `intro_kontakt` + `thankyou_kontakt`. Page-template editor har klikbare variabel-chips med tooltip-hints — klik indsætter `{{variabel}}` ved cursor i sidst-fokuserede felt (titel eller brødtekst), per-template-type variable-set (intro: firma-info, thankyou: booking-data). API-wrappers tilføjet i `shared/api.js`. Live UI-test bekræftet.
- [x] **M11 (komplet)**: "📅 Indsæt booking-link"-knap + popover i [office/views/crm-kunde360.js](office/views/crm-kunde360.js) mail-compose. Popover indeholder flow-radio (Smagsprøve/Kontakt) + intent-dropdown (alle aktive mødetyper inkl. `is_bookable=0` med "sælger-only"-label). "Indsæt" placerer `{{booking_link}}` ved cursor i textarea + viser info-strip ved siden af knappen. Backend: `POST /api/customers/:id/mail` udvidet med `booking_flow` + `booking_intent_meeting_type`-params. Body kører gennem `renderTemplate(text, {}, { customerId, userId, bookingFlow, bookingIntent, appendSignature: false })` så `{{booking_link}}` substitueres til kort URL bundet til (kunde, sælger, flow, intent). Nyt endpoint `GET /api/booking/meeting-types/intent` (auth-required) returnerer alle aktive types til popoveren. Verificeret via 13 in-process asserts i `scripts/test-m11.js` + UI live-test.
- [x] **M12 (komplet)**: End-to-end smoke-test ([scripts/test-booking-e2e.js](scripts/test-booking-e2e.js)) der binder hele flowet sammen i ét kald: sælger genererer link via `{{booking_link}}` → kunde klikker `/b/:token` → 302 → tools-side henter pre-fill via `/api/booking/token/:token` → kunde submitter → activity oprettet med `booked_via='token_link'` + token-konsumeret + intern notif sprunget over → 2 dage senere kører cron → reminder sendt + `reminder_sent_at` sat. 19 asserts. Hardening: `/api/booking/token/:token` logger advarsel når token rammer ≥20 opens (potentiel bot-probing) — endpointet spærres ikke, men gør usædvanlig aktivitet synlig i ops-loggen.

### Delivery — Spor 1: Manuel bestilling (maj 2026)
> Spec: [docs/delivery/CLAUDE_DELIVERY.md](docs/delivery/CLAUDE_DELIVERY.md) + [docs/delivery/PLAN_BYEKSPRESSEN_3D4.md](docs/delivery/PLAN_BYEKSPRESSEN_3D4.md)
> Strategi: vendt-på-hovedet — manuel bestilling først (i drift NU), rute-planlægger + OSRM/VROOM + mobile courier (Spor 2 = 3D.2/3D.3) bygges sideløbende.

- [x] Migration 057: `delivery_vehicles` (master data) + `delivery_events.vehicle_id`/`booked_by_user_id` + `bons.delivery_vehicle_id`/`delivery_cost_estimated`/`delivery_cost_source`. Seeds 4 vehicles: Volvo (calendar), Egen cykel (calendar), By-expressen (manual_clipboard, URL klar), Taxa 4×35 (manual_clipboard, URL klar). Templates udfyldes via Settings UI.
- [x] `services/booking_template.js` — render template med `{variabel}`-syntaks. 19 variabler (bon_id, customer_name, delivery_address, delivery_contact_name/_phone, packaging_lines mm). `[mangler]`-markering for tomme felter. `estimateCost(vehicle, bon)` med 3 cost-formler (volvo per_km, By-expressen base+included_boxes+extra, taxa standard_inner_city).
- [x] `services/delivery_log.js` — `logBookingEvent({ bonId, vehicleId, reference?, status, userId, note })` skriver til eksisterende `delivery_events` (ingen ny audit-tabel) + opdaterer `bons.delivery_vehicle_id` + `delivery_method` (auto-synced fra vehicle.type for backwards compat) + `courier_provider` + `delivery_cost_estimated` + changelog + SSE `bon_updated`. `setActualCost({ bonId, amount, source })` opdaterer `bons.delivery_cost` (én pris pr. bon, klar til fakturering).
- [x] `routes/delivery.js` — 9 endpoints:
  - `GET /api/delivery/vehicles` (liste, åben for alle aktive brugere)
  - `GET/POST/PATCH/DELETE /api/delivery/vehicles/:id` (CRUD, admin-only på write)
  - `GET /api/delivery/template-variables` (variabel-katalog til Settings-chips)
  - `GET /api/delivery/booking-payload?bon_id=&vehicle_id=` (genererer clipboard-tekst + URL)
  - `POST /api/delivery/book` (book + log event + opdater bon)
  - `POST /api/delivery/cancel` (annullér aktiv booking — rydder vehicle-tildeling, logger `cancelled`-event)
  - `POST /api/delivery/actual-cost` (sæt `bons.delivery_cost`)
  - `GET /api/delivery/events?bon_id=` (booking-historik per bon)
- [x] `shared/manual_booking_modal.js` + `.css` — standalone overlay-modal:
  - Vehicle-vælger (kun manual_clipboard-vehicles)
  - Clipboard-preview (mørkt code-block) med `[mangler]`-markering + manglende-felt-chips
  - "Rediger"-toggle → editable textarea (lokal kun)
  - "Kopiér og åbn {label}"-knap: `navigator.clipboard.writeText()` + `window.open(booking_url)`. Fallback: pre-selected `<textarea>` + Cmd+C-instruktion (ingen `execCommand`)
  - Booking-ref input (valgfri) + faktisk pris (valgfri)
  - "Marker som booket" eller "Spring over" (in_progress)
  - Estimat-pille fra cost-formel
- [x] `shared/bon_drawer.js`/`.css` — ny "BESTIL BUD"-sektion:
  - Vehicle-status pill (current courier_provider · cost)
  - "📦 Bestil hos…"-knap åbner manual_booking_modal
  - Faktisk omkostning-input (kr) med Gem-knap
  - Booking-historik-liste (vehicle, dato, ref, evt. note)
  - Sektionen skjules automatisk når `delivery_type` er `pickup` eller `event` (eller `is_internal=1`)
  - `BonDrawer.open(bonId, { scrollTo: 'bestil-bud' })` til deep-linking fra bon-kort
  - Den gamle "Leveringsmetode"-dropdown er fjernet — én sandhed: vehicle.type styrer alt, `bons.delivery_method` synkroniseres automatisk
- [x] `shared/bon_kort_builder.js`/`bon_kort.css` — leveringsindikator under datolinjen (én linje, klikbar):
  - Tildelt vehicle: `🚴 By-expressen` / `🚕 Taxa 4×35` / `🚛 Volvo Duett`
  - Pickup: `🏠 Afhentning`
  - Ikke planlagt: `📍 Ikke planlagt endnu` (grå/kursiv) — vises også på kitchen-today så køkkenet kan se hvis ingen er booket endnu
  - Klik åbner drawer scrollet til BESTIL BUD-sektionen via `openBonDeliveryFromCard(cardId)` global handler
  - `delivery_notes` (etage, port, kode) bevares som lille grå linje i bunden af kortet — separat fra leveringsindikatoren
- [x] Cost-formel inkl. standard inner-city priser fra office: By-expressen 154 kr (base 100 + included_boxes 2 + extra 50), Taxa 250 kr.
- [x] Booking-mapping `vehicle.type → bons.delivery_method`: volvo→volvo, bike/own-bike→bike, taxi→taxi. Sikrer at alle eksisterende lister/filter/displays (bons-list, calendar, modal) virker uændret.
- [x] `settings/index.html` — ny "Leveringsmetoder"-fane (admin-only):
  - Tabel over alle vehicles (label/type/booking-metode/template-status/URL-status)
  - Inline editor: label, type, booking_method, is_active, URL, template med klikbare variabel-chips, cost-formel JSON
  - Editor skjult som default — åbner ved "Rediger"-klik
- [x] `routes/kitchen.js` — joiner `delivery_vehicles` så `delivery_vehicle_label` kommer med på `/today` + `/later` til frontend-display
- [x] `shared/api.js` — 11 nye wrappers: fetchDeliveryVehicles, fetchDeliveryVehicle, createDeliveryVehicle, patchDeliveryVehicle, deleteDeliveryVehicle, fetchDeliveryTemplateVariables, fetchBookingPayload, bookDelivery, setDeliveryActualCost, fetchDeliveryEvents
- [x] `shared/utils.js` — `mapApiBonToCardData()` udvidet med `delivery_vehicle_label` så bon-kortets indikator kan vise vehicle-navn
- [x] HTML-filer udvidet med modal-script + CSS: `kitchen/today.html`, `kitchen/later.html`, `kitchen/calendar.html`, `office/index.html`. `_bonInfoEditHandler(bonId, opts)` videregiver opts (scrollTo) til drawer.
- [x] **Tests**: `scripts/test-delivery-spor1-unit.js` (65 unit-tests mod isoleret in-memory DB — booking_template, delivery_log, edge cases). `scripts/test-delivery-spor1.js` (46 integration-tests mod spawned server med isoleret test-DB — full HTTP-flow + auth-tjek for admin-only endpoints). Alle grønne.
- [x] **Office Spor 1 deploy-checkliste**: 1) Templates skal udfyldes for By-expressen + Taxa via Settings → Leveringsmetoder før modalen producerer brugbar tekst. 2) Verificér at By-expressens URL `https://byexpressen.groupnet.at/lobo/#!//coreLogin/` matcher hvad office bruger i dag. 3) Test først med taxa (simpel ét-felts paste), så By-expressen (Lobo's 4-trins wizard kræver block-by-block paste).
- [x] **Migration til Spor 2 (3D.2):** Når routes-tabeller introduceres, udvides leveringsindikator-data-kilden til at læse `delivery_route_stops` joined med `delivery_routes`/`delivery_vehicles` parallelt med eksisterende `bons.delivery_vehicle_id`. SSE-events `delivery_route_stop_added`/`_removed` tilføjes til samme handler som nuværende `bon_updated`.

### Delivery — Spor 1: Popout-vindue (19. maj 2026)
> Spec: `docs/CLAUDE_DELIVERY_POPOUT.md` · Mockup: `docs/delivery_note_popout_mockup.html`
> Erstatter den gamle `shared/manual_booking_modal.{js,css}` overlay-modal med et separat popup-vindue der kan placeres ved siden af leverandørens hjemmeside.

**Hvorfor:** Lobo's 4-trins wizard hos By-expressen kræver block-by-block paste. Én samlet tekstblok hjælper ikke når kontoret skal udfylde 12 separate felter. Felt-for-felt-visning løser begge use-cases (Lobo + taxa.nu).

**Princip:** Hvert "felt" i popoutet er en lille template med samme `{variabel}`-syntaks som `booking_template`. Sammensatte felter (fx `Reference: {bon_id} · {total_boxes} kasser · lev. {delivery_time}`) genereres med ét klik. Genbruger `renderTemplate()` direkte — ingen ny syntaks.

- [x] Migration 071: `delivery_vehicles.booking_fields_json` (JSON-array af `{ label, template, step? }`). Seed for By-expressen (med `step`-grouping pr. Lobo-trin) og Taxa 4×35 (uden step). Bagudkompatibel: NULL = ingen felt-konfiguration, popout falder tilbage til "Samlet tekst"-mode.
- [x] `services/booking_template.js` — Intern `_renderWithMeta(template, vars)` returnerer `{ text, hasMissing }`. Ny public `renderFields(vehicle, vars)` returnerer `[{ label, value, missing, step }]` eller `null` ved manglende/ugyldig JSON. `buildBookingPayload` returnerer nu `fields` array parallelt med `clipboard_text` — én sandhed: `Array.isArray(payload.fields)` driver UI-detection.
- [x] `routes/delivery.js` — `booking_fields_json` i PATCH allowed-listen + GET vehicles select.
- [x] `routes/delivery_views.js` — Ny route `GET /delivery/note/:bon_id?vehicle=ID` (ikke under `/api`) serverer popout-HTML. Egen `requireAuthRedirect` middleware fordi `shared/auth.js`'s `requireAuth` er JSON-orienteret — denne redirecter til `/login.html?next=…` ved manglende session.
- [x] `views/delivery/note.{html,css,js}` — Standalone popout-side:
  - Sticky header med bon-id · kunde · dato · tider · pax
  - Vehicle-dropdown (alle aktive vehicles, ikke kun manual_clipboard) + estimat-pille
  - Mode-tabs: Felt-for-felt (default) / Samlet tekst
  - Felt-liste med klikbare chips (klik = `navigator.clipboard.writeText` + grøn `copied`-state + toast). Manglende felter er ikke-klikbare med ⚠-ikon + `[mangler]`-tekst
  - Step-grouping: hvis felter har `step`-property render små step-headers (fx "Trin 2: Afhentning"). Hvis ingen felter har step → ingen headers
  - Sticky footer: booking-ref + faktisk-pris-input + "Spring over" / "✓ Marker som booket"
  - SSE-realtid: `bon_updated` + `bon_status` re-loader payload hvis det er samme bon
  - Clipboard-fallback: pre-selected `<textarea>` + alert hvis `clipboard.writeText` fejler
  - Escape lukker vinduet
- [x] `shared/bon_drawer.js` — Ny `openDeliveryNote(bonId, vehicleId)` global helper. Bruger `window.open` med target-navn `rr-delivery-note-${bonId}` — flere bookings kan håndteres parallelt (fx weekend-batch). Klik på samme bon to gange genbruger samme vindue. Popup-blocked fallback: viser modal med direkte link.
- [x] `shared/bon_kort.js` — `openBestilBud(cardId)` bruger nu `window.openDeliveryNote` i stedet for den gamle modal.
- [x] `settings/index.html` — Felt-editor i Leveringsmetoder-fanen:
  - Hvert felt er en række med ▲▼ reorder, step-input, label-input (påkrævet), template-input (mono-font), × remove
  - "+ Tilføj felt"-knap nederst
  - Variabel-chips (eksisterende) indsætter nu i det <em>sidst-fokuserede</em> felt-template-input (fallback: den globale samlet-tekst-textarea)
  - Tomme rækker filtreres ud ved save; rækker med indhold men uden label = fejl
  - Ny "Felter"-kolonne i vehicle-tabellen viser antal konfigurerede felter eller `—`
- [x] `shared/manual_booking_modal.{js,css}` — **Slettet**. Modal-script/css fjernet fra `kitchen/today.html`, `kitchen/later.html`, `kitchen/calendar.html`, `office/index.html`.
- [x] `scripts/test-delivery-spor1-unit.js` — 19 nye tests: `renderFields` returnerer null ved missing/invalid/non-array JSON, rendrer felt-array korrekt, markerer missing-flag på tomme variabler, bevarer step-property, normaliserer manglende label til tom string. `buildBookingPayload.fields` array indeholder rigtige labels/values/missing-flags + er `null` for vehicle uden config. **84/84 tests passed.**

### Delivery — Spor 1: Skift/annullér booking (20. maj 2026)

Det var ikke muligt at lave en booking om eller fortryde den fra bon-draweren — knappen hed altid "📦 Bestil hos…" (ligner "lav en ny", ikke "ret"), og der var ingen vej til at rydde en booking helt.

- [x] `services/delivery_log.js` — ny `cancelBooking({ bonId, userId, note })`: logger `cancelled`-event i `delivery_events` (event_type-CHECK havde allerede `'cancelled'` — ingen migration) + rydder `bons.delivery_vehicle_id`/`delivery_method`/`courier_provider`/`delivery_cost_estimated`. `delivery_cost` (faktisk pris) bevares så en allerede bogført faktura ikke tabes. Kaster hvis bonen ikke har en aktiv booking.
- [x] `routes/delivery.js` — `POST /api/delivery/cancel` (`requireAuth()`, samme som `/book`).
- [x] `shared/api.js` — `cancelDelivery(data)` wrapper.
- [x] `shared/bon_drawer.js` — BESTIL BUD-sektionen: knappen hedder nu "🔄 Skift bud" når der allerede er en booking (åbner popout som før), og en "Annullér"-knap dukker op ved siden. Annullér → confirm → `cancelDelivery()` → `this.load()`. Booking-historikken viser nu også `cancelled`-events med rød "Annulleret"-tag.
- [x] **SSE-fix (pre-eksisterende bug):** `delivery_log.js` broadcastede `bon_updated` med `{bon_id}` (alt andet + drawer'ens `_bindSSE` bruger `{id}`) og ekskluderede aktørens bruger (`routes/bons.js` ekskluderer ikke). Rettet til `{id}` uden eksklusion, så aktørens kitchen/office-sider re-renderer efter booking.
- [x] **`views/delivery/note.js`** — popoutet og hovedvinduet deler bruger/session, og ingen kode dispatcher `sse:bon_updated` window-events (drawer'ens SSE-bro var død). Popoutet kalder nu `notifyOpener()` der dispatcher `sse:bon_updated` på `window.opener` efter booking → drawer'en genindlæser.
- [x] Tests: +1 unit (`cancelBooking` happy path + edge cases) → 94/94, +4 integration (`/cancel` 200/400/auth) → 50/50. Browser-verificeret end-to-end: book → "🔄 Skift bud" + "Annullér" → annullér → tilbage til "Ikke planlagt", historik viser "Annulleret".

**Office Spor 1+Popout deploy-checkliste (opdateret):** 1) Templates (`booking_template` = samlet tekst fallback) skal udfyldes for By-expressen + Taxa. 2) Felt-konfiguration (`booking_fields_json`) udfyldes via felt-editor under hver vehicle — seed-data ligger der allerede efter migration 071, men juster gerne ud fra hvilke felter office faktisk paster ind hos leverandøren. 3) URL'er bekræftet uændret. 4) Test først taxa (simple liste, ingen step), så By-expressen (step-grouping pr. Lobo-trin gør det visuelt klart hvilke felter der hører til hvilket wizard-trin).

### Moms-refaktorering (1. maj 2026)
> Spec: `docs/CLAUDE_TILBUD_PRIS.md` Del 1–4 + `docs/CLAUDE_MOMS_AUDIT.md` + `docs/CLAUDE_MOMS_AUDIT_AUTO.md`
> Status: KOMPLET. Bug der lagde 25 % moms ovenpå incl-priser er rettet og forebygget.

- [x] **Moms-doktrin** tilføjet til `BON_V2_PRINCIPPER.md` sektion 6b (hvor moms ligger gemt) + 6c (7 visningsregler)
- [x] **`shared/moms.js`** — fælles helpers: `inclToExcl`, `exclToIncl`, `momsOfIncl`, `computeMomsFields`. Eksponeres som `window.Moms` i browser, re-eksporteres fra `db/helpers.js` på server-siden
- [x] **13 områder migreret** fra magic `* 1.25` / `* 0.25` / `/ 1.25` til Moms.* helpers (tilbud, fakturering, planlægning, modal, dashboard, rapporter, indkøb, mail-templates osv.)
- [x] **Pre-commit-hook aktiveret** — blokerer nye `1.25`/`0.25`-multiplikationer uden for `shared/moms.js` og `tests/`
- [x] **Backend leverer pre-beregnede moms-felter** — API-responses for bons/quotes/invoices indeholder `total_incl_moms`, `total_excl_moms`, `moms_amount` så frontends ikke selv regner
- [x] **Tests**: `tests/moms.test.js` (unit) + `tests/moms_audit_e2e.test.js` (28 områder, T-5 testbon = 23.650 → 18.920 + 4.730)
- [x] **2 latente bugs fundet og fixet** under refaktoreringen — se `docs/KENDTE_DATABUGS.md` #003 + #008
- [x] **Tilbuds-prisbug rettet** — `office/views/tilbud.js` lagde tidligere 25 % moms ovenpå priser der allerede var incl. moms. Nu bruger den `Moms.computeMomsFields()` på rå totalpriser

### Kontakter & Firma 360° (april–maj 2026)
> Spec: `docs/CLAUDE_KONTAKTER.md` (Fase 1–4)

- [x] Migration 053: `contact_points`-tabel (polymorf: entity_type = company|customer) + 4 SQLite-triggers der holder `companies.email`/`phone` + `customers.email`/`phone` i sync med `is_primary=1`-rækker
- [x] Migration 054: Drop `changelog.action` CHECK-constraint så nye action-værdier (`contact_point_*`, `enrich`, `merge`, `merge_rollback`) kan tilføjes uden re-create
- [x] Migration 055: `companies.last_enriched_at` + `last_enriched_source` (bruges af batch-enrichment til at finde firmaer der ikke er beriget de sidste 90 dage)
- [x] Migration 056: `companies.alternate_names` (JSON-array af tidligere firmanavne) + `changelog.rolled_back_at` (forhindrer at samme rollback køres to gange)
- [x] **`routes/contact-points.js`** — CRUD: GET (list), POST (opret + auto-promote til primary hvis flag sat), PATCH, DELETE (auto-promote næste hvis primary slettes), PATCH `/:id/toggle-public`
- [x] **`shared/contactPoints.js`** — `syncPrimaryCache()`, `clearOtherPrimaries()`, `promoteNextPrimary()`, `validateContactValue()` (genbruges af både routes/contact-points.js og enrich-flow)
- [x] **`services/contactExtractor.js`** — parse pasted HTML/tekst for emails + telefoner (regex + heuristik om personlig/public). Web-scraping nedgraderet fra auto-fetch til manuelt paste-flow (fjerner robots.txt-, anti-bot- og GDPR-risici)
- [x] **`routes/companies.js`** udvidet:
  - `GET /:id/enrich-preview` — kør CVR/NemHandel-enrichment uden at gemme, returnerer diff (felt-for-felt + nye contact_points)
  - `POST /:id/enrich` — anvend valgt delmængde af diff'en, opdaterer `last_enriched_at` + skriver changelog-entries
  - `POST /:id/extract-contacts` — kør paste-flow mod contactExtractor, returnér kandidater til checkbox-bekræftelse
- [x] **`routes/crm.js`** udvidet:
  - `GET /companies` — aggregeret listview (kunder + bons + omsætning per firma) til Firmaer-fanen
  - `GET /company/:id` — detaljeret firma-data inkl. contact_points + kunder + bons + aktiviteter til Firma 360°
- [x] **CVR-kontaktpunkter** markeres automatisk `is_public=1` (offentlige per definition); manuelt indtastede default'er til `source='manual'`, `is_public=0`, `is_primary=1` (juridisk sikker default)
- [x] **`office/views/crm-firmaer.js`** + **`crm-firma360.js`** — Firmaer-fane parallelt med Kunder, Firma 360°-side med kontaktpunkter (offentlige/private toggle), berig-knap (firma-handling, ikke person-handling), kunder/bons-tabs
- [x] Office sidebar: "Kontakter" erstatter "Kunder" som overskrift, undermenuer Kunder/Firmaer
- [x] **Backfill** kørt: alle eksisterende `companies.email`/`phone` + `customers.email`/`phone` migreret til `contact_points` med `source='manual'`, `is_public=0`, `is_primary=1`

### Test-suite (maj 2026)

**Status:** 437 PASS · 0 FAIL · 3 SKIP. 0 åbne medium+ findings.
9 patches anvendt og lukket (A-I). 32 TEST_OBSERVATIONS logget — 31 lukket, 3 bevidst-accepteret, 5 åbne lav-prio.

**Tracks med fuld dækning:**

Fase 1 (130/130 PASS · 3 SKIP):
- T_DB, T_BON (25/25 inkl. force-mode), T_INPUT, T_AGGR, T_KITCHEN_TODAY,
  T_GROCY, T_ECON, T_PLAN

Fase 2a — Lager:
- T_INVENTORY (10/13 — pre-existing Grocy-flakiness)
- T_STOCK (31/31)
- T_RECIPES (20/20)

Fase 2b — Indkøb & varemodtagelse:
- T_INDKOB_LISTE (38/39)
- T_INDKOB_SETUP (47/47)
- T_INDKOB_ADMIN (50/50)
- T_INDKOB_HORKRAM (54/56)
- T_VAREMODTAGELSE_PATCH_REGRESSION (26/26)
- T_VAREMODTAGELSE_FULL (67/67 efter Patch E)
- T_PATCH_C (10/10)
- T_PATCH_F_REGRESSION (5/5)

Fase 3 — Office:
- T_BONS_LIST (77/78 · 1 SKIP — mail-read setup)
- T_BON_DRAWER_CORE (61/61)
- T_BON_DRAWER_LINES_AND_RELATIONS (69/70 · 1 SKIP — backwards-compat)
- T_FAKTURERING (60/60 efter Patch G)
- T_TILBUD (81/82 · 1 SKIP — bug-tilstand fjernet på dybere niveau efter Patch I)
- T_DASHBOARD (84/84)

**Resterende:** T_CRM, T_CASHFLOW, T_V1_AFSTEMNING (weekenden).

**Patches anvendt:**

| # | Lukker | Indhold |
|---|--------|---------|
| A | F30/F31/F32/F35 | Goods-receipts kritiske fixes (duplikat-pid, photo-path, webhook navn, user-lookup) |
| B | F37/F40/F41 | Goods-receipts validation (temperature_value, product_name, has_deviation klamping) |
| C | #013/#014/#015/F28 | API consistency (suppliers POST+PATCH, grocy-locations duplikat, barcode-duplikat, item.status enum) |
| D | #005/F005 | Force-mode med session-baseret rolle-tjek (privilege-escalation fix) |
| E | F33 | `partially_approved`-status på goods_receipts ved Grocy-fejl |
| F | F49/F57/F58 | SSE-broadcast konsistens (bon_*-events bruger `{id}`, PUT/DELETE lines broadcaster nu) |
| G | F62/F63/F64/F65 | invoices.js consistency (tilbud-filter, accessory-eksklusion, BETALT i done-list) |
| H | #036 | Fakturering UI: rettet "ekskl. moms"-label + 3-rækkers visning |
| I | F68/F72/F73 | Quotes consistency (won-blokering via /convert, is_accessory i INSERT, SSE event-navne) |

**Konventioner etableret:**

- `bon_*`-events bruger `{id, ...metadata}` (jf. Patch F)
- `mail_*`/`po_*`/`supplier_*` events bevarer semantiske FK-navne (`bon_id`, `customer_id` etc.) fordi de er polymorfe
- §6c: alle revenue-felter har 3-felts pattern (`_excl_moms`, `_incl_moms`, `vat_collected`) via `shared/moms.js`
- Test-bons bruger prefix (`T_BL_`, `T_BD_`, `T_FAK_`, `T_TLB_`, `T_DASH_`) for hermetisk cleanup
- Specs er i `tests/specs/T_*.md`, runners i `tests/scripts/run_T_*.js`
- SSE-test-helper `tests/scripts/helpers/sse_listener.js` genbruges på alle office-tracks
- Findings dokumenteres som F-numre i specens §11; observations som #NNN i `docs/TEST_OBSERVATIONS.md`

### Videresendt mail: intern afsender + reel afsender (10. august 2026)

Anne videresendte en kundemail til kontakt@ for at få kunden oprettet. Mailen
landede som en tråd på **os selv** (`#k-3005 Ristet Rug`), og kunden inde i
beskeden blev aldrig set.

Årsag: `info@ristetrug.dk` står i `customers` som kunde 3005 under firmaet Ristet
Rug — huset er sin egen kunde. `processInboundMail` trin 3a matchede derfor
afsenderen mod os, og forward-parseren (`parseForwardedSender`, som har eksisteret
siden migration 018) kører kun på den ufordelte gren mailen aldrig nåede. Kolonnerne
`mail_unmatched.parsed_email/_name/_company` blev skrevet, men **læst ingen steder**.

- **Migration 142**: `settings.internal_mail_domains` (CSV, seedet fra `mail_domain`).
  Entries er enten et helt domæne (`ristetrug.dk`) eller én adresse
  (`bogholder@partner.dk`).
- **`services/internalIdentity.js`** — `isInternalEmail(db, email)`. To uafhængige
  signaler: settingens liste **og** `companies.is_internal = 1` (kunder under et
  internt firma). 60s cache, ryddes af `PATCH /api/settings/:key`.
- **`mailService.resolveEffectiveSender`** — er afsenderen intern, slås kunden op på
  den **videresendte** afsender i stedet. Kendt kunde ⇒ kundens tråd (genåbnes som
  ved en direkte mail). Ukendt eller ingen forward-blok ⇒ ufordelt indbakke med
  `parsed_*` udfyldt. Vi gætter aldrig på os selv.
- **`/api/mail/threads/:id/reply` fik et filter**: modtageren er seneste indgående
  **ikke-interne** afsender. Uden det ville et svar på en videresendt kundemail gå
  til kollegaen — bogført afsender er jo den der videresendte.
- **`create-lead` + `reply` tager `use_parsed`** → opretter/svarer den reelle
  afsender. Domæne-gættet på firmanavnet lægges som note på leadet (det er et spor,
  ikke en sandhed). Serveren afviser `use_parsed` mod en intern adresse.
- **Indbakke-UI**: gult panel "↪ Videresendt af X — reel afsender Y ⟨mail⟩ · Firma"
  med *Opret som lead* / *Svar til Y* / *Findes allerede — søg kunde* (forudfylder
  søgningen med navnet). De gamle knapper hedder nu "…af afsender", så de to ikke
  forveksles. Listevisningen viser `↪ fra <navn> · <firma>`.
- **`parsed_is_internal`** sættes server-side på ufordelte rækker: peger forward-blokken
  tilbage på os selv (fx en videresendt ordrebekræftelse fra bon@), vises panelet ikke.
  Fundet ved at kigge på ægte data — frontenden kender ikke domænelisten.
- **Settings → Mail → "Interne afsendere"**: feltet + en liste over de kunderækker
  reglen faktisk rammer, med begrundelse. Reglen er usynlig i sig selv; den viser sig
  først som en mail der ikke havnede hvor man ventede.
- `_guessCompany` splitter nu på bindestreg: `cap-partner.eu` → "Cap Partner".

**Tests**: `tests/inbox_handling.test.js` udvidet 19 → **29 asserts** (intern uden
forward → ufordelt · intern forward af ukendt → `parsed_*` · intern forward af kendt
kunde → kundens tråd · modtager-valg springer den interne over). Mutations-testet:
rulles `resolveEffectiveSender` tilbage til den gamle adfærd, falder 10 asserts.

**Ikke løst her**: en tråd der ALLEREDE er fejlkoblet kan stadig ikke flyttes —
`PATCH /api/mail/threads/:id` tager ikke `customer_id`, og tråd-visningen har ingen
"Flyt til kunde"-knap. Det er den generelle retteventil (gælder enhver fejlrouting,
ikke kun videresendelser) og bør bygges som sin egen opgave.

### Kunde-oprettelse: find firma uden CVR-nummer + gem tilbudskladde (10. august 2026)

To driftsfriktioner fundet mens Lærke skulle oprettes:

**1. Firma kunne kun slås op på CVR-nummer.** `KundeSoeg`s opret-firma-formular havde
ét felt: 8 cifre + "Slå op" (`cvrLookup` returnerer uden videre ved `length !== 8`).
CAP Partner havde ikke skrevet deres CVR nogen steder — hverken i mailen eller på
hjemmesiden — så man stod af. `GET /api/cvr/search?q=` (navn) og `/api/cvr/virk-search`
har eksisteret hele tiden; de var bare ikke wiret ind her, kun på CRM-Kunder-siden.

- `cvrSearchByName()` i [shared/kunde_soeg.js](shared/kunde_soeg.js): søger på navn,
  **cvrapi først** (præcis på korte entydige navne), **Virk ES som fallback** (fuzzy,
  bedre til fulde firmanavne). Resultater vises som klikbare rækker
  (navn · CVR · postnr/by · status); klik udfylder felterne via `applyCvrResult()`.
- **Link til `datacvr.virk.dk`** forudfyldt med søgeteksten, altid synligt under
  resultaterne. cvrapi kan returnere et plausibelt men forkert match på et ukendt navn
  (verificeret: nonsens-navn gav "IKR A/S"), så udvejen skal stå der.
- Hjælpelinje: *"CVR er ikke påkrævet — firmaet kan oprettes med navnet alene"*.
  Det var allerede sandt (kun `name` er påkrævet), men ikke synligt.
- `_guessCompany` deler nu på bindestreg: `cap-partner.eu` → "Cap Partner".
- **Ikke løst**: adressen fra CVR-opslaget gemmes stadig ikke. `companies.address_id`
  er FK til `addresses`, så det kræver at der først oprettes en adresse-række.
  Gælder også det eksisterende nummer-opslag — ikke en regression.

**2. Et halvfærdigt tilbud kunne ikke gemmes.** "Gem tilbud" fandtes kun på trin 3 og 4
i wizarden, så et tilbud man blev afbrudt i på trin 1 var tabt. `_tSaveBtn()` lægger nu
en **"Gem kladde"** (→ "Gem" når tilbuddet har et nummer) på trin 1, 2 og 3. Trin 0 er
kun skabelonvalg og har intet at gemme.

> ⚠️ **`bons.delivery_date` er `NOT NULL`.** Derfor kan et tilbud ikke gemmes helt uden
> dato. Det ramte også "Gem tilbud" på sidste trin i dag — med en rå
> `NOT NULL constraint failed: bons.delivery_date` i en toast. `_tSaveQuote()` fanger
> det nu, siger det på dansk og hopper til datofeltet. **Det er en workaround.** Den
> rigtige løsning er at lempe kolonnen (kræver 12-trins table-rebuild af `bons` med
> 3 triggers + 11 views hængende på sig — egen opgave, ikke en sidebemærkning).

Verificeret i browser mod kopi af driftsdata: CAP Partner fundet på navnet alene
(CVR 34599963, samme adresse som i mailsignaturen), felterne udfyldt ved klik, og en
kladde gemt fra trin 1 helt uden kunde og varer (T-14, findbar i listen). Testdata ryddet.

### Tilbud: fritekst-linjer fik antal — og fire fejl der lå bagved (10. august 2026)

Driften bad om et **antal-felt ved fritekst** i tilbuds-wizardens sammensæt-trin
(`qty` var hardkodet til 1). Undervejs viste det sig at fritekst var halvbygget i
fire lag:

1. **Fritekst-linjer var usynlige på trin 2.** Rendering-loopet går gennem
   `_tMenu`-kategorierne og slår op i det valgte, så alt uden for Grocy-menuen faldt
   ud af billedet. En fritekst-vare blev talt med i blok-headeren og dukkede op i
   pristabellen på trin 3, men kunne hverken ses, tælles op eller slettes dér hvor man
   sammensætter. Ny `_tBuildExtraItems()` renderer dem som **"Fritekst og øvrige"** med
   samme antals-kontrol som menuvarer. Sektionen fanger også en gemt vare hvis
   opskriften siden er fjernet i Grocy — den forsvandt lydløst før.
   `_tTogMI()` prøver nu fravalg FØR menu-opslaget; ellers kunne en fritekst-vare ikke
   fjernes igen (opslaget returnerede tidligt).
2. **To parallelle fritekst-modeller.** Enkeltbestilling brugte `_tCxItems`
   (`{name, price}`, ingen `qty`) med egen kode i pristabel, preview, PDF og
   `_tCollectLines`. Men ved genindlæsning havner linjer uden `block_type` i
   `_tSiItems` — så *samme linje* blev vist og talt forskelligt før og efter gem.
   `_tCxItems` er fjernet; `_tAddCx()` lægger nu i `_tSiItems` via `_tFreeItem()`,
   som giver fritekst samme form som en menuvare. Fire specialgrene væk.
3. **`category` blev aldrig sendt med ved gem.** Backenden faldt tilbage på
   `block_type` (tidsblokken, fx `morning`) eller NULL — og `bon_lines.category` er
   præcis hvad enheds-tællingen matcher mod `unit_count_categories`. Et konverteret
   tilbud ville have talt **nul enheder** på dashboard, ugeoversigt og kapacitet.
   Latent i dag: 0 konverterede tilbud i drift (kontrolleret).
4. **Menuvarerne bar ikke deres egen kategori.** `_tLoadMenu` brugte kategorien som
   nøgle i `_tMenu`, men kopierede den ikke ind i varen — så `item.category` var
   `undefined`, og rettelsen i punkt 3 ville have gemt tom streng. Nu sættes
   `category: cat` ved indlæsning af menuen.
   Samme sted: indlæsning af et gemt tilbud brugte `l.block_type` som kategori, så
   hver vare i en enkeltbestilling blev til "Ukendt" i preview og PDF. Bruger nu
   `l.category` (API'et har altid returneret feltet).

Verificeret ende-til-ende i browser på begge skabeloner: antal tastet ved oprettelse,
−/+ justerer, header og pristabel regner med det (4 × 250 = 1.000 kr), gem → DB
(`quantity: 4`, `category: '01 Sandwich'` / `'Fritekst'`) → genindlæsning viser
linjen igen med antal. Preview viser `5× Service på stedet`, PDF genereres uden fejl.
Testdata ryddet.

**Slukket tidsblok beholder sit indhold (samme dag).** `_tTogBlk` kørte
`delete _tEvBlk[id]`, så ét klik på "Frokost" smed hele blokken væk — uden varsel og
uden fortrydelse. Det er sikkert at lade indholdet ligge: alt der læser blokke
(stat-stribe, pristabel, preview, `_tCollectLines`, PDF) springer allerede inaktive
blokke over, så en slukket blok tæller stadig ikke med i tilbuddet. Chippen får en
stiplet kant + antal-badge når der ligger noget bag den, så det er synligt at der er
noget at hente tilbage. `_tBuildStats` filtrerede som det eneste sted IKKE på
`_tActBlk` — den talte den slukkede bloks varer med og modsagde dermed pristabellen
(rettet samtidig: 7 varer/700 kr → 1 vare/100 kr når Frokost slukkes).
**Og indholdet overlever et gem.** En slukket bloks varer lægges i
`offer_block_metadata[blok].stash` — den frie JSON-kolonne fra migration 024, der
allerede bærer pax pr. blok. **Ingen skemaændring.**

Hvorfor ikke bare lade linjerne ligge i `bon_lines` med et inaktiv-flag: så ville de
tælle med i priser, enheder og pakkeliste, og de ville følge med over i en rigtig bon
ved konvertering — medmindre hver eneste forbruger af `bon_lines` lærte at filtrere.
Med stash ser `bon_lines` ud præcis som før, så alt nedstrøms er uberørt, og
"en slukket blok er ikke en del af tilbuddet" forbliver sandt i databasen.

- `_tSyncBlockStash()` (kaldes i `_tSaveQuote`): slukket blok med indhold → `stash`;
  tændt blok → `stash` slettes, for så ejer `bon_lines` indholdet. Ingen dobbelt-registrering.
- `_tRestoreBlockStash()` (kaldes i `_tOpenQuote` EFTER linjerne er indlæst, så en
  tændt bloks rigtige indhold ikke overskrives).
- Fælde undervejs: `_tSaveStepFields` gjorde `_tBlockMeta = {}` og byggede den forfra
  fra pax-felterne. Det ville have smidt stash væk hver gang man forlod trin 1.
  Nøglerne opdateres nu i stedet for at blive nulstillet.

Verificeret: fyld Frokost (6 + 2 varer) → sluk → gem → `bon_lines` har KUN morgenmad,
`offer_block_metadata.lunch.stash` har de to varer → genindlæs → Frokost stadig slukket
med "8" på chippen og indholdet intakt → tænd → gem → varerne er tilbage i `bon_lines`
med rigtig blok, antal og kategori, og metadata er `null`. Pax pr. blok (40/80) og stash
lever side om side gennem hele turen. Testdata ryddet.

### Tilbud: varekategorier kan skjules eller flyttes nederst (10. august 2026)

Emballagelinjer — "2× Transportkasse m låg", "15× Receptions Skinner" — stod midt
imellem maden på kundens tilbud og virkede umotiverede. På bon-kortet ligger
emballagen allerede dæmpet nederst; tilbuddet manglede den samme adskillelse.

- **Migration 143**: `settings.offer_category_display`, JSON fra kategorinavn til
  `show` | `last` | `hidden`. Default flytter kun emballage nederst
  (`{"06 Emballage":"last"}`). At **skjule** noget kunden betaler for skal være et
  bevidst valg. Kun det kanoniske Grocy-navn — den historiske variant "Emballage"
  hører ikke til som valgmulighed; den mappes væk af
  `scripts/normalize-bon-line-categories.js`. (Migrationen retter sig selv hvis den
  første udgave nåede at seede begge, men kun hvis værdien er urørt.)
- **Reglen er ren visning.** `_tOfferItems()` / `_tOfferCategories()` bruges de fire
  steder der renderer for kunden (preview + PDF × event + enkeltbestilling).
  Beløbene summeres fortsat over ALLE varer — i single-mode blev `sub` tidligere
  akkumuleret inde i render-loopet, så det er hejst ud, ellers ville en skjult
  kategori have ændret totalen. `_tCollectLines` er urørt: linjerne gemmes uændret
  på bonen, så køkkenet ser emballagen.
- **Settings → Tilbud — opbygning → "Varekategorier på tilbuddet"**: Vis/Nederst/Skjul
  pr. kategori. Kategorier der allerede har en regel tages med selvom de ikke længere
  findes i Grocy — ellers ville en gammel regel være usynlig og umulig at fjerne.
  Grocy nede ⇒ de gemte regler vises stadig.
- **Grocys kategoriliste ét sted**: `getGrocyRecipesCached()` + `getGrocyCategories()`
  i `settings/index.html`. Fire sektioner udledte listen hver for sig; den nye blev
  først en femte kopi. Nu deles den, og opskrifterne hentes én gang pr. sideindlæsning.
  **Grocy er eneste kilde** — historiske stavemåder (`Salat`, `Emballage`) er ikke
  valgmuligheder, de normaliseres væk. `Tilbehør & Bokse`, `Frugt`, `x-Levering`,
  `RR Produktion` m.fl. ER derimod rigtige Grocy-kategorier og skal med.
- Sidegevinst: preview og PDF grupperede event-blokke forskelligt (preview efter
  kategori, PDF fladt). Begge er nu flade med samme sortering.

Verificeret: emballage tilføjet FØRST i en blok → vises alligevel sidst i preview og
PDF; total 2.060 kr uændret. Sat til `hidden` → linjen forsvinder for kunden, totalen
er stadig 2.060 kr, og `_tCollectLines` returnerer den fortsat. Settings gemmer og
listen viser alle Grocy-kategorier. Testdata rullet tilbage.

**Reglerne gælder også eksisterende tilbud — uden at gemme dem.** De anvendes ved
visning, ikke ved gem. Men `_tLoadBlockTypes()` (som henter både blok-typer og
kategori-reglerne) lå bag et `_tBlocksLoaded`-flag og blev kaldt **fire-and-forget**.
To fejl i én:

1. En ændring i Settings slog først igennem efter en **hård genindlæsning af hele
   office** — så det lignede at indstillingen ikke virkede.
2. Et deep-link til et tilbud (`?quote=ID`) kunne nå at rendere med default-blokkene
   før svaret var hjemme.

`initTilbud` er nu `async` og **awaiter** hentningen, og flaget er væk: indstillingerne
hentes hver gang viewet åbnes. Ét lille `/api/settings`-kald pr. view-skift — samme
kald der allerede hentede firmaoplysningerne til PDF'en.

Verificeret på et gemt tilbud med emballage spredt mellem maden: regel sat i Settings →
væk fra Tilbud-viewet og tilbage (ingen reload, intet gem) → begge emballagelinjer
står nederst, total 2.285 kr uændret. Samme mekanisme får en ændret blok-rækkefølge
til at slå igennem.

**Gamle tilbud havde ingen kategori at sortere efter.** Reglen virkede på nye tilbud,
men emballagen fløj stadig rundt på de eksisterende. Årsagen var ikke reglen, men
dataene: `bon_lines.category` blev aldrig gemt fra tilbudsmodulet (se punkt 3 ovenfor),
så alle gamle linjer har NULL eller tidsblokken (`lunch`) i feltet — aldrig
`06 Emballage`. Kontrolleret i driftskopien: T-4 har 7 af 7 linjer uden kategori.

Linjen kender sin opskrift, og Grocy kender opskriftens kategori, så den kan **udledes**
i stedet for at kræve en backfill i databasen: `_tApplyMenuCategories()` kobler
`grocy_recipe_id` → `_tMenu`-kategorien, hver gang menuen er hentet. Grocy er kilden,
så feltet overskrives også når det HAR en værdi (den er i praksis blok-navnet).
Fritekst har ingen opskrift og røres ikke. Gemmes tilbuddet igen, skrives den rigtige
kategori nu med til `bon_lines`, og så retter dataene sig selv efterhånden.

Verificeret på de to tilbud i driftskopien: T-4 (enkeltbestilling, 7/7 linjer uden
kategori) → begge "(emballage)"-varer flytter nederst; T-5 (event, kategori =
`lunch`) → kategorierne bliver til `01 Sandwich`/`x- Service`/`06 Emballage`, og en
emballagevare tvunget **først** i blokken vises **sidst**. Databasen er urørt af testen.

**Leveringen fulgte ikke prismoden.** I `total`-mode ("kun samlet pris") stod
leveringen som **eneste** linje på hele tilbuddet med et beløb ud for sig, mens alle
varerne var uden. Prisen optrådte to steder — i varelisten og i leverings-info-boksen
— og ingen af dem så på `_tPriceMode`. Preview og PDF var oven i købet uenige:
preview skrev beløbet i varelisten men PDF'en gjorde aldrig, så i `line`-mode fik
kunden alle varepriser undtagen leveringens.

Nu gælder samme regel begge steder og i begge visninger: **linjen** vises altid (den
bærer hvor og hvordan der leveres), **beløbet** kun når tilbuddet i øvrigt viser beløb
(`line` eller `block`). Totalen er uændret — leveringen tælles med uanset hvad der vises
(verificeret: 3.000 kr i alle tre modes).

**Blok-typer kan ikke længere få samme navn.** På et tilbud fra drift stod
"Eftermiddagssnack" som blok-overskrift **to gange** med hver sit indhold — og
"Morgenmad" var væk. Forklaringen var ikke en kodefejl i tilbuddet: en blok var
blevet omdøbt i Settings til et navn en anden allerede havde. `saveOfferBlocks`
gemte det uden at sige noget.

- **Gem afviser nu** dublet-label (med begge nøgler nævnt: *"To blokke hedder
  'Eftermiddagssnack' (morning og pmsnack)"*), dublet-nøgle og tomt navn.
- Feltet markeres rødt **mens man skriver**, ikke først ved gem.
- `_tLoadBlockTypes` filtrerer defensivt dublet-nøgler fra: nøglen er blokkens
  identitet (`bon_lines.block_type`), så to ens ville dele `_tEvBlk[id]` og
  rendere samme indhold to gange. Data der allerede ligger sådan må ikke vælte
  et tilbud.
- `addOfferBlock` tager første ledige `customN` i stedet for højeste + 1. Den
  gamle var også unik, men efterlod huller efter en sletning.

Verificeret ved at genskabe situationen: Morgenmad omdøbt til "Eftermiddagssnack"
→ begge felter markeres, gem afvises med besked. Tomt navn og dublet-nøgle
afvises hver for sig; gyldig opsætning gemmes. Driftsdata urørt.

### E-conomic: slider-bokse foldes ud til de tre sliders de består af (#438, 10. august 2026)

`economicInvoice` kunne kun lave én fakturalinje pr. bonlinje. Slider-bokserne er
ét styk i `bon_lines`, men indeholder tre forskellige sliders med hver sit varenummer
i e-conomic. Boksene har derfor intet eget nummer og blokerede faktureringen.

- **Ingen ny stamdata.** Sammensætningen står allerede i Grocys `recipes_nestings`,
  og alle seks børn har varenummer. Samme kilde som `recipe_unit_counts` (migration
  113) bruger til at tælle en boks som 3 enheder. En ændret boks slår igennem af sig selv.
- **`grocyAdapter.getEconomicBundleMap()`** → `Map(recipe_id → [{recipe_id,
  product_number, servings, name}])`. Tre betingelser, alle nødvendige: opskriften
  har **intet** eget varenr, den har mindst én nesting, og **alle** børn har et varenr.
  Ét barn uden ⇒ intet bundt, og linjen blokerer som før — hellere en synlig
  blokering end en faktura hvor en tredjedel mangler. Rammer mod grocy-hq præcis
  77 + 78. Tager valgfrit `(recipes, nestings)` som testsøm; produktionen kalder uden.
- **`enrichBonForEconomic`** hænger `economic_bundle` på linjer uden eget varenr;
  `buildDraftInvoice` folder dem ud; `checkReadiness` regner dem som dækket.
- **Prisen fordeles fra BONENS linjepris**, ikke fra børnenes listepriser — boks 78
  koster 160 kr mens delene står til 176. `splitOre()` fordeler i ører med største
  rest, så fakturasummen er præcis den samme som uden udfoldning (128 ex moms delt
  på tre = 42,67 + 42,67 + 42,66). Med `servings > 1` kan afrundingen pr. enhed
  flytte totalen et par ører; de lægges tilbage på den linje hvor det går præcist op.
- **Beskrivelsen er kun varens eget navn** — boksnavnet ("Alm slider Boks - fisken,
  Frikadellen, kartoflen") ville støje på hver eneste linje.

> ⚠️ **"Eget varenr vinder" er en sikkerhedsvagt, ikke en optimering.** 24 opskrifter
> med eget varenummer HAR nestings. Ingen rammes i dag (deres underopskrifter er
> produktionsopskrifter uden numre), men får én af dem et nummer, er vagten det eneste
> der forhindrer at fx `Fisken` faktureres som sine ingredienser. Det er en **forkert
> faktura**, ikke en blokering. Første udgave af testen bestod af den forkerte grund —
> fixturen har nu en ret hvis underopskrift OGSÅ har varenr, så vagten reelt testes.

**Tests**: `scripts/test-economic-invoice.js` 57/1 (den ene fejl, `#12 kaster uden
nummer (strict)`, er **pre-eksisterende** — bekræftet mod `HEAD`; koden springer
linjen stille over i stedet for at kaste) + `tests/scripts/run_T_ECONOMIC.js` 30/0
(bundtet hele vejen gennem routeren). Mutations-testet: alle fire kerneregler fanges.

**Baggrund — hvorfor koblingerne manglede.** `data/economic-match-review.csv` (25. juni)
har 28 rækker markeret `OK`/`ok` i **status**-kolonnen mens `godkendt_nr` står tom.
`scripts/economic-product-match.js --apply` skriver kun rækker med et tal i
`godkendt_nr`, så alle 28 godkendelser blev sprunget over uden en lyd. 7 opskrifter
er koblet i hånden 10. august (61→78, 35→30, 39+42→105, 99+101+102→104). Resten er
issues: [#439](https://github.com/liffez/bon-v2/issues/439) (rabat/engangsbeløb),
[#440](https://github.com/liffez/bon-v2/issues/440) (koblings-side der afløser CSV'en),
[#441](https://github.com/liffez/bon-v2/issues/441) (5 slettede opskrifter der blokerer
gamle bons permanent).

> **Kan ikke ses lokalt.** Den lokale dev-DB peger på **grocytest**, hvor userfeltet
> `economic_product_number` ikke findes — koblingslisten er tom dér. Verificér mod
> grocy-hq-data, ikke i browseren.

### E-conomic: Rabat og Engangsbeløb som beløbslinjer (#439, 11. august 2026)

De tre `x- Service`-opskrifter er tastet med **kronerne i antal-feltet** og ±1 som pris
(`recipe 135 · quantity 11600 · unit_price -1,00`). Sendt råt bliver det til
**"11.600 stk à -0,80 kr"** på kundens faktura — beløbet er rigtigt, linjen kan ikke
sendes ud.

- **Migration 144**: `settings.economic_amount_line_recipes` = `[7,8,135]`. Opskrifterne
  **udpeges**, de gættes ikke ud fra pris eller kategori — en ægte vare til 1 kr ville
  også ramme sådan et gæt. Samme mønster som `unit_count_extra_recipes` (113).
- `buildDraftInvoice` folder dem til **antal 1 med linjesummen som pris** og bruger
  `special_request` som beskrivelse ("bil", "løn", "Prisjustering") når den findes.
  **Ingen `discountPercentage`** — en rabat skal ikke rabatteres igen.
- Samme migration sætter `economic_oneoff_product_number` = **111**
  (`Engangsbeløb / Diverse`, oprettet i e-conomic 11. august) — kun hvis feltet stadig
  er tomt, så en håndsat værdi ikke overskrives. Feltet har været tomt siden 110, hvilket
  betød at engangsvare-fallbacken aldrig kunne fyre.

> ⚠️ **Rækkefølgen er ikke ligegyldig.** Feature'en er inert indtil recipe 7/8/135 kobles
> til varenr 110/111 i Grocy — og koblingen må først ske **efter** deploy. Gøres den før,
> fjernes den blokering der i dag er det eneste der forhindrer at en rabatlinje sendes i
> den gamle form. Her er den manglende kobling et værn, ikke en fejl.

**Nye e-conomic-varer 11. august**: 106 Øl · 107 Fadøl · 108 Vand m. brus · 109 Cava
(gruppe 2 Catering) · 110 Rabat · 111 Engangsbeløb / Diverse (gruppe 3). 12 opskrifter
koblet samme dag — alle **levende** opskrifter er nu dækket på nær de tre beløbslinjer.
Alt andet der blokerer er slettede opskrifter, se #441 (16 stk: udgåede + dubletter).

**Tests**: `scripts/test-economic-invoice.js` 75/1 (den ene = #444, lukket nedenfor) +
`run_T_ECONOMIC.js` 34/0, hvor route-testen samtidig beviser at migrationen er seedet.

### E-conomic: en linje må ikke forsvinde stille fra fakturaen (#444 + #454, 17. august 2026)

To issues, samme fil, samme rod: **en bonlinje kunne falde ud af fakturaen uden at
nogen fik det at vide.** Resultatet er en faktura der ser rigtig ud og er for lille.
Samme fejlklasse som #319 og #305 — se memory `project_silent_sideeffect_failures`.

**#444 — mekanismen.** Manglede en linje `economic_product_number`, gjorde
`buildDraftInvoice` `continue`. Testen `#12 kaster uden nummer (strict)` havde fejlet
lige siden `NONINVOICE_CATEGORIES` blev indført; ingen andre steder opdagede forskellen.

**#454 — aksen.** `NONINVOICE_CATEGORIES` udelod pr. **kategori**, men to af de fem
kategorier er blandede. Målt på driftsdata:

| Kategori | Billede |
|---|---|
| `Tilbehør & Bokse` | 19 opskrifter, **ingen** har varenr — men flere er ægte varer med omsætning (Glutenfri Bolle, Børne Bokse, HåndDelle, Morgenboller, Toast) |
| `06 Emballage` | 47/96/157 **har** varenr. 45/46/48/82/121 er aldrig faktureret. Men **Receptions Skinner (50) er faktureret 210 gange mod 55 gratis** |
| `RR Produktion` + `RR produktion Hurtig` | 32 opskrifter, alt er prep, 0 kr — ægte "faktureres ikke" |
| `lunch` | **ikke en Grocy-kategori.** Det er `block_type` lækket fra tilbudsmodulet og kan dække hvad som helst |

Alene i 2026 ville reglen have droppet **3.643,90 kr fordelt på 66 bons** hvis de var
gået den automatiske vej. Det er eksponering, ikke tabt omsætning — de fleste blev
faktureret i hånden, hvor et menneske så hele bonen. Men mekanismen var live.

> CLAUDE.md's egen note fra 11. august — *"alle levende opskrifter er nu dækket"* —
> var kun sand fordi kategori-reglen skjulte netop disse varer. Blokerede de, ville
> de have været synlige som ukoblede.

**Løsningen — beløbet afgør, ikke kategorien.** Én ren `classifyLine()` som **både**
`checkReadiness` og `buildDraftInvoice` kører over `mergeLines(...)`, i denne orden:

| # | Betingelse | Udfald |
|---|---|---|
| 1 | linjen har varenr | faktureres |
| 2 | linjen er et bundt (slider-boks) | foldes ud |
| 3 | linjen bærer **0 kr** | udelades — men **rapporteres** |
| 4 | engangsvare-redning valgt (og nummeret findes) | engangsvare-linje |
| 5 | ellers | **blokerer** |

To invarianter:

- **En linje til 0 kr kan ikke gøre fakturaen for lille; en linje med penge må aldrig
  forsvinde.** Samme opskrift kan derfor lande begge steder — `Receptions Skinner`
  udelades gratis og blokerer prissat. Det er præcis dét kategorien ikke kunne udtrykke.
- **`settings.economic_noninvoice_recipes` (migration 149) kan kun ophæve en blokering,
  aldrig fjerne omsætning.** Står en opskrift på listen og linjen har en pris, blokerer
  den — en selvmodsigelse i stamdata skal ses, ikke skjules. Den værste fejl en forkert
  indtastning kan lave, er derfor at en 0-kr-linje ikke kommer med.

> **Hvorfor én `classifyLine` og ikke bare et `throw`.** `checkReadiness` klassificerede
> rå `bon.lines`, builderen sine egne `mergeLines(...)` med en parallel if-kæde. De blev
> holdt i sync ved håndkraft — og dét var netop hvad der producerede #444. Et `throw`
> uden at samle klassifikationen ét sted havde bare gjort divergensen til en 500-fejl.

**To stille udgange mere, lukket samtidig:**
- `createDraftInvoice` slap en bon igennem med `oneoffForMissing` selv om
  `economic_oneoff_product_number` var tom — så faldt den tilbage til `continue`.
  Nu kaster den `oneoff_unavailable`. (Feltet er sat til 111 af migration 144, så
  hullet var lukket i praksis — men ved et tilfælde, ikke ved et værn.)
- **Leverings-synteselinjen** var usynlig for forhåndstjekket: uden varenr blev
  `String(null)` = strengen `"null"` POST'et til e-conomic. Nu `readiness.missingDelivery`
  + `delivery_without_product`. Latent i dag (fallback er sat til 17), men samme fejlklasse.

**Synligt for kontoret:** `checkReadiness` returnerer `excluded[]` + `excluded_total`
(INKL moms — preview-tabellen ved siden af summerer EX moms, så det står eksplicit).
Fakturerings-skærmen viser dem i **forhåndsvisningen**, ikke kun når bonen er blokeret.

**Slettede opskrifter kan ikke kobles — og så det ud som om de kunne.** Userfield-værdier
overlever at en opskrift slettes i Grocy: `objects/recipes/133` svarer **404**, mens
`userfields/recipes/133` stadig returnerer `economic_product_number: "92"`.
`economic-product-match.js --apply` læste kun userfeltet og meldte *"recipe 133 har
allerede 92"* — mens faktureringen læser `/objects/recipes` og aldrig ser spøgelset.
De to værktøjer var uenige om hvad "koblet" betyder, og scriptet meldte succes på noget
der ikke virkede. Det tjekker nu eksistensen **først** (både i apply og som ny status
`SLETTET` i review-CSV'en, med `godkendt_nr = "-"`, så en håndredigeret fil heller ikke
kan skrive et spøgelse). Målt mod grocy-hq: **19 solgte opskrifter findes ikke længere**
— bl.a. Tomaten (260 linjer), Humus'en (192) og Trøflen – slider (48, den der blokerer
i dag). Deres bons kan kun faktureres via engangsbeløb-knappen. Se
[#441](https://github.com/liffez/bon-v2/issues/441), som dermed er større end de 5
opskrifter issuet nævner.

**`scripts/economic-blocking-report.js`** (read-only, kan køres mod drift) viser hvilke
opskrifter der blokerer, hvor mange bons det rammer, og hvad der udelades:

```bash
node --experimental-sqlite scripts/economic-blocking-report.js --all --since 2026-01-01
```

> Scriptet loader selv `.env` (via dotenv, som `scripts/economic-product-match.js`),
> fordi koblingerne hentes fra Grocy. Kør det fra projektroden.

**Tests**: `npm run test:economic` — 100 unit + 52 integration, alle grønne (baseline
var 75/1 + 34/0). **Mutations-testet:** de fire kerneregler rulles hver især tilbage og
fælder en navngiven assert; matrixen står i `tests/specs/T_ECONOMIC.md` §7. Fixturen i
`#8` blev rettet undervejs — den havde hverken antal eller pris, hvilket `quantity NOT NULL`
gør umuligt i drift.

> ⚠️ **Kan ikke ses i den lokale dev-DB** — den peger på grocytest, hvor userfeltet
> `economic_product_number` ikke findes. Verificeret mod en kopi af driftsdata + et
> Grocy-snapshot; kopien er slettet efter brug.

**Koblingsarbejdet er gjort (17. august).** Rapporten fandt først **74 af 429**
fakturerbare bons i 2026 blokeret. Ni opskrifter blev koblet i grocy-hq — Receptions
Skinner (50 + 82), Glutenfri Bolle (75 → varenr 25, ikke scriptets gæt 94), Glutenfri
Bolle slider (95), begge Børne Bokse (71/72), crossiant (104) og de to Kartoflen-One
planet (152/154). **Tilbage: 10 bons**, og ingen af dem kan kobles:

- **133** Trøflen – slider og **134** Falafel Bowl er **slettet i Grocy** (404).
- Fire **fritekst-linjer uden opskrift** — Fingergrønt, Müslibar, Kage, Peanuts.

Alle seks faktureres via engangsbeløb-knappen. Det var netop dét tilfælde der gjorde
knappen nødvendig frem for teoretisk.

To ting fra samme runde, værd at kende:

- **`133` optræder i BEGGE lister** — den blokerer på 6 bons hvor den bærer 2.793 kr,
  og udelades på 1 bon hvor den står til 0 kr. Samme opskrift, to udfald. Det er
  beløbsreglen, og kategorien kunne aldrig have skilt dem ad.
- **`163 Cookie knæk`** viser reglen bære en ufuldstændig liste: opskriften er oprettet
  efter listen blev seedet, står ikke på den, og udelades alligevel korrekt fordi linjen
  er 0 kr.

**Ikke bygget:** Settings-UI til listen — "faktureres ikke" pr. vare hører hjemme på
koblings-siden (#440). Indtil da kræver en ændring SQL, men beløbsreglen betyder at en
ny prep-opskrift er dækket af sin 0-kr-pris uden at nogen rører listen.

**Engangsvare-knappen** ("Fakturér som engangsbeløb") er bygget samtidig. Nødudgangen
fandtes hele vejen ned — route, service og varenr 111 (migration 144) — men
`fakturering.js` kaldte `createEconomicDraft(bonId)` **uden opts**, så flaget aldrig
blev sendt. Den var dermed kun teoretisk, og det holdt ikke: fire af de blokerende
poster i drift er fritekst-linjer uden opskrift, som pr. konstruktion ikke kan stå på
en opskrift-liste og ikke har noget at koble i Grocy.

Knappen vises kun når varenumre er den **eneste** mangel — mangler kunden et
e-conomic-nr, hjælper engangsvaren ikke. `checkReadiness` returnerer derfor
`oneoffAvailable`, så UI'et kan se om nødudgangen findes før den tilbydes; en knap der
altid fejler er værre end ingen knap. Bekræftelsen viser linjerne fremme, skelner
fritekst fra opskrift og siger at de lander på "Diverse" i regnskabet. Er ingen af dem
fritekst, står der i stedet at en vare der sælges igen bør have sit eget varenr i
Grocy — det er en nødudgang, ikke en genvej.

### Kunde-stamdata: hvilket værktøj til hvad (21. august 2026)

Oprydningen i firma-rækker, CVR/EAN og e-conomic-koblinger fik fem scripts. De to
første er dem man kører; resten tages frem når man går i gang med én familie.

| Kommando | Svarer på |
|---|---|
| `npm run audit:kunder -- --cvr` | Kan noget sende en faktura til den **forkerte**? (kobling, CVR, EAN) |
| `npm run audit:dubletter -- --sweep` | Hvilke **familier** skal gennemgås? 62 stk., rangeret efter bons på ukoblede rækker |
| `npm run audit:dubletter -- --cvr <nr>` | Hvilke rækker er dubletter i dén familie, og hænger CVR/EAN/navn sammen? |
| `npm run opdel:plan -- --company <id>` | Hvordan deles en paraply-række op? Skriver en review-fil |
| `npm run opdel:udfoer -- --plan <fil> --company <id>` | Udfør opdelingen. **Dry-run som standard**, `--apply` skriver |
| `npm run audit:fakturering -- --all` | Hvilke opskrifter/kunder blokerer faktureringen? |

Alle er **read-only** på nær `opdel:udfoer --apply`, som tager backup først.

**Delt CVR er familie-nøglen.** Det er det eneste objektive signal — og for kommunerne
det eneste brugbare: rækkerne hedder "Skolen på Grundtvigsvej" og "Fritidscenter
Christianshavn", så der er intet fælles ord at gruppere på. Derfor `--cvr` ved siden
af `--familie`.

> ⚠️ **Klyngerne er forslag, ikke konklusioner.** Danske sammensatte ord lader sig ikke
> afgøre automatisk: "børn" står i både *Børnefortællingen* og *Børne- og Ungdoms-
> forvaltningen*, som er to forskellige enheder. Klynger på seks eller flere rækker
> markeres som sandsynligt over-flettede. Sammenlægning er svær at fortryde — læs dem.

**Rækkefølgen der virker:** ret CVR først (et forkert CVR er dét der spærrer for det
automatiske match), læg så dubletterne sammen, sæt kundenummeret på den overlevende,
og del til sidst paraplyen op. Gør man det omvendt, flyttes bons ind i nye rækker ved
siden af dem der allerede findes.

### Tilbud: kopiér-ordre henter friske priser (#428, 10. august 2026)

`_tCopyBon` ("📋 Kopiér" i wizardens trin 1) tog priserne fra den kopierede bons
linjer. `bon_lines.unit_price` er et **snapshot** fra da den bon blev oprettet —
rigtigt for den gamle bon, forkert som udgangspunkt for et nyt tilbud.

To fejl, og den anden var værst:

1. **Gamle priser.** En ordre fra sidste år sendte sidste års priser til kunden.
2. **Forkert prisliste.** Funktionen så slet ikke på `_tPriceCat`. En butiks-bon
   kopieret ind i et catering-tilbud gav butikspriser — også når ordren var helt frisk.

Priser, kostpriser og kategori hentes nu fra `_tMenu`, som er bygget for tilbuddets
gældende priskategori og genindlæses når kategorien skiftes. **Kun mængderne** kommer
fra den gamle ordre.

- **`_tMenuIndex()`** — `Map<grocy_recipe_id, menuvare>`, ét opslag delt af
  kategori-berigelsen (`_tApplyMenuCategories`) og kopieringen. Samme princip som
  Grocy-kategorihentningen i Settings: én kilde, ikke en kopi pr. kaldested.
- **Fritekst og udgåede opskrifter er ikke det samme.** Begge beholder den gamle pris,
  men kun den ene er et problem:
  - **Fritekst** (ingen `grocy_recipe_id`) har aldrig haft en Grocy-pris. Den er
    skrevet i hånden og kopieres som den er — **ingen markering**. Der er intet at
    hente, så et forbehold ville være ren støj.
  - **Opskrift der er udgået i Grocy** bar sin pris derfra, og det tal vi nu slæber
    med er et gammelt snapshot. Den markeres `stalePrice`: toasten navngiver den
    (*"4 varer kopieret fra bon cafe-3472 — priser fra catering · 1 findes ikke i
    Grocy længere (RR Boks)"*) og pristabellen på trin 3 sætter ⚠ på linjen.

  **Kundens preview og PDF er urørt** — dér skal der ikke stå forbehold om vores
  egne priser.

Verificeret mod driftsdata: bon `cafe-3472` (priskategori **store**, Kyllingen 104 kr)
kopieret ind i et **catering**-tilbud → Kyllingen **130 kr**, Transportkasse 12,50 →
**20 kr**, mængderne (11 og 1) bevaret. Testen kørte med en fritekst-linje og en udgået
opskrift i samme ordre: fritekst kom med til 350 kr **uden** markering, den udgåede fik
⚠ og blev navngivet i toasten. Fritekstens egen livscyklus efterprøvet separat —
oprettes, vises på trin 2 og 3, står i kundens preview, gemmes som `category: 'Fritekst'`
og overlever genindlæsning uden markering. Databasen ryddet.

**Om genbruget:** `_tOpenQuote` og `_tCopyBon` bygger næsten samme item-objekt fra en
bon-linje, og det er fristende at samle dem. Lad være — eller gør det med åbne øjne.
De har modsat semantik: at **åbne** et tilbud skal bruge de gemte priser (det er
tilbuddets egne, aftalte tal), at **kopiere** skal hente friske. En naiv sammenlægning
ville genskabe præcis #428.

### Tilbud: hent menu fra ordre, tilbud eller event (#427, 10. august 2026)

"Vi laver det samme som til Novo i marts" er nu to klik. Knappen **"⤵ Hent menu fra…"**
ligger på trin 2 (Sammensæt), hvor menuen faktisk bygges — ikke ovre ved
ordrehistorikken på trin 1, hvor man ikke kan se resultatet.

Tre kilder i én dialog med faner og søgning **på tværs af kunder**:

| Kilde | Endpoint | Bemærkning |
|---|---|---|
| Tilbud | `GET /api/quotes?q=` | søger bon_number, kunde- og firmanavn |
| Ordre | `GET /api/bons?q=` | do. |
| Event | `GET /api/events` + `/:id/menu` | menuen er en **prisliste uden mængder** → 1 stk. pr. vare |

**Tilføjer altid** — den gamle `_tCopyBon` ryddede alt først, så et fejlklik kostede
det man havde bygget. Ikke-destruktivt: man kan slette det man ikke vil have.

- **Én kerne, tre indgange.** `_tItemFromSource()` + `_tAddSourceLines()` bruges af både
  "Kopiér ordre" og den nye import. De gør nemlig det samme: tager **mængderne** med og
  henter **prisen** på ny (jf. #428). Var de to skrevet hver for sig, ville de drive fra
  hinanden — det var præcis sådan #428 opstod.
- **Blokke bevares.** `_tTargetBlock()` bruger kildens `block_type` når vi kender blokken,
  så en menu hentet fra et andet event-tilbud beholder morgenmad/frokost/snack hver for
  sig i stedet for at smelte sammen. Ellers første tændte blok.
  Forudsatte at **`getBonLines` fik `block_type` med** ([db/helpers.js:97](db/helpers.js:97))
  — kolonnen manglede, og det var derfor `_tCopyBon` hardkodede `'lunch'`.
- **Ens varer slås sammen.** Findes varen allerede i målblokken, lægges mængderne sammen
  i stedet for at give to rækker med samme navn — samme regel som
  `POST /api/bons/:id/lines` bruger server-side. Fritekst slås aldrig sammen: to
  fritekst-linjer kan sagtens være to forskellige ting.
- **Søgefeltet beholder fokus.** Hver søgning re-renderer hele trinnet, så markøren
  sættes tilbage — ellers skulle man klikke i feltet igen for hvert bogstav. (Samme
  fælde som indkøbslistens søgefelt havde.)

Verificeret mod driftsdata, alle tre kilder i samme tilbud: **tilbud T-5** → de fire
varer landede i `lunch` (deres egen blok, ikke hardkodet) med friske catering-priser,
mens Morgenmad blev bevaret; **event-menu** → priser 85/90 erstattet af Grocys 99/130,
fritekst 75 kr med uden markering, alle 1 stk.; **ordre cafe-3472** → fundet på tværs af
kunder (Stromma Danmark A/S), Kyllingen slået sammen til 6 + 11 = **17**, to varer uden
for menuen fik ⚠ og blev navngivet. Syntetisk event oprettet via de rigtige endpoints og
ryddet igen; databasen urørt. Regression grøn: moms 18, indbakke 29, bon_lines 10,
event-menu 42, topup 35.

**Kategorier starter foldet sammen.** En blok viste elleve kategori-overskrifter med
alle varer under sig — en skærmfuld scroll før man var i gang.
`_tSeedCollapsedCategories()` folder **alle** sammen, også dem med valgte varer:
antals-badgen på overskriften viser allerede hvor der er indhold, så linjerne behøver
ikke være fremme for at man ved det. (Første udgave holdt de valgte åbne — unødigt,
netop fordi badgen findes.)

Foldningen er brugerens så snart hun rører den (`_tColCatSeeded`) — et almindeligt
re-render (antalsændring, prisskift) må ikke folde om bag ryggen på hende. Flaget
nulstilles kun ved wizard-reset og **efter en import/kopiering**, så det man netop har
hentet kan ses.

Verificeret: en blok med varer i to kategorier fylder nu fem linjer i stedet for en
skærmfuld, med badges på de to. Klik på en kategori overlever et efterfølgende
re-render. Import folder om, så det hentede kan findes.

**Stadig åbent i #427:** man kan ikke vælge *hvilken* dag der hentes fra i et
fler-dags-tilbud — det afventer #425.

### Mail-oprydning: spam/auto-ignored + bounces (14.-15. maj 2026)
> Spec: `docs/CLAUDE_MAIL_FIX_SPAM_OPHOBNING.md`

- [x] Migration 066: Rydder ~1335 mails fra `mail_unmatched` ved første kørsel (HubSpot/Jotform-notifikationer + auto-svar). Verificeret lokalt: 1412 → 69 åbne
- [x] `services/mailService.js` — `shouldAutoIgnore(fromAddr, subject)` tjekker indkommende mails mod samme mønstre som migration 066 (holdes synkront). Matches indsættes direkte med `status='ignored'` så de ikke ophober sig fremover
- [x] SSE-broadcast af `mail_unmatched` skippes for auto-ignored så badge ikke flickerer på spam
- [x] AUTO_IGNORE-mønstre:
  - HubSpot (alle subdomæner): `%hubspot.com`
  - Jotform: `%@jotform.com`
  - Auto-svar (subject): `Autosvar:`, `Out of Office:`, `Automatic reply:`
- [x] **Migration 067 — korrektion**: Bounces (postmaster, Mailer-Daemon, antispam) er forretningskritiske og IKKE skraldepost. Hver "Undelivered Mail" indikerer kunde med forkert email der skal kontaktes. Mønstre fjernet fra AUTO_IGNORE, eksisterende bounces sat tilbage til `status='open'`
- [x] `scripts/cleanup-unmatched-mail.js` opdateret til at matche migration 1:1 — ad-hoc værktøj til fremtidige spam-bølger
- [x] `office/views/crm-inbox.js` — bounce-helper med direkte kunde-link (commit 8425fd8)

### Office sidebar v2 (14. maj 2026)
> Spec: `docs/CLAUDE_OFFICE_SIDEBAR.md` + `CLAUDE_OFFICE_SIDEBAR_IMPL.md` · Mockup: `docs/office_sidebar_v3.html`

- [x] Sidebaren konsolideret fra **23 → 8 top-level punkter**: Dashboard · Bons · CRM · Tilbud · Logistik · Indkøb · Økonomi · Vagtplan
- [x] Underviews flyttet ned som pills i toppen af content-arealet (`.pills-row` + `.pill.active` i `shared/components.css`)
- [x] `routes/nav.js` — `GET /api/nav/badges` samler 5 badge-tællere i ét kald (erstatter de tidligere 3 separate badge-funktioner)
- [x] `office/index.html` — ny sidebar HTML, pills-container, `switchSection()` + `SECTION_VIEW_MAP` der oversætter `(section, pill) → internt view-navn`
- [x] Klikbar logo med "⇄ KØKKEN"-pill erstatter den gamle zone-switcher
- [x] Footer-ikoner (Whiteboard, SOP, Settings, Log ud) som kompakte 34×34px
- [x] Global søgefelt i topbar — Enter → bons-liste med `?q=`
- [x] SSE-debounced badge-reload via `scheduleBadgeReload()`
- [x] Indkøb + Indkøbsindstillinger mountet via `shared/indkob.js` og `shared/indkob_settings.js` (genbrug fra kitchen-zone)
- [x] Logistik som placeholder-side indtil Spor 2
- [x] **Backwards-compat**: 16 gamle URL-formater (`?view=fakturering`, `?view=kontakter` osv.) mapper automatisk til ny `?view=section&pill=pill` via `REVERSE_MAP`. Drawer-deeplink (`?bon=N`) virker uændret
- [x] Kitchen-topbar: "← Office"-knap for office/admin/salg-roller (erstatter den generiske zone-switcher pill)
- [x] 5 tomme stub-filer slettet: `office/views/{invoicing, logistics, offers, purchasing, reports}.js`

### Settings → Grocy AKTIV-badge + miljø-badge (17. maj 2026)
- [x] **Settings → Grocy**: ★ AKTIV-badge med grøn venstre-border markerer hvilken lokation `default_grocy_location_id` peger på
- [x] "Sæt som aktiv"-knap på de øvrige lokationer skifter default + rydder adapter-cache i ét klik — gør cutover til UI-handling uden SQL
- [x] "Test forbindelse" tester nu den lokation den står ved (nyt `POST /api/settings/locations/:id/test-grocy` endpoint), så status afspejler hver lokation individuelt
- [x] `getGrocyConfig()` accepterer optional `locationIdOverride` så test-endpoint kan vælge target uden at røre adapter-cache
- [x] `shared/env_badge.js` — viser **LOCAL/PROD** i øverste højre hjørne med hostname-baseret detektion. Forhindrer forveksling under cutover. Inkluderes kun i Settings og Office
- [x] `grocyAdapter` slår nu op via `GROCY_<CODE>_KEY` uppercased så env-vars matcher konvention uanset `locations.code` casing
- [x] **Auth fix**: session-cookie blev afvist på localhost når `.env=production` pga. `cookie.secure=true`. Detekterer nu host og slipper secure-flag på localhost (`43d55d7`)

### Density toggle — per-device tæthed (17.-18. maj 2026)
> Spec: `docs/CLAUDE_DENSITY_TOGGLE.md`

- [x] Tre modes: **Komfort** (standard), **Kompakt**, **Tæt** — vælges per device i Settings → Denne enhed, gemmes i localStorage
- [x] Auto-detect: kompakt mode aktiveres på ≤1366px (ThinkPad L14 mfl.)
- [x] Påvirker `zone-kitchen` + `zone-office`. Mobile-zonen bevidst ekskluderet (har egen touch-først CSS)
- [x] `shared/density.js` — init/set/reset/current + auto-detect
- [x] `shared/density.css` — overrides for bon_kort, bon_drawer, modal, vare_picker, calendar, indkob (+ token CSS-variabler)
- [x] `settings/index.html` — ny "Denne enhed"-sektion synlig for alle roller, med radios + nulstil + live preview-kort
- [x] 11 kitchen-shells + `office/index.html` loader `density.css` + `density.js`
- [x] Kompakt-overrides til køkken-dashboard (`88da0cc`): sparer ca. 130px lodret så alle 6 nav-knapper er synlige indenfor 864px viewport
- [x] Kitchen dashboard kategori-liste scroller internt på små skærme (`9a9b743`): `#todayCategories` er nu eneste scrollende region med sticky thead, 5 nye CSS-variabler til tunable density-værdier

### Bon-kort redesign (17. maj 2026)
> Spec: `docs/CLAUDE_BON_KORT_REDESIGN.md`

- [x] **Header komprimeret fra 4-5 linjer → 2 linjer**:
  - Row1: bon-id (20px) + units (26px)
  - Row2: pickup (24px) → lev-time · dato · mode-badge · flag
- [x] **Kunde-sektion context-afhængig**:
  - `context-today` (kitchen-today) → adresse skjult, "▾ adresse" toggler
  - `context-later` / `context-office` → adresse altid synlig (uændret)
  - Toggle bruger `event.stopPropagation` så bon-customer expand ikke trigges samtidig
- [x] **Køkkeninfo læst-toggle**:
  - × close-knap i pillens øvre højre hjørne → markerer som læst (session)
  - Kollapser til "+ Køkkeninfo (læst)" badge
  - Klik på badge → folder pillen ud igen
  - Edit-flowet (klik pill-tekst → textarea) er uændret
- [x] **× mellem antal og navn på menu-linjer** + skarpere line-spacing (`77fd503`)
- [x] **SSE bon_updated bug-fix** (`6624c08`): erstat hele kortet med ny `createCard()` ved `bon_updated`. Den gamle partial-update opdaterede kun `.select-mode-container` + `.unit-primary` (sidstnævnte findes ikke længere efter redesign'en), så ændringer fra bon-drawer var først synlige efter manuel reload. Springer over hvis brugeren er midt i kitchen-info edit-mode eller select-mode

### Mobile-zone udvidelser (14.-17. maj 2026)

- [x] **Mobile Nye: pending-inbox-model** (14. maj, spec: `docs/CLAUDE_MOBIL_NYE_OG_SOEG.md`)
  - "Nye" er ikke et tidsbaseret feed — det er en pending-inbox der kun viser arbejde der endnu ikke er håndteret:
    - Bons med `status_code = 'NY'`
    - Ulæste indkommende mails (med 7-dages cap for v1-residue)
  - Status-skift → bonen forsvinder automatisk fra Nye
  - Mail markeres læst (af nogen, hvor som helst) → forsvinder
  - Fjernet: "Marker alle læst"-knap, IntersectionObserver auto-mark, `last_seen_at`-baseret filtrering (kolonnen er ubrugt men beholdt)
  - `POST /api/bons/:id/mark-seen` + `/mark-all-seen` er no-op for bagudkompatibilitet med cachede klient-builds
- [x] **Mobile Overblik: 14 dage / Måned + klikbare dage** (17. maj, `df53bb9`)
  - Periode-toggle (14 dage default, Måned) huskes i localStorage
  - ◀ ▶ navigerer frem/tilbage
  - Hver dag-kort er klikbart og åbner bons for dagen
  - Sticky toolbar-top fix (`ea48655`) — fjernet 52px gap
  - Link til hele vagtplanen i toolbaren (`5f222eb`)
- [x] **Mobil bons: kundeønsker som kollapsbar sektion** på bon-detalje (`3e4c65e`)

### Office: Opskrifter & priser — margin-analyse (17. maj 2026)
> Krydser Grocy (kostpris fra fulfillment) med Bon v2 (salgspriser pr. priskategori + faktisk volume fra `bon_lines`) for at vise dækningsbidrag pr. opskrift.

- [x] **Moms-doktrin**: alle tal vises ex moms. Revenue summeres incl moms i SQL (`unit_price` er incl moms per §6b) og konverteres via `Moms.inclToExcl()` i Node — undgår 1.25-fælden via pre-commit-hook
- [x] **Backend**:
  - Migration 068: recreate `item_prices` med `item_type`-kolonne (recipe/product/local), nye tabeller `recipe_cost_cache` + `recipe_db_targets`
  - `services/itemPriceBackfill.js` — auto-migration fra Grocy `Salesprice*`-userfields ved første overview-kald (idempotent via setting-flag)
  - `services/grocyAdapter.js` — `invalidateRecipeCost()` hooket ind i alle 7 recipe-CRUD-funktioner så cache holdes frisk uden nightly-wait
  - `routes/recipes_overview.js` — 9 endpoints (overview, refresh-costs, backfill, targets bulk+patch+delete, item-prices, grocy-link redirect)
  - `scripts/refresh-recipe-costs.js` — standalone, kaldes fra system-crontab (foreslået 03:00, før v1-sync 05:00)
  - SSE: `item_price_updated`, `recipes_cost_refreshed`, `recipe_targets_updated`
- [x] **Frontend** (`office/views/opskrifter.js` + `.css`):
  - KPI-strip med "Andel under mål" som primær + conditional Tabsgivende
  - Tabel med default-sortering: tabsgivende → under-mål (omsætning desc)
  - Drill-down side-panel
- [x] Monteret i sidebar under ØKONOMI-sektionen som "Opskrifter & priser"

### Småfixes (14.-19. maj 2026)

- [x] **UTC-tider → dansk lokal tid** (`1f4b551`): changelog, mail-historik osv. viste UTC-tider; nu vises lokal tid i alle visninger
- [x] **Sortér bons: fallback fra `pickup_time` til `delivery_time`** (`42df8fa`): bons uden pickup_time sorteres nu efter delivery_time i stedet for at falde bagest
- [x] **Workload-beregninger ekskl. AFLYST** + brug pax-fallback i SUMs (`5a23bd6`): aflyste bons regnes ikke længere med i kapacitet, og enheder=0 falder tilbage til pax så total ikke bliver 0
- [x] **Bestil bud: tillad valg af eget køretøj** (`08f149d`): Volvo, egen cykel m.fl. i manual-booking modal
- [x] **Bon-linjer: klik på antal → inline stepper** til at justere antal (`f038ce0`)
- [x] **Sammentælling: KATEGORI/VARE-toggle** (`27c638b`): Vare-mode summerer per produktnavn og ignorerer special_request-noter (fx Grisen på Rug 20 + Grisen på Rug (minus tomat) 1 = 21 x Grisen på Rug). Brugerens valg huskes i `localStorage`
- [x] **Køkken-dashboard: neutralt look på "nye bestillinger"-kortet** (`1e773f7`): fjernet rød baggrund + pulse-animation. Kortet matcher nu andre dashboard-kort. Count-pillen bevares brand-brun
- [x] **Bestilling: default-email rettet** fra bestilling@ til bon@ristetrug.dk (`d69a2b1`)
- [x] **Engangs-scripts**:
  - `scripts/mark-prep-bons-internal.js` — oprydning af stale AFSLUTTET (`7cb8bc1`)
  - `scripts/cleanup-test-bons.js` — slet B%-test-bons før launch (`79c9302`)
- [x] **Hetzner**: full nginx-config til whiteboard.ristetrug.dk (`c9b0507`)

### Office UX-fixes (19. maj 2026)

- [x] **Status-farver fra BonConfig** (commit `c1274b9`): ugeoversigt, web-orders kort og kalender web-order-listevisning brugte raw `status_color` fra DB (blege `#f1e6b2` for VENTER INFO) i stedet for BON_CONFIG-paletten. Alle 3 steder fixet — bruger nu `statusToFrontend()` + `BON_CONFIG.statuses` lookup med fallback til DB-værdi hvis BonConfig mangler
- [x] **Produktions-bons i kalender** (commit `c1274b9`):
  - `data-production="true"` på `.cal-bon-entry` overskriver `--bon-color` til `#4a7ab0` (blå)
  - 🔧-badge tilføjet i listevisning (manglede der — kun month-grid havde det)
- [x] **Mobile bons-list customer_name-fallback** (commit `c1274b9`): linje 462 + 642 manglede `customer_name`-fallback (havde kun `contact_name_full || company_name`), så nogle bons viste "Ukendt"
- [x] **SSE `bon_status` til bons-list** (commit `b436492`): `routes/bons.js:593` broadcaster `bon_status` (ikke `bon_updated`) ved status-skift, men kun fakturering/dashboard/rapporter/ugeoversigt lyttede. Bons-list krævede manuel refresh efter status-ændring. Fix: tilføjet `_blHandleBonStatus` + wired `_blHandleBonStatus`, `_tilbudHandleSSE`, `_woHandleSSE` ind i `office/index.html` bon_status-handler
- [x] **Office responsive sidebar** (commit `1de0e58`): sidebar blev brutalt skjult ved <768px uden replacement nav. Sænket breakpoint til 900px og gjort sidebar til **overlay-drawer** der toggles via hamburger-knap (☰) i topbar. Lukker ved klik på backdrop, Escape eller sidebar-link. Backdrop med 0.4 alpha overlay
- [x] **Bon-drawer historik-knap** (commit `a76b9d0`): "⏱ Historik"-knap i drawer-header åbner `showHistorik`-modal med fuld changelog. `showHistorik` refaktoreret til at acceptere enten `cardId` (legacy fra bon-kort) eller `{ bonId, bonNumber }`-objekt (drawer)
- [x] **Bon-drawer expandable note-felter** (commit `ff0cfd7`): klik på sublabel (Kundeønsker, Faktura info, Køkken info, Interne noter) toggler textarea-størrelsen så hele indholdet er synligt uden scroll. Auto-grow mens åben. Lille ▾ caret indikerer state og roterer ved expand
- [x] **Web-order toast i office** (commit `95b4a77`): grøn toast nederst-højre når SSE `bon_created` med `source='web_order'` lander. Klik åbner bon i drawer. Auto-fade efter 12s. Genbruger toast-mønstret fra `_showMailToast`. CSS i `shared/components.css` (`.web-order-toast` + `@keyframes webOrderToastSlide`)
- [x] **Listview "Afleveret"-kolonne** (commit `6e63625`): valgfri kolonne (default off) der viser tidspunktet for seneste `delivery_event` på bonen. Format: HH:MM hvis i dag, dd/MM HH:MM ellers. Hover viser event-type + raw timestamp. Bruger eksisterende `latest_delivery_event_time` fra `/api/bons` (ingen schema-ændring)
- [x] **Owner-mail på nye web-ordrer**: allerede implementeret i migration 062 (`web_order_notification_email` setting + `web_order_owner_notification` skabelon). Markeret som ✅ i huskelisten

### Kunde-flags — påmindelser på kunder og firmaer (19. maj 2026)
> Spec: `docs/CLAUDE_KUNDE_FLAGS.md` (alle 7 faser komplet)
> Commits: `c99c959` (fase 1-4) · `d72a93d` (fase 5-6) · `c0edb31` (fase 7)

Stående/engangs-påmindelser ("flags") på kunder og firmaer der hejses ved bon-åbning og bon-oprettelse i office. Polymorf datamodel (entity_type = company | customer) i samme stil som `contact_points`. Eksempler: "Send cookies som tak næste gang", "Tjek altid leveringstidspunkt — skriver konsekvent forkert", "Fakturaer skal til Anne, IKKE faktura@-adressen".

- [x] **Migration 069**: `entity_flags` + `flag_acks` med partial index `WHERE dismissed_at IS NULL` på hot path
- [x] **`routes/flags.js`** — CRUD: GET (med ack_bons-historik), POST, PATCH, POST /:id/ack (per-bon, UPSERT-idempotent), POST /:id/dismiss (permanent)
- [x] **`GET /api/bons/:id`** leverer `flags`-array fra både kunde og firma med `acked_on_this_bon`-flag
- [x] **`GET /api/bons`** listview tilføjer `flag_count` som korreleret subquery
- [x] **`GET /api/crm/customer/:id`** leverer flags + ack_count + ack_bons (seneste 10), og merger **dismissed** flag som syntetiske `type='dismissed_flag'`-rows ind i `activities`-array (fase 7)
- [x] **`GET /api/crm/company/:id`** spejler flags-leveringen
- [x] **`GET /api/crm/companies`** tilføjer `flag_count` til listview-aggregat
- [x] **`shared/flag_strip.js`** — collapsible strip i bon-drawer med to handlinger:
  - **"Forstået"** = `POST /:id/ack` (per-bon, flag lever videre — bevidst klarere wording end spec'ens "Set")
  - **"Færdig — fjern"** = `POST /:id/dismiss` (permanent — bevidst klarere end spec'ens "Gjort")
  - Default-heuristik: 1 flag = open, 2+ = collapsed. Bevarer brugerens åbnede tilstand ved ack/dismiss, nulstilles kun ved bon-skift via `setBonId`
- [x] **`shared/bon_drawer.js`** — DOM-placeholder + init i constructor + `load(bonId, opts)` med `expandFlags`-flag
- [x] **`office/views/bons-list.js`** — 🚩N-badge i kunde-kolonne, klik åbner drawer med strip force-expanded (stopPropagation så row-klikket ikke samtidig fyrer)
- [x] **`office/index.html`** — `openDrawer(bonId, opts)` propagerer opts ned i drawer.load/open
- [x] **`office/views/crm-kunde360.js`** — `.k3-quick-note` erstattet med "Aktive påmindelser" (kort med × fjern) + "Tilføj" med radio-toggle Påmindelse/Note. Note-mode bruger eksisterende `crm_activities`-flow med kombineret titel+body
- [x] **`office/views/crm-kunde360.js`** Aktivitet-tab: `typeIcons.dismissed_flag = '🚩'`, `typeLabels.dismissed_flag = 'Påmindelse afsluttet'`, læse-only kort (`.k3-tl-readonly` gråtonet) med dismiss-note som kursiv linje
- [x] **`office/views/crm-firma360.js`** — nyt "Påmindelser"-card i oversigt-tab (efter kontaktpunkter, før RFM) med samme tilføj/fjern-mønster
- [x] **`office/views/crm-firmaer.js`** — 🚩N-badge på firma-rækker ved `flag_count > 0`
- [x] **`shared/kunde_soeg.js`** — kunde- og firma-navn i bon-drawer er klikbare i `zone-office` (dotted underline + tooltip). Klik kalder `window.openKunde360()` / `window.openFirma360()` med graceful degradation hvis globals ikke er loadet
- [x] **CSS**: `.flag-strip`/`.flag-item` i `shared/components.css`, `.k3-flag-card`/`.k3-quick-add` i crm-kunde360.js inline-style, `.f3-flag-card` i `shared/firma360.css`, `.ks-sel-name-link` i `shared/kunde_soeg.css`
- [x] **Zone-isolation**: `.zone-kitchen .drawer-flags { display: none }` — flag er office-only værktøj
- [x] **SSE**: `flag_created`, `flag_updated`, `flag_dismissed`, `flag_acked` med `{id, entity_type, entity_id}` polymorft payload
- [x] **Test-data ryddet** efter verifikation

**Bevidst udeladt (ikke cutover-blokker):**
- Firma 360° Aktivitet-tab fase 7-integration — kræver firma-aggregering af `crm_activities` (TODO i `_f3RenderAktivitet`). Dismissed flag vises lige nu kun i Kunde 360° timeline.
- Status-filter på drawer-strip (vis altid på alle bon-statusser) — kan tilføjes senere som `b.status_code IN (aktive)` hvis støj på AFSLUTTET/BETALT bons bliver et problem.

### Kalender-opgradering — status som baggrund + dagstotal øverst + kalender-density (19. maj 2026)
> Spec: `docs/CLAUDE_KALENDER.md` · Mockup-reference: `docs/kalender_optimering.html`

V1-overblikket genskabt med v2's polish: hele bon-rækken farves efter status i stedet for at have en tynd venstrekant-stribe — kontoret kan nu scanne en hel måned og se statusfordelingen uden at læse linje for linje. Dagstotal flyttet til toppen af hver celle. Kalenderen kan have sin egen tæthed særskilt fra det globale density-system hvis brugeren synes den er svær at læse.

- [x] **`shared/calendar.js`** — `--bon-text` CSS-variabel sat fra `statusCfg.text` (genbruger BON_CONFIG's eksisterende `text`-felt — ingen luminans-helper nødvendig). Production-bon sætter inline `--bon-color: #4a7ab0` + `--bon-text: #ffffff` direkte fordi inline-style har højere specificitet end CSS attribute-selectoren (fix på pre-eksisterende bug der gjorde production-bon's blå override umulig). Total-rækken rendres øverst som `cell.appendChild` lige efter datolinjen, ikke som bund-element.
- [x] **`shared/calendar.css`** — `.cal-bon-entry` skiftet fra `border-left: 5px solid var(--bon-color)` + `background: color-mix(... 10%, white)` til fuld `background: var(--bon-color)` + `color: var(--bon-text)`. Border-radius 4px. Hover via `filter: brightness(1.08)` i stedet for color-mix-genberegning. Ghost-stil for `[data-offer="true"]`: 50%-tint + stiplet border. `.cal-day-totals` flyttet fra `margin-top: auto` til top med `border-bottom: 1px dotted`.
- [x] **`shared/density.js`** — Nyt `window.CalendarDensity`-modul (`init`/`set`/`reset`/`current`/`hasExplicitChoice`) med localStorage-nøgle `bon_v2_calendar_density`. Sætter `body.cal-density-X` kun ved eksplicit valg ≠ `'inherit'`. Eget event `calendar-density:change` så Settings-UI kan synkronisere ved cross-tab-ændringer. Auto-init på `<html>` mod first-paint flash, parallelt med eksisterende `Density`-modul.
- [x] **`shared/density.css`** — 3 sæt overrides (`body.cal-density-comfort/compact/dense:not(.zone-mobile) .cal-*`) der placeres efter de globale `body.density-*` regler så CSS-cascade-rækkefølgen sikrer at kalender-override vinder ved samme specificitet. Værdier matcher den globale paletten (cal-day-cell min-height: comfort 110px / compact 88px / dense 72px).
- [x] **`settings/index.html`** — Ny "Tæthed — kalender (særskilt)" sektion i "Denne enhed" med 4 radios (`inherit` = "Følg global" som default + comfort/compact/dense) og nulstil-knap. JS-handler wired til `window.CalendarDensity.set/reset`. Live preview via `calendar-density:change` event.
- [x] **`routes/kitchen.js`** — Pre-eksisterende bug-fix: calendar-endpointet (`GET /api/bons/calendar`) manglede `b.price_category` + `pc.code AS price_category_code` i SELECT. Det betød at frontend-detection `isProduction = bon.price_category === 'produktion'` altid var `false`, så production-bons aldrig blev blå i kalender (på trods af CLAUDE.md's commit c1274b9-note). JOIN tilføjet + felter med i response.
- [x] **Verificeret end-to-end** i browser via preview-tools: alle 6 statuser (NY/VENTER/IGANG/KLAR/LEV/GODKENDT) farves korrekt med matching tekstfarve fra `BON_CONFIG.text` (hvid på mættede, mørk på lyse). Production-bon #3288 viser blå + 🔧. Offer-bon #3291 viser 50%-tint + stiplet border. Density-toggle skifter dynamisk (`set('dense')` → 72px min-height, `reset()` → 88px fra global compact). Listview uændret.

**Bevidst udeladt:**
- Topbar density-toggle på kalender-headeren — plumbing'en findes (`CalendarDensity.set()` virker fra hvor som helst), kan eksponeres uden ny model når brugeren efterspørger den.
- Justering af `BON_CONFIG`-paletten til mindre mættede farver — beslutning fra brugeren: behold farverne, evaluér efter brug. Hvis "rød væg"-fornemmelse opstår på lange AFSLUTTET-måneder, kan en separat `calBg`-property på `BON_CONFIG.statuses` indføres senere uden at røre filter-pills, status-bar eller bon-kort-stripe.

### Enheds-kategorier — kun sandwich/slider/salat tæller (19. maj 2026)

Indtil nu tæller alle bon_lines med i `bons.total_units` så længe `is_accessory=0` — men `is_accessory` er i praksis aldrig sat (0 ud af 8.245 emballage/levering/kage/drikke-linjer). 2.774 ud af 2.893 bons (96 %) havde forkerte enheds-tal der inkluderede kager, drikke, emballage, levering og service-fees. Det forplantede sig til dashboard, ugeoversigt, rapport-KPIs og bon-kortets ENH-tal.

**Ny regel**: kun kategorier i `settings.unit_count_categories` tæller med. Grocy `grupper`-userfield er master for hvilke kategorier der findes; settings udvælger hvilke der tæller. Default-listen er sandwich/slider/salat (matcher faktiske data inkl. historiske stavevarianter).

- Migration 070: `settings.unit_count_categories` JSON-array. Default: `["01 Sandwich","02 Salat","04 Slider","Burger","Slider","Salat"]`
- `db/helpers.js` — `getUnitCountCategories()` med 60s cache + `recalcBonTotalUnits(db, bonId)` helper
- `routes/bons.js` — 3 inline `SUM(quantity)`-queries ved POST/PUT/DELETE `/lines` erstattet med helper
- `routes/quotes.js` — samme helper ved tilbud→bon konvertering
- `routes/reports.js` — `_unitCaseExpr()` builder + 4 monthly/priskategori SQL'er retter `SUM(quantity)` til `SUM(CASE WHEN category IN (...) THEN quantity ELSE 0 END)`. Top-categories (linje 555/570) + dashboard categories (`/today`) + dashboard top-products (`/top-products`) er bevidst IKKE filtreret — de er per-bucket visninger, ikke samlede enheds-metrics
- `shared/bon_kort.js` — `_renderSummary()` viser ikke-tællende kategorier dæmpet (`.summary-row-dim`, opacity 0.55). Grand total kun fra tællende kategorier. Setting fetches lazy ved første sammentælling og caches i `window._unitCountCats`
- `settings/index.html` — Settings → System → "Enheds-kategorier"-sektion: chips med × til at fjerne + dropdown til at tilføje (genereret fra Grocy `GET /api/grocy/recipes`). Settings gemmes som JSON via eksisterende `PATCH /api/settings/:key`
- `scripts/backfill-total-units.js` — dry-run + `--apply` med backup. Re-beregner `total_units` for alle eksisterende bons. Tager backup af `data/bon.db` før `--apply`
- Følgende steder bruger `bons.total_units` direkte og fixes automatisk via backfill: kitchen today/later/calendar, dashboard, ugeoversigt, schedule kapacitet, planning, listview, mobil overblik

**Deploy-trin**:
1. Kør migrations (auto-applies 070)
2. Kør `node --experimental-sqlite scripts/backfill-total-units.js` for dry-run, læs sammenfatningen
3. Kør med `--apply` (tager auto-backup)
4. Justér listen i Settings → System → Enheds-kategorier hvis Grocy bruger andre kategorinavne i produktion

#### Kategori-normalisering — ren Grocy-kilde (3. juni 2026)

Driften viste at emballage stadig blev talt med i enheds-tallet på køkken-dashboardet:
`total_units` var stale for eksisterende bons (backfill aldrig kørt på prod). Samtidig
pegede brugeren på den underliggende skrøbelighed: tællingen matcher på kategori-*navne*,
og default-listen havde dubletter (`"04 Slider"` + `"Slider"`, `"02 Salat"` + `"Salat"`)
fordi historiske/importerede bon_lines bruger bare-varianter mens nye Grocy-bons bruger
de nummererede navne.

**Beslutning**: kategorier skal udelukkende komme fra Grocy. Bare-varianter normaliseres
til Grocy's kanoniske navne, så whitelisten kan være ren (`["01 Sandwich","02 Salat","04 Slider"]`).

- `scripts/normalize-bon-line-categories.js` — **NYT**. Henter Grocy's kategorier LIVE
  (`grocyAdapter.getRecipes`) og udleder mapping bare→kanonisk ved at strippe `NN `-præfiks
  (`04 Slider` ⇒ bare `Slider`). Mål-navne hårdkodes ALDRIG. Opdaterer `bon_lines.category`
  + rydder `settings.unit_count_categories` op til kanonisk form (dedup). Bare-navne uden
  Grocy-match (`Tilbehør`, `lunch`, `Frugt`, `x-Levering`, `x- Service`) røres ikke.
  dry-run default, `--apply` tager backup. Kræver Grocy-adgang (kør på prod).
- `EXTRA_MAP` i scriptet: forretningsregel-overrides for historiske kategorier der IKKE
  findes i Grocy længere og derfor ikke kan udledes via nummer-strip. Pt. `burger → 01 Sandwich`
  (burgere var historisk en sandwich-type; ~1.100 linjer). Målet VALIDERES mod Grocy ved
  kørsel — findes det ikke, springes overriden over (vi opfinder aldrig kategorier).
- **Deploy-rækkefølge (vigtig)**: kør `normalize-bon-line-categories.js --apply` FØR
  `backfill-total-units.js --apply`, så `total_units` beregnes på rene kategorier.
- Data ved analysen: bon_lines havde bl.a. `01 Sandwich` (6.661), `06 Emballage` (4.415),
  `04 Slider` (3.238) + bare-varianter `Slider` (253), `Salat` (31), `Emballage` (210),
  `Drikke` (64), `Kager` (63).

#### Top produkter: emballage ud af konkurrencen (11. august 2026)

Dashboardets "Top produkter" havde **RR Boks (emballage)** som nr. 1. Den følger
med næsten hver bon, så på antal slår den enhver sandwich — uden at være noget
man sælger.

`/top-products` prøvede at filtrere tilbehør fra med `bl.is_accessory = 0`, men
**flaget er aldrig sat**: 0 af 20.781 linjer i drift. Filteret var dødt, og
emballage, drikke og kager konkurrerede på lige fod med maden.

- **`db/helpers.js`** — boolean-delen af `bonUnitsExpr` udskilt som
  `unitCountablePredicate()` ("tæller denne linje som en solgt enhed?").
  `bonUnitsExpr` bruger den nu selv, så listen og `bons.total_units` ikke kan
  drive fra hinanden. **COALESCE på begge kolonner** er ikke kosmetik: uden den
  giver `NULL IN (...)` et NULL-prædikat, og 642 linjer uden kategori ville
  falde ud af BÅDE `sql` og `NOT sql`. I `bonUnitsExpr` er semantikken uændret
  (NULL ramte allerede ELSE-grenen).
- **`GET /api/dashboard/top-products?bucket=food|other`** — `food` (default) er
  kun tællende varer, `other` er resten. Samme svar-form begge veje, så det er
  et filter og ikke et formskift. Tallet er fortsat rå `SUM(quantity)`: en
  slider-boks tæller 3 enheder i `total_units`, men står som 1 stk her, fordi
  det er dét man spørger om i en produktliste. `is_accessory = 0` beholdes som
  sikkerhedssnor.
- **`office/views/dashboard.js`** — foldet "Øvrigt · emballage, drikke, kager"
  under tabellen, som henter `?bucket=other` først ved udfoldning. Overlever
  Kr/Enheder-skift og genindlæsning (hentes igen hvis den står åben).
- **Rapporter → Top kategorier** — emballage lå dér på førstepladsen med 30 %.
  Kategorien hører legitimt hjemme i en kategori-nedbrydning, så den fjernes
  ikke: rækker der ikke tæller dæmpes (opacity .55) med forklaring i tooltip og
  en note under listen. `counts_as_unit` pr. række fra `/top-categories`.
  Begrænsning: kun kategori-reglen kan bruges her — `unit_count_extra_recipes`
  er pr. opskrift, så "Tilbehør & Bokse" dæmpes selvom Børne Bokse i den tæller.
- **Test**: `run_T_DASHBOARD` fik TPR_09/TPR_10 (bucket-opdeling + komplement).
  Seedens Frikadeller-linje flyttet fra `Hovedret` til `01 Sandwich` — ellers
  var TPR_06 + TPR_08 degraderet lydløst til SKIP i stedet for at fejle.
  58 PASS mod baseline 56, samme 15 FAIL (alle #133's UTC-natte-bug i runneren,
  som regner "i dag" i UTC — verificeret ved at køre baseline uden ændringerne).

### Menu-grupper persisteres (20. maj 2026)

Gruppering af menu-linjer på køkken-bon-kortet (select-mode → vælg → Gruppér → titel + note)
var indtil nu ren DOM-manipulation uden persistering — grupper forsvandt ved næste
SSE-re-render eller sidereload, og der var ingen "Gem"-knap. Funktionen var halvbygget:
`_buildMenu` kunne rendre `type:'group'`, men `mapApiBonToCardData` producerede aldrig det,
og `groupSelected` lavede kun et DOM-element.

- Migration 072: `bon_menu_groups` (titel + note + sort_order pr. bon) + `bon_lines.menu_group_id`
  (FK, `ON DELETE SET NULL` — en slettet gruppe opløser sine linjer)
- `PUT /api/bons/:id/menu-groups` — reconcile-endpoint: frontenden sender den fulde struktur
  (`{ groups: [{ title, note, line_ids }] }`), serveren sletter alle grupper for bonen og
  genskaber dem fra payloadet i én transaction. Idempotent; tomme grupper droppes.
  Gruppe-id'er er interne — frontenden refererer dem aldrig. Broadcaster `bon_updated`.
- `db/helpers.js` — `getBonLines` returnerer `menu_group_id`; ny `getBonMenuGroups(bonId)`;
  `getBon` tilknytter `bon.menu_groups`
- `routes/kitchen.js` — `/today` + `/later` tilknytter `bon.menu_groups`
- `shared/utils.js` — `mapApiBonToCardData` bygger menuen gruppe-bevidst: grupper rendres
  øverst i sort_order (titel + note + sammenlagte items), løse linjer kategori-sorteret nedenunder
- `shared/bon_kort.js` — gruppering **auto-gemmer** (debounced 450ms) ved: opret gruppe,
  rediger titel (`finishTitle`), rediger note (`noteChanged`), drag-and-drop, opløs gruppe.
  Ny `dissolveGroup()` + opløs-knap (×) i gruppe-header. `scheduleSaveMenuGroups` →
  serialiserer DOM (fjerner tomme grupper) → `saveMenuGroups()`. Kort "✓ Gemt"-kvittering
  i select-toolbaren
- `shared/bon_kort_builder.js` — "Annuller"-knappen omdøbt til **"Færdig"** (auto-gem betyder
  intet at annullere; "Annuller" antydede fejlagtigt at gruppen blev kasseret). Gruppe-titel
  og -note **escapes** ved rendering (`_buildMenu`) — vedvarende fri-tekst vist på alle
  køkkenskærme
- **SSE-vagt-fix (pre-eksisterende bug):** `kitchen/today.js` + `later.js` tjekkede
  `oldCard.classList.contains('select-mode')`, men `select-mode`-klassen sidder på
  `.select-mode-container` (efterkommer), ikke kortet — vagten var død. Rettet til
  `.querySelector('.select-mode-container.select-mode')` + ny fokus-vagt (afbryd ikke et
  INPUT/TEXTAREA i fokus). Uden dette ville auto-gem → SSE-broadcast → re-render afbryde
  brugeren midt i gruppering
- Browser-verificeret end-to-end: opret gruppe → DB → reload bevarer gruppen (titel escaped),
  opløs rydder DB, select-mode overlever egen SSE-broadcast, re-render efter "Færdig" viser
  persisteret gruppe

**Bevidst udeladt:** Løse linjers drag-drop-rækkefølge persisteres ikke (kun gruppe-medlemskab
+ gruppe-rækkefølge). Grupper rendres altid øverst i deres sort_order — en gruppe trukket
ned blandt løse linjer hopper tilbage til toppen ved reload. Pre-eksisterende begrænsning
(løs-linje-orden var aldrig persisteret); kan tilføjes senere uden skemaændring.

### Delivery — Spor 2: S2.0 Fundament + S2.1 Workflow B (20. maj 2026)
> Spec: `docs/delivery/CLAUDE_DELIVERY_SPOR2.md`
> Vej-routing via OpenRouteService (ORS), geokodning via DAWA. To-workflow-model:
> B (daglig triage) bygget først, A (Volvo-planlægning) følger i S2.2.

**S2.0 — Fundament:**
- [x] Migration 073: `delivery_routes`, `delivery_route_stops`, `delivery_incidents`, `geo_calculations` genskabt med nullable `bon_id` (afstands-cache nøglet på `address_id`), 8 `delivery_*` settings inkl. DAWA-geokodede HQ-koordinater
- [x] `services/geocode.js` — DAWA-geokodning (`geocodeRaw`, `geocodeAddress`), ingen API-nøgle
- [x] `services/routing.js` — ORS-wrapper: `getDistance` (30-dages `address_id`-cache i `geo_calculations`), `getRoute`, `healthCheck`. `RoutingError` med `.code` (no_api_key/timeout/no_route/ors_error/bad_input). ORS `/geojson`-endpoint kræver `Accept: application/geo+json` (json giver HTTP 406)
- [x] `services/delivery_calc.js` — `calculateForBon`: HQ→adresse-afstand + per-vogn constraint-tjek + pris + billigste-egnede-forslag + afhentningstid
- [x] `scripts/backfill-geocode.js` — geokoder `addresses` uden coords (dry-run/`--apply`)
- [x] `routes/delivery.js` — `POST /calculate` (single-bon forslag, geokoder synkront ved manglende coords), `GET /health`
- [x] `routes/addresses.js` — fire-and-forget geokodning efter INSERT (DAWA-kald aldrig på den kritiske sti)
- [x] `booking_template.estimateCost` udvidet med `per_km`-støtte (bagudkompatibelt) + rute-aggregater
- [x] `.env`: `ORS_API_KEY` + `ORS_BASE_URL`
- [x] bon-draweren: constraint-forslag i BESTIL BUD-sektionen (afstand + vogn-anbefaling + alle alternativer med pris). Ikke-anbefalede vogne vises med amber note ("kan vælges alligevel") — aldrig udgrånet/spærret
- [x] `shared/api.js`: `calculateDelivery`, `deliveryHealth`

**S2.1 — Workflow B (leveringsoversigt):**
- [x] `services/route_planner.js` — `computeRoute` (ETA pr. stop, `pickup_time` = MIN over stop af `deadline − kørsel − margin`, negativt pickup klampes til 0, 4-regel constraint-check, SKRIVER IKKE til DB) + `applyRouteProposal` (skriver routes/stops/`bons.pickup_time`, rører ikke bons med status ≥ KLAR). `routing.getRoute` tilgås via modul-objekt så den kan mockes i tests
- [x] `routes/delivery.js` — 11 rute-endpoints: `GET /overview`, rute-CRUD (`GET/POST/PUT/DELETE /routes`), `POST/DELETE /routes/:id/stops`, `/compute`, `/apply`, `/confirm`, `/routes/:id/actual-cost`. Stop-mutationer synker `bons.delivery_vehicle_id`/`delivery_method` (spec §5), kompakterer sequence, afviser ændringer på bekræftede ruter, nulstiller `computed`→`draft` ved stop-ændring
- [x] `office/views/logistik.js` + `logistik.css` — leveringsoversigt: dato-nav, liste over dagens leveringer med per-bon forslag (async `/calculate`), bon-valg → opret tur, rute-panel med compute/apply/confirm/slet + faktisk pris. Erstatter Logistik-placeholderen
- [x] `office/index.html` — logistik wired (script+css+view-registrering+SSE-handler)
- [x] SSE: `delivery_route_stop_added`, `delivery_route_stop_removed`, `delivery_route_status_changed`
- [x] `shared/api.js`: 11 rute-wrappers (`fetchDeliveryOverview`, `createDeliveryRoute`, `addDeliveryRouteStop`, `computeDeliveryRoute`, `applyDeliveryRoute` osv.)

**Constraint-princip (vigtigt):** brud (kapacitet/distance/deadline) er `errors`/`warnings` i forslaget — `apply`/`confirm` nægter ALDRIG. Office bestemmer (kunder betaler gerne for cykellevering langt ude). Frontends viser brud som amber/rød note, ikke som spærring.

**Tests:** `scripts/test-delivery-spor2-unit.js` (25 — routing-cache, delivery_calc constraint-logik), `scripts/test-delivery-spor2-routes.js` (24 — route_planner: pickup=MIN, capacity/distance/deadline-brud, KLAR-bon låst). 143 delivery-tests grønne i alt (inkl. Spor 1's 94). Browser-verificeret end-to-end mod live ORS: opret rute → compute → apply → confirm.

**Bevidst udskudt i S2.1:** Leaflet pin-kort, rute-niveau popout-booking (`/routes/:id/booking-payload` + `/book`), `/history`-endpoint. Den daglige leveringstriage fungerer uden dem.

**Åbne afhængigheder:** ORS-nøgle ligger i `.env` (registreret hos openrouteservice.org). `scripts/backfill-geocode.js` skal køres mod prod-DB før go-live så v1-synkede adresser får coords.

### Delivery — Spor 2: S2.1-rest + S2.2 + delt logistik (20.-21. maj 2026)

**S2.1-rest — Leaflet-kort + booking + historik:**
- [x] Self-hostet Leaflet 1.9.4 + leaflet-heat i `assets/leaflet/` (ingen CDN, ingen build-step)
- [x] Leaflet pin-kort i logistik-viewet: HQ-markør + farvede vogn-markører pr. leverings-bon, ORS-polyline pr. beregnet rute, kort↔liste hover-link, legende
- [x] `GET /overview` returnerer HQ-koordinater; rute-niveau booking via Spor 1's popout (`/routes/:id/booking-payload` + `/routes/:id/book`)
- [x] `GET /history-map?from=&to=&method=` + `office/views/logistik-historik.js` — historiske leveringer som punkt-/heatmap-kort, dato- og metode-filtre. Logistik har pills `[ Oversigt | Historik ]`

**S2.2 — fælles pickup-model + drag-drop:**
- [x] Migration 074: `delivery_vehicles.color`. Migration 075: `delivery_vehicles.pickup_lead_min` (By-expressen = fast 45 min) + `delivery_routes.pickup_time_source` (`auto`/`manual`)
- [x] **Fælles pickup-model**: vi regner altid baglæns — `afhentning = leveringstid − lead`. `lead` = fast `pickup_lead_min` ELLER kørsel + margin. Office kan altid sætte afhentningstiden manuelt (`POST /routes/:id/pickup-time`); en manuel tid overlever genberegning. `route_planner` returnerer `suggested_pickup_time` + `pickup_is_manual`
- [x] **Editérbare ruter**: en bekræftet/booket rute kan altid ændres — stop-ændring nulstiller ruten til `draft` (genberegning nødvendig) og `booked`→`pending`; en afgået (`active`) rute røres ikke. Ingen 409-spærringer
- [x] Forenklet UI: `/confirm` fjernet, "Beregn"+"Anvend" slået sammen til én "Beregn rute"-knap. Drag bon → rute-kort, ▲▼ omarrangér stop
- [x] Settings → Leveringsmetoder: `pickup_lead_min`-felt pr. vogn

**Delt logistik (køkken + office):**
- [x] `office/views/logistik.{js,css}` flyttet til `shared/logistik.{js,css}` — `initLogistik(el, { date?, highlightBon?, openDrawer })`
- [x] `kitchen/logistik.html` — køkken-shell der mounter delt logistik (køkkenet bruger kortet, booker bud, ringer til buddet). Logistik i kitchen MERE-dropdown
- [x] "Se i logistik"-link på bon-kort (kitchen-today/later) + bon-drawer (begge zoner). Office: switcher til logistik-viewet + flash på bonen. Kitchen: navigerer til `kitchen/logistik.html?bon=&date=`. Google Maps-link bevaret

### Delivery — Spor 2: S2.3 Live + courier-mobil (21. maj 2026)
> Spec: `docs/delivery/CLAUDE_DELIVERY_SPOR2.md` §8-10. Betjener den interne chauffør (Volvo/cykel).

- [x] **`routes/delivery.js` — courier-endpoints:**
  - `POST /routes/:id/depart` — courieren kører fra HQ, rute → `active` + `actual_departure`
  - `POST /stops/:id/status` — `{status:'leveret'|'problem', lat?, lng?}`. `leveret` rykker også bonen til LEVERET (`markBonDeliveredFromStop`) + auto-completer ruten når intet stop er `planlagt` mere
  - `POST /incidents` — multipart busboy, logger leveringsproblem (6 typer), valgfrit foto → `attachments`-tabel (`entity_type='delivery_incident'`), sætter stoppet til `problem`
  - `GET /courier/today` — den indloggede chaufførs egne ruter i dag (stop + adresse + kontakt + indhold + incidents)
- [x] **Bon→LEVERET-kobling**: courier-levering flytter bonen til LEVERET så køkken/kontor ser det uden dobbeltarbejde. Grocy auto-consume genbrugt via ny `autoConsumeBonInventory(bonId)` i `db/helpers.js` (udtrukket fra `routes/bons.js` — idempotent via `bons.inventory_deducted`, ét sted, kaldt fra både office-status-skift og courier-levering)
- [x] **`mobile/views/levering.js` + `m-lv-*` CSS** — courier-mobil: dagens ruter, "Kør fra HQ"-knap, stop-kort, stop-detalje (naviger-knap → Google Maps, kontakt på dagen, leveringsinstruks, indhold), "Marker som leveret", 3-trins problem-flow (type → foto+note+position → bekræft). Mockup `courier_mobile_v5.html` uden "Tilbage til HQ"-kort + dual-kontakt (jf. spec §12). Geoposition fanges i baggrunden — blokerer aldrig. Ny "Levering"-tab i mobil-nav (`requires: null`)
- [x] **Logistik live-mode** — når datoen er i dag viser `shared/logistik.js` en live-statbar (● Live · N leveret / N undervejs / N problem). Stop-etiketten viser courierens stop-status (`leveret`/`problem`) frem for bon-statussen. SSE `delivery_stop_status_changed` + `delivery_incident_logged` wired i begge zoner
- [x] **SSE-events**: `delivery_stop_status_changed`, `delivery_incident_logged`, `delivery_route_status_changed` (depart/auto-complete). Polymorf payload (`bon_id`, `route_id`, `stop_id`)
- [x] `shared/api.js` — `fetchCourierToday`, `departDeliveryRoute`, `setDeliveryStopStatus`, `logDeliveryIncident` (multipart FormData)
- [x] **Tests**: `scripts/test-delivery-spor2-courier.js` — 29 integration-tests (spawned server, isoleret test-DB): courier/today kun egne ruter, depart, leveret→bon LEVERET, incident+foto, rute auto-complete, auth. **222 delivery-tests grønne i alt** (94 spor1-unit + 50 spor1-integration + 25 spor2-unit + 24 spor2-routes + 29 spor2-courier). Browser-verificeret: mobil courier-flow (afgang → problem 3-trin → leveret → tur afsluttet) + office live-statbar

**Spor 2 KOMPLET (S2.0-S2.3).** Mangler kun S2.4 (By-expressen API) som afventer Sebastians credentials — Spor 2 fungerer fuldt uden den (manuel popout-booking).

### Delivery — Spor 2: Chauffør-tildeling i logistik (29. maj 2026)

Courier-mobilen (`mobile/views/levering.js`) viste aldrig nogen ture, selv når der lå
en intern rute for dagen. Årsag: `GET /api/delivery/courier/today` filtrerer på
`r.courier_user_id = session.userId`, men logistik-viewet oprettede ruter med
`createDeliveryRoute({ route_date, vehicle_id })` **uden** at sætte `courier_user_id` —
og der fandtes ingen UI til at tildele en chauffør. Feltet forblev NULL, så ingen ruter
matchede den indloggede chauffør.

- `routes/delivery.js` — nyt `GET /api/delivery/couriers` (aktive brugere, `requireAuth()`).
  Egen endpoint frem for `/api/users` som er admin-only — en `salg`-bruger ville ellers få 403.
- `shared/api.js` — `fetchDeliveryCouriers()`.
- `shared/logistik.js` + `logistik.css` — chauffør-dropdown på hvert rute-kort, **kun for
  interne vogne** (`vehicle_booking_method` ≠ `manual_clipboard`/`api` — eksterne som
  By-expressen/taxa bookes hos leverandøren og kører ikke selv). Manglende chauffør viser
  rød advarsel "⚠ Ingen chauffør — vises ikke på mobil". Valg (inkl. ryd → NULL) gemmes
  straks via det eksisterende `PUT /api/delivery/routes/:id` (accepterede allerede
  `courier_user_id`). Delegeret `change`-lytter på `#logRouteList`.
- Koblingen: dropdown sætter `courier_user_id` → matches mod `session.userId` i
  `/courier/today` → ruten dukker op på chaufførens mobil.

### Mail-historik: fælles komponent (21. maj 2026)

Mail blev vist på seks steder med fire separate chat-boble-implementeringer
(`bm-msg` / `si-msg` / `ib-po-msg` / `k3-mail-msg`), tre forskellige dato-formattere
og hård afkortning af beskedteksten (120/150/200/300 tegn) **uden mulighed for at se
hele beskeden** — selvom backenden altid har returneret hele `body_text`.

- `shared/mail_thread.js` + `mail_thread.css` — **NY** fælles komponent. `window.MailThread`:
  - `renderHistory(container, { threads|messages, header?, emptyText?, maxHeight?, onMarkRead? })`
    — chat-boble-historik med **klik-for-at-folde-ud**: lange beskeder (>260 tegn / >5 linjer)
    kollapses visuelt med fade-maske + "Vis hele beskeden ▾"-knap; klik på boblen folder ud.
    Klik på ulæst indgående boble markerer den læst via `onMarkRead`.
  - **Boblen folder kun UD — aldrig ind.** Sammenfoldning sker via "Skjul ▴"-knappen.
    Togglede boblen begge veje, lukkede en markering af fx et EAN-nummer mailen midt i
    markeringen: muse-klikket ender inde i boblen og blev tolket som "luk". To vagter
    oveni, så heller ikke *udfoldningen* stjæler en markering: klikket ignoreres hvis
    musen har flyttet sig mere end `DRAG_SLOP_PX` siden mousedown (træk), eller hvis
    `hasSelectionIn(el)` siger at der står en markering inde i netop den boble (en
    markering et andet sted på siden tæller ikke). Markér-læst fyrer **uanset** at
    foldningen blev undertrykt — man har læst mailen når man markerer i den. Knappen
    er fritaget for vagterne: den er utvetydig hensigt.
  - `fmtDate(iso)` — ét fælles datoformat (dd/M HH:MM, 2-cifret år hvis ikke i år)
  - `normalize({threads|messages})` — tråde/flad liste → sorteret array (nyeste først)
  - `isLong`-heuristik er tegn/linje-baseret (ikke `scrollHeight`) så den virker når
    containeren er skjult (fx drawer-mail-sektion kollapset ved load)
- **Alle seks visninger migreret** til `MailThread.renderHistory`:
  - `shared/bon_kort.js` — "Send mail"-modal (`openBonMail`). Fik også **vedhæftnings-UI**
    (`_bm*`-handlers) så den matcher drawer'en — bon-mail kan nu sendes med samme
    funktioner uanset indgang.
  - `shared/modal.js` — info-modalens mail-sektion. Fik desuden en **"✉ Skriv mail"-knap**
    der åbner `openBonMail` (guarded med `typeof`) — én klar vej til den rige mail-modal.
  - `shared/bon_drawer.js` — drawer-mail-sektionen (`_loadMail`).
  - `shared/supplier_inbox.js` — leverandørpost tråd-preview (`#siMsgHost`-host).
  - `shared/indkob.js` — PO- + leverandør-mail-paneler. `_ibRenderMailMessages` returnerer
    nu en `.ib-mail-host[data-mt-messages]`-placeholder; `_ibHydrateMail()` (kaldt sidst i
    `_ibRender`) afkoder JSON og kalder `renderHistory`.
  - `office/views/crm-kunde360.js` — Kunde 360° mail-tab (`#k3MailHost`-host). Per-besked
    `· #bonnummer`-tag bevaret.
- **Død CSS fjernet**: `.bm-msg*`/`.bm-messages`/`.bm-history-header`/`.bm-badge`/`.bm-no-mail`
  (bon_kort.css), `.bm-msg-att*` (bon_drawer.css), `.si-msg*` (supplier_inbox.js style-blok),
  `.ib-po-msg*`/`.ib-po-mail-msgs`/`.ib-po-mail-empty` (indkob.css), `.k3-mail-msg*`
  (crm-kunde360.js). Døde funktioner fjernet: `_markMailRead` (bon_kort.js),
  `_ibFmtDateTime` (indkob.js). Compose-formularerne er **ikke** rørt — kun historik-visningen
  blev konsolideret (CRM's booking-link-popover, drawer/modal-vedhæftninger, supplier-reply
  bevarer hver deres compose-flow).
- `mail_thread.{js,css}` loades i: today/later/calendar/planning/purchasing (kitchen) +
  office/index.html.
- Browser-verificeret end-to-end på alle seks visninger: historik renderer, fold-ud virker,
  ulæst-markering persisterer, vedhæftninger vises, tom-tilstand vises.

**Bevidst udeladt:** Compose-formularerne (3 bon-varianter + supplier-reply + indkøb +
CRM) er ikke samlet i én komponent — de har genuint forskellige behov (CRM booking-link,
drawer/modal-vedhæftninger, supplier per-tråd-svar). Kun historik-**visningen** — hvor
duplikeringen og "kan ikke læse hele beskeden"-problemet lå — er konsolideret. Tråde
flades stadig ud til én sorteret liste i bon-visningerne (emne vist pr. besked).

**Mail-emoji → SVG (samme dag):** Alle resterende `✉`/`✉️` unicode-envelope-glyffer
(U+2709 — renderer som tynd, næsten usynlig outline) konverteret til `mailIcon()`-SVG:
modal-titler, send-knapper, mail-sektion-labels, "ny mail"-toast (`_showMailToast`),
kontakt-detalje-linjer, kalender-mail-linje, CRM-kontaktrækker m.fl. `textContent`-spots
(knap-tekst, toasts) skiftet til `innerHTML`. Ny `phoneIcon()`-helper i `shared/utils.js`
ved siden af `mailIcon()` — de fire `✉/☏`-kontaktpunkt-par (CRM Firma 360°, Settings
bestillings-import) konverteret samlet så parret forbliver visuelt konsistent (☏ U+260F
er lige så tynd). Farve-emojis (`📨`/`📞` osv.) er urørt — de renderer fint; kun de tynde
monokrome glyffer var usynlige.

### Send flyver fra bon-draweren (22. maj 2026)

Flyver kunne kun sendes fra et bon-kort — `sendFlyver(cardId)` slog op i DOM'en
(`getElementById(cardId)` + læsning af `.bon-id`), så bon-draweren (uden et kort i
DOM'en) kunne ikke sende flyvere.

- `shared/flyver.js` — ny `openFlyverComposer(bonId, bonNr)` åbner send-modalen direkte
  ud fra et bon-id. `sendFlyver(cardId)` delegerer nu til den (bagudkompatibelt — bon-kortene
  uændret).
- `shared/bon_drawer.js` — "✈ Flyver"-knap i drawer-headeren ved siden af "⏱ Historik".
  Klik kalder `window.openFlyverComposer` (guarded med `typeof` — degraderer lydløst hvis
  flyver-systemet ikke er loadet).
- `shared/bon_drawer.css` — `.drawer-flyver` deler styling med `.drawer-history`.
- `office/index.html` + `kitchen/calendar.html` — loader nu `flyver.js` + `flyver.css`
  (today/later havde dem i forvejen). Banner-systemet (`initFlyverBanner`) auto-initialiseres
  ikke i office — kun send-funktionen bruges; flyveren modtages som banner på køkken-views
  som hidtil.
- Browser-verificeret: knap → modal "Send flyver — NNNN" → besked → Send → flyver POST'es
  og lander i `notifications` med `type='flyver'`.

### Settings-reorg (3. juni 2026)
> Spec: `docs/CLAUDE_SETTINGS_REORG.md` (alle dele ✅ gennemført)

Settings-sidebaren omstruktureret fra 23 flade punkter + én "Admin"-divider til navngivne
grupper, og tre operationelle views flyttet ud til de moduler hvor arbejdet hører hjemme.
Fem PR'er:
- **Hotfix (#148)**: dobbelt `ROLE_LABELS`-deklaration (en `var` til bruger-roller + en `const`
  til jobtyper, indført af jobtype-PR #141/#143) brækkede HELE `settings/index.html`'s inline-script
  → `init()` kørte aldrig, siden var død. Jobtype-varianten omdøbt til `JOBTYPE_LABELS`.
  (Settings var brudt i prod indtil dette deployedes.)
- **DEL 1 (#149)**: grupperet sidebar (Denne enhed + Adgang/Team & løn/Bon & salg/Formularer/
  Integrationer/System & vedligehold). Admin-gating omskrevet — de gamle `#st-admin-sep`/
  `#st-admin-label` findes ikke længere, ny logik skjuler tomme gruppe-labels dynamisk.
  Omdøbt: "Tilbud" → "Tilbud — opbygning", "Legoklods-rapport" → "Legoklods-kategorier".
  `data-section`-id'er + switch-logik uændret.
- **DEL 2 (#150)**: indkøb-config-dublet fjernet fra Settings (var allerede monteret i office
  Indkøb → Leverandører via `initIndkobSettings(...,{mode:'page'})`).
- **DEL 3 (#151)**: produkt-duplikater flyttet til office Indkøb som **4. tab** i
  `shared/indkob_settings.js` (`data-idx=3`, ved siden af Leverandører/Produkter/Hørkram).
  API uændret (`/settings/duplicates*`).
- **DEL 4A (#152)**: Sammenlæg firmaer (merge-wizard) flyttet til **CRM → Værktøjer** som ny
  pill + ny selvstændig `office/views/crm-verktoj.js` (injicerer egen CSS, egen `escapeHtml`,
  admin-gated indhold). Merge-API uændret (`/api/admin/merge-companies*`, `requireAuth('admin')`).
- **DEL 4B**: Berig alle firmaer (bulk) bliver bevidst i Settings (tung handling, friktion ønsket).
- **DEL 4C**: per-firma "Berig fra CVR" var allerede bygget (`companies.js` + Firma 360°) — ingen kode.

Besluttede åbne valg: Duplikater = 4. tab (ikke egen pill); Leveringsmetoder + Bestilling-Menu
bliver i Settings (Leveringsmetoder = ægte config; Bestilling-Menu hører under "Formularer"-gruppen).

**Lære (gemt som memory):** `settings/index.html` er én kæmpe inline-`<script>` — en enkelt
dublet top-level-deklaration dræber hele siden lydløst (ingen synlig console-fejl). `node --check`
på det udtrukne inline-script efter hver redigering.

### CRM bulk lead-import (3. juni 2026)
> PR #161. Løser at leads kun kunne oprettes manuelt én ad gangen.

Ny pill **CRM → Importér leads** der indlæser en liste af potentielle kunder på én gang —
fra `.csv`-fil eller indsat direkte fra Excel/Google Sheets.

- **`POST /api/crm/leads/import`** ([routes/crm.js](routes/crm.js)) — pr. række: match firma på
  **CVR** (ellers eksakt navn) + kontakt på **email** → opret eller berig manglende felter,
  **ingen dubletter**. Sætter `stage='lead'` i `crm_customer_meta` (synkes til `rfm_scores` med
  `stage_locked`) — nedgraderer **aldrig** en VIP/aktiv kunde. Valgfrit batch-tag i
  `crm_customer_meta.tags` + valgfri CVR/Virk-berigelse. `dry_run`-flag → matching + rapport
  uden writes (driver præcist preview). Auth-gated via `requireAuth()`.
- **`contact_points` oprettes eksplicit** med `source='manual'`, `is_public=0` (juridisk sikker
  default) — 053-triggerne fyrer kun ved UPDATE, ikke INSERT, så importen gør det selv.
- **Frontend** [office/views/crm-leadimport.js](office/views/crm-leadimport.js) — skilletegn-detektion
  (tab/`;`/`,`), header-genkendelse, kolonne-mapping med auto-gæt, forhåndsvisning + resultattabel
  med statuspiller. [shared/api.js](shared/api.js) → `importLeads()`. Wired i [office/index.html](office/index.html)
  (pill + view-map + view-registry).
- **Ingen migration** (genbruger `customers`/`companies`/`contact_points`/`crm_customer_meta`/`rfm_scores`).
  Ny route-fil ⇒ server-genstart ved deploy. Verificeret end-to-end mod kørende server + DB +
  browser-UI (parse, auto-mapping, dry-run-preview, dedup, privatkunde, fejlrækker).

### Event-pakkeliste v2 — produktions-niveau + buffer-mekanismer (12. juni 2026)
> Spec: `docs/CLAUDE_EVENT.md §14b`. Driftsfeedback: pakkelisten eksploderede dressinger/Frisk
> Grønt til salt/peber/tahini — men de blandes færdige hjemmefra og pakkes som færdige varer.

- **Produktions-niveau pakkeliste** ([shared/modal.js](shared/modal.js) `showPakkeliste`): direkte varer
  + underopskrifter som ét færdigt item ("Blandet hjemmefra"), ikke eksploderet. Tabs `📦 Pak ned` / `🍽 Skal laves`.
- **Tre buffer-mekanismer** (alle trækkes fra HQ ved LEVERET):
  - override (migration 097, pr. produkt): ERSTATTER en direkte vares mængde.
  - **extra** (migration 102 `prep_packing_extras`, pr. produkt): LÆGGER en konkret vare OVENI ("➕ Tag ekstra med"-vælger).
  - **recipe-factor** (migration 103 `prep_packing_recipe_overrides`, pr. underopskrift): SKALERER en
    underopskrifts råvarer proportionalt. Frisk Grønt 13,63→16 kg ⇒ `factor=16/13,63`; ved LEVERET ganges
    faktoren på råvare-multiplieren i `resolveConsumeItems` (kål, spinat … skaleres, inkl. nestede underopskrifter).
- **Read-only forhåndsvisning** `GET /api/bons/:id/packing/consume-preview` → `grocyAdapter.planConsume`:
  viser PRÆCIS hvad LEVERET ville trække fra HQ uden at røre lageret. Consume-logikken er udtrukket til delte
  helpers (`applyPackingAdjustments` + `makeEffectiveStock`) som BÅDE `consumeRecipes` OG preview bruger → garanteret match.
- Filer: [services/ingredientResolver.js](services/ingredientResolver.js) (`resolveConsumeItems(lines, recipeFactors)`
  + `weight_grams` på production sub_recipes) · [services/grocyAdapter.js](services/grocyAdapter.js) ·
  [db/helpers.js](db/helpers.js) · [routes/bons.js](routes/bons.js) · [shared/modal.js](shared/modal.js)+css.
- **Tests:** `scripts/test-recipe-factor.js` (8) + `scripts/test-prep-packing.js` udvidet til 12 (extras). Begge grønne.

### Event top-up-forslag — forecast minus beregnet rest (13. juni 2026)
> Spec: `docs/CLAUDE_EVENT.md §6` (nu ✅ implementeret). Driftsbehov: top-up-bonnen skal vide hvad
> der allerede står i traileren ud fra prep-bonnen, så man hverken henter for meget eller for lidt.

- **`computeTopupSuggestion(event, date)`** i [routes/events.js](routes/events.js) +
  `GET /api/events/:id/topup-suggestion?date=`:
  - `rest = preppet (prep+topup, delivery_date ≤ dato) − solgt (salg, delivery_date < dato)` —
    dagens salg er ikke sket endnu; en allerede oprettet topup-bon på dagen reducerer forslaget.
  - Kategori-niveau: `forslag = max(0, forecast_dag_N − rest)`. Forecasten er pr. kategori →
    fordeles pro-rata på prep-mixets produkter (`allocateInteger`, largest remainder).
  - Råvare-niveau: BOM-behov af forslaget mod BOM-rest (m/pakke-overrides) → **fetch**
    ("hent mere fra HQ") + **surplus** ("rigeligt på pladsen — behøver ikke hentes").
    Degraderer gracefully til kun kategori-niveau hvis Grocy er nede (kategori-delen er ren SQL).
  - Resten er et GÆT ("vi er trætte om aftenen" — salget er ikke altid tastet): `sales_bon_count`
    sendes med, UI viser antagelsen eksplicit (⚠ ved 0 salgsbons), alt frit justerbart.
- **UI** ([office/views/events.js](office/views/events.js)): "+ Top-up"-modalen pre-fylder linjer fra
  forslaget, viser kategori-tabel (Forecast/Preppet/Solgt/Rest/Forslag) + foldbart råvare-tjek.
  Default-dato = i dag hvis midt i eventet (lokal dato — ikke `toISOString`/UTC-buggen).
  Dato-skift genberegner og erstatter linjerne.
- **Test:** `scripts/test-topup-suggestion.js` — 35 asserts (mockede Grocy/BOM, ægte helper:
  kategori-math, clamp, datofiltre, allokering, fetch/surplus, degradering, tomt event). Grøn.
- Browser-verificeret end-to-end mod syntetisk event (oprettet + ryddet op igen).

### Moduler bygget efter 21. maj — efterdokumenteret (29. juni 2026)
> Disse moduler blev bygget mellem maj og juni, men status-sektionen ovenfor stoppede
> ved 21. maj. Efterdokumenteret ved en tracker-oprydning 29. juni 2026 (verificeret mod kode,
> migrations op til 119). 6 GitHub-issues lukket som færdige (#64, #70, #71, #77, #85, #132).

#### Driftsregnskab (dagsbaseret resultatanalyse) — #132 ✅
- [x] `routes/drift.js` — `GET /api/drift/day?date=&mode=` (dagsresultat, live/frosset), `GET /api/drift/day/bons` (per-bon nedbrydning, altid live), `POST /api/drift/refreeze` (admin), `GET /api/drift/period?from=&to=` (trend), `GET /api/drift/items?from=&to=` (produktions-sammentælling pr. kategori, altid live)
- [x] **Løn% + råvare% (branchens nøgletal)** på KPI-pillerne og som kolonner i dag-for-dag, plus procent-trend-kurve i uge/periode. Farvekodes mod måltal (migration 145: `target_labor_pct`, `target_food_cost_pct`, `target_pct_tolerance` — **tomme som default = ingen farve**, sættes i Settings → Løn & jobtyper). Måltal fryses aldrig ind i `labor_day_snapshot`; de lægges på svaret uden om `data_json`, så et ændret mål også gælder historiske dage. Detaljer i `docs/CLAUDE_DRIFTSREGNSKAB.md` §6 + §6b
- [x] `services/laborAdapter.js` — Smartplan-timer × lokale `wage_rates` (tidsversioneret timeløn) + `smartplan_role_map` (jobtype → production|delivery|other)
- [x] Migrations 088 (`wage_rates` + `smartplan_role_map`), 091 (`labor_day_snapshot` — fryser afsluttede dage ved første visning), 093 (`settings.labor_overhead_pct`)
- [x] `computeDay()`: revenue incl→ex, cost ex, delivery ex, løn ex m. overhead, enheder, kapacitetsrate, løn-andel %. Alt ex moms. Office-view `office/views/driftsregnskab.js` (ØKONOMI-sektionen)
- Smartplan leverer KUN timer (ingen løn) — løn er selv-styret CSV (jf. memory `project_smartplan_salary_blocker`)

#### Produktionsbatch MVP — #85 ✅
- [x] `routes/production.js` — `POST /api/production/batches` (QU-konvertering server-side, Grocy-consume + self-production add, idempotens via `batch_nonce`), `GET /batches`, `GET /batches/:id`
- [x] `shared/production_batch.js` — `window.ProductionBatch.open()`-modal: redigér opskrift-kopi før produktion (tilføj/fjern/byt varer, justér mængder, markér afvigelse: justeret/udeladt/byttet/tilføjet), valgfri indkøbsliste-kobling
- [x] Migrations 089 (`production_batches` + `production_batch_consumption`), 090 (output-produkt nullable → consume-only batches). Alt ex moms

#### E-conomic-adapter — #77 ✅ (MVP draft-faktura)
- [x] `services/economicAdapter.js` — auth (X-AppSecretToken + X-AgreementGrantToken), REST + OpenAPI base-URLs, fejlklasser (Config/Auth/Rate), timeout
- [x] `services/economicInvoice.js` — bon → draft-invoice payload-builder (ren funktion), moms-konvertering `line_total` incl→`unitNetPrice` ex via `shared/moms.js`, kunde-resolver (company > customer economic-nr), EAN-tjek, kategori-eksklusion (emballage/prep uden varenr)
- [x] Migration 110 — `bons.economic_draft_number`/`_at` (guard mod re-send), `customers.discount_percent`, `delivery_vehicles.economic_product_number`, settings (payment_terms/layout/fallback-produkt/draft+invoice URL)
- [x] Bruges af `routes/invoices.js` + `routes/cashflow.js` + `services/cashflowReconcile.js`. Opretter KUN draft (`POST /invoices/drafts`) — bogfører aldrig automatisk. Idempotens via Idempotency-Key
- Bemærk: arbejde fortsatte på branch `claude/economic-docs` (Spor 1 + Spor 2 Fase 1 live-verificeret per memory)

#### Lobo/Byekspressen delivery (Spor 2 S2.4) — #64 ✅ (kode bygget)
- [x] `services/byExpressenAdapter.js` — HTTP Basic → JWT (cachet til expiry), `DEFAULT_BOOKING_SCOPES` (31/38 aktive)
- [x] `services/lobo_booking.js` — `quoteForBon()` (orderdraft → læs kostpris → slet kladde = pris uden ordre), `bookForBon()` (POST /orders → `delivery_events`), `defaultBoxesForBon()`, `suggestCustomerPrice()` (margin-anbefaling)
- [x] `services/lobo_webhook.js` — selvkalibrerende HMAC (finder sign_target + header ved første callback), `mapLoboEvent`
- [x] Migrations 093 (`delivery_events.snapshot_json` + By-ex config seed, provider='lobo', sandbox-toggle), 108 (host → `byexpressen.groupnet.at`, fkpayment=1 faktura). PR #235 (sandkasse-toggle, se-og-ret-panel, status-polling)
- [x] Integreret i Spor 1's popout-booking + `POST /api/delivery/book`. Ekstern API-adgang (scope/403) kan stadig blokere i drift — se memory `project_lobo_byekspressen_api`

#### Outreach-kampagner + CRM-triks — #80 (delvist), #226/#233 leveret
- [x] `routes/campaigns.js` — `GET /api/campaigns`, `/pipeline`, `POST /campaigns`, `PATCH /:id`, `POST /:id/members` (jura-validering: B2C+DNC blokeret, B2B uden consent OK), `POST /from-suggestion`
- [x] Migrations 084-085 (`outreach_campaigns` + `campaign_members`), 105 (prospect-fit-vægte: branche 50% / størrelse 20% / afstand 30% + blacklist), 106 (`prospect_distance_min_km`), 107 (reaktiverings-tærskler), 109 (`crm_suggestion_snoozes` — skjul forslag midlertidigt), 114 (`crm_activities.outcome` = success|partial|declined|no_response|pending)
- [x] Leveret: review_ask (anbefaling efter glad kunde, #226), snooze + "N skjult", `interleaveSuggestions` round-robin feed-budget, gradueret ICP-fit + afstands-filter (#213), outcome-måling på review-ask (#233)
- [ ] **Udestår** (#228/#229/#230): `cold_offer`-suggestion (kold tilbudsopfølgning), delt `shared/crm_worklist.js` fundament, sæson- + rytme-lister. **#80 Outreach Fase 1 scope ikke endeligt bekræftet** — review

#### Event-modul (fundament) — bygget (ikke et selvstændigt issue; ≠ Festival #81)
- [x] `routes/events.js` — `GET/POST /api/events`, `PATCH /:id`, `GET /:id/overview` (bons i 4 roller + P&L), `POST /:id/bons` (generator), `PUT /:id/forecast` (per kategori/dag)
- [x] `office/views/events.js` — liste + detalje med 4 roller (🎒 prep, 🔄 topup, 💰 dagssalg, 💸 udgift) + P&L + generator, SSE live-reload
- [x] Migrations 095 (`events` + `bons.event_id`), 096 (`event_forecast`), 098 (event-adresse), 100 (polish), 101 (`bons.event_role`), 104 (`bon_lines.moms_included` — event-udgifter ex moms)
- [x] **No-deduct gate (§5):** event-salgsbons trækker IKKE HQ-lager (kun prep-bons), håndhævet i `autoConsumeBonInventory` scoped til event_id. "Let event fra HQ"-model — adskilt fra Festival-specens trailer-Grocy + transfer
- Bygger ovenpå: "Event-pakkeliste v2" + "Event top-up-forslag" (egne sektioner ovenfor)

#### Diverse mindre migrations efter 21. maj
- 081 — FAKTURERET → BETALT direkte (status-transition)
- 083 — KLAR → GODKENDT direkte (køkken kan gå tilbage uden IGANG)
- 094 — mail inline-billeder (`mail_attachments.content_id`/`is_inline`)
- 099 — `mail_unmatched.body_html` (billeder i CRM-indbakke)
- 104 — inbox-handling
- 111 — stående rabat (trigger kopierer company/customer `discount_percent` → `offer_discount_percent` ved INSERT)
- 112 — `cf_meta.economic_booked_until` (e-conomic-afstemnings-vandmærke)
- 113 — `recipe_unit_counts` (boks-aware enheder) + `settings.unit_count_extra_recipes`

### Pengestrøm §2.F + §2.E — split-allokering + direkte event-salg (29. juni 2026)
> Spec: `docs/economics/CLAUDE_PENGESTROEM.md` §2.F + §2.E. Løser tre drift-sager der brød den
> stive 1:1-bank-afstemning: faktura split på flere bons, bon der ikke kunne kobles (søgning så
> kun udestaaende), og Zettle/event-indtægt uden faktura.

- **Migration 115:** `cf_allocations` (én tx → ét/flere mål MED beløb; target_type invoice|bon|event|fee).
  Backfill af eksisterende `matched_invoice_id` → 1:1-allokering. `matched_invoice_id` bevares som
  denormaliseret hurtig-sti — sandheden er allokeringerne.
- **§2.F:** `POST/DELETE /api/cashflow/allocations`, `GET /transactions/:id/allocations`,
  `GET /match-targets` (universel union: bons + fakturaer + events). "Kan ikke matches"-listen er nu
  allokerings-bevidst. **To-akset status:** allokering rører IKKE `cf_invoices.betalt` (bank-afstemt ≠
  e-conomic-bogført — reconcile B ejer `betalt`). Split-UI i panelet (flere linjer m. beløb, gebyr-linje,
  rest-tæller). Brutto+gebyr-model: Zettle-netto = event-brutto + negativ gebyr-linje.
- **§2.E (direkte event-salg, bygget på cf_allocations — IKKE matched_event_id):**
  `GET /events-on-date` (auto-forslag på dato-overlap, +5 dages buffer) · `GET /event-income`
  (per-event brutto/gebyr/netto-kort i Overblik) · `POST /create-bon-from-tx` (opret BETALT salgsbon,
  event_role='sales', festival-pris, ingen kunde; genbruger eventets salgsbon hvis den findes; fleksible
  linjer + valgfri gebyr). "🧾 Opret bon"-knap i alloc-panelet.
- `shared/api.js`: 7 nye wrappers (allocations, match-targets, events-on-date, event-income, create-bon-from-tx).
- Caseliste + beslutninger afklaret med Leif (brutto+gebyr, ingen forudbetaling, MobilePay relevant,
  status BETALT, samlefaktura→bons) — i specens §2.F.4/§2.F.5 + §2.E.
- Drive-by: `scripts/test-cashflow-sync.js` brugte urealistiske bon-numre uden B-præfiks (stale fixtures
  → FK-crash); rettet til prod-format. 28/0 grøn.
- Browser-verificeret end-to-end mod kopi af prod-data; testdata ryddet, kopi pristine.

### Pengestrøm §2.F.6 — kategori-triage + e-conomic-genkendelse + find-værktøjer (29.-30. juni 2026)
> Spec: `docs/economics/CLAUDE_PENGESTROEM.md` §2.F.6. Drevet af Leifs drifttest på branchen.
> Løser at "kan ikke matches" var uoverskuelig (396 poster) og ubrugelig til at FINDE en bestemt
> indbetaling. Otte commits, alle browser-verificeret mod prod-data-kopi, testdata ryddet hver gang.

- **Vandmærke-FOLD (ikke skjul):** det tidligere "match-mod-betalt-faktura-på-beløb"-tjek var en fejl
  (med ~2.900 fakturaer rammer ethvert beløb tilfældigt en betalt faktura → skjulte event-kontant som
  "Zettle Michelin"). Fjernet. Foldede poster er findbare via chip/søgning.
- **Kategori-triage** (`cfCategorize`, banktekst+dato+beløb): `event_cash` 🎪 (Zettle/MobilePay/kontant,
  alle år, kræver salgsbon) · `invoice_check` 📄 (fakturanr, åbent år) · `large_check` 🔍 (≥ grænse, ingen
  fakturanr, ALLE år — fanger "SLUTAFREGNING RF25") → SURFACE. `invoice_paid`/`minor` → FOLD.
  Settings: `cf_accounts_closed_year` (2025), `cf_check_large_threshold` (10.000), tolerance 350→**400**.
- **E-conomic-fakturanummer-link (migration 117):** `cf_invoices.economic_number` — reconcile gemmer
  `bookedInvoiceNumber` (overskriften INDEHOLDER bon-nr, fx 4091/#B4117 — verificeret via diagnose).
  `matchByEconomicNumber` kobler indbetaling via nr+beløb i bankteksten.
- **E-conomic-spejl (migration 119):** `cf_economic_invoices` — reconcile spejler ALLE bogførte fakturaer
  (også uden bon-kobling). `cfCategorize` genkender en faktura-indbetaling som afregnet blot ved at nummeret
  findes i spejlet → 📄-listen skrumper til ægte undtagelser (testdata: 63 → 1; surfaced 97 → 35).
  Backfill: `scripts/backfill-economic-numbers.js --apply` (engangs, fylder spejl + numre; dry-run kører i
  transaktion + rollback for sandt preview). Diagnose: `scripts/diagnose-cashflow-match.js` (read-only).
- **Find-værktøjer:** kategori-chips + dato/beløb-filtre + sortering i "kan ikke matches"
  (`?category/from/to/min/sort`). Event-side **"Find indbetaling"** (`/candidates-for-event`, ±14 dage) →
  "Opret salgsbon" → bon arver eventets **lokation, dato (start_date) og adresse**.
- **Fakturaform-UX:** foldbar header (✎ Faktura <nr> · <kunde>), valgt-række fremhævet, liste scroller
  uafhængigt (`#cfInvRows` max-height).
- **Tests:** `scripts/test-cashflow-sync.js` 49/0 (cfCategorize-regler + bookedSet-genkendelse + matchByEconomicNumber).

### Pengestrøm — udgiftsbons allokeres i bankens moms-grundlag (#318, 17. juli 2026)

En bank-afstemning i drift kunne ikke gemmes: "Gem allokering" var grå, fordi summen af
linjerne oversteg indbetalingen. `/api/cashflow/match-targets` returnerede bon-totalen råt
fra `total_price` — men udgiftsbons kan have linjer bogført **ex moms**
(`moms_included = 0`, migration 104), fx en stadeleje-faktura hvor event-P&L'en vil have
nettobeløbet. Banken flytter bruttokroner, så allokeringen blandede to momsgrundlag og
kunne aldrig gå op. Alt andet i allokeringen (salgsbons, fakturaer, indbetalingen selv)
er incl moms.

- **`momsLoeft(bonTotal, exclPart)`** ([routes/cashflow.js](routes/cashflow.js)) løfter KUN
  ex-moms-delen via `Moms.exclToIncl()`. Resten af totalen (incl-moms-linjer + levering, der
  ikke er en `bon_line`) bæres uændret igennem, så bons uden ex-moms-linjer er urørte.
  `match-targets` leverer `excl_part` = Σ `line_total` for linjer med `moms_included = 0`.
- Verificeret mod en syntetisk udgiftsbon oprettet via produktionskoden
  (`POST /api/events/:id/bons`, `role=expense`): udgift −N → −1,25N (= fakturaens brutto),
  salgsbon M → M (uændret). `test-cashflow-sync` 49/0 · `moms_audit_e2e` 18/0.
- **Kendt begrænsning (#317):** `moms_included` er binært og kan ikke udtrykke *momsfri*.
  Migration 104 lumper selv service-fees ("momsfri i forvejen") sammen med ex moms. En
  momsfri udgiftslinje løftes med 25 % den ikke har. Indtil videre: håndtér momsfri udgifter
  som "+ Justering"-linje i allokeringen frem for en bonlinje.
- Desuden: event-oversigtens status-badges havde to næsten ens gråtoner (planlægning
  `#f0f0f0` / afsluttet `#e8e8e8`). Fire adskilte kulører nu — blå/grøn/lilla/rød.

**Fund fra samme gennemgang (egne issues — status pr. 10. august 2026): alle tre er løst.**
- **#319 — LØST** (lukket 6. august, migration 130 + `services/invoiceGuard.js`).
  Faktureringskøen er *status*-drevet, så en bon sat til FAKTURERET/AFSLUTTET i hånden forlod
  køen selv om der hverken fandtes kladde eller bogført faktura — mens `cf_invoices`-rækken blev
  liggende og lignede en dårlig betaler. Vagten samler nu de to sandheder og viser dem som
  "N fakturaer er aldrig sendt" (holdt UDE af "Forfaldne"). Fire filtre mod falske alarmer:
  kun `payment_type = 'invoice'`, aldrig tilbud/interne, skæringsdato
  (`settings.invoice_guard_from_date`), og en eksisterende kladde/bogført faktura frikender.
  **Bemærk:** manglende `economic_number` er kun et signal for v2-bons — v1-æra (`cafe-*`) er
  betalt uden i over tusind tilfælde.
- **#320 — LØST** (PR #445, se "Pengestrøm — betalt-status som fuld tilstand" nedenfor).
  Advarslen "gør ingen skade i dag" holdt ikke: da tallet blev målt 10. august, stod
  107.669 kr som forfaldne uden at være det.
- **Byttehandel — LØST** (#324 + migration 129). `payment_types` har nu `barter`/"Modregning"
  og `sponsorship`/"Sponsorat", begge med `counts_as_revenue = 0`. En ny "gratis"-type koster
  én række i Settings + et flueben — ingen kodeændring.
  De to greb der gør det til at leve med:
  **(a)** betalingstype ≠ `invoice` ⇒ bonnen kommer aldrig i `cf_invoices`, så den kan hverken
  stå som forfalden eller udløse vagten på "aldrig sendt" (`invoiceGuard.js`);
  **(b)** `counts_as_revenue = 0` ⇒ krone-summer bidrager 0 i rapporter, dashboard,
  driftsregnskab, CRM-omsætning og margin — mens **enheder og pax er urørte**, for maden blev
  jo lavet og skal tælle i produktion og kapacitet. Bonnens ægte pris bliver stående, så man
  kan se hvad sponsoratet var værd.
  > At lægge det på `payment_types` frem for en ny *priskategori* var det afgørende valg:
  > en priskategori ville kræve et nyt `Salesprice*`-userfield i Grocy på alle opskrifter +
  > kodeændring i `grocyAdapter`, og 0-priser ville slette omsætningen ud af rapporter og
  > margin-analyse i stedet for at markere den som ikke-omsætning.

### Pengestrøm — betalt-status som fuld tilstand (#320, 10. august 2026)

"Forfaldne" viste 21 fakturaer / 122.420 kr. E-conomic sagde samtidig 14 ubetalte i alt /
33.859 kr. Kørt op mod deres debitorbog: **18 af de 21 var for længst betalt — 107.669 kr
stod forkert som forfalden.**

Ikke et data-problem. `cashflowReconcile` udledte betalt-status af `/invoices/booked` filtreret
på `date$gte:<vandmærke>`, hvor `date` er fakturaens **egen** dato. Vandmærket rykkes til seneste
sete fakturadato, så en faktura hentes præcis én gang — omkring udstedelsen, hvor den per
definition er ubetalt — og aldrig igen. Men `remainder` ændrer sig bagudrettet, når betalingen
falder. Efter første fulde kørsel kunne `betalt` reelt ikke flippe mere, og en ny synk hjalp
ikke: den kiggede bare længere fremme.

- **Betalt-status kommer nu fra REST `/invoices/unpaid` — fuld tilstand, intet vandmærke.**
  Listen ER e-conomics debitorbog: alt bogført der ikke står på den, er afregnet. Ét kald,
  14 rækker mod 4.133 bogførte — **billigere end det delta den erstattede**, og der er intet
  vindue at falde uden for. Vandmærket bruges fortsat til at opdage NYE fakturaer og koble
  fakturanummeret på; der er det rigtigt.
  > REST har hele familien (`GET /invoices` lister dem): `drafts`, `booked`, `paid`, `unpaid`,
  > `overdue`, `notDue`, `sent`. Ingen OpenAPI nødvendig. **Spørg efter tilstand, ikke delta,
  > når API'et tilbyder det** — det var hele fejlen.
- **Værn:** vi konkluderer kun "betalt" når nummeret faktisk kendes hos e-conomic (spejl eller
  scan), så et ciffer-rod ikke kan afskrive en fordring · kun ÉN vej automatisk (ubetalt →
  betalt; det modsatte ville genoplive fakturaer kontoret bevidst har afskrevet — rapporteres
  som `conflicts`) · melder e-conomic rækker men leverer nul (brudt paginering), afbrydes
  synken frem for at markere hele debitorbogen betalt.
- **Spejlet holdt op med at lyve.** `cf_economic_invoices.remainder` var også et fastfrosset
  øjebliksbillede fra den ene gang fakturaen blev scannet — samme fælde. Det følger nu den
  fulde tilstand.
- **Synligt for kontoret:** badgen viser e-conomics eget antal ubetalte + tidspunkt for sidste
  synk (`cf_meta.economic_synced_at` / `_open_count` / `_open_total` — ingen migration).
  Vandmærket er ikke længere en "ajour til"-dato; betalt-status har ingen, den er altid nu.
  Kvitteringen lister uenigheder og `unlinkedOpen` — åbne fakturaer hos e-conomic uden
  modsvarende `cf_invoice` — så forskellen mellem de to tal er synlig i stedet for skjult.
- **Tests:** `scripts/test-cashflow-reconcile.js` (35 asserts, attrap-adapter + isoleret DB;
  regressionen er en faktura udstedt FØR vandmærket og betalt siden, med tomt booked-scan).
  Mutations-testet: gammel adfærd → 6 falder. `npm run test:cashflow` kører den + sync-suiten.
- **Tilbage bagefter:** 12 ubetalte UDEN e-conomic-nummer (41.235 kr) — 6 Brightside Pictures,
  3 Silvan. De har ingen faktura i e-conomic overhovedet. Det er #319's område, ikke dette:
  vagten fanger dem der opfylder dens fire filtre (4 stk. / 18.781 kr i drift) og holder dem
  ude af "Forfaldne"; resten falder for skæringsdatoen eller betalingstypen.
- ~~**Ledger-endpoints er spærret af app-rollen.**~~ **Rettet 4. september 2026:** de er
  åbne. `/accounts` (240), `/journals` (7), `/suppliers` (59) og `/employees` svarer alle
  **200** — Bookkeeping-rollen kom til med app'en `bon-v2-regnskab` (appNumber 29856).
  Noten her stammede fra den udfasede app `bon-faktura`, som kun havde `Sales`. `/self`
  (`application.requiredRoles`) er facit. `/price-groups` svarer derimod **501** — ikke
  implementeret hos e-conomic, så en kundes rabatsats kan ikke læses derfra.

### CRM-triks — Ringeliste + fælles worklist-komponent (#229 + #230 + #228, 6. juli 2026)
> Epic #232. Spec: `docs/CLAUDE_CRM_TRIKS.md`. Lav-friktions "top-of-mind"-ringekøer oven på
> den eksisterende suggestions-motor. Bygger videre på det allerede leverede (PR #226/#233:
> review_ask, `interleaveSuggestions` round-robin, snooze, outcome-måling).

Forretningsdrevet: "ring til folk efter ferien" — dedikerede lister der viser HVEM man skal
ringe til, i stedet for max-8 kort blandet ind i digest-feeden.

- **Data-tjek før build** (mod ægte dev-data): sæson **120** kunder, rytme **21** (afgrænset
  1,3×–3×), sovende 13. Anbefaling 0 i dev (forventet — kræver friske servicekald-stemninger,
  fylder sig selv i drift). Grønt lys — arbejdsbare lister, ingen tom/900-rækkers.
- **#229 — `shared/crm_worklist.js`** (fundament): instans-baseret factory `CrmWorklist.create(cfg)`.
  Én worklist = kort med navn·meta·opener·**Ring/Log/Profil/🙈 Skjul** + inline log-formular
  (resultat+stemning+note → `postCrmActivity` med purpose_id) + `ListCampaignSelect` (cherry-pick)
  + "📣 Opret kampagne af listen" + SSE-debounced reload. Snooze indbygget (kalder
  `snoozeSuggestion({customer_id, type: key})`). Generaliseret fra `crm-dashboard.js`-mønstret
  (kort/log/outcome) — IKKE en klon af `crm-reaktivering.js`.
- **Fanebaseret shell** `office/views/crm-ringeliste.js`: ÉT view med faner (Sæson · Fast rytme,
  + plads til flere) — beslutning: ét "Ringeliste"-sted frem for N sidebar-pills, så det skalerer.
  Monterer/afmonterer worklist-instanser ved fane-skift, husker fane i localStorage.
- **Backend** (`routes/crm.js`): `GET /api/crm/season` + `/rytme` — fulde lister (forfremmelse af
  `season_reminder`/`overdue_customer`-forslagene, UDEN LIMIT), med **snooze-filter server-side**
  (`NOT EXISTS crm_suggestion_snoozes` pr. type). Rytme har øvre grænse ×3 så reelt sovende falder
  til dormant-flowet. Snooze er type-isoleret (season-snooze skjuler ikke i rytme).
- **`routes/campaigns.js`**: `POST /from-suggestion` udvidet fra kun `dormant` til
  `['dormant','seasonal','rytme']` — kandidat-query pr. type i en switch, consent/DNC/dedup-loopet
  genbrugt uændret. `shared/api.js`: `fetchCrmSeason` + `fetchCrmRytme`.
- **#228 — Fase 5: kold tilbudsopfølgning** (3. fane "Kolde tilbud"): `GET /api/crm/cold-offers` —
  tilbud der ER udløbet uden konvertering (`is_offer=1`, `offer_status='sent'`, `offer_valid_until < nu`,
  inden for sidste år). Modstykke til det fremadrettede `expiring_offer`-forslag. **Bon-centreret:**
  dedupe pr. TILBUD (`crm_activities.bon_id` + purpose `tilbud_opfoelgning`), så opfølgning på ét tilbud
  ikke skjuler kundens øvrige kolde tilbud. Komponenten fik valgfri `getBonId(row)` → logger opfølgning
  med `bon_id`. `campaignType: null` (per-tilbud, ikke bulk). Snooze type `cold_offer` (kunde-niveau).
- **Migration 123**: `fast_rytme`-purpose. **Migration 124**: `tilbud_opfoelgning`-purpose
  (`saesonoutreach` fra 048 genbruges af sæson).
- `office/index.html`: pill "Ringeliste" (2. plads under CRM) + view-registrering + SECTION_VIEW_MAP
  + titel + SSE-forwarding (`_ringeHandleSSE` på crm_activity_created/crm_stage_changed/rfm_computed).
- **Tests (55 asserts grønne):** `scripts/test-crm-ringeliste.js` (24 — /season + /rytme + /cold-offers
  detektion + snooze + type-isolation + per-tilbud-dedupe), `tests/campaigns_from_suggestion.test.js`
  udvidet 14→20 (seasonal+rytme HTTP-cases). `scripts/test-crm-review.js` uændret 25/0 (ingen regression).
- **Browser-verificeret** end-to-end (kopi af prod-data, dev-DB urørt): alle tre faner renderer korrekt,
  fane-skift, snooze 21→20 med server-side filter, kold tilbud vist via syntetisk seed. Migration 123+124 kørte rent.
- **4. fane "Sovende"** (7. juli 2026): re-aktiverings-listen flyttet ind i Ringelisten oven på den
  delte komponent — nav-punktet "Re-aktivering" (`reakt`-pill) fjernet, så Ringelisten samler
  Sæson · Fast rytme · Sovende · Kolde tilbud ét sted. **Prospekter forbliver separat** (kold
  akkvisition — anden aktivitet end at ringe eksisterende kunder). Komponenten fik to valgfri hooks:
  `buildExtra(row)` (RFM R/F/M + potentiale i kortet) + `renderControls(el,{meta,reload})` (data-afhængig
  min-ordrer/karantæne-config-bar, fokus-vagtet). `services/rfm.js` `getReactivationCandidates` fik
  snooze-filter (type `reaktivering`, firma-niveau) så "🙈 Skjul" virker. Config-knapperne (kun
  redigerbare i det gamle view) bevaret i fanen. Ingen ny migration (genbruger `re_aktivering`-purpose +
  `crm_suggestion_snoozes`). Tests: `scripts/test-reactivation.js` +4 snooze-cases (19/0). Verificeret via
  headless render-shim (13/0 — buildExtra/renderControls/meta-stier) + endpoint (56 rows + config).
- **Bevidst udeladt:** `#231` (jubilæum) parkeret (CVR-stiftelsesdato + consent). Epic #232 er dermed
  færdig på nær #231. Den gamle `office/views/crm-reaktivering.js` er ikke slettet (stadig loadbar via
  `switchView('crm-reaktivering')` for bagudkompat) men er ude af nav'en — kan ryddes senere.

### Event-modul: Info-panel + vedhæftninger + nøgletal på én linje (PR #287, 7. juli 2026)

Driftsønske: et sted i event-modulet hvor der kan skrives fri info ind, og mulighed for at
vedhæfte filer (kort, billeder, PDF) til eventet. Plus en throwaway prep-estimat-prototype fra
`docs/CLAUDE_EVENT.md` §15-drøftelsen.

- **Info på event-overblikket** ([office/views/events.js](office/views/events.js)): `events.notes`
  gjort synligt + inline-redigerbart (auto-gem via `PATCH /api/events/:id` → changelog → SSE;
  `_evHandleSSE`-guarden forhindrer re-render mens feltet har fokus). **Sammenklappelig** —
  én linje med preview af noten når lukket, folder ud til multi-linje redigering. Nøgletallene
  (P&L-strip) forbliver **øverst**; info + vedhæftninger ligger i en kompakt værktøjs-række under.
- **Vedhæftninger** (kort/billeder/PDF/dokumenter): genbruger den polymorfe `attachments`-tabel
  med `entity_type='event'` — **ingen migration**. Filer under `data/attachments/event/<id>/`.
  Nye endpoints i [routes/attachments.js](routes/attachments.js): liste (`GET /api/attachments?entity_type=&entity_id=`),
  slet (`DELETE /:id`), inline-visning (`GET /:id/inline`, content-type udledt af filendelse).
  Upload/download fandtes i forvejen. **UI:** pille med antal-badge → popover med liste
  (hent/åbn i ny fane/slet), luk ved klik udenfor/Escape. MIME-validering (PDF/billeder/Office)
  + 10 MB arvet fra upload-endpointet. `shared/api.js`: `fetchAttachments`, `deleteAttachment`,
  `attachmentInlineUrl`.
- **Nøgletal på én linje** ([office/views/events.css](office/views/events.css)): P&L-strippens grid
  rettet fra `repeat(6,1fr)` til `repeat(7,1fr)` — CO₂e-cellen faldt tidligere ned på egen række.
- **Prep-estimat-prototype** (`scripts/prep-estimate.js`, §15): throwaway beregner (per-enhed +
  per-batch, §15.2-rater i rettbar blok, flagger UKENDTE rater). **Ikke wired ind i noget** — til
  kalibrering før vi beslutter datamodel/granularitet for prep-tid-modellen.
- **Bevidst udeladt:** prep-tid-modellen (§15) er stadig kun design-noter + prototype; dags-ratio-
  eksklusionen (§15.3 pkt. 4) holdt adskilt. Browser-verificeret end-to-end + godkendt i drift.

### Lageroptælling — rullende session-model (#331, PR 1 #332 + PR 2, 18. juli 2026)
> Spec: `docs/CLAUDE_OPTAELLING.md` (første spec for optællingen) · Mockup: `docs/optaelling_mockup_pr2.html`
> Optællingen er backstoppet der re-baseliner Grocy-lageret. Efter #305 (auto-deduct tændt)
> er den vigtigere end nogensinde — og den forgiftede sine egne data.

**PR 1 — fire stille-datafejl** ([shared/inventory_check.js](shared/inventory_check.js)):
`LastCheckedAt` blev skrevet ved HVER tælling (afbrudt session = "tjekket i dag" i Grocy uden
at lageret blev rettet) · hardkodet `2999-12-31` stemplede optalt surplus som "udløber aldrig" ·
sorteringen kunne løfte en nyligt tjekket vare over en ikke-tjekket · `default_consume_location_id`
trak frostvarer ind i køle-listen. Plus concurrency-vagt (§6): baseline pr. vare på
tælletidspunktet, ingen tavs last-writer-wins.

**PR 2 — UX-redesign** (samme fil + `.css`):
- **Enheds-chips** erstatter "Næste enhed" — alle fysiske enheder synlige med antal talte varer.
  Tælling bevares pr. enhed (`counts[id].units`), så samme vare kan tælles flere steder.
- **Tælleenheder**: tæl i "3 bøtter", skriv i kg. Live-konvertering under feltet viser hvad der
  faktisk lander på lageret. Enheden huskes pr. **vare + fysisk enhed** (bøtter i køl, kasser på
  tørlager) — et forslag, ikke en låsning; togglen står altid synlig.
- **⋯-menu** (2 tryk, kun beslutninger): "Skal ikke tælles fast" (`HverDag=""`) · "Varen findes
  ikke mere" (lager 0 + `active=0`, bekræftes). ✓ godkend og ⏭ spring over bliver på kortet
  (1 tryk) — omkostning følger hyppighed, ikke konsekvens-frygt.
- **Sprungne varer forsvinder ikke** — de dæmpes med "Sprunget over i \<enhed\> · Fortryd", og
  progress viser "· N sprunget over" så tallet ikke lyver.
- **Ny slutskærm** ("Gem og luk") med beslutnings-sektion + **blivende kvitteringsbanner**
  (en 3-sek toast er væk før man har nået at læse den).

**To ekstra datafejl fundet under PR 2** (begge rettet):
- `_icSessionKey()` brugte UTC-dato → dansk kl. 22 er UTC "i morgen", så en aftenoptælling
  skiftede nøgle og mistede alle counts. Samme fælde som memory `project_utc_today_bug`.
- Den dags-scopede nøgle modsagde spec §6's egen fler-dags-præmis og efterlod døde
  localStorage-nøgler. Nøglen er nu `ic_counts_<lokation>` med `startedAt` i payloadet;
  en session fra i går møder et genoptag-banner i stedet for at blive kasseret bag ryggen
  på brugeren. Skip flyttet fra `sessionStorage` ind i samme payload (samme levetid som counts).

**Sprog** (spec §7): ingen systemord i UI — "Grocy" ude af brugerteksten, konflikt-valg hedder
"Mit tal er rigtigt" / "Lagerets tal er rigtigt", ikke "Overskriv"/"Behold". Mockup'en er ældre
end det princip og blev bevidst fraveget tre steder.

**Følgeopgave leveret (#336):** varemodtagelsen stempler nu `LastCheckedAt` +
`LastCheckedUnit` når en vare kommer på lager, så en netop modtaget vare ikke står som
"aldrig tjekket" i optællingen. Enheden udledes af receiptens Grocy-lokation (første efter
`sort_order`) — ingen brugerhandling. Et forkert gæt retter sig selv via den bløde fallback.
Kun ved vellykket `addStock`; en fejlet stempling vælter aldrig en modtagelse.
Dækket af T_VAREMODTAGELSE_FULL's OBS-gruppe (76 PASS, op fra 67).

**Åbent til drift, ikke til kode:** `_icIsPackUnit()` afgør om ¼ ½ ¾ betyder "en del af én
pakke" eller "en del af det forventede lager". Grocy skelner ikke stykvare fra målenhed, så
tærsklen (`_IC_PACK_MIN_SHARE = 0,05`) er et skøn. Kålhovedet er grænsetilfældet: 0,8 kg,
altså *mindre* end lagerenheden, men "et halvt kålhoved" giver god mening. Efterprøv i køkkenet.

**Tests — to runnere, fordi den ene ikke kan se layout:**
- `npm run test:run-optaelling` — **112 PASS · 0 FAIL · 0 SKIP** (pure, ingen server/Grocy).
  Commit-stien er splittet i `_icPlanCommit` / `_icExecuteCommit` / `_icCommitMessage`, så
  den kan køres med injicerede Grocy-attrapper (case 16) i stedet for kun at kunne nås
  gennem brugerfladen.
- `npm run test:ui-optaelling` — **8 PASS** (Playwright, mod test:server + grocytest).
  Dækker det logik-tests ikke kan se: at ⋯-menuen ikke klippes af kortets `overflow:hidden`,
  at en sprunget vare kan findes ved søgning, at enheds-chips bevarer tællingen, og at
  tælleenheds-skift omregner frem for bare at skifte etiket. Spec'en skriver aldrig til
  Grocy — "Gem og luk" trykkes aldrig.

Begge er **mutations-testet**: fem bevidste fejl indført i kildekoden blev alle fanget.
To af dem (klippet menu, søgning der skjulte en sprunget vare) var ægte fejl der slap
gennem 112 unit-tests og først blev set i drift — derfor findes UI-spec'en. Browser-verificeret end-to-end mod grocytest med før-tilstand noteret og
rullet tilbage: lager rettet, `LastCheckedUnit` flyttet, **best-before bevaret**, ikke-talt vare
urørt. Spec: `tests/specs/T_OPTAELLING.md`.

### Event-menu — eventets prisliste (#314, 19. juli 2026)
> Spec: `docs/CLAUDE_EVENT.md §16`. Bygget forud for et event 30. juli.

Menuen fandtes før kun implicit (unionen af prep-bonnens linjer + hvad prefill
tilfældigvis hentede fra Grocy). Det gav tre driftsproblemer: prisen fandtes ikke før
første salg (skiltet på vognen kunne ikke laves), en pris justeret på pladsen forsvandt
lydløst næste dag, og en ret fundet på pladsen skulle tastes som fritekst hver dag.

- **Migration 131**: `event_menu_items` (event_id CASCADE, nullable `grocy_recipe_id`,
  `unit_price`, sort_order, note). Partielt unique-indeks på `(event_id, grocy_recipe_id)`
  WHERE NOT NULL — flere fritekst-linjer pr. event er tilladt.
  ⚠️ `unit_price` er **INCL moms** (matcher `bon_lines.unit_price`, §6b) mens
  `item_prices` (068) er **EX moms**. De to må ikke "rettes" til at ligne hinanden.
- **3 endpoints** i [routes/events.js](routes/events.js): `GET/PUT /:id/menu` (PUT =
  reconcile, samme mønster som `/forecast`, valideret fuldt ud FØR skrivning) +
  `POST /:id/menu/generate`.
- **Generér = resync, ikke additiv**: genskaber slettede prep-afledte linjer, men
  **rører aldrig prisen på linjer der findes** — ellers ville et tryk nulstille alle
  on-site-justeringer. Manuelle linjer overlever. Kun prep-rollen, aldrig aflyste bons.
- **`computeSalesPrefill`** henter nu antal fra prep-bons og **pris fra menuen**
  (`price_source: 'menu'|'grocy'`); falder tilbage til Grocy når der ingen menu er
  (bagudkompatibelt). Menupunkter uden prep kommer med som antal 0.
- **Ingen prisversionering** — i stedet markeres en menurække diskret hvis en salgsbon
  solgte til en anden pris (⚠ + de solgte priser i tooltip).
- **UI**: sammenklappeligt **Plan**-felt med Forecast + Menu & priser, foldet sammen som
  default ved status `active`/`done`, header-preview viser "N forventet · M menupunkter".
  Auto-gem med kort SSE-suppressionsvindue (`_evMarkLocalAction`) så vores eget
  `event_updated`-ekko ikke river kvitteringen væk.
- **Rækkefølge + print** (samme runde): ▲▼ pr. række (persisteres som `sort_order`) og
  `🖨 Print menu` — skiltet til vognen. Print bygger `#ev-print-root` på `body` og bruger
  `@media print` til at skjule office-shellen; ingen `window.open`, altså ingen
  popup-blokering. Grupperet efter kategori i menuens egen rækkefølge, fritekst under
  "Øvrigt", marginer fra `@page`. Varer uden pris kommer med som "0 kr" — ikke fjernet i
  stilhed, men panelet advarer før print. `afterprint` + 8 s timeout-fallback rydder
  `body.ev-printing` (Safari fyrer ikke altid eventet).
- **Drive-by-fix**: `GET /:id/overview`'s `preppedRows` var den ene prep-query der
  manglede `EXCLUDE_CANCELLED_SQL` fra #303 — menuen genereres fra prep-bons og ville
  have arvet fejlen.
- **Tests**: `scripts/test-event-menu.js` (42 asserts, ægte endpoints over HTTP mod
  isoleret temp-DB). Regression grøn: sales-prefill 10, topup 35, event-cancelled 26,
  event-gate 15, event-polish 27, prep-packing 12, recipe-factor 8, moms-audit 18.
  Browser-verificeret end-to-end; testdata ryddet.

### Råvarer-modal: status på underopskrifter + rekursions-fix (#349, 19. juli 2026)

Produktion-fanen viste underopskrifter med en **hardcodet grøn prik** — "Æggesalat 1,56 kg"
stod grøn mens Råvarer-fanen samtidig sagde at der kun var 10 af de 18 nødvendige æg.
Serveren beregnede slet ingen status for underopskrifter; `sub_recipes`-objektet havde
aldrig et `status`-felt. En kok der kun kiggede på Produktion fik aldrig at vide at
råvaren manglede, for råvaren optræder ikke på det niveau.

- **`services/ingredientResolver.js`** — ny `attachSubRecipeStatus()` + `collectSubRecipeProductIds()`
  sætter `status` + `shortfalls[]` på hver underopskrift.
  - Statussen læses fra **råvare-niveauet**, altså det SAMLEDE behov på tværs af bonnen —
    ikke underopskriftens isolerede behov. Bruger to opskrifter tilsammen flere æg end der
    er på lager, kan æggesalaten heller ikke laves. Det er også det eneste der garanterer
    at de to faner aldrig modsiger hinanden.
  - **Emballage udelades** (samme afgrænsning som `calcSubRecipeWeightGrams`): en manglende
    serviet siger intet om hvorvidt blandingen kan laves, og emballage har sin egen gruppe.
- **`shared/modal.js` + `.css`** — rigtig prik, `N råvarer · mangler`-mærke bag navnet,
  farvet venstrekant, og rækken foldes ud med mangellisten (behov vs. lager) uden fane-skift.
  `_filterIngredients` patchet så mangellisten følger sin række; inline-style ryddes ved
  match, så CSS'ens `.open` fortsat styrer om den er foldet ud.
- **Latent rekursionsfejl rettet (#349)**: begge opløsere gav `subMultiplier * subBaseServings`
  videre ét niveau ned, hvilket ophævede divisionen og pustede alt i **dybde 2+** op med
  `base_servings`. Usynlig i dag (alt i grocy-hq har `base_servings = 1`), men den sad
  **også i `resolveConsumeItems`** — stien der trækker rigtigt Grocy-lager ved LEVERET
  (auto-deduct tændt, #305). Rekursér med `subMultiplier`; buffer-faktoren bæres stadig
  videre da den allerede er ganget ind.
- **Datanote (ikke en kodefejl):** `recipes_pos.amount` er i **stock-enhed**, ikke i den
  viste `qu_id`. Æg står som `0.9` med `qu_id = Antal`, men `qu_id_stock = Kilo` → 0,9 **kg**
  pr. batch. Grocy-UI'et er misvisende her; koden gør det rigtige.
- **Tests**: `scripts/test-subrecipe-status.js` (16 asserts — `base_servings` 4 og 2 i to
  niveauer, status-oprulning inkl. dybde-2-mangel, emballage-undtagelsen, og at Produktion
  og Råvarer er enige). Mutations-testet: med den gamle rekursion bliver en råvare i dybde 2
  til `2` i stedet for `0.5`. Regression grøn: recipe-factor 8, prep-packing 12,
  topup 35, event-menu 42. Browser-verificeret mod live grocy-hq.

### Pakkeliste: redigeret mængde gemmes nu i lager-enhed (#352, 19. juli 2026)

Pakkelistens redigerbare felt viste produktets **visnings-enhed** ("140 g"), men den
gemte værdi blev ved LEVERET brugt som om den var i **lager-enhed** (0,14 kg). Der
konverteredes ingen steder. Rettede køkkenet "140" til "150" på rødløg, blev der
trukket **150 kg** fra HQ i stedet for 0,15 kg — faktor 1000.

Fejlen ramte i to varianter, og den anden er den lumske: dels når visnings-enhed ≠
lager-enhed (Æg: Antal vs. Kilo), dels når `autoFormatAmount` skifter kg→g under 1 kg
— så selv et produkt hvor `qu_id == qu_id_stock` blev ramt, hvis mængden var lille.

- **`services/quConvert.js`** — `autoFormatAmount` og `convertAndFormat` returnerer nu
  også `factor`: den samlede faktor lager → vist tal. En kalder der lader brugeren
  **redigere** det formaterede tal er nødt til at kunne regne tilbage; gætter man på 1,
  genskaber man fejlen.
- **`services/ingredientResolver.js`** — hver ingrediens får `display_factor` +
  `stock_unit_name`. Bemærk at `unit`/`stock_unit` er VISNINGS-enheder og kan være `g`
  selvom produktet lagerføres i kg — derfor det separate felt.
- **`shared/modal.js`** — `_pakkeOverrides` holder nu konsekvent **lager-enhed** (samme
  som server, DB og consume). Feltet viser fortsat display; der konverteres ved ind- og
  udlæsning. Sammenligningen "tæt på beregnet → fjern override" sker i vist enhed, fordi
  det er det tal brugeren ser. `unit` gemmes nu som lager-enhedens navn, så rækken er til
  at tyde bagefter. Fallback udleder faktoren af `amount_needed / needed_stock`, så en
  cachet browser mod ny server (og omvendt) ikke falder tilbage til 1.
- **"Ekstra varer"-stien var korrekt hele tiden** (henter enhedslabel fra `qu_id_stock`)
  og er urørt.
- **`scripts/fix-packing-override-units.js`** — engangs-oprydning af rækker gemt før
  rettelsen. Konverterer kun rækker hvor gemt enhed afviger fra lager-enheden, hvilket
  gør den idempotent. Dry-run default, `--apply` skriver. Verificeret mod kopi af
  driftsdata: 8 rækker → 1 reel konvertering (Brød Rug 600 Antal → 72 Kilo), 3 nul-rækker
  får kun enheden rettet, 4 rækker allerede i kg røres ikke. Anden kørsel: "intet at ændre".
- **Tests**: `scripts/test-packing-units.js` (18 asserts — faktor pr. autoFormat-gren,
  kombineret faktor, round-trip-invarianten `vist ÷ faktor = lager`, at resolveren
  eksponerer felterne, og selve drifts-scenariet). Regression grøn: subrecipe-status 16,
  recipe-factor 8, prep-packing 12, topup 35, event-menu 42, moms-audit 18.
- **Browser-verificeret** ende-til-ende: 140 → 150 tastet i UI'et → DB gemmer `0.15 Kilo`
  → `consume-preview` viser `final_amount 0,15 Kilo`. Testdata ryddet.

**Ingen skade nået at ske:** de to bons med gemte overrides havde begge
`inventory_deducted = 0`. Men auto-deduct blev tændt 17. juli (#305), så kør
oprydnings-scriptet i drift **inden** de leveres.

### Opskrift-vieweren: status på underopskrifter + fire fejl mere (#353, 19. juli 2026)

`shared/recipe_viewer.js` er en klient-side variant af logikken i `ingredientResolver.js`
og var ikke fulgt med #349/#351. Fem fejl, alle i samme fil:

1. **Hardcodet grøn prik** på underopskrifter — samme fejl som i råvare-modalen.
   Rulles nu op via `_rvNestingStatus()`, med et `N råvarer · mangler`-mærke og
   tooltip der viser behov mod lager pr. råvare.
2. **Indkøbsknappen kunne aldrig vises**: betingelsen sammenlignede `statusClass` med
   `'rv-status-missing'`, men variablen sættes kun til `'ok'/'low'/'missing'/'unknown'`.
   Strengen `rv-status-` fandtes ét sted i hele repoet — netop den linje. Handleren var
   wired hele tiden; knappen blev bare aldrig renderet.
3. **"Alle ingredienser er paa lager!"** så kun på de direkte ingredienser. Behovet
   samles nu pr. produkt på tværs af hele træet, hvilket samtidig fjerner dobbelt-rækker
   når et produkt optræder både direkte og i en blanding.
4. **Vægt af underopskrift gik ikke i dybden.** IKKE latent: grocy-hq har nesting i
   dybde 2, så Æggesalat blev målt til 89 g hvor den rettelig vejer 110,25 g —
   Remoulade indeni tælles nu med (24 % under-rapportering i drift). Samme fejl rettet
   i `shared/recipe_designer.js`.
5. **Samme `base_servings`-fejl som #349** i "Træk fra lager"-stien. Latent (alt i
   grocy-hq har `base_servings = 1`), men det er rigtigt lagertræk.

**Struktur:** de tre kopier af træ-gennemløbningen er erstattet af én `_rvWalkNested()`
som lagertræk, indkøbsliste og statusprik deler. Duplikeringen var netop grunden til at
#349 kunne overleve i klienten efter at være rettet på serveren. Cyklus-værnet er
stak-baseret (`delete` ved udgang), så en opskrift der optræder i to forskellige grene
stadig tælles begge gange — kun ægte cykler stoppes.

**Test:** `scripts/test-recipe-viewer-nested.js` (12 asserts). Browser-kode kan ikke
`require`s, så filen køres i en `vm`-sandkasse med stubbede globals og de rene
funktioner kaldes direkte — det er de samme funktioner browseren bruger, ikke en kopi.
Mutations-testet: alle tre kerne-rettelser fanges når de rulles tilbage.
Browser-verificeret mod live grocy-hq.

### Resolver: stak i stedet for sæt + cyklusværn (#354, 19. juli 2026)

Sidste del af oprydningen efter #349. Begge opløsere i `ingredientResolver.js` brugte
ét `visited`-sæt for hele træet under en bon-linje — for groft til at beskrive formen
på et opskriftstræ.

- **Diamant-undertælling**: nås den samme underopskrift ad to veje (A→B→D og A→C→D),
  blev D's egne råvarer korrekt talt to gange (de tilføjes i løkken FØR rekursionen),
  men rekursionen ind i D blev sprunget over anden gang. Alt **under** D blev derfor
  undertalt. Ramte også `resolveNestings`, altså rigtigt lagertræk — der blev consumet
  for lidt fra Grocy.
- **Rettelse**: stak (tilføj ved indgang, `delete` ved udgang) i stedet for sæt. En
  opskrift der optræder i to forskellige *grene* tælles nu begge gange; kun en ægte
  cyklus (en opskrift inde i sig selv) stoppes. Samme mønster som `services/co2Engine.js`
  allerede brugte, og som `shared/recipe_viewer.js` fik i #353.
- **Cyklusværn i `calcSubRecipeWeightGrams`**: havde slet intet. En cyklus i
  `recipes_nestings` gav stack overflow og væltede hele `/api/bons/:id/ingredients`.
- **Kosmetisk**: `scaleFactor * baseServings / baseServings` var et no-op der fik det
  til at ligne at `base_servings` havde en rolle på top-niveau. Skrevet som `scaleFactor`
  — multiplier-konventionen har allerede kostet én fejl her.

**Ingen effekt på nuværende drift, med vilje efterprøvet:** grocy-hq har maks
nesting-dybde 2, ingen diamanter og ingen cykler. Resolveren blev kørt mod ægte
grocy-data før og efter — fingeraftrykket af råvarer, consume-mængder og
underopskrift-vægte er byte-identisk. Ændringen er alene et værn mod den dag
opskriftstræet får en anden form.

**Test**: `scripts/test-resolver-graph.js` (8 asserts) med et diamant-træ hvor det delte
led selv har et niveau under sig — det er dér undertællingen sad. Mutations-testet:
uden `stack.delete` falder både råvare- og consume-tallet fra 2 til 1; uden cyklusværnet
giver testen "Maximum call stack size exceeded".

### Tilbud: sendt er nu en status man kan se og sætte (#452, 11. august 2026)

T-21 og T-22 blev sendt til kunden og blev alligevel liggende som **KLADDE**. Kontoret
sendte derfor samme tilbud afsted flere gange — mail-historikken på T-22 har to udgående
mails med PDF, tre minutter fra hinanden.

Tre fejl gav samme oplevelse: *der skete ingenting.*

1. **Kvitteringen slettede sig selv.** `_tToast(msg, ms)` tager en varighed i millisekunder,
   men tre kaldesteder sendte en **art** i stedet: `_tToast('Tilbud sendt til …', 'success')`.
   `setTimeout` gør en streng til `NaN` → 0 ms, så netop de vigtigste kvitteringer blev
   fjernet i samme øjeblik de blev oprettet og nåede aldrig at blive tegnet. Andet argument
   accepterer nu **begge** — tal = varighed, streng = art (grøn `success` / ravgul `warning`).
   Den kan ikke længere sætte sin egen levetid til nul ved et uheld.
2. **Afsendelse ændrede ikke status.** `_tDoSendMail` sendte mailen og rørte aldrig
   `offer_status`. Skiftet ligger nu **efter** afsendelsen og kan aldrig vælte den — mailen
   er den uigenkaldelige del. Slår skiftet fejl, siges det højt frem for at fejle stille.
3. **Ingen manuel vej ud af Kladde.** `PATCH /api/quotes/:id/status` har eksisteret hele
   tiden, og `patchQuoteStatus()` lå i `shared/api.js` — **uden ét eneste kaldested**.
   Eneste virkende vej var CRM-tavlens pipeline (`tilbud_sendt`-kolonnen). `'lost'` kunne
   slet ikke sættes: filteret "Tabt" på tilbudslisten kunne aldrig blive fyldt.
   Trin 5 har nu en status-stribe `Kladde · Sendt · Tabt`. **"Vundet" står bevidst ikke der**
   — den sættes af "Opret som bon", og serveren afviser `'won'` på status-endpointet af
   præcis den grund (Patch I, F68), så en knap ville kun kunne fejle.

**Luk et tilbud fra pipelinen** uden en femte kolonne: hvert *tilbudskort* har et ✕ der
først dukker op ved hover (kun `is_offer=1` — en rigtig bon aflyses via sin egen status).
Det kalder tilbuddets status-endpoint, ikke pipeline-flytningen: "tabt" er en tilstand på
tilbuddet, ikke en kolonne på en tavle.

> Det krævede én ting på serveren: pipelinen hentede **alle** tilbud uanset status, og
> kolonne-fordelingen har kun fire kasser — alt der ikke er sendt/forhandling/vundet ryger
> i **Lead**. Et netop lukket tilbud ville altså hoppe tilbage til starten af tavlen.
> `GET /pipeline` filtrerer nu `lost`/`expired` fra. Ændrer intet for eksisterende data:
> indtil nu kunne intet tilbud overhovedet *blive* tabt.

**Hvorfor det ikke bare er kosmetik:** et tilbud der bliver liggende som åbent tæller med i
sidebarens tilbudstal, og når gyldigheden udløber, dukker det op på
**Ringeliste → Kolde tilbud** som et tilbud ingen har fulgt op på — også når kunden for
længst har valgt noget andet.

Desuden: manglende mailadresse blokerer ikke længere. Send-panelet åbner med tomt Til-felt
og en synlig gul note, så adressen kan skrives ind på stedet. Før afviste knappen sig selv
med en toast, der (jf. fejl 1) var usynlig — så knappen så ud til slet ikke at gøre noget.

- `public/embed/bestilling.html` — ⓘ folder nu **beskrivelse + allergener** ud (før kun
  allergener). Beskrivelsen står øverst, allergenerne dæmpet nedenunder. `max-height` på
  `.allergen-row` hævet 100px → 260px så en to-linjers salgstekst ikke klippes.
- `routes/embed.js` + `routes/event-bridge.js` — Grocy-mode/fallback læser nyt valgfrit
  userfield **`bestil_beskrivelse`**. Grocys egen `description` på opskriften bruges
  bevidst IKKE: den indeholder produktions-noter ("skæres med blad nr 2 på Robocut") og må
  aldrig ud til kunden. 34 af 131 opskrifter i grocy-hq har sådan en note i dag.
- `settings/index.html` — Grocy-mode-infoboksen dokumenterer feltet + advarslen.
- Manuel mode er uændret: beskrivelsen skrives pr. ret i **Settings → Bestilling — Menu**
  (feltet "Kort salgstekst" fandtes allerede) og følger med gennem broen uden kodeændring.
- Info-rækken er skiftet fra mørkeblå (`#2c3e50`) til designmanualens **grå flade + brun
  markering** (s. 5: grå `#d7d1ca`, brun `#8e631f`). Den sorte/mørke boks skar for hårdt i
  en ellers lys menu. Samme greb i event-order-3's ⓘ-boks.
- `scripts/import-menu-descriptions.js` — fylder de 32 retter med teksterne fra
  ristetrug.dk/menu (hentet 6. august 2026). Matcher på menu-item-id med navne-fallback,
  rører ikke retter der allerede har en tekst (`--force` overskriver), dry-run default,
  tager backup af menuen ved `--apply`. Idempotent — anden kørsel siger "0 sættes".
  Fire bevidste indgreb i teksterne er dokumenteret i scriptets hoved (fodnote-stjerner
  fjernet, én tastefejl rettet, slidere arver standard-rettens tekst, bokse skrevet ud
  pr. variant). Brownie + de tre drikkevarer har ingen tekst på hjemmesiden og springes over.

**Drift:** feltet er tomt på alle retter i produktion. Kør scriptet på serveren
(dry-run først) — eller skriv teksterne i Settings i hånden. Verificeret hele vejen:
Settings → `/webhook/event-menu` → bro → event-order-siden, og mod en kopi af
driftsdata: 32 af 36 retter matchede på id, 0 ikke fundet.

### Leveringspris: tal i pillen + beregner for løs adresse (6. august 2026)

To ting fra driften: pillen i logistik-rækken sagde bare "By-ex pris" uden et tal, og
der var ingen vej til at svare på "hvad koster levering til X?" når en kunde ringer,
uden først at oprette en bon.

- **Pris i pillen uden klik** ([shared/logistik.js](shared/logistik.js) `_logFillByExPill`):
  rækken henter allerede `/api/delivery/calculate`, og svarets `alternatives[]` indeholder
  By-expressens standard **kundepris**. Pillen viser den nu direkte (`💰 By-ex 154 kr`) —
  **nul ekstra API-kald**. Klik henter stadig By-expressens egen pris (vores KOSTpris) +
  margin som før. Ligger turen uden for standardprisens rækkevidde (`max_distance_km`),
  vises **intet tal** — pillen bliver stiplet med begrundelsen i tooltip. Et forkert tal
  er værre end ingen. `_logFillRow` samler forslag-linje + pille, så de altid følges ad.
- **Prisberegner for en løs adresse**: knappen `🧮 Beregn pris` i logistik-toolbaren
  åbner et panel med DAWA-autocomplete + kuverter/kasser. Bruger **samme** `/calculate`
  som bon-forslagene, så prisen kunden får i røret er den samme office senere ser på bonen.
  Ingen bon oprettes, og der ringes ikke ud til By-expressen. Viser **både ex og inkl. moms**
  (via `Moms.exclToIncl`) — `cost_formula` er ex moms, mens `bons.delivery_price` er incl,
  så en privatkunde skal høre det andet tal end et firma. Uegnede vogne vises stadig, men
  dæmpet med begrundelse (constraint-princippet: aldrig spærring). Egne vogne er mærket
  "egen vogn" med en note om at det er vores omkostning, ikke et tal at give kunden.
  Virker i begge zoner (delt `shared/logistik.js`).

**Prisformlen rettet — `standard_inner_city` er et GULV, ikke et loft**
([services/booking_template.js](services/booking_template.js) `estimateCost`): bytaksten tog
hidtil forrang og **ignorerede afstanden helt**, så taxaens `base 136 + per_km 19` var reelt
uendelig død kode — en tur til Roskilde (40 km) blev prissat til 250 kr i stedet for ~895 kr.
Nu vinder km-taksten når turen er lang nok. Vogne uden km-takst (By-expressen) er uændret
flade; dér er `max_distance_km = 8` værnet. Kasse-tillægget lægges oveni uanset hvilket
prisled der vinder. Uden afstand står bytaksten alene → bagudkompatibelt.
Rammer også margin-visningen i draweren, hvor lange taxature før så kunstigt rentable ud.

**`POST /api/delivery/calculate`** ([routes/delivery.js](routes/delivery.js)): uden `bon_id`
udledes kasser nu af `pax` efter **samme** regel som for en bon (`default_pax_per_box`), så
beregneren og bon-forslaget ikke kan blive uenige — reglen lever ét sted, på serveren.
Svaret returnerer additivt `boxes` + `pax_per_box`, så beregneren kan vise *hvilket*
kasse-antal prisen er regnet på.

**Falsk tabs-alarm på lange ture fjernet** (driftsfund): `GET /lobo/quote` regnede margin
mod `estimateCost(vehicle, bon)` **uden afstand**, altså mod By-expressens **bypris** på
154 kr — også når turen lå langt uden for de 8 km bytaksten gælder for. En levering til
Høje Taastrup (21,9 km, kost 328,80) viste derfor rødt `margin −174,8 kr` + "I taber på
leveringen", målt mod en pris vi aldrig ville have tilbudt derude. By-expressen har ingen
`per_km`, så gulv-rettelsen ovenfor hjælper ikke her — formlen *kan* ikke udtrykke afstand
for den vogn.
- `quoteForBon` sammenligner nu Lobos **egen** målte `routedistance` mod vognens
  `max_distance_km` (samme regel som `supply_warning` i `previewBooking`) → nyt felt
  `standard_price_applies`. Er den falsk: `margin = null` (ingen margin mod en pris der
  ikke gælder) og i stedet `suggested_customer_ex` + `suggested_margin` via den
  eksisterende `suggestCustomerPrice` — som hidtil KUN blev brugt i booking-previewet.
- **Vi foreslår IKKE selv en kundepris derude.** Driftsfeedback afdækkede hvorfor:
  By-expressen *kører* gerne uden for zonen — bare på andre produkter
  (Small/Medium/Large × Economy/Standard/VIP) plus et `outside zone`-tillæg på +30 %
  af ordreværdien (dertil `volume surcharge` +50 % og `saturday delivery` +30 %; vi får
  10 % rabat på basisprisen). **Food** — det produkt `cost_formula` beskriver, og det
  vi altid spørger om i `bonToOrderInput` — er derimod kun tilgængeligt i
  forsyningsområdet, og Lobos *kladde* afviser IKKE out-of-area (kun den rigtige
  booking gør; det er præcis hvad `supply_warning` i `previewBooking` allerede advarer
  om). Kostprisen for en fjern tur er altså **en Food-pris for noget vi ikke kan købe**,
  og en markup ovenpå ville bygge en kundepris på et tal der ikke findes. Derfor
  `suggested_customer_ex = null` ved out-of-area; office henter den rigtige pris i
  By-ex booking-panelet, hvor produktet kan vælges og `previewBooking` regner forslaget
  på rigtigt grundlag.
- Logistik-rækken: `uden for Food-området — hent rigtig pris under By-ex booking`
  (dæmpet gul) i stedet for rødt tab. Draweren: `Kundepris (std) → gælder ikke så langt
  ude` + samme forklaring som booking-panelets `supply_warning`, i dæmpet gul
  (`.lq-warn-soft`) — det er en anvisning, ikke et tab. Inden for området hvor
  bytaksten ikke dækker (fx mange kasser) er kostprisen ægte, og dér beregnes forslaget
  som før.
- **Kendt upræcished:** grænsen testes som `routedistance > max_distance_km` (8 km),
  men By-expressens rigtige grænse er **postnummer-zoner**, ikke en radius — primær zone
  (1000–2450 Kbh, 1800–2000 Frb, 2150, 2500, 2900) + udvidet zone (2600 Glostrup …
  2920 Charlottenlund). Fx 2750 Ballerup ligger ~14 km væk men *i* den udvidede zone.
  Radius-testen er derfor konservativ i begge retninger. At kode zonelisterne ind kræver
  bekræftelse på om Food dækker hele den udvidede zone — ikke afklaret.
- Vogne uden `max_distance_km` → bytaksten gælder altid (bagudkompatibelt; test-fixturen
  har ikke feltet, så de eksisterende margin-asserts er urørte).
- **De to afstande skilles ad**: rækken/draweren viste `21,9 km` (vores ORS fra HQ) og
  `18,9 km` (Lobos egen rute) lige over hinanden uden forklaring. Lobos er nu mærket
  `(By-ex)`.

**Tests:** +7 asserts i `scripts/test-delivery-spor2-unit.js` (bypris vs. km-takst i begge
retninger, flad vogn uden km-takst, kasse-tillæg på begge grene) og +5 tests i
`tests/lobo_booking.test.js` (drifts-tilfældet 18,9 km/8 km → margin null + `supply_warning`
+ **intet** forslag, bynær tur hvor bytaksten dækker → margin bevaret og intet forslag,
bynær tur hvor den ikke dækker → forslag beregnet, vogn uden `max_distance_km` → uændret).
Mutationstestet: neutraliseres `outOfArea`, fejler drifts-testen.
241 delivery-tests grønne (102+50 spor1, 31+24+29 spor2, 21 lobo) + moms-audit 18/0.
Browser-verificeret i begge zoner mod live ORS: 5 km → taxa 250 kr, 21,9 km → 552 kr,
40 km → 895 kr; 60 kuverter → 4 kasser → By-ex 154 → 254 kr; pille med og uden tal;
Lobo-svaret stubbet med driftens egne tal for at se renderingen. Testdata ryddet.

### By-expressen: ét login pr. klik gav 429 fra `/token` (14. september 2026)

Draweren viste *"Uventet svar fra /token (status 429)"* på alle By-ex-knapper. Det er
ikke en syntaks-token, men Lobos login-endpoint der afviste os: **429 = Too Many
Requests**. Spec'en (`CLAUDE_LEVERING_LOBO.md`) advarede om streng rate-limit på
netop `/token` og krævede modul-niveau-cache — men adapteren cachede tokenet **på
instansen**, og `getByExpressenAdapter()` bygger bevidst en ny instans pr. HTTP-kald,
så en ændret sandkasse-indstilling slår igennem uden genstart. Resultat: 0 % genbrug.
Hvert klik (pris, preview, ordre-status ved drawer-åbning) var et nyt login.

- **Token-store på modul-niveau** i [services/byExpressenAdapter.js](services/byExpressenAdapter.js),
  nøglet på `(fetchImpl, base-URL, bruger)`. Base-URL skiller sandkasse fra produktion;
  `fetchImpl` gør at en test med egen mock-fetch aldrig låner en anden tests token
  (WeakMap pr. transport). Produktion deler global `fetch` → ét token i ~10 min.
- **Samtidige logins deles** (`pending`-promise): to requests der begge ser et udløbet
  token, fyrer ét `/token`, ikke to. Et fejlet login efterlader intet hængende.
- **401 rydder det delte token**, så næste instans også re-auther (samme som før,
  bare på det rigtige objekt).
- **429 er nu en forståelig fejl** med `code: 'rate_limited'` — *"By-expressen afviser
  lige nu (for mange kald — login). Prøv igen om 30 sek."* (Retry-After vises når Lobo
  sender den). Gælder både `/token` og authede kald. Frontenden viser serverens
  besked direkte, så teksten når helt ud i draweren.

**Tests:** `tests/byexpressen_adapter.test.js` 30 → **37** (regressionen er tre
instanser → ét login; plus dedupe, sandkasse/prod-adskillelse, transport-isolation,
401-rydning og de to 429-cases). **Mutations-testet:** fem tilbagerulninger fælder hver
sine navngivne tests. Regression grøn: lobo_booking + lobo_webhook (71 i alt),
delivery spor1-unit 105, spor2-unit 42, spor2-routes 24, booking-confirmed-by 10.

### Leveringspris: afstandstrappe + "sidst taget" (6. august 2026)
> Fortsættelse af sektionen ovenfor. Driften leverede tre oplysninger der ændrede designet:
> Food dækker kun byområdet · til Høje Taastrup har vi taget 400 kr · en taxa koster 605 kr i dag.

**Trappe-takst i `estimateCost`** (migration 139): ny formel-type
`{tiers:[{max_km,price,label},…]}` — fast pris pr. afstandsinterval. Sidste trin uden
`max_km` = "og derover". Vinder over `standard_inner_city`/`base`/`per_km` når afstanden
kendes; uden afstand bruges trin 1, så kaldere uden distance er upåvirkede.

**Trappen er ikke opfundet** — den lå i driftsdataene hele tiden
(`bon_lines.category = 'x-Levering'`, 2.269 linjer):

| Leveringslinje | Pris incl | Antal | Sidst brugt |
|---|---|---|---|
| By-ekspressen leverer | 180 kr | 1.067 | maj 2026 |
| By-ekspressen – Langt væk | 300 kr | 47 | **apr. 2024** |
| By-ekspressen – Meget Langt væk | 500 kr | 9 | **apr. 2024** |

De to sidste holdt op med at blive brugt i april 2024 — dét var hullet. Bekræftet mod en
faktura fra 11. juni 2025 til 2630 Taastrup: `Transport Taastrup 400,00` = 500 incl = **400 ex**,
altså meget-langt-taksten. `bon_lines.unit_price` er incl moms, `cost_formula` er ex (§6b),
så trappen er **144 / 240 / 400**. Km-grænserne (8 / 15) er derimod et **skøn** — de historiske
takster blev valgt i hånden og er ikke konsistente (2800 Lyngby fik både 300 og 500;
300-taksten blev også brugt på inderby-adresser). Justeres i Settings → Leveringsmetoder.

**`quoteForBon` + `previewBooking` sender nu Lobos målte afstand ind i `estimateCost`,**
så `customer_ex` rammer det rigtige trin. Dermed er kundeprisen pålidelig hele vejen ud —
men `margin` er stadig `null` uden for Food-området, fordi **kostprisen** dér er en Food-pris
for noget vi ikke kan købe (uændret fra sidste runde).

**`GET /api/delivery/price-history?postal_code=&limit=`** — hvad har vi FAKTISK taget?
Læser leveringslinjer (`category = 'x-Levering'`), ikke `bons.delivery_price` (udfyldt på
4 af 3.125 bons) og ikke `bons.delivery_cost` (blandet v1/v2-semantik, #194). Returnerer
`last` + `common` + `rows` med både incl og ex. Postnumrene i v1-data er rodede
(`2630`, `DK-2620`, `1000 København K`) → delstrengs-match på de fire cifre.
Vises i **prisberegneren** og i **bon-drawerens forslags-blok** ("Sidst taget til 2630:
180 kr inkl. (144 kr ex) · Levering med El-Taxa · 2026-01-28 · oftest 180 kr (2/3)").

**Tre kilder, bevidst adskilt i UI'et:** trappen = *hvad bør det koste*, historikken =
*hvad plejer vi at tage*, live By-ex-opslag = *hvad koster det os*. Live-opslaget er
uændret on-demand (klik) — det opretter og sletter en kladde hos Lobo pr. opslag, så det
må ikke køre automatisk pr. række. Det er mest pålideligt netop inden for byområdet, hvor
Food gælder.

**Pillen viser nu trappens pris hele vejen ud** (400 kr på 21,9 km) — stiplet med forklaring
når Food ikke dækker, i stedet for at skjule tallet. Beregnerens caveat blev rettet fra
"prisen holder ikke her" til "kan vælges alligevel": efter trappen *gælder* prisen derude.

**Tests:** +14 asserts i `scripts/test-delivery-spor1-unit.js` og `-spor2-unit.js`
(trin-grænser inkl. ≤-kant, kasse-tillæg oveni trappen, tiers-forrang, tom/ugyldig trappe
falder igennem), +14 i `scripts/test-delivery-spor1.js` (price-history: kun x-Levering,
`DK-`-præfiks matcher, incl→ex, hyppigste pris, ukendt postnr → 200 tom, ugyldigt → 400).
285 delivery-tests grønne (105+65 spor1, 42+24+29 spor2, 21 lobo) + moms-audit 18/0.
Browser-verificeret i office: pille 144/400 kr, beregner 400 ex / 500 incl (= fakturaens tal),
historik i både beregner og drawer. Testdata ryddet.

**Beregnet adresse vises på kortet** (driftsønske): markør (🧮 i stiplet brun ring — bevidst
anderledes end bon-pins, for det er et opslag og ikke en levering der findes) + stiplet linje
fra HQ, så afstanden kan *ses* og ikke bare læses. Tooltip: adresse · km · billigste eksterne
vogn. Ligger i sit **eget Leaflet-lag** (`_logPcLayer`), så `_logRenderMap`'s `clearLayers()`
ikke fjerner den ved en SSE-drevet genindlæsning; punktet lægges desuden ind i `fitBounds`
så kortet ikke panorerer det ud af syne. Ryddes når panelet lukkes, og så snart der tastes i
adressefeltet igen (så markøren aldrig viser noget andet end det feltet siger).
**Åbn/luk ejes af én funktion** (`_logPcSetOpen`) — første udgave lagde oprydningen i ✕-vejen
men ikke i toolbar-knappen, så markøren blev hængende når man lukkede dér (fundet i drift).
Escape lukker først adresse-listen, derefter panelet.

**Åbent:** taxaens takst. Appen viser 605 kr for HQ → 2630 Taastrup; vores formel siger
552 kr ex. Er appens tal **incl** moms (som forbrugerpriser typisk er), er den rigtige pris
484 ex, og `per_km: 19` er ~14 % for høj (~15,8 ville ramme). Ikke rettet — moms-grundlaget
er ikke bekræftet.
### Kontaktperson på eventet (6. august 2026)
> Spec: `docs/CLAUDE_EVENT.md §17`. Driftsfeedback: kontoret udfyldte kunden i hånden
> på hver enkelt event-bon, og de øvrige stod som "Ukendt" på køkkenets kort.

- **Migration 139**: `events.customer_id` + `company_id` + `day_contact_name`/`_phone`
  (alle nullable → events uden kontakt opfører sig præcis som før).
- **`eventContactFields(event)`** ([routes/events.js](routes/events.js)) er den ene regel:
  kunden kopieres råt; dagskontakten falder tilbage til kundens navn/telefon når den ikke er
  sat separat. **Både** event-generatoren (`POST /:id/bons`) og **event-broen**
  ([routes/event-bridge.js](routes/event-bridge.js)) bruger den — broen importerer helperen
  frem for at have sin egen kopi. Eksplicit `customer_id` i payloadet vinder (`??`, ikke `||`).
- **Bons lavet før kontakten fandtes**: `GET /:id/overview` returnerer
  `bons_missing_contact`, og `POST /:id/apply-contact` udfylder dem. Rører **kun tomme
  felter** (`COALESCE`) — en bon hvor kontoret selv har sat noget står urørt. Eksplicit
  handling med bekræftelse, ikke en bivirkning af at gemme eventet. Idempotent.
- **UI** ([office/views/events.js](office/views/events.js)): kontaktpersonen vælges i
  event-modalen med samme `KundeSoeg` som bon-draweren; kontaktlinje under event-headeren
  med "Udfyld på N bons uden kunde" når der er noget at udfylde.
- **Fælde (fundet ved browser-verifikation):** `KundeSoeg` må ikke stå i et `<label>` —
  label-aktivering videresender klikket til labelens første formularkontrol, som efter
  valget er ✕ ("skift kunde"), så valget blev ryddet i samme klik.
- **Tests**: `scripts/test-event-contact.js` — 26 asserts mod de ægte endpoints over HTTP
  (isoleret temp-DB, spawned server). Regression grøn: event-menu 42, event-bridge-prep 69,
  topup 35, event-cancelled 26, event-gate 15, event-polish 27, prep-packing 12.
  Browser-verificeret end-to-end; testdata ryddet.
### Mail: sent_at sættes først når mailen faktisk er sendt (#362, 20. juli 2026)

`mail_messages` blev indsat med `sent_at = datetime('now')` cirka **45 linjer før**
`transport.sendMail()` blev kaldt — uden try/catch og uden kompenserende sletning.
Fejlede SMTP, eller bare en manglende vedhæftning, overlevede rækken med udfyldt
`sent_at` og `message_id = NULL`.

**Ingen steder opdagede det.** `message_id IS NULL` optræder ét sted i hele repoet, og
dér filtreres der på *indgående* mail. En fejlet afsendelse var altså ikke til at skelne
fra en gennemført — heller ikke for et menneske der læste tråden. Det ramte bl.a.
booking- og web-ordrebekræftelser, som sendes fire-and-forget: kunden fik intet, tråden
sagde "sendt".

- **`services/mailService.js`** — `sent_at` indsættes som NULL. Vedhæftnings-opløsning
  **og** afsendelse er pakket i én `try`; ved fejl skrives `send_error` på beskeden og
  fejlen kastes videre (kalderen skal stadig se den — vi tilføjer kun sporet). Først
  efter et vellykket `sendMail` sættes `message_id` + `sent_at`, og `send_error` ryddes.
- **Migration 147** — `mail_messages.send_error`.
- **Sorteringen tåler det:** alle læsere brugte i forvejen
  `COALESCE(sent_at, received_at, created_at)`, så en fejlet besked bliver stående det
  rigtige sted i tråden i stedet for at forsvinde.
- **`shared/mail_thread.js`** — udgående besked uden `sent_at` markeres med rød ramme og
  "⚠ Ikke sendt" + fejlbeskeden. Komponenten dømmer kun når endpointet faktisk har
  leveret `sent_at`, så en visning der ikke henter feltet ikke markerer alt som fejlet.
  `send_error` + `sent_at` tilføjet til de tre tråd-forespørgsler (bon/kunde, PO, leverandør).

**Tests:** `scripts/test-mail-send-truth.js` (13 asserts — vellykket send, SMTP-fejl,
manglende vedhæftning, at beskeden bliver i tråden, og at et nyt vellykket forsøg rydder
fejlsporet). Mutations-testet: sættes `sent_at` ved oprettelsen igen, falder præcis de to
asserts der beskriver fejlen. Testen fangede undervejs en fejl i selve rettelsen —
`info` var deklareret inde i den nye try-blok men bruges i `return`.

### Vægtberegning: kæd to hop via kilo (20. juli 2026)
### Yield-modellen: en opskrift vejer ikke summen af sine input (20. juli 2026)

Køkkenet har standardiseret på at hver produktionsopskrift **yielder** en fast mængde af
den vare der bruges senere — typisk 1 kg. Syltelagen hældes fra, kødet svinder:

```
"Balsamico + løg" = 1 kg løg + 0,06 L balsamico + 0,5 L vand
    sum af input: 470 g      yield: 300 g
Syltet rødkål:  2,7 kg ind → 1 kg brugbar vare
Svinekam:      1,12 kg ind → 1 kg pulled pork
```

**Yieldet er allerede erklæret i Grocy** som `recipeunit` + `recipeunitnumber` (14 af 16
underopskrifter). Koden *kendte* feltet — `recipe_viewer` brugte `recipeunit` til at
afgøre OM der skulle vises en vægt — men beregnede så vægten som summen af input.

Målt på alle 16: yieldet er **aldrig højere** end summen (intet opstår af ingenting), og
rammer præcist dér hvor intet går tabt (Frisk Grønt, Remoulade ±0 %). Størst afvigelse:
Balsamico + løg −36 %, Æggesalat −23 %.

- **`services/ingredientResolver.js`** — `sub_recipes[]` får `yield_amount` + `yield_unit`,
  og `weight_grams` er nu **yieldet** når det er en masse. Summen bevares som
  `input_weight_grams`, og `unit_weight_grams` giver g/stk for antal-opskrifter.
  Findes intet yield, falder vi tilbage på summen — **vi opfinder aldrig et yield**.
- **To slags visning:** masse/volumen → yieldet ER mængden. Antal (sliders) → bonen
  tæller stykker (`63 antal` frem for `3,78 kg`), men vægten skal stadig kunne findes.
- **`shared/recipe_viewer.js`** viser begge dele: `1 antal` med `137 g/stk · i alt 136,86 g`
  under. Afviger yield og sum på en masse-opskrift, vises `råvarer ind: …` som note.
- **Lagertrækket er urørt.** Råvarerne forbruges nøjagtigt som før; yieldet ændrer kun
  hvad der VISES. Låst fast af en test (S5).
- **Kædning som fallback:** `findConversionFactorToGrams` kæder nu via kilo, så et produkt
  med `1 Liter = 1 Kilo` kan vejes. 27 råvarer i grocy-hq var tavst udeladt af summen.
  Betyder mest for de opskrifter der ikke har et erklæret yield.

**Tests:** `scripts/test-yield-model.js` (14 — masse-yield, antal-yield med g/stk, fallback
uden yield, skalering, og at lagertrækket er uændret) + `scripts/test-gram-chaining.js` (6).
Browser-verificeret mod live grocy-hq.

**Grocy-huller fundet undervejs:** `Løvstikke Mayo` og `Æggesalat` mangler
`recipeunitnumber` (falder tilbage på summen indtil de udfyldes), og Æggesalat-opskriften
producerer efter køkkenets egen vurdering for meget — rettes af Leif.

**Retning:** yieldet er første skridt mod #272/#269, hvor underopskrifterne bliver rigtige
produkter med eget lager, og `recipeunitnumber` bliver mængden på `Produces product`.

### Varemodtagelsen blev usynlig — modtagelseslog + Whiteboard-kobling (7. august 2026)
> Driftsfund: varemodtagelserne dukkede ikke op i loggen, og køkkenet var gået tilbage til
> Whiteboards egen formular (den uden lagerdelen). Koden fejlede aldrig — den var **aldrig
> koblet til**.

**Diagnosen** (bekræftet mod drift): `settings.whiteboard_webhook_url` har stået **tom siden
den blev seedet** (migration 035, 11. april 2026). `send()` springer stille over ved tom URL
(`bonv2_only`-mode, spec §"Tre driftsmodes"), så `webhook_log` var tom og
`whiteboard_synced_at` NULL på **alle** registreringer. Samtidig havde `fetchGoodsReceipts()`
**nul forbrugere** — listevisningen var aldrig bygget. En registrering var derfor usynlig fra
det øjeblik succes-skærmen forsvandt. Fem registreringer (18. maj – 5. august) nåede aldrig
frem. Feltet kunne kun sættes med SQL.

Fejlklassen er den samme som #305/#319 (jf. memory `project_silent_sideeffect_failures`):
**handlingen påstod at være sket, bivirkningen fyrede aldrig, og intet sted mødtes de to.**

- **🗂 Modtagelseslog** i `shared/varemodtagelse.js` — liste (periode-chips 30 dage/3 mdr/1 år/alt)
  + detalje med alle FVST-felter, varer, foto og synk-status. Ligger i **samme container** som
  selve modtagelsen, så den følger med i køkkenfanen *og* mobilen uden separat montering.
- **Loggen overlever at Grocy er nede**: `initVaremodtagelse`'s catch-gren renderer nu topbaren
  i stedet for kun en fejltekst. Ny registrering kræver Grocy (varer, enheder, leverandører) —
  FVST-dokumentationen gør ikke, og måtte ikke ryge med i faldet.
- **Settings → Integrationer → Whiteboard**: URL-felt (validerer at den peger på `/api/events`),
  koblet/ikke-koblet-mærke, antal usendte + "send de manglende", og de seneste 20 forsøg med
  statuskode og fejl. `GET /api/goods-receipts/webhook-log` (admin).
- **`whiteboard: { configured, dispatched }`** i POST-svaret. `webhook_sent`/`webhook_dispatched`
  stod altid på `true` — også når intet blev sendt; de er bevaret som deprecated fordi
  T_VAREMOD_HAPPY_03 pinner dem (F31).
- **`POST /:id/resend-webhook`** (`requireAuth()`, ikke admin — den der står ved leverancen skal
  kunne rette op). **Nægter når `whiteboard_synced_at` er sat**: Whiteboard afviser ikke dubletter,
  så en gensendelse ville lægge samme leverance i FVST-loggen to gange.
- **`scripts/resend-goods-receipt-webhooks.js`** — backfill af efterslæbet. Dry-run default,
  `--apply`/`--id`/`--from`/`--to`. Sender kun hvor `whiteboard_synced_at IS NULL` ⇒ idempotent.
- `send()` returnerer nu `{ok, skipped, reason, statusCode, error}` (additivt — POST-stien
  er stadig fire-and-forget) + `isConfigured()`/`getWebhookUrl()`.
- **Tests**: `scripts/test-goods-receipt-webhook.js` — 27 asserts mod isoleret temp-DB + stub-modtager:
  at en sluttet kobling *rapporterer* sig selv, at payloaden matcher Whiteboards skema-felter
  (FVST Skema 1, migration 020), og at `whiteboard_synced_at` kun sættes ved 2xx. Mutations-testet.
- Verificeret end-to-end mod stub-modtager der validerer mod Whiteboards feltnavne: payload rent
  igennem (ingen ukendte nøgler, gyldig `deviation`-værdi, frys udeladt når toggle er slået fra),
  503 + netværksfejl logges uden at blokere brugeren, gensend + backfill + dublet-værn.
  Browser-verificeret i køkken, mobil og Settings; testdata ryddet, dev-DB tilbage i udgangspunktet.

**Deploy:** URL'en er sat i drift (7. august). Kør bagefter backfill'en mod prod —
dry-run først, så `--apply` — for de fem registreringer der aldrig nåede frem.

Browser-verificeret ende-til-ende mod en kopi af driftsdata: status gemmes (`offer_status`,
`offer_sent_at`), listen skifter til SENDT, kvitteringen bliver stående, ✕ vises kun på
tilbud (2 af 26 kort), det lukkede tilbud forsvinder fra tavlen og kan findes under
Tilbud → Tabt. Selve afsendelsen blev testet med et stub'et mail-kald, så der gik ingen
post ud. Testdata rullet tilbage.

### Tilbud: vundet betyder ikke forsvundet (12.–13. august 2026)

T-22 blev vundet og lavet om til en bon — og var derefter væk. Ikke i tilbudslisten,
ikke under **Vundet**, ikke i CRM-pipelinen. Den ene sag man havde vundet var den ene
man ikke kunne finde.

Årsagen var én linje: ét-dags-konvertering flippede `is_offer` fra 1 til 0 på tilbuddets
**egen række**. Rækken holdt op med at være et tilbud i samme sekund den blev en bon, og
tre flader tabte den samtidig:

| Flade | Forespørgsel | Hvorfor den tabte rækken |
|-------|--------------|--------------------------|
| Tilbudslisten | `WHERE is_offer = 1` | rækken er ikke et tilbud mere |
| Filteret "Vundet" | `is_offer = 1 AND offer_status = 'won'` | den kombination efterlader et flip aldrig — fanen var **tom af konstruktion** |
| CRM-pipelinen | `is_offer = 1 OR status IN ('NY','VENTER')` | en konverteret bon er hverken |

**Fler-dags gjorde det allerede rigtigt** (#425): tilbuddet bliver liggende som bilag, og
dagsbonnerne er NYE rækker med `source_quote_id` tilbage. Ét-dags var særvejen, og den er
væk — `convertToBons()` er den gamle `convertMultiDay()` hvor et tilbud uden dage bare er
n = 1. Uden dage bruges en **tom dag**, så hvert `day.x ?? q.x` falder tilbage på
tilbuddets egen værdi; de to veje kan ikke længere skride fra hinanden. `is_offer` skifter
aldrig mere værdi på en levende række.

To ting fulgte med i samme ombæring:

- **Menu-grupper kopieres nu med** (`bon_menu_groups` + `menu_group_id` gennem en
  `groupMap`). Flippet beholdt grupperne gratis — de sad jo på samme række. En ny bon ville
  have mistet den opdeling køkkenet netop har lavet for at kunne læse bonnen.
- **Dobbelt-konvertering** afvises nu på at der *står bons på tilbuddet*, ikke på at status
  er `won`. Pipelinen kan trække et tilbud til Vundet uden at oprette noget, og det tilbud
  skal stadig kunne blive til en bon.

**Låsen (migration 146, `bons.offer_locked_at`).** Når bilaget bliver liggende, kan man
også blive ved med at rette i det — og så dokumenterer det ikke længere hvad kunden sagde
ja til. Konvertering låser derfor tilbuddet: `PATCH /:id`, `PUT /:id/days` og
`PATCH /:id/status` svarer 409 med `locked: true`. `POST /:id/unlock` tager låsen af igen,
for en aftale *kan* genforhandles — men det er en bevidst handling med sin egen changelog-
linje, aldrig en bivirkning af at trykke Gem. Tidsstempel frem for boolean: "hvornår" er
gratis at gemme og umuligt at rekonstruere bagefter. NULL = ulåst.

PDF og "Send til kunde" bliver stående på et låst bilag — man skal kunne sende den
accepterede aftale igen. Kun det der **skriver** i tilbuddet forsvinder.

**Vejen frem og tilbage.** Tilbudslisten viser `→ B-1234` på vundne rækker, status-striben
i wizarden har en klikbar knap til hver bon, og bon-drawerens overskrift bærer et `fra T-22`
der åbner bilaget (`bons.source_quote_number`, kun i office — kitchen og mobil har ingen
tilbudsvisning at åbne, og et dødt link er værre end intet).

**De allerede flippede rækker** retter ikke sig selv:
`node --experimental-sqlite scripts/repair-converted-quotes.js` (dry-run; `--apply` skriver).
Den opretter bilaget som en NY række med tilbuddets oprindelige T-nummer og giver bonnen et
almindeligt bon-nummer. Bonnens `id` røres aldrig — en halv snes tabeller peger på
`bons(id)` (fakturaer, leveringer, mailtråde, vedhæftninger), og de skal blive ved med at
pege på ordren. Omnummereringen er det farlige skridt, fordi bon-nummeret står i mailemner
(`#b-…`), på fakturaudkast og i e-conomic — derfor fredes enhver bon med status
FAKTURERET/BETALT/AFSLUTTET, en `cf_invoices`-række eller et e-conomic-udkast. De listes til
sidst og skal håndteres i hånden.

Dækket af `tests/quote_convert.test.js` (10 tests), som bygger skemaet af de **rigtige**
migrations i en `:memory:`-database — en kolonne der flytter sig får testen til at fejle i
stedet for at bestå mod en håndskrevet kopi.

### "✓ Booket" betød kun at et menneske trykkede (#365, 20. juli 2026)

Tredje del af mønstret fra #362: *feltet der registrerer en bivirkning skrives på en
kodesti der ikke afhænger af om bivirkningen lykkedes.*

`POST /routes/:id/book` skriver
`booked_at` + `booked_by_user_id` uden at noget har talt med leverandøren; office kalder
det *efter* popout-vinduet. Gennemgang bekræftede at dette endpoint er det **eneste** sted
der sætter `booking_status='booked'` på en rute — så etiketten var løgnen, ikke dataen.

- **Migration 148** — `delivery_routes.booking_confirmed_by` (`'manual'` | `'api'` | NULL).
  Bevidst en **ny kolonne** frem for en ny værdi i `booking_status`: den har en
  CHECK-constraint, og SQLite kræver hele tabellen genskabt for at ændre den — med FK'er
  fra `delivery_route_stops`. Risikoen står ikke mål med gevinsten.
- Endpointet stempler altid `'manual'`; `'api'` kan ikke sættes fra request body.
  NULL på gamle rækker behandles som manuel, for det er faktuelt hvad de var.
- `shared/logistik.js` viser "Sendt til bud" i gul frem for "✓ Booket" i grøn, med
  tooltip: *"Leverandøren har ikke bekræftet — ring hvis det er vigtigt."*

**Tests:** `scripts/test-booking-confirmed-by.js` (10 — mod en rigtig server med isoleret
DB; asserterer mod **databasen**, ikke kun svaret). Mutations-testet. Regression: delivery
spor1-unit 102, spor2-unit 25, spor2-routes 24.

**Webhook-delen (#363) er flyttet til #414.** Begge ændrede samme funktion i
`services/goodsReceiptWebhook.js` — hver med sin returværdi, så de udelukkede hinanden.
#414 er den fyldigere: den løser #363 sammen med #412 og bygger samtidig den
modtagelseslog og den synlige Whiteboard-status i Settings, som mangler her. Netop
fraværet af en læser på `webhook_log` var grunden til at denne PR kun kunne skrive
`Refs #363`, ikke `Closes`.

### Web-bestilling: menu_items[] → bon-linjer (#382, august 2026)
> As-is-fund (`docs/formbuilder/CLAUDE_PREORDER_ASIS.md` §6): kundens ret-valg blev sendt
> struktureret (`menu_items:[{id,count}]`) men lå kun inert i `web_orders.raw_data` — office
> tastede linjerne i hånden. Nu auto-genereres bon-linjer ved bestilling.

- [x] `services/menuItemsToLines.js` — **ny**, ren/testbar `resolveMenuItemLines()`: id `r<recipe_id>`
  → Grocy-opskrift → snapshot af pris/kostpris/CO₂. Pris = **bonens priskategori** (festival-events
  rammer festival-pris; catering default). Uset/0-pris → prisløs linje (office prissætter, ikke 0 kr).
  Slug-id uden Grocy-kobling → navn-only linje via menu-JSON. Aldrig magic-moms (pris tages råt fra Grocy)
- [x] `routes/web-orders.js` — `generateLinesFromMenuItems()` kaldes efter `createBon`, **best-effort**
  i try/catch: en Grocy-fejl vælter aldrig selve bestillingen (bonen er allerede oprettet). Læser bonens
  priskategori, snapshotter linjer, `recalcBonTotalUnits` + `recalcBonTotal`, changelog + SSE `bon_updated`
- [x] `recalcBonTotal` flyttet `routes/bons.js` → `db/helpers.js` (eksporteret) så webhooken bruger
  **nøjagtig samme** server-autoritative total-beregning (rabat + levering). `bons.js` importerer den nu
- [x] Eksponeret `_generateLinesFromMenuItems` til integrationstest
- [x] Tests: `scripts/test-menu-items-lines.js` (24 unit — mapping, festival vs catering, prisløs fallback,
  unmatched, defensivt) + `scripts/test-web-order-lines-e2e.js` (12 integration mod isoleret `.backup`-kopi:
  linjer indsat, `total_price` + boks-aware `total_units` recalc, changelog). Verificeret mod ægte grocytest:
  `r91` → festival-pris 115 snapshottet, slug-menu → graceful navn-only fallback
- **Drifts-note:** værdien afhænger af menu-id-format. Produktionsmenuen er importeret fra Grocy (`r<id>`)
  → prissatte linjer. En håndlavet slug-menu → navn-only. `menu_items` ligger allerede i `raw_data` for
  ~25 historiske ordrer → backfill mulig hvis ønsket (ikke bygget)
### Hærdning af consume-/varemodtagelses-stien (#358 + #359 + #361, 6. august 2026)
> Migration 141. Tre fejl der delte rod — enheds-forveksling og manglende idempotens —
> og som først blev til aktiv skade da auto-deduct blev tændt i drift 17. juli (#305).

**#358 — varemodtagelsen skrev indkøbs-enhed som lager-enhed.** Tallet kommer fra
indkøbslisten i INDKØBS-enhed ("994 Kasse"), men `addToStock` sendte det uden enhed, og
Grocy læser altid lager-enhed. **69 af 215 produkter** i grocy-hq har forskellig købs- og
lager-enhed. Sket to gange i drift (spidskål fordoblet, rødkål for lavt) og først fundet i
Grocys `stock_log` — en fysisk optælling havde imens rettet tallet og dermed skjult årsagen.
- Klienten sender nu `qu_id` (den kendte den allerede fra indkøbsliste-rækken);
  serveren omregner via ny **`resolveToStockAmount()`** i [services/quConvert.js](services/quConvert.js).
- **Nægter at gætte:** manglende omregning → `grocy_error` på linjen + receipt
  `partially_approved`. Lageret røres ikke. Fødevarekontrollen (temperaturer, FVST, foto)
  gemmes uanset — den er lovpligtig og må ikke afhænge af Grocys tilstand.
- Sender klienten slet ingen `qu_id` (cachet browser), accepteres det KUN på produkter hvor
  køb og lager er samme enhed — der er intet at forveksle. Ellers fejl.
- `received_qu_id` + `received_quantity_stock` gemmes på linjen, så en fremtidig afvigelse
  kan afgøres uden at gætte. Samme fix i legacy [routes/receiving.js](routes/receiving.js).
- **Sagt FØR der tastes, ikke efter.** Serverens nægtelse kom først når man havde trykket
  Godkend — stående med varerne, hvor løsningen lå i et andet system. Klienten tjekker nu
  omregningen mens varelisten bygges (`_vmUnitIssue`), og siger det to steder: en gul
  advarsel **uden for** varelisten (den er foldet sammen som default, så "Godkend alt" er
  den normale vej igennem — en advarsel inde i listen ville ikke blive set) og på selve
  varekortet.
- **Og kan rettes på stedet.** Lager-enheden er i praksis altid kilo eller stk (grocy-hq:
  136 Kilo, 59 Antal, 15 Liter, 1 Flaske ud af 211 aktive), så det manglende svar er ét tal:
  *"Hvor meget er én Kasse i Kilo?"*. Feltet skriver omregningen til Grocy via det
  eksisterende `POST /api/grocy/quantity-unit-conversions` — svaret kender den der står med
  kassen, ikke kontoret. `pack_size_warning` fra routen vises, den betyder at tallet strider
  mod pakkestørrelsen på stregkoden.
- Kun **5 produkter** i grocy-hq mangler en omregning i dag (`npm run check:receipt-units`),
  så advarslen er sjælden — men den rammer netop dem der ellers ville blive skrevet forkert.
- `_vmFindFactor` **spejler** `findConversionFactor` i quConvert.js. Divergerede de to, ville
  skærmen sige god for noget serveren bagefter nægter. Enigheden er testet direkte.
- Kunne omregningerne ikke hentes, advares der **ikke** (`_vmConversionsLoaded`). Tom liste
  ville ellers markere hver vare med afvigende enhed — 22 falske alarmer ved et Grocy-hik.
  Serverens nægtelse står stadig som sikkerhedsnet mod en cachet browser.

**#359 — `inventory_deducted` blev sat selvom hvert Grocy-træk fejlede.** `consumeRecipes`
afviser aldrig (fejl pr. produkt returneres som `success:false`), så `UPDATE ... = 1` kørte
ubetinget. En bon hvor alt fik 500 stod som "lager trukket" — og **vagthunden fra #305 leder
efter bons UDEN flaget**, så den var blind for præcis den tilstand den blev bygget til at fange.
- Flaget er en **idempotens-vagt, ikke en kvittering**: det sættes kun når en gentagelse ville
  gøre skade. Ny `bons.inventory_deduct_status`: `ok` / `partial` (flag sat — ellers dobbelt-
  trækkes dem der lykkedes) / `failed` (flag bliver 0, sikkert at gentage) / `empty` /
  `event_prep_owns_stock`.
- [scripts/check-inventory-deduct.js](scripts/check-inventory-deduct.js) fik `findPartial()` —
  delvise træk har flaget sat og var helt usynlige. Både log og alarm-mail dækker nu begge.
- **Vagthundens afgrænsning rettet (9. august 2026).** Første kørsel i drift meldte tre
  "manglende træk" der ingen af dem var fejl. Vinduet havde **ingen øvre datogrænse** —
  beskeden sagde "de seneste N dage", men forespørgslen fangede alt fra N dage siden og
  *frem*, så en bon med leveringsdato i 2027 blev rapporteret hver eneste dag indtil datoen
  indtraf. Og bons **uden opskriftskoblede linjer** blev talt med, selvom de aldrig kan
  trække noget; nye bons får `empty` + flaget sat, men historiske rækker fra før #359 står
  med flaget på 0 for evigt (migration 141 bagudfyldte bevidst ikke). Begge afgrænsninger
  ligger nu i SQL'en. `failed` slipper igennem datogrænsen — et forsøgt og mislykket træk
  skal frem uanset dato. Bons uden noget at trække **tælles og nævnes** frem for at
  forsvinde, så man kan se forskel på "ingen problemer" og "kontrollen kigger forkert".
  En alarm der melder det samme hver dag om noget der ikke er galt, bliver ikke læst —
  samme svigt som #305 selv. `npm run test:deduct-watchdog` (15 asserts mod den ægte SQL
  og et rigtigt skema, mutationstestet). Målt på en kopi af driftsdata over 400 dage:
  787 → 773 rapporterede, heraf 13 flyttet til "intet at trække" og 1 fremtidsdateret.
- [office/views/events.js](office/views/events.js) viste `✓ lager trukket` ud fra flaget alene
  og bekræftede dermed løgnen for et menneske. Nu egne labels for delvis/fejlet.

**#361 — consume-endpoints havde ingen idempotens.** To klik, dobbelt-submit eller
netværks-retry = dobbelt træk, og trækket var usynligt bagefter, så det først dukkede op ved
næste optælling som en uforklarlig difference.
- Ny `grocy_consume_log` (nonce UNIQUE) — samme mønster som produktionsbatchens `batch_nonce`.
  Rækken indsættes **før** trækket og virker dermed også som lock: to samtidige klik kappes om
  constrainten, taberen får vinderens svar. Igangværende træk → 409, ikke et opdigtet resultat.
- `consume_nonce` er **påkrævet** på begge endpoints. En cachet klient får en fejlbesked der
  beder om genindlæsning — det er bedre end et tavst dobbelttræk.
- [shared/recipe_viewer.js](shared/recipe_viewer.js) holder nonce'en indtil trækket er
  kvitteret, så et gentaget klik efter en netværksfejl bliver en opslagning. Trækket kan
  nemlig godt være gået igennem hos Grocy selvom svaret aldrig nåede tilbage.

**Deploy-forudsætning:** `npm run check:receipt-units` (read-only) lister produkter med
forskellig købs- og lager-enhed UDEN omregning i Grocy — dem nægter varemodtagelsen nu.
På grocytest: 5 af 64 (2 på indkøbslisten). Ordn dem i Grocy før første modtagelse.

**Tests:** `npm run test:consume-hardening` (40 + 9 asserts — stubbet Grocy, så "hvert kald
fejler" og "kun ét fejler" kan fremprovokeres; vm-sandkasse for klientens payload).
T_VAREMODTAGELSE_FULL udvidet med UNIT-gruppen der modtager i købs-enhed mod ægte grocytest
og måler at lageret flyttede sig med qty × faktor (**79 PASS**, op fra 76). Alle fire
kerne-rettelser er **mutations-testet**. Regression grøn: VAREMOD_PATCH 26, T_STOCK 31,
T_GROCY 14/2skip, T_RECIPES 20, deduct-check 10, prep-packing 12, packing-units 18,
subrecipe-status 16, resolver-graph 8, recipe-viewer-nested 12, moms-audit 18.
### Rettens beskrivelse vises bag ⓘ (6. august 2026)

Kost-tags og allergener nåede frem til event-order-3's bestillingsside (broen, `#394`),
men beskrivelsen gjorde ikke. Datavejen var der allerede — `buildEventMenu` har hele tiden
læst `description` fra `bestilling.menu_standard` — men **ingen af retterne havde feltet
udfyldt**, og bon-v2's egen bestillingsform viste det slet ikke, selvom Settings-feltet
lover "vises på bestillingssiden".

- `public/embed/bestilling.html` — ⓘ folder nu **beskrivelse + allergener** ud (før kun
  allergener). Beskrivelsen står øverst, allergenerne dæmpet nedenunder. `max-height` på
  `.allergen-row` hævet 100px → 260px så en to-linjers salgstekst ikke klippes.
- `routes/embed.js` + `routes/event-bridge.js` — Grocy-mode/fallback læser nyt valgfrit
  userfield **`bestil_beskrivelse`**. Grocys egen `description` på opskriften bruges
  bevidst IKKE: den indeholder produktions-noter ("skæres med blad nr 2 på Robocut") og må
  aldrig ud til kunden. 34 af 131 opskrifter i grocy-hq har sådan en note i dag.
- `settings/index.html` — Grocy-mode-infoboksen dokumenterer feltet + advarslen.
- Manuel mode er uændret: beskrivelsen skrives pr. ret i **Settings → Bestilling — Menu**
  (feltet "Kort salgstekst" fandtes allerede) og følger med gennem broen uden kodeændring.
- Info-rækken er skiftet fra mørkeblå (`#2c3e50`) til designmanualens **grå flade + brun
  markering** (s. 5: grå `#d7d1ca`, brun `#8e631f`). Den sorte/mørke boks skar for hårdt i
  en ellers lys menu. Samme greb i event-order-3's ⓘ-boks.
- `scripts/import-menu-descriptions.js` — fylder de 32 retter med teksterne fra
  ristetrug.dk/menu (hentet 6. august 2026). Matcher på menu-item-id med navne-fallback,
  rører ikke retter der allerede har en tekst (`--force` overskriver), dry-run default,
  tager backup af menuen ved `--apply`. Idempotent — anden kørsel siger "0 sættes".
  Fire bevidste indgreb i teksterne er dokumenteret i scriptets hoved (fodnote-stjerner
  fjernet, én tastefejl rettet, slidere arver standard-rettens tekst, bokse skrevet ud
  pr. variant). Brownie + de tre drikkevarer har ingen tekst på hjemmesiden og springes over.

**Drift:** feltet er tomt på alle retter i produktion. Kør scriptet på serveren
(dry-run først) — eller skriv teksterne i Settings i hånden. Verificeret hele vejen:
Settings → `/webhook/event-menu` → bro → event-order-siden, og mod en kopi af
driftsdata: 32 af 36 retter matchede på id, 0 ikke fundet.


### Hørkram-kurven gætter ikke længere salgsenheden (#419, 12. august 2026)
> Fjerde gang samme mønster: *vi kender ikke værdien, og i stedet for at sige det
> sender vi noget der ser rigtigt ud.* Jf. #358 (enheds-forveksling), #362 (`sent_at`),
> #365 (`booked_at`).

`PUT /api/horkram/basket/add` slår salgsenheden op via Hørkrams snapshot-endpoint.
Hoka bruger `SalesUnitIndex` (0, 1, …) i sin PUT, og det indeks giver kun mening mod
den liste snapshottet leverer — **uden snapshot findes der ingen korrekt værdi**.
Alligevel faldt koden igennem til `SalesUnitIndex: ?? 0` og `Code: || 'st'` og sendte.

Hoka tog imod PUT'en og markerede linjen ugyldig. Fejlen dukkede derfor op ovre hos
dem, i deres ord — *"Produktet er blevet tilføjet med fejl - fjern og tilføj produktet
på ny"* — efter at Bon v2 havde sagt "lagt i kurv" uden forbehold. Rådet virker ikke:
varenummeret er dødt, så samme forsøg giver samme resultat hver gang. **12 af 137**
Hørkram-koblinger i grocy-hq havde døde varenumre 9. august, heraf tre aftalevarer.

- **`resolveSalesUnits(products, snapMap, failedIds)`** i `routes/horkram.js` er trukket
  ud som ren funktion og eksporteret — beslutningen om at afvise er nu testbar uden at
  røre Hørkram. Returnerer `{resolved, rejected}`.
- **Afvist ≠ afvist.** `lookup_failed` (opslaget kunne ikke gennemføres) holdes adskilt
  fra `unknown_product` (varenummeret findes ikke), fordi de kræver hver sin handling:
  "prøv igen om lidt" mod "kobl varen til det aktuelle nummer". Chunk-loopet noterer nu
  også HTTP-fejl, ikke kun kastede exceptions.
- **Ugyldigt varenummer** blev før sprunget tavst over med en `console.warn`. Det kommer
  nu retur som `invalid_number`.
- **Er intet tilbage at sende, røres kurven ikke** — ingen PUT, og svaret bærer `rejected`.
  Resten af kurven går uhindret igennem når kun én vare er død.
- **`addedProducts`** talte de *ønskede* varer (`products.length`). Den tæller nu de
  faktisk afsendte (`newProducts.length`) — samme slags påstand i det små.
- **`shared/indkob.js`** sætter ikke længere `inCart = true` uden at læse svaret, og
  beskeden bliver stående ved varen (`.ib-cart-error`) i stedet for i en kvittering der
  forsvinder af sig selv.

**Tests:** `scripts/test-horkram-salesunit.js` (18 asserts — kendt vare uændret, dødt
varenummer, opslagsfejl, blandet kurv, tomme `SalesUnits`, ugyldigt nummer).
Mutations-testet: genindføres gættet, falder 11 asserts. Testen er skrevet så den
**fejler rent** frem for at kaste `TypeError` på et tomt `rejected` — en stak-udskrift
er et dårligere signal end en rød linje der siger hvad der gik galt.

**Observation til T_INDKOB_HORKRAM:** BASKET_02 bruger Spinat som "kendt aktivt
varenummer", og Spinat står på listen over døde numre. Fixturen skal skiftes, eller
varen kobles om, før den suite siger noget meningsfuldt.

**Fandt undervejs:** pre-commit-hooken standsede commit'en på to UTC-datoer i samme
fil (#133). `deliveryDate()` og søgningens `expectedDeliveryDate` brugte
`toISOString()`, som mellem midnat og kl. 02 dansk tid giver gårsdagens dato — så
"i morgen" blev til i dag, og søgningen spurgte på en leveringsdato der var passeret.
Begge bruger nu `todayISO()`/`offsetISO()` fra `db/helpers`. `/dropsize` sender
bevidst et fuldt tidsstempel og er urørt.

**Tilbage:** de døde koblinger rettes i Grocy — det er data, ikke kode. Issuet foreslår
også at markere dem i "Alle koblinger" ud fra samme opslag; udgået-detektionen findes
allerede dér, men fanger ikke 404-tilfældet før nogen prøver at bestille.

### Prep-modal: Enter oprettede bonnen — og varevalget fik bon-kortets flow (17. august 2026)

Medarbejdere fik oprettet en prep-bon efter **første** varelinje. Antagelsen var at
kurv-metaforen var utydelig. Den egentlige mekanisme var en anden: modalen er en
`<form>`, alle linjefelterne ligger inde i den, og **Enter i antal-feltet indsendte
den**. Det er præcis den gestus `VarePicker` har lært folk på bon-kortet — vælg vare,
tast antal, Enter = *tilføj linje*. Muskelhukommelsen fyrede den forkerte knap.

Ses i drift. Vig Festival 8. juli, tre prep-bons på samme dag:

| Bon | Tid | Indhold |
|---|---|---|
| B4099 | 07:43:49 | Frikadellen 40 — **1 linje** |
| B4100 | 07:44:08 | Falaflen 300, Frikadellen 800 … — 9 linjer |
| B4101 | 07:45:52 | Falaflen 10 — **1 linje** |

19 sekunder mellem de to første. Hver ekstra bon er et kort mere på køkkenets
I dag-tavle, og vareforbruget splittes over flere bons.

- **`_evModal`** ([office/views/events.js](office/views/events.js)) — Enter i et felt
  indsender ikke længere formularen (alle fire roller: prep, top-up, salg, udgift).
  `textarea` og `button` er undtaget. Knappen navngiver den bon der oprettes og tæller
  linjerne (`Opret prep-bon (3 linjer)`); ved 0 linjer er den slået fra, så et fejlklik
  ikke kan lave en tom bon. Escape lukker en åben varepicker før hele modalen.
  Returnerer nu overlay'et, så kalderen kan nå knappen.
- **Prep/top-up bruger `VarePicker` i detached mode** (`bonId: null`) — samme vælger som
  bon-kortet, åben som udgangspunkt. Den POSTer ikke selv; linjerne samles i tabellen og
  bonnen oprettes først ved klik på knappen. Samme mønster som
  [shared/planning.js](shared/planning.js) allerede brugte.
- **Prislisten viser kostpris ex, ikke salgspris.** Bonnen er 0 kr (produktion), så
  salgsprisen ville stå som "0 kr" ud for hver vare; kostprisen er det tal der
  snapshottes pr. linje og driver Vareforbrug i P&L. Ny option `priceField: 'cost'` på
  `VarePicker` — additiv, default uændret (`'sales'`), så bon-kort, bon-drawer og
  planlægning er urørte.
- **Salg og udgift beholder dropdownen.** Udgiftsmodalen har moms-vælger pr. linje og
  fritekstbeløb, som pickeren ikke kender; salgsbonnen er forudfyldt fra prep-bonnerne
  og handler om at justere antal, ikke om at vælge varer.
- **Ens varer slås sammen** i stedet for to rækker med samme navn (samme regel som
  `POST /api/bons/:id/lines` bruger server-side), med et kort gult blink som kvittering.
- Tom tabel har en tom-tekst. Top-up-genberegning fjerner nu kun linje-rækkerne i stedet
  for at tømme hele `tbody` — ellers forsvandt tom-teksten, og et tomt forslag efterlod
  knappen med linjeantallet fra før genberegningen.

> ⚠️ **En knap uden `type` er `submit` inde i en `<form>`.** `VarePicker`s seks knapper
> manglede `type="button"`, så et klik på **"Tilføj" eller på en kategori** oprettede
> bonnen. Latent de tre andre steder — bon-kort, bon-drawer og planlægning er ingen af
> dem formularer — men fatalt her. Fejlen slap gennem hele testrunden, fordi jeg kun
> brugte Enter og `dispatchEvent`; den viste sig i første fysiske museklik. Læg en delt
> komponent ind i en formular, og gennemgå dens knapper.

**Sideeffekt værd at kende:** Enter gemmer heller ikke længere event-redigeringsmodalen
— den skal lukkes med knappen. Bevidst: et ensartet "Enter indsender aldrig" er sikrere
end en undtagelse pr. modal.

Browser-verificeret mod kopi af driftsdata, testdata ryddet: prep-bon gennem UI'et giver
**én** bon med korrekte linjer (`unit_price = 0`, `cost_price`, kategori,
`grocy_recipe_id`); alle fire roller opfører sig rigtigt; bon-draweren viser uændret
salgspriser. 183 tests grønne (event-menu 42, event-contact 26, event-gate 15,
event-polish 27, event-cancelled 26, topup-suggestion 35, prep-packing 12).
Bekræftet i drift 17. august — kostpriserne stemmer mod grocy-hq.

**Ikke bygget:** dublet-værn ("der findes allerede en prep-bon på 20. august — læg
linjerne på den?"). Bevidst udskudt: Enter-fælden var kilden til de observerede
dubletter, så værnet ville kun fange det tilfælde hvor nogen bevidst åbner modalen to
gange. Tages op hvis det viser sig i drift alligevel.

### Et tilbud bærer nu sit eget mail-tag (1. september 2026)

Et tilbud blev sendt med emnet **"#b-28 Tilbud T-28"** — bonnens tag på et
tilbud. Et tilbud ER en bon (`is_offer = 1`), og alle mail-veje satte derfor
`type: 'bon'` på den uden at se på rækken.

**Det er ikke kosmetik — det er routingen.** `matchBonByTagNumber` afgrænser
bevidst et bon-tag til `is_offer = 0`, så kundens svar blev slået op blandt de
rigtige bons, fandt ingenting og faldt ud i den ufordelte indbakke. Og fandtes
der en rigtig bon med de samme cifre, ville svaret lande på **DEN**. Laveste bon
i drift er `cafe-64`, så kollisionen begynder ved T-64 — tilbudsnummeret står
ved 28.

> Hele `#t-`-siden fandtes i forvejen: settingen `mail_tag_offer_prefix`,
> `parseSubject`'s `offerMatch` og offer-grenen i `matchBonByTagNumber`.
> Den var bare uden for rækkevidde, fordi `type: 'offer'` ikke optrådte ét
> eneste sted i produktionskoden. Modtageren var bygget, afsenderen ringede aldrig.

- **`mailService.bonMailContext(db, bonId)`** udleder typen af rækken. Ét sted,
  fordi de to kaldesteder — `POST /api/bons/:id/mail` (tilbudswizardens
  "Send til kunde" går gennem den) og `threadReplyContext` i indbakken — havde
  hver sin kopi af det samme hardkodede gæt.
- **Gamle tags bliver ikke hjemløse.** Rammer et `#b-`-tag ingen rigtig bon,
  prøves tilbuddene, og fallbacken logges. Rækkefølgen er det der gør det
  sikkert: rigtige bons vinder altid, så et gyldigt bon-tag kan aldrig
  omdirigeres til et tilbud — kun det tomme opslag falder igennem.

**Det lille `#b-` ved siden af det store `B4229` er ikke en dublet.** `#b-` er
routing-tagget (`mail_tag_bon_prefix`), `B` er bon-nummerets visnings-præfiks
(`bon_number_prefix`) — to adskilte settings, ingen af dem hardkodede. Ligger
`{{tag}}` i skabelonens emne, står tagget hvor man har sat det (som i
`booking_confirmation`); mangler det, sætter serveren det forrest. Vil man have
det til at fylde mindre, er det skabelonen der skal rettes — tagget selv skal
blive, for det er dét der får kundens svar hjem i den rigtige tråd.

**Tests**: `npm run test:offer-tag` — 20 asserts. Afsendelsen rammer den ægte
rute over HTTP (typen udledes dér), routingen kalder `processInboundMail`
direkte. Fixturen har et tilbud **og** en bon med samme cifre — det par er hele
pointen. **Mutations-testet:** fem tilbagerulninger fælder hver sine navngivne
asserts, heriblandt en hvor fallbacken får forrang og dermed stjæler et gyldigt
bon-tag. Regression grøn: inbox-learn 53, inbox_handling 29, inbox-link 21,
mail-send-truth 17, mail-tid 20, mail-parser 49.

### Indbakken: en kobling lærer afsenderen, og et arkiv kan findes igen (#478 + #479, 18. august 2026)

Lærke skrev to mails 11. august — den ene med selve bestillingen (43 kuverter,
8 madhensyn). Begge landede i den ufordelte indbakke, blev arkiveret to dage
senere, og var derefter **ikke til at finde nogen steder** i Bon v2.

**Årsagskæden.** Kunden blev oprettet gennem tilbuds-flowet med telefon men
**uden email** (feltet er valgfrit). En videresendt mail blev koblet til hende —
og koblingen skrev ikke afsenderens adresse på kunden. Da hun svarede dagen
efter uden `#k-`-tag, havde trin 3a i `processInboundMail` intet at slå op på,
og mailen faldt ud igen. Systemet **fik adressen serveret og kastede den væk.**

Fejlklassen er den samme som #305/#319 (memory `project_silent_sideeffect_failures`):
handlingen sagde den lykkedes, den nødvendige bivirkning fyrede aldrig, og
intet sted mødtes de to.

**#478 — koblingen husker nu.** `learnSenderEmail()` i [routes/mail.js](routes/mail.js)
opretter afsenderens adresse som kontaktpunkt (`source='mail'`, `is_public=0`)
når en ufordelt mail kobles til en kunde. Fem tilfælde hvor vi holder os væk,
hver med sin grund: **ugyldig** · **intern** (vores egne adresser må aldrig blive
en kundes kontaktpunkt — det var #426-fejlen) · **findes** · **deaktiveret**
(nogen har fjernet den bevidst) · **optaget** (adressen står på en ANDEN kunde;
to ejere gør `findCustomerByEmail` tvetydig, og en ufordelt mail er bedre end en
stille fejlrouting).

- **Vi tilføjer, vi flytter aldrig.** Har kunden allerede en primær email, bliver
  den lærte ikke-primær. Kun når kunden ingen har — situationen der forårsagede
  fejlen — bliver den primær og synkes til `customers.email`.
- **`learnFromUnmatched()`** vælger den rigtige adresse: normalt afsenderen, men
  ved en intern videresendelse den **videresendte**. Spejler `resolveEffectiveSender`
  i mailService, så de to ikke driver fra hinanden.
- Gælder alle koblingsveje: Link til Kunde, **Link til Bon** (bonen kender sin
  kunde), Opret lead og Svar.
- Changelog-linje viser hvor adressen kom fra.

**#479 — arkivet er ikke længere en blindgyde.** `status='ignored'` betød indtil nu
"usynlig overalt": indbakken hentede kun `open`, og søgefeltet der hedder
*"Søg al mail (også afsluttet)"* kiggede aldrig i `mail_unmatched`.

- **"Ignorer" hedder nu "Arkivér"**, og kvitteringen siger hvor mailen tog hen.
  Ordet lovede det forkerte: i enhver mailklient betyder arkivér "gem den".
- **Ny chip 🗄 Arkiv** med eget søgefelt. Listen viser **kun de menneske-arkiverede**
  (12 stk.) — af 1.434 arkiverede er de 1.422 spamfiltreret automatisk og ville
  drukne resten. **Søgningen** går derimod gennem alt arkiveret, så en mail
  filteret ramte forkert stadig kan findes. Rækkerne mærkes `🗄 arkiveret` mod
  `filtreret`, så "jeg lagde den væk" kan skelnes fra "filteret tog den".
- **`POST /unmatched/:id/restore`** — fortryd. `requireAuth()`, ikke admin: den der
  arkiverede skal kunne rette op med det samme.
- **Tråd-søgningen krydshenviser**: `🗄 N træffere i ufordelt og arkiv — vis →`
  fører over i arkivet med søgeteksten i behold. Feltets løfte holder nu.
- **Arkiv-sporet vises**: *"🗄 Arkiveret af Anne · 13/8 09:11"*. `handled_by_user_id`
  og `handled_at` har ligget der hele tiden uden at blive vist nogen steder — så
  kunne ingen se hvad der var sket med en mail der manglede. (Delvis #480; en
  rigtig historik med flere handlinger mangler stadig.)

> ⚠️ `/mail/inbox` joiner nu `users` for at vise hvem der arkiverede. Både
> `mail_unmatched` og `users` har `created_at`, så **alle** where-klausuler i den
> forespørgsel skal prefixes `um.` — ellers er datofilteret tvetydigt.

**Omfanget var ikke teoretisk.** Af de 12 ufordelte mails der nogensinde er
arkiveret af et menneske, er **9 fra afsendere der ER kunder** — flere er
bestillinger (Læderstræde, kbh-el-service, mortenw ×2, cap-partner ×2).
Oprydningen af dem er #483.

**Tests:** `npm run test:inbox-learn` — 25 asserts mod de ægte endpoints over HTTP
(isoleret temp-DB, spawned server), inkl. at afsender-opslaget bagefter faktisk
finder kunden. **Mutations-testet:** fjernes læringen falder 11 asserts; hvert af
de tre værn (intern, optaget, ikke-primær) fælder sin egen navngivne assert.
Regression grøn: inbox_handling 29, inbox-link 21, mail-send-truth 13,
mail_signature 24. Browser-verificeret mod en kopi af driftsdata — den fulde
drifts-repro (kunde uden email → kobling → adressen læres → næste mail rammer)
kørt igennem; kopien slettet efter brug.

**Åbne opfølgninger:** #480 (rigtig mail-historik i changelog), #481 (kortlæg
mailklient-forventninger — Leifs pointe om at folk skal føle sig hjemme),
#482 (foreslå kunden automatisk + advar før en kundemail arkiveres),
#483 (ryd de 9 arkiverede kundemails op).

### Indbakken foreslår kunden — og advarer før en kundemail arkiveres (#482, 18. august 2026)

#478 sørger for at en kobling **husker** adressen. Men kun anden gang. Første gang
en kendt kunde skriver fra en adresse vi ikke har på dem, står man med præcis det
valg Anne stod med: koble manuelt eller arkivere. Systemet vidste faktisk hvem det
var — det sagde bare ingenting.

- **`suggestCustomerFor()`** ([routes/mail.js](routes/mail.js)) hænger
  `suggested_customer` på hvert ufordelt item i `/mail/inbox` og `/mail/unmatched`.
  Slår op på afsenderen, og på den **videresendte** afsender når mailen kom via en
  kollega. `via` fortæller hvilken af de to der ramte. Opslagene caches pr. request —
  en arkiv-søgning kan give hundredvis af rækker fra de samme få afsendere.
- **Vi foreslår aldrig os selv.** Huset står som kunde (`info@` = 3005), så uden
  intern-værnet ville hver videresendelse foreslå Ristet Rug — nøjagtig den fejl
  #426 rettede i routingen.
- **`lookupCustomerByEmail` fik `is_active`-filtre** på både kunde og kontaktpunkt.
  En sammenlagt dublet er *lukket*, ikke slettet, og måtte ikke kunne foreslås.
  Rettelsen gælder også bounce-berigelsen, som brugte samme funktion.
- **UI**: gult panel i previewet (*"👤 Afsenderen er kunde: Lærke Haumann Andersen ·
  CAP PARTNER ApS"* + `Kobl til Lærke`) og et `👤 kendt kunde`-mærke i listen.
- **Arkivering advarer**: *"Afsenderen er kunde: … Vil du arkivere alligevel? Tryk
  Annuller for at koble mailen til kunden i stedet."* Ikke en spærring — en kundemail
  kan godt være støj — men valget skal være bevidst. Bulk-arkivering navngiver de
  første fem kunder i bunken, så den ene bestilling ikke forsvinder i mængden.

> ⚠️ **Et mærke i `.inb-mail-subject` er usynligt på lange emner.** Emne-linjen har
> `text-overflow: ellipsis`, så mærket lå i DOM'en men blev klippet væk på 5 af 12
> rækker — kun synligt ved at måle `getBoundingClientRect().width`. Mærkerne bor nu
> i meta-linjen med `flex-shrink: 0`.

**Målt på driftsdata:** 9 af de 12 menneske-arkiverede mails får nu et forslag —
præcis de 9 der viste sig at være kundekorrespondance. De tre uden (Hungarian
Embassy, Luca Mateo, kbh-el-service) er reelt ukendte afsendere.

**Tests:** `npm run test:inbox-learn` udvidet 25 → **34 asserts**. Mutations-testet:
intern-værnet, `is_active`-filteret og forward-fallbacken fælder hver sin navngivne
assert. Verificeret ende-til-ende mod en kopi af driftsdata, hele kæden i ét forløb:
kobl Mortens første mail manuelt → adressen læres (#478) → hans anden mail får
automatisk et forslag (#482). Kopien slettet.

### Retteventilen: en mailtråd kan flyttes til den rigtige kunde (#481, 19. august 2026)

Kortlægningen til #481 fandt otte mailklient-forventninger indbakken ikke holdt.
Syv af dem har en omvej. Den ottende var en ægte blindgyde: **en tråd der sad på
den forkerte kunde kunne ikke flyttes.** `PATCH /threads/:id` tager status,
udsættelse og tildeling — ikke ejerskab. Opdagede man fejlen, var der intet at
gøre ved den.

- **`POST /api/mail/threads/:id/move`** med `{customer_id}` eller `{bon_id}`.
  `requireAuth()`, ikke admin: den der opdager fejlen skal kunne rette den med
  det samme. Leverandør- og indkøbsordre-tråde afvises — de har deres egen
  tilknytning og hører ikke til en kunde.
- **Flyt til en bon arver bonens kunde**, så tråden også ses på kundekortet.
  Flyt til en kunde rydder `bon_id` — en kundetråd hænger ikke fast i den
  gamle bon.

**Den lærte adresse følger med — ellers retter flytningen ingenting.**
#478 skrev afsenderens adresse på kunden da tråden blev koblet. Blev den
koblet forkert, står gættet på den forkerte kunde, og næste mail fra samme
person ville lande samme forkerte sted igen — nu *helt uden* at nogen rørte
den. En retteventil der lader fejlkilden stå, cementerer fejlen i stedet for
at rette den.

- Kun kontaktpunkter med `source = 'mail'` flyttes. Manuelt indtastede, fra CVR
  eller fra en formular står et menneske eller en ekstern kilde inde for, og de
  er ikke vores at flytte rundt på. Verificeret mod driftsdata: Lærkes egen
  `manual`-adresse er urørt gennem flytninger i begge retninger.
- Den gamle adresse **deaktiveres**, slettes ikke — sporet skal kunne ses, og
  #478 genopliver ikke en deaktiveret adresse af sig selv.
- `learnSenderEmail` fik derfor `{ reactivate }` (default `false` = uændret):
  ved en flytning HAR nogen sagt at adressen hører til her, så en tidligere
  deaktiveret række genaktiveres i stedet for at blive sprunget over.
- Interne adresser springes over, som alle andre steder.
- Kvitteringen siger det højt: *"Flyttet til Lærke Haumann Andersen · 1 lært
  adresse fulgte med, så næste mail lander samme sted"* — adresse-delen er den
  man ikke kan se på skærmen.

**UI**: `⇄ Flyt` i trådens handlingsrække åbner et panel der søger kunde på navn
eller bon på nummer. Tråden **genindlæses** efter flytningen i stedet for at
blive lukket væk, så man kan se at den nu sidder rigtigt.

`changelog` får en `entity_type='mail_thread'` / `action='thread_moved'`-linje
pr. flytning — første skridt af #480.

> ⚠️ **En assert der kaster er et dårligere signal end en der fejler.**
> `findCustomerByEmail(...).id === x` kastede `TypeError` da mutationstesten
> fjernede rettelsen, i stedet for at fælde sin navngivne assert — så mutationen
> så ud til at slippe igennem. Optional chaining i alle opslag der kan give null.

**Tests:** `npm run test:inbox-learn` udvidet 34 → **53 asserts**.
Mutations-testet: fjernes adresse-flytningen, falder 2 navngivne asserts;
fjernes oprydningen på den gamle kunde, falder 4; fjernes `source='mail'`-
filteret, fældes fredningen af manuelle adresser. Regression grøn
(inbox_handling 29, inbox-link 21, mail-send-truth 13, mail_signature 24).
Verificeret mod en kopi af driftsdata: mail koblet til forkert kunde →
adressen lært dér → flytning → adressen væk fra den forkerte og på den
rigtige, begge kunders egne `manual`-adresser urørte. Kopien slettet.

**Stadig åbent i #481:** de øvrige syv forventninger afventer samtalen med Anne
(markér som ulæst igen, videresend, vedhæft i tråd-svar, ret emne, sorteringen
i #488). Talgrundlaget ligger som kommentar på issuet.

### Ét tidsstempel-format i mail-tabellerne (#488, 19. august 2026)

Trådlisten sorterede forkert **inden for samme dag**: to tråde fra kl. 17:25 og
17:16 stod under en fra 15:49. Ikke tabt data — men "nyeste øverst" var ikke
sandt, og en liste hvis rækkefølge ikke kan stoles på undergraver hele
indbakken (fundet under kortlægningen til #481).

**Årsagen var to skrivemåder for samme ting.** Indgående tidsstempler blev
skrevet med `toISOString()` (`2026-08-10T15:49:24.000Z`), udgående med
`datetime('now')` (`2026-08-10 15:53:19`). Begge er UTC — men de sammenlignes
som **tekst**, og `'T'` (0x54) sorterer efter `' '` (0x20). Derfor lagde enhver
tråd med indgående som seneste aktivitet sig over enhver tråd med udgående fra
samme dag. Datodelen er ens-formateret, så det holdt på tværs af dage; kun
inden for en dag skred det — hvilket typisk er dér man kigger.

- **`sqlTime(date)`** i [db/helpers.js](db/helpers.js) giver
  `YYYY-MM-DD HH:MM:SS` i UTC — samme skala og form som `datetime('now')`.
  Her er UTC **rigtigt**, modsat `todayISO()` lige ovenfor, fordi databasens
  tidsstempler ER UTC; derfor `// utc-ok`-markeringen. Ugyldig dato → `null`
  frem for strengen `"Invalid Date"`.
- **Migration 150** normaliserer de eksisterende rækker (`mail_messages.received_at`,
  `mail_unmatched.received_at` + `handled_at`, `mail_threads.last_inbound_at`).
  Idempotent — `WHERE ... LIKE '%T%'` rammer kun det der mangler.
- **Skrivestierne** i `mailService.processInboundMail` og `markThreadInbound`
  bruger nu `sqlTime()`. Alle øvrige skrivesteder brugte i forvejen
  `CURRENT_TIMESTAMP`/`datetime('now')` eller kopierede en allerede normaliseret
  værdi.

> **At begge sider var UTC er efterprøvet, ikke antaget.** Afstanden mellem en
> mails `received_at` (ISO) og dens `created_at` (mellemrum) på samme række er
> 0–7 minutter i drift — nøjagtigt IMAP-pollingens interval. Var den ene lokal
> tid, ville forskellen have været ±1–2 timer. Derfor er konverteringen ren
> formatering, og migrationen kan køre uden risiko for at flytte tider.

**Tests:** `npm run test:mail-tid` — 20 asserts mod en temp-DB bygget af de
rigtige migrations. Den viser fejlen begge veje: med det normaliserede format
ligger nyeste øverst, og sættes ISO-formatet tilbage vender rækkefølgen om.
**Mutations-testet** — fire mutationer, alle fanget. To huller blev fundet og
lukket undervejs: testen rørte hverken den ægte skrivesti
(`processInboundMail`) eller `mail_threads`/`handled_at`-grenene med data i,
så begge kunne fjernes uden at noget fejlede.

Verificeret mod en kopi af driftsdata: alle 181 + 1.465 tidspunkter uændrede
målt som epoch, rækketal uændret, ingen ISO-rester, anden kørsel ændrer intet.
Efter server-start (migrationen kører automatisk) er alle 185 tråde
kronologisk korrekt sorteret i UI'et.

### Varemodtagelsen henter sit FVST-skema fra tavlen (#495, 20. august 2026)

Driften savnede et felt: *hvilket produkt målte du temperaturen på?* Det viste sig
aldrig at have været der — men jagten på det afdækkede en større fejl.

**Skemaet fandtes to steder.** Whiteboard ejer FVST-definitionen i
`registration_types.fields` og kan redigeres i admin. Bon v2 havde en **håndskrevet
kopi** i `shared/varemodtagelse.js`:

```js
_vmBuildTempRow('koel', '🧊', 'Kølevarer', 'max. 5°C', 4.5, 0.1, true, 4.7, 5)
```

De tal ER tavlens skema, skrevet af i hånden. Rettede man en grænseværdi i admin,
skete der ingenting i bon, og ingen fik det at vide. Fejlklassen er den samme som
#305/#319 (memory `project_silent_sideeffect_failures`): to systemer var uenige, og
uenigheden var usynlig. FVST-dokumentation er ikke et sted at have to sandheder.

> Bevis for driften: bons kopi havde `warn=4,7`, tavlens skema `warn_above=4`. De var
> allerede skredet fra hinanden. Efter koblingen viser standardværdien 4,5 °C nu
> **OBS** i stedet for **OK** — det er tavlens skema der gælder. Vil kontoret have den
> gamle tærskel tilbage, rettes `warn_above` i admin; det kræver ikke kode.

**Tavlen er nu eneste kilde.** Bon henter skemaet gennem en maskindør og renderer
formularen ud fra det.

- **Whiteboard**: `GET /api/registration-types/schema?key=…` (`X-Webhook-Secret`,
  uden for login-gaten) + `server/helpers/machineAuth.js` — `requireWebhookSecret`
  udtrukket så webhooken ind og skemaet ud deler **én** adgangskontrol. Migration 026
  lægger produktfelterne i skemaet **additivt** (020 nulstillede alt og slettede
  dermed folks admin-ændringer; denne springer over hvis feltet findes, bevarer
  egne felter og placerer hvert produktfelt lige efter sin temperatur).
- **nginx**: `location = /api/registration-types/schema` med `auth_request off`.
  Egen sti frem for at åbne `/api/registration-types` — nginx matcher på sti, ikke
  metode, så en undtagelse på listen ville også åbne POST/PATCH for internettet.
- **`services/receiptSchema.js`**: tavle → cache (`settings`) → indbygget kopi.
  Cachen er **ikke en optimering, men en garanti**: fødevarekontrol er lovpligtig og
  må aldrig blokeres af at tavlen er nede. `getSchema()` venter aldrig på nettet
  (stale-while-revalidate); kun en helt kold start kan vente, og højst 8 s.
- **Migration 151**: `temperature_cool_product`, `temperature_frozen_product` +
  `extra_fields_json` på `goods_receipts`.

**`extra_fields_json` er det der gør koblingen ægte.** Uden den ville "tavlen ejer
skemaet" kun gælde halvt: labels og grænser ville slå igennem, men et **helt nyt**
felt i admin ville kræve kode og en migration i bon. Ukendte felter renderes nu
generisk, gemmes som JSON og sendes videre til FVST-loggen under tavlens egne
felt-id'er. Kendte felter havner **aldrig** der — de har egne kolonner, så rapporter
og tests er upåvirkede. Klientens input filtreres mod skemaet, så et fjernet felt
holder op med at blive gemt og kolonnen ikke kan fyldes af en klient.

**Produktvalget** fik egne kolonner frem for `extra_fields`, fordi bon kan rendere
det rigere end tavlen: `<input list>` med varerne på **netop den leverance** som
forslag, og fri tekst hvis der blev målt på noget andet. Værdien er varenavnet som
tekst — ikke et Grocy-id — så tavlen kan tage imod uden også at kende Grocy.
Feltet følger sin temperatur: er toggle slået fra, ryddes og deaktiveres det, og
serveren gemmer det ikke.

> ⚠️ **Fandt undervejs:** en frost-række der starter slukket (`toggle_default_off`)
> viste et grønt **OK** for en måling der aldrig blev taget, og talfeltet var
> skrivbart. `_vmUpdateTempBadge()` beregnede badgen uden at se på om rækken var
> slået til. Starttilstanden går nu gennem `_vmOnTempEnabled()` — samme kode som et
> klik på toggle — så badge, talfelt og produktfelt altid følges ad.

**Oversættelsen ét sted:** tavlen skriver `accepted_no_risk`, bon gemmer `no_risk`
(låst af CHECK-constraint i migration 036). Tabellen bor i `receiptSchema.js`;
webhooken importerer den, og `/schema` leverer allerede oversatte værdier, så
frontenden ikke får en tredje kopi.

**Tests:** `test-receipt-schema.js` (38 — degradering: slukket kobling, manglende
hemmelighed, tavle nede, **login-redirect tolkes ikke som skema**, tomt skema, 401,
samtidige kald, filtrering) + `test-receipt-schema-e2e.js` (22 — hele kæden over HTTP
mod ægte endpoints) + whiteboards `api-test.js` (+13). Mutations-testet: fire
kernerettelser rulles tilbage og fælder hver sin navngivne assert. Regression grøn:
goods-receipt-webhook 47, consume-hardening 40, packing-units 18, whiteboard 161+10.
Browser-verificeret ende-til-ende mod en kopi af driftsdata: skema hentet fra tavlen,
forslag fra leverancen, registrering gemt, `målt på Spidskål` læsbar i
modtagelsesloggen, og `temp_product` fremme i tavlens FVST-log. Kopien slettet.

**Deploy — rækkefølgen betyder noget:** whiteboard-PR'en (rute + migration 026) skal
være ude **før** nginx-undtagelsen, og nginx før bon-PR'en. Indtil alle tre er på
plads svarer `/schema` med `source: 'builtin'`, og varemodtagelsen kører præcis som
i dag — koblingen er inert, ikke i stykker. `GOODS_RECEIPT_WEBHOOK_SECRET` skal stå
i **begge** `.env`-filer (den gør den allerede, til webhooken).

**Ikke løst:** tavlen kan stadig ikke lægge varer på lager — dét kræver at den kender
indkøbslisten, Grocy-enheder og QU-konvertering. Whiteboard #19's valg (tavlens
formular *viger* for bon når de er koblet) står ved magt. Denne opgave løser den
anden halvdel: at bon ikke længere har sin egen forældede kopi af FVST-delen.


### Migrations er alt-eller-intet (20. august 2026)

Produktionen lå nede i crash-loop med `502 Bad Gateway`. Loggen sagde
`duplicate column name: temperature_cool_product` — migration 151 forsøgte at
tilføje en kolonne der allerede fandtes, hver gang systemd startede serveren.

**Ændringen var anvendt, registreringen manglede.** `db/migrate.js` kørte hele
SQL-filen med `db.exec(sql)` og skrev først `INSERT INTO _migrations` bagefter.
`exec` kører uden transaktion, så SQLite committer hvert statement for sig. Rammer
noget vinduet mellem de to, står databasen ændret mens migrationen ser ukørt ud —
og næste opstart rammer sin egen første `ALTER TABLE`. Serveren kommer aldrig ud
af det selv; systemd genstarter den bare ind i samme fejl.

Udløseren er bekræftet: main blev deployet lige efter merge og `systemctl restart`
kørt flere gange i træk, så **to server-processer startede oven i hinanden**. Begge
så migrationen som ukørt; den ene anvendte alle fire statements, den anden holdt
skrivelåsen da registreringen skulle skrives.

- **Migration og registrering committes nu sammen.** `BEGIN IMMEDIATE` → `exec` →
  `INSERT INTO _migrations` → `COMMIT`, med `ROLLBACK` ved fejl. `IMMEDIATE` frem
  for `BEGIN` er ikke pynt: skrivelåsen tages med det samme, så to samtidige
  processer støder sammen FØR den ene har ændret noget. Taberen fejler rent.
- **Fem migrations er undtaget** — dem der slår foreign keys fra (`032`, `041`,
  `060`, `090`, `128`). `PRAGMA foreign_keys` er en **no-op inde i en transaktion**,
  så en indpakning ville tavst lade FK-håndhævelsen være tændt midt i en 12-trins
  table-rebuild. Det fejler ikke højlydt — det river rækker med sig. De køres som
  før og har præcis samme risiko som hidtil. Detekteres på `OWNS_FK_PRAGMA`.
- **Fejlbeskeden anviser udvejen.** Ved `duplicate column` skriver loggen nu at
  ændringerne sandsynligvis allerede er anvendt, og hvordan migrationen registreres.
  Det er fejlsøgningen gjort til tre linjer i journalctl.
- `runMigrations(dbPath, migrationsDir)` — mappen er injicerbar, så testene kører
  den **rigtige** runner mod kontrollerede migrations i stedet for en kopi af
  logikken. Alle ~60 eksisterende kaldere sender højst ét argument.

> Rettelsen har først effekt ved NÆSTE migration. En database der allerede står
> halvfærdig skal bringes i orden i hånden — verificér at hele filens indhold er
> anvendt, og registrér den så i `_migrations`.

**Tests**: `tests/migrate.test.js` (6 — rollback efterlader intet, en rettet migration
kan køres igen, ændring og registrering følges ad, ingen dobbeltkørsel, fejlbeskeden
anviser, FK-undtagelsen virker). **Mutations-testet:** fjernes transaktionen falder de
to tests der beskriver produktionsfejlen; fjernes FK-undtagelsen fejler table-rebuild;
fjernes fejlbesked-hjælpen falder dens egen test. **Regression:** en frisk database
kører alle 160 migrations, og skemaet er **byte-identisk** (258 objekter) med den
originale runner. `cashflow-sync`'s 4 FAIL er pre-eksisterende — efterprøvet ved at
køre suiten mod den gamle `migrate.js`.


### Et zone-skift må ikke ende i browserens fejlside (#423, 21. august 2026)

"Der er ingen internetforbindelse" ved skift fra køkken til office — selvom nettet
virker, og genindlæs løser det med det samme.

**Første diagnose blev modbevist undervejs.** SSE-forbindelser blev aldrig lukket, så
teorien var at de ophobede sig. Serverloggen viste noget andet: 10–12 forbindelser
stabilt over tre timer, ingen ophobning, ingen genstart. Da Safari sagde "ingen
internetforbindelse", **havde serveren aldrig set forespørgslen**. Fejlen sidder på
klientsiden. Oprydningen fra PR #424 (`manageSSE`) var korrekt, men ikke årsagen.

Vi kan ikke fremprovokere fejlen, og de to tilbageværende forklaringer — webapp-vinduets
egen fastlåste HTTP/2-forbindelse eller macOS' netværk der flapper — kræver begge at
nogen står ved skærmen i det sekund det sker. Derfor er den ikke jagtet videre: den er
gjort **umulig at ende i**.

- **`safeNavigate()` + `guardLink()`** ([shared/utils.js](shared/utils.js)) prøver
  forbindelsen af FØR siden forlades: et `HEAD` mod selve destinationen. Ethvert svar —
  også 401 eller en redirect til login — beviser at forbindelsen lever. Fejler det, har
  browseren netop revet den døde forbindelse ned, så andet forsøg får en frisk. Fejler
  også det, viser vi vores egen besked med automatisk genforsøg, **og siden brugeren står
  på går ikke tabt**. Et timeout tæller som "i live" — et langsomt net må ikke spærre for
  navigation. Modifier-klik, midterklik og `target="_blank"` røres ikke.
  Wired på "← Office" ([kitchen_topbar.js](shared/kitchen_topbar.js:113)), zone-switcheren
  og office-logoets vej til køkkenet.
- **Streamen cykler** ([shared/sse.js](shared/sse.js)): lukkes efter 10 min ± 2 min jitter
  i stedet for at stå åben i timevis og holde domænets ene HTTP/2-forbindelse fastlåst.
  `EventSource` genopretter selv.

> **Uden replay ville punkt 2 være en regression.** En planlagt lukning ville koste de
> events der falder i genopkoblingsvinduet — på en køkkenskærm er det en tabt
> statusændring. Derfor buffer + `Last-Event-ID`, hvilket samtidig lukker hullet ved de
> **uplanlagte** genopkoblinger vi altid har haft. To ting der ikke må skride: et
> `sendTo`-event er adresseret og må kun afspilles til sin egen bruger, og et `broadcast`
> med `excludeUserId` skal blive ved med at springe afsenderen over — ellers ser hun sit
> eget ekko. Id'et bærer et epoke-mærke, så et `Last-Event-ID` fra før en genstart ikke
> tolkes som en position i den nye tællers rækkefølge.

**Ingen nginx-ændring.** `proxy_read_timeout 24h` er nu blot en øvre grænse der aldrig
nås, fordi serveren selv lukker først. Ingen migration, ingen ny route.

**Tests:** `npm run test:nav` — 8 + 7 asserts. Navigationen køres i en vm-sandkasse mod
den rigtige `shared/utils.js` (browserkode kan ikke `require`s), SSE'en mod en rigtig
HTTP-server. **Mutations-testet:** otte kernerettelser rulles hver især tilbage og fælder
hver sin navngivne assert. Browser-verificeret ende-til-ende: "← Office" navigerer
normalt, et brudt `fetch` giver overlayet i stedet for blindgyden, og da nettet kom
tilbage, kom genforsøget selv videre. Browser-panelet var frosset (viewport 0×0), så
klikket blev sendt som `MouseEvent` gennem den ægte lytter, ikke som fysisk museklik.

**Stadig ubesvaret:** næste gang fejlen rammer — åbn `whiteboard.ristetrug.dk` i en
almindelig Safari-fane **før** du genindlæser. Virker den, mens webapp-vinduet er dødt,
er det Safari og ikke netværket. Det svar afgør om #423 kan lukkes helt.

### En ny skærm arver ikke flyver-historikken (#521, 22. august 2026)

Åbnede man Bon v2 på en ny computer, kom **hver eneste flyver der nogensinde er sendt**
frem som ulæst — også dem på bons der for længst var leveret og faktureret. Målt på en
kopi af driftsdata: 19 flyvere, 15 klient-id'er, **263 read-rækker**. Stort set hver
skærm havde måttet klikke hver eneste flyver væk i hånden.

To uafhængige huller, begge i `GET /api/notifications/unread`:

1. **En ny klient arvede hele historikken.** "Ulæst" var defineret som *ikke i
   `notification_reads`*, og reads er nøglet på et localStorage-UUID (`getClientId()`).
   En frisk browser har nul rækker og fik derfor alt siden 19. maj.
2. **En flyver blev aldrig irrelevant af sig selv.** Forespørgslen så hverken på bonens
   status eller dato. Alle 19 flyvere i drift sad på FAKTURERET/AFSLUTTET-bons.

- **Relevansfilter**: status ikke i `LEVERET, FAKTURERET, BETALT, AFSLUTTET, AFLYST`,
  og `delivery_date` inden for `settings.flyver_grace_days` (default 2) bagud.
  > ⚠️ **`is_terminal` kan ikke stå alene her.** LEVERET har `is_terminal = 0`, men en
  > flyver på en leveret bon er lige så forældet som på en faktureret. Listen skrives ud.

  Marginen er ikke pynt: status-filteret fanger normalt en afsluttet bon, men køkkenet
  når ikke altid at trykke LEVERET, og ved midnat er datoen teknisk passeret. Uden
  marginen ville en besked kunne forsvinde i det hul.
- **Nulpunkt pr. klient** (migration 153, `notification_clients`): første gang et
  `client_id` spørger, stemples det, og derefter ses kun flyvere sendt siden da.
  O(1) pr. klient — modsat at skrive en read-række for hver eksisterende flyver ved
  første besøg, som ville vokse med klienter × flyvere.
- **Migrationen backfiller kendte skærme** med `MIN(read_at)`, altså deres FØRSTE
  kvittering. Uden det ville hver eksisterende skærm få nulpunktet sat til
  deploy-tidspunktet og dermed tabe en flyver der lige nu ligger uklikket på en aktiv bon.
  `read_at` og `notifications.created_at` skrives begge med `CURRENT_TIMESTAMP`, så de
  har samme format og kan sammenlignes som tekst (jf. migration 150).

**Begge greb er nødvendige.** Relevansfilteret rydder køen op af sig selv når bonen
leveres — også på skærme der allerede står med gamle flyvere. Nulpunktet sikrer at en
ny maskine aldrig kan få en bunke, heller ikke af flyvere på bons der stadig er i arbejde.

**Fravalgt:** at nøgle læst-status på `user_id`. Login findes, men roller er delte
PIN-konti, så én skærm der kvitterede ville fjerne flyveren for alle andre køkkenskærme
på samme rolle. Per-device er den rigtige granularitet.

**Tests:** `npm run test:flyver` — 21 asserts. Migrationens backfill køres mod de
**rigtige** migrations-filer, hvor 153 anvendes efter at der ligger kvitteringer i basen;
ellers ville testen aldrig se den kodesti (en frisk DB har tom `notification_reads`).
Resten rammer endpointet over HTTP mod en spawnet server. **Mutations-testet:** seks
kerneregler rulles hver især tilbage og fælder hver sin navngivne assert.
Verificeret mod en kopi af driftsdata: **19 → 0** for en ny maskine, 15 eksisterende
skærme fik deres rigtige nulpunkt med. Browser-verificeret: frisk localStorage → intet
banner trods ulæst flyver på aktiv bon; ny flyver → banner via SSE; bon sat til LEVERET
→ 1 → 0. Testdata ryddet.

### Modaler lukkede når musen blev sluppet udenfor (22. august 2026)

Markerede man teksten i et felt inde i en modal og trak musen ud over den grå
baggrund for at frigøre markeringen, lukkede modalen — med det man havde skrevet.
Set i drift på udgifts-modalen i event-modulet, men fejlen sad i **21 modaler**.

`click` fyrer på den nærmeste **fælles forfader** til dér hvor knappen blev
trykket ned og dér hvor den blev sluppet. Når trykket startede i feltet og
slippet skete på overlayet, blev den fælles forfader netop overlayet — og
vagten `if (e.target === overlay) luk()` så det som et klik udenfor. Vagten
kiggede kun på hvor musen SLAP, aldrig på hvor den startede.

- **`closeOnOutsideClick(overlayEl, closeFn)`** + **`isOutsideClick(e, el)`** i
  [shared/utils.js](shared/utils.js) kræver at **både** nedtrykket og slippet
  skete på overlayet. Alle 21 kaldesteder er lagt om (shared/modal.js,
  bon_opret_modal, bon_drawer, indkob ×2, add_to_campaign_modal,
  supplier_inbox, stock_overview ×2, mobile/views/crm og otte office-views).
- **Trykkets ophav spores ét sted på `document` i capture-fasen**, ikke pr.
  overlay. Ellers kunne de to delegerede handlere i `stock_overview.js` ikke
  spørge — de har intet overlay-element at hænge en lytter på.
- Slip-target nulstilles ved hvert nyt tryk, så et slip fra forrige tryk ikke
  kan tælle med når `click` ankommer uden et friskt `pointerup` (pointercancel
  ved scroll på touch).
- To inline `onclick="if(event.target===this)…"`-attributter (supplier_inbox,
  mobile/crm) er blevet til rigtige lyttere; ellers kunne de ikke dele reglen.
- Sidebackdrops der ligger som **søskende** til panelet (indkøbs-settings-panelet,
  Settings) var aldrig ramt: dér bliver den fælles forfader `body`, så overlayets
  lytter fyrer slet ikke. De er urørt.

**Samme fejl i dropdowns og menuer.** En dropdown har ingen overlay at hænge
vagten på; den lukker fra en `document`-lytter med `!panel.contains(e.target)`.
Trækker man en markering ud af den, lander `click` på en fælles forfader
udenfor — og listen lukkede. `clickedOutside(e, …elementer)` og
`clickedOutsideSelector(e, selector)` bruger samme regel. Anvendt på:
adresse-autocomplete i bon-draweren og i Kunde 360°, kolonnevælgeren i
bonlisten, MERE-menuen i køkkenets topbar, prisberegnerens adresseliste i
logistik, opmærksomheds-panelet i office-topbaren, opskrift-designerens to
autocomplete-lister og kortmenuen i optællingen.

**Tre steder er bevidst urørt:** hjælpesystemets kortlægningstilstand (klik
udpeger et element — det ER meningen), dashboard-chartets tooltip (lukkes af
`touchstart`, ikke `click`) og event-popoveren, der allerede lytter på
`mousedown` i capture — dér lukker trykket, før man kan nå at trække.

**Draweren havde samme symptom, men en anden mekanisme.** Baggrunden er dér
SØSKENDE til panelet, så den fælles forfader bliver `body` og baggrundens lytter
fyrer slet ikke — verificeret med et rigtigt musetræk (`pointerdown` på feltet,
`pointerup` på baggrunden, `click` på `body`). Det der lukkede draweren, var
**klikket bagefter**: det man laver for at fjerne markeringen. Første klik ryddede
markeringen OG lukkede draweren i samme bevægelse.

Et klik hvis eneste ærinde er at rydde en markering må ikke oveni lukke panelet.
`closeOnOutsideClick` tager derfor et tredje argument, `panelEl` — det indhold
der beskyttes. Udelades det, beskyttes alt inde i overlayet (rigtigt for en
modal); draweren sender sit panel med, da baggrunden er søskende. Første klik
rydder markeringen, næste klik lukker — og uden markering lukker første klik som
altid.

> ⚠️ **En markering inde i et `<input>`/`<textarea>` er usynlig for
> `getSelection()`** — den returnerer tom. Netop dét felt er det almindelige
> tilfælde i en bon-drawer, så `document.activeElement` tjekkes særskilt.
> Markeringen skal desuden aflæses i **capture-fasen på nedtrykket**: browseren
> rydder den som standardhandling, så ved `click` er den væk.

**Tests:** `npm run test:modal` — 30 asserts. Den rigtige `shared/utils.js` køres
i en vm-sandkasse med en DOM der modellerer capture, bobling og netop den
retargeting af `click`; begge grene (pointer + mus-fallback) køres.
**Mutations-testet:** tolv kernerettelser rulles hver især tilbage og fælder hver
sin navngivne assert — den gamle adfærd (`kun e.target`) fælder 9, og fjernes
markerings-vagten falder 6.
Verificeret i browser på `shared/modal.js` og `bon_opret_modal.js`: markering
trukket ud → modalen står, klik på en knap indeni → står, ægte klik udenfor →
lukker. Konsolfejlene på office er efterprøvet mod `git stash` og er
pre-eksisterende (manglende Grocy-nøgle lokalt).

Drawer-forløbet er kørt igennem med **fysiske museklik** i begge zoner: træk ud →
draweren står med markeringen intakt, første klik → markeringen ryddes og draweren
står, andet klik → den lukker; uden markering lukker første klik. Modal-delen blev
sendt som events gennem de ægte lyttere, fordi browser-panelet var frosset (viewport
0×0) da den blev bygget.

> ⚠️ **Test mod `_drawerInstance.el` / `.overlayEl`, ikke `querySelector`.**
> Under verifikationen fandt jeg to `.bon-drawer` i DOM'en på køkken-kalenderen
> og troede det var en fejl i appen. Det var testkoden: `shared/bon_kort.js`'
> `openBonDeliveryFromCard` falder tilbage til `new BonDrawer()` når
> `window._bonInfoEditHandler` mangler, og min attrap gjorde det samme. En frisk
> indlæsning har præcis én. Kalenderen wirer sin drawer gennem `initCalendar`s
> `onEdit`/`onBonClick` og bruger slet ikke `_bonInfoEditHandler`.
>
> Fallbacken i `bon_kort.js` er **uden for rækkevidde i dag** — bon-kort renderes
> kun af `kitchen/today.js` og `kitchen/later.js`, og begge sætter handleren.
> Den er alligevel gjort robust: `openBonDeliveryFromCard` genbruger nu sidens
> egen drawer (`window._drawerInstance`) i stedet for at bygge en ny ved hvert
> klik. `new BonDrawer()` hænger et overlay, et panel og et sæt lyttere på
> `<body>`, og den nye instans ville ikke være den som sidens URL-synk og
> "ugemte ændringer"-dialog hænger på — draweren ville altså se rigtig ud og
> opføre sig forkert. Efterprøvet i browseren med handleren fjernet: tre klik
> giver fortsat 1 drawer / 1 overlay og genbruger `_todayDrawer`, hvor den gamle
> gren gav 4/4.
### Én prep-bon kan dække flere event-dage (22. august 2026)

Generatoren laver én prep-bon pr. dag, fordi forecasten er pr. dag. Men køkkenet
pakker ofte **alt** til hele eventet på én gang og topper først op dagen efter.
Så skulle den samlede pakning tastes to steder — og pakkelisten kunne ikke vise
hvad der reelt skulle ned i kasserne.

**Hvorfor det ikke bare er en visning.** Pakkelisten ER lagertrækket:
`prep_packing_overrides` / `_extras` / `_recipe_overrides` er alle `UNIQUE(bon_id, …)`,
og ved LEVERET trækker netop dén bons mængder fra HQ. En samlet liste med redigering
over to bons ville derfor kræve at de pakkede mængder blev **fordelt tilbage** — og
den fordeling er ren fiktion, for alt forlod huset samme dag. Fiktionen ville
oven i købet blive læst som en måling senere, i retur- og top-up-beregningen.

Derfor: er det én fysisk udlevering, er det **én bon**.

- **Migration 156**: `bons.event_covers_until` (TEXT, nullable). NULL = dækker kun
  sin egen `delivery_date` ⇒ alle eksisterende bons uændrede. Sættes kun på prep;
  `resolveCoversUntil` afviser rollen ellers, og en dato der ikke ligger **efter**
  pakkedagen gemmes som NULL frem for at stå som en tom påstand i data.
- **Nedstrøms er allerede rigtigt — ingen ændring nødvendig.** `computeTopupSuggestion`
  regner `rest = preppet(delivery_date ≤ dato) − solgt`, så dag 1's bon tælles med
  på dag 2: forslaget er 0 indtil der faktisk er solgt. `computeReturnSuggestion` og
  `getPrepAggregate` summerer over alle bons — én i stedet for to giver samme sum.
  Efterprøvet i drift-lignende forløb: 300 preppet, 260 solgt dag 1 ⇒ dag 2 foreslår 60.
- **Det ene sted det knækkede** er overblikkets forecast-tabel: `prepped` opgøres pr.
  `(delivery_date, kategori)`, så dag 2 ville stå med 0 og invitere til at pakke det
  samme igen. `/overview` returnerer nu `covered_days`, og tabellen **markerer** dagen
  (`✓ pakket med B-1234`, knappen bliver `+ Top-up`). Vi fordeler bevidst **ikke**
  mængden pro-rata ud over dagene — vi ved ikke hvor meget der hørte til dag 2, og et
  gæt ville forplante sig ind i top-up-forslaget som var det målt.
- **UI**: `+ Prep for flere dage` i forecast-tabellens fod åbner den kendte modal med
  **checkbokse pr. dag** (alle valgt). Måltal-strippen summerer forecast og allerede-
  prepped over de valgte dage; pakkedagen følger første valgte dag og kan stadig rettes
  i hånden. Intervallet holdes **sammenhængende** — krydser man dag 1 og 3, krydses dag 2
  med, for `event_covers_until` er et interval og skal svare til det skærmen viser.
  Pr-dags-knappen `+ Prep` er uændret.

**Tests**: `npm run test:event-covers` — 33 asserts (18 rene helper-tilfælde + 15 mod de
ægte endpoints over HTTP i isoleret temp-DB). **Mutations-testet:** de fire kerneregler
rulles hver især tilbage og fælder 6/2/1/3 navngivne asserts. Regression grøn:
event-contact 26, event-menu 42, topup 35, prep-packing 12, event-gate 15, event-cancelled 26.
Browser-verificeret ende-til-ende på et 3-dages event: checkbokse summerer måltallet
(120+100+80 = 300), hul-fyldning virker, én prep-bon oprettet med `event_covers_until`,
dag 2+3 markeret som pakket med, pakkelisten viser alle 13 varer ét sted, og top-up
reagerer korrekt på salg. Testdata ryddet.

### Retur til HQ kunne bogføres to gange — uden spor (#536, 23. august 2026)

Kontoret kunne ikke se om returen var lavet. Kvitteringen var en flygtig
statuslinje der forsvandt ved næste render, så efter en genindlæsning stod
**Retur & afstemning** med sin intro-tekst præcis som før.

**Men det var ikke kosmetik.** `POST /api/events/:id/return` havde ingen
beskyttelse mod gentagelse, og `computeReturnSuggestion` regnede
`rest = preppet − solgt` uden at vide noget om tidligere retur. Et tryk mere
foreslog derfor de **samme** mængder og lagde dem på HQ-lageret **igen**.
Lageret blev for højt, og fejlen dukkede først op ved næste optælling som en
uforklarlig difference — samme fejlklasse som #305 og #319: handlingen påstod
at være sket, bivirkningen efterlod intet spor, og de to mødtes aldrig.
`logChange` skrev faktisk en linje, men den blev ikke vist nogen steder.

- **Migration 157**: `event_returns` (event, produkt, mængde, enhed, hvem, hvornår).
  Hver række er en **hændelse**, ikke en tilstand — derfor ingen UNIQUE på
  `(event_id, product_id)`: man kan legitimt bogføre ad flere omgange når første
  kørsel fejlede delvist hos Grocy, eller der dukker mere op i traileren.
  `added_to_product_id` bærer parent→barn-omdirigeringen (fx "kål" → Spidskål),
  så sporet peger på det produkt Grocy faktisk rørte.
- **Forslaget trækker det returnerede fra**: `rest = preppet − solgt − returneret`,
  klampet ved 0. En anden bogføring foreslår dermed **resten**, ikke det hele.
- **Sporet skrives KUN når Grocy tog imod.** Skrev vi det ubetinget, ville en
  fejlet linje tælle som returneret og blive trukket fra næste forslag — så ville
  varerne aldrig komme hjem. Samme lære som #359. Lykkes lagertrækket men fejler
  skrivningen, siges det højt (`untracked` i svaret + fejl i driftsloggen) frem for
  at svaret ser rent ud.
- **`booking_ref`** (uuid pr. bogføring) grupperer historikken. `booked_at` alene
  er utæt: tidsstemplet har sekund-opløsning, så to bogføringer i samme sekund
  ville smelte sammen til én linje. Rækker uden ref falder tilbage på tidsstemplet.
- **UI**: `/overview` leverer `return_bookings`, så Retur-sektionen viser
  `✓ bogført · N råvarer` + hvornår og af hvem **ved indlæsning** — uden at man
  først skal trykke "beregn". Knappen hedder da "Beregn igen", tabellen får en
  **Returneret**-kolonne, og en gentagen bogføring kræver en bekræftelse der
  nævner det tidligere tidspunkt. Ingen spærring: en delvist fejlet retur skal
  kunne køres om.

**Tests**: `npm run test:event-retur` — 40 asserts. Den positive gren kører
**in-process med stubbet Grocy** mod den ægte route-handler; uden det blev
"vellykket bogføring skriver sporet" sprunget over hver gang grocytest ikke var
nåelig, og testen bestod af den forkerte grund. **Mutations-testet:** syv
kerneregler rulles hver især tilbage og fælder navngivne asserts. Første runde
afslørede at `rest = preppet − solgt − returneret` **ikke** var dækket — kernen i
issuet — fordi forslaget aldrig blev beregnet i testen; hullet er lukket med en
prep-bon + stubbet BOM. Regression grøn: topup 35, event-menu 42, event-contact 26,
prep-packing 12, event-gate 15, event-cancelled 26, event-polish 27.
Browser-verificeret ende-til-ende mod grocytest: bogfør → badge + historik →
genindlæsning bevarer dem → forslaget falder fra 0,05 til 0,03 → gentagelse
advarer med tidspunktet. Grocytest-lageret rettet tilbage, testdata ryddet.

### Portioner på opskrifter kan være decimale (#548, 24. august 2026)

Intern produktion (RR Produktion) skulle kunne skaleres så den passer med de råvarer
der faktisk står på lager. Portionstallet kunne kun justeres i hele trin — man måtte
tage en hel portion eller ingenting.

Matematikken var der i forvejen: `multiplier = portioner / base_servings` er flydende.
Det eneste der spærrede, var heltalsklampningen i UI'et (`Math.max(1, … + delta)`).

- **Tallet er nu et felt** i både opskrift-vieweren og designeren. `inputmode="decimal"`
  åbner taltastaturet direkte på iPad, så man ikke skal klikke sig væk fra bogstaverne.
  Fokus markerer indholdet (man vil erstatte tallet), og Enter lukker tastaturet.
  **Ingen brøkknapper** — optællingens ¼ ½ ¾ passer dårligt her: behovet er "så meget
  som råvarerne rækker til", ikke "en halv af noget".
- `± ` går bevidst fortsat i **hele trin**; 1,4 → 2,4. Decimaler tastes.
- **Dansk komma virker.** `_rvNum`/`_rdNum` spejler `_num` i `production_batch.js`, så
  de tre felter ikke kan nå at tolke det samme input forskelligt.
- **Producér arver portionstallet** (`ProductionBatch.open({ portions })`). Før startede
  batchen altid forfra på `base_servings`, så tallet skulle tastes to gange på samme skærm.
  Udeladt parameter ⇒ `base_servings` som hidtil.
- 0, tomt eller vrøvl falder tilbage til opskriftens eget tal — aldrig 0 eller negative
  portioner. `base_servings` (det der gemmes på opskriften) forbliver et heltal.

> ⚠️ **Decimaler åbnede en fælde i lagertrækket — lukket her.** `_rvConsumeRecipe`
> rundede mængder til **2** decimaler, hvilket var nok da portioner altid var hele tal.
> Ved 0,05 portioner bliver 0,06 L balsamico til `0,003` → afrundet `0,00` → og
> `if (amount <= 0) return;` springer linjen over **helt stille**. Målt i drift på
> "Balsamico + løg": 3 varer blev til 2. Hullet fandtes i forvejen, men var uden for
> rækkevidde. Lagertrækket runder nu til `RV_CONSUME_DECIMALS = 4`; visningen må gerne
> afrunde, det der skrives til Grocy må ikke. Hele portioner er uændrede.

**Grocy er ikke en forhindring** — portionstallet forlader aldrig browseren. Det ganges
ind i hver ingrediensmængde, og til Grocy sendes kun `{ product_id, amount }`. Efterprøvet
mod grocytest: 71 af 114 produkter har decimalt lager, 289 af 400 `recipes_pos` har
decimale mængder, og et live consume på `0,33` blev accepteret (`amount: -0.33`) og rullet
tilbage med undo. Det ene sted portioner FAKTISK gemmes er `production_batches.portions`,
som allerede er `REAL NOT NULL` (migration 089/090).

**Uden for scope:** `bon_lines.quantity` er `INTEGER NOT NULL` — halve tal på bon-linjer
er en datamodel-beslutning med nedstrøms konsekvenser (enheds-tælling, pakkeliste, faktura,
e-conomic, CO₂), og "0,33 sandwich" giver ikke mening. Indkøbslistens `Math.ceil` til hele
pakker er bevidst og urørt.

**Tests:** `npm run test:portioner` — 32 asserts. Browser-koden køres i en vm-sandkasse og
de rene funktioner kaldes direkte (samme mønster som `test-recipe-viewer-nested.js`);
batch-delen aflæser den markup modalen faktisk renderer, fordi `_st` ligger i en IIFE.
**Mutations-testet:** fem kernerettelser rulles hver især tilbage og fælder 5/3/3/2/2
navngivne asserts. Regression grøn: recipe-viewer-nested 12, subrecipe-status 16,
yield-model 14, gram-chaining 6, resolver-graph 8, recipe-factor 8. Browser-verificeret
mod grocytest i begge faner; intet blev trukket fra lageret undervejs.

> **Fund undervejs (ikke rettet — ligger uden for opgaven):** dev-DB'ens `locations`-række
> for `test` peger på `https://grocytest.ristetrug.dk/api`, som svarer **401**. Den levende
> instans er `.env`'s `GROCY_TEST_URL` = `https://grocy-test.ristetrug.dk/api` (200).
> Serveren bruger DB'ens URL, så en frisk dev-opsætning kan ikke nå grocytest.
> CLAUDE.md's egen Grocy-instans-sektion har samme gamle værdi.

### En unormal status-vej kan overstyres af alle indloggede (27. august 2026)

En kunde aflyste, og bonen skulle lukkes: `AFLYST → AFSLUTTET`. Vejen findes ikke i
`status_transitions` (AFLYST er terminal), så skiftet blev afvist — og tilbuddet om at
overstyre blev kun givet til **admin**. Enhver anden stod med en blank fejlbesked og
ingen vej videre.

Kravet stammer fra Patch D (maj 2026), hvor det rigtige problem var *privilege
escalation*: `body.user_id` kunne bestemme rolle-tjekket. Værnet — at både rolle og
audit-user-id skal komme fra sessionen — var korrekt. Admin-kravet der fulgte med, var
det ikke: **auth her er rolle-baseret med delte PIN-konti**, så det ramte roller frem
for ansvar, mens virkeligheden ikke følger flow-diagrammet.

- **Force kræver nu login, ikke admin.** Login-kravet står ved magt af en grund der er
  værd at holde fast i: uden en session er der ingen at skrive i auditsporet. `can_force`
  følger derfor `!!sessionUser`, ikke rollen.
- **`body.user_id` bestemmer stadig aldrig hvem historikken siger det var.** Efter at
  rolle-tjekket er væk, er auditsporet det **eneste** der peger på et menneske — så det
  må ikke kunne skrives af afsenderen. D-3-værnet er dermed vigtigere end før, ikke
  mindre.
- **Advarslen bærer beslutningen** i stedet for rollen: den siger nu hvad der springes
  over (kontroller og automatik i de normale trin — lagertræk, afbestilling af bud) og
  at skiftet noteres i historikken med brugerens navn.
- **Historikken markerer det.** `was_forced` lå allerede i `changelog.payload`, men blev
  ikke vist nogen steder — et forceret skift så ud præcis som et almindeligt. Nu står der
  et dæmpet `OVERSTYRET` på entryen. Uden det ville advarslens løfte kun være halvt sandt,
  og netop dét mærke er hvad man leder efter når man bagefter spørger hvorfor lagertrækket
  ikke skete.

> ⚠️ **T_BON kunne ikke køre — brudt af auth-gaten (#316), ikke af denne ændring**
> (efterprøvet mod `git stash`: samme 401 på baseline). Runneren lavede rå `fetch` uden
> session, så den døde i preflight. Den logger nu ind som køkken-rollen; force-casene
> laver stadig deres egne logins, fordi de netop skal skelne roller. Samme efterslæb som
> CLAUDE.md's deploy-afsnit beskriver — flere runnere kan have det.

**Tests:** T_BON 25/25 (FORCE_01–07 alle PASS, ingen SKIP). FORCE_02 er vendt fra
"non-admin afvises" til "non-admin kan, og auditsporet peger på hende"; FORCE_03 tester
nu det den hele tiden burde: at `body.user_id` ikke kan skrive en anden bruger i
historikken. **Mutations-testet** — genindføres admin-kravet, falder FORCE_02+03; lader
man `body.user_id` vinde i auditsporet, falder FORCE_03. Den anden mutation er den
interessante: med det gamle 403-svar var D-3 aldrig reelt efterprøvet, fordi afvisningen
skjulte audit-hullet. Regression grøn: T_BON_DRAWER_CORE 61/61, T_BONS_LIST 77/78·1 SKIP,
moms-audit + bon_lines + dato 36/36. Browser-verificeret som **kitchen-rolle** (ikke
admin) på bon 4004: advarsel → bekræft → AFSLUTTET, `changelog.user_id = 2` med
`was_forced: true`, og `OVERSTYRET` synligt i historikken.


### AFLYST var en status man ikke kunne se eller vælge (27. august 2026)

Opfølgning på ovenstående. Kontoret spurgte om AFLYST var det samme som AFSLUTTET.
Det er det ikke — og forvekslingen er dyr: en aflyst ordre holdes ude af omsætning,
workload og kapacitet (`EXCLUDE_CANCELLED_SQL`), mens en afsluttet **tæller med**.
Sætter man en aflyst bon til AFSLUTTET, flytter man den ind i regnskabet.

Grunden til at nogen ville gøre det: `aflyst` stod ikke i `BON_CONFIG.statuses`
(bevidst — den er ikke et trin i sekvensen). Men drawerens status-bar bygges af
netop den liste, så tre ting fulgte:

1. **Aflysning kunne kun ske gennem knappen der hed "Slet bon"** — to-trins, hvor
   første tryk aflyser og andet sletter permanent. Navnet lovede kun det ene, og
   det farligste. Knappen hedder nu **"Aflys bon"** / **"Slet permanent"** efter
   hvad et tryk faktisk gør, med tooltip der siger konsekvensen.
2. **En aflyst bon viste INGEN aktiv status** — `curStatus = 'aflyst'` matchede
   ingen knap, så bonen så statusløs ud i draweren.
3. **Kalenderen havde måttet holde sin egen kopi** af label og farve for at kunne
   filtrere på den. Den er fjernet; farven bor ét sted nu.

- `aflyst` er tilføjet med **grå** `#8a8a8a`, ikke DB'ens røde `#bc181b`: rød er
  allerede AFSLUTTET, og grå siger "ude af spil".
- Nyt felt **`cardButton: false`**: statussen har label og farve, men vises ikke som
  knap på bon-kortet i views der ellers viser alle statusser. Køkkenkortene skal
  ikke have et aflys-klik ved siden af KLAR. Det er skrevet som en **undtagelse**,
  ikke en hvidliste, så en ny status fortsat dukker op af sig selv.
  (I dag rammer `'all'`-fallbacken ingen kort — kun `kitchen-today`/`kitchen-later`
  bruger `createCard`, og begge har eksplicitte lister. Flaget er et værn fremad.)
- `BON_CONFIG.sequence` er urørt: aflyst er ikke et trin frem. Feltet bruges i
  øvrigt ikke af noget i dag.

> ⚠️ **`status_transitions.requires_confirmation` er dødt i frontenden.** Feltet er
> udfyldt i seed for alle → AFLYST, men **ingen** frontend læser det: serveren
> returnerer det først i svaret, altså efter skiftet er sket. En rå AFLYST-knap ville
> derfor være ét klik uden varsel, hvor "Slet bon" i dag spørger. `_setStatus` har
> fået en eksplicit bekræftelse for `aflyst` med samme ord som slet-vejen. At vække
> feltet til live ville aktivere ~10 sovende bekræftelser på én gang og hører til sin
> egen opgave.

**Verificeret** som køkken-rolle mod testserveren: AFLYST står sidst i drawerens
status-bar, bekræftelsen kommer, statussen bliver aktiv (bugfix 2), og slet-knappen
skifter til "Slet permanent" uden genindlæsning. `buildStatusBar` kaldt direkte med
`view: 'all'` giver alle statusser **uden** AFLYST — **mutations-testet**: fjernes
`cardButton`, dukker den op. Kalenderens filterbar er uændret (samme knap, samme
`#8a8a8a`), nu fra ét sted. Regression: T_BON 25/25, drawer 61/61, bons-list
77/78·1 SKIP.

> Browser-panelet frøs undervejs (viewport 0×0 — se memory `project_browser_panel_freezes`),
> så klikkene er sendt gennem de ægte lyttere frem for som fysiske museklik. Layout er
> derfor ikke efterprøvet visuelt; adfærd og markup er.

**Efterspil samme dag: knappen lærte det ikke.** Fra en terminal status gav "Aflys bon"
en blank `Transition AFSLUTTET → AFLYST er ikke tilladt` uden tilbud om at overstyre —
mens AFLYST i status-baren virkede. `_handleDelete` kaldte `patchBonStatus` **direkte**
og havde hverken bekræftelse eller force-gren; kun `_setStatus` fik dem. To veje til
samme handling, hvor den ene lærte det nye. Knappen delegerer nu til `_setStatus('aflyst')`,
så de deler kode og ikke kan skride fra hinanden igen — samme lære som `_tOpenQuote`
vs. `_tCopyBon` (#428).

`_setStatus` returnerer nu `true`/`false`. Uden det kunne kalderen ikke skelne "aflyst"
fra "brugeren sagde nej i override-dialogen", og ville have nulstillet `dirty` på en bon
der aldrig blev aflyst.

Draweren **lukker ikke længere** efter aflysning fra knappen (det gjorde den før):
aflysning er ikke en fjernelse, AFLYST er nu synlig i status-baren, og "Slet permanent"
står klar hvis den skal væk helt. At blive er også det samme som status-bar-vejen gør.

Verificeret på en BETALT bon: aflys-bekræftelse → override-dialog → AFLYST, knappen
skifter til "Slet permanent", draweren bliver. Nej til override og nej til aflysning
lader begge bonen stå på BETALT uden fejlbesked. "Slet permanent" sletter stadig
(`GET /api/bons/4008` → 404 bagefter). En udløbet session giver "Ikke logget ind" i
stedet for override-tilbuddet, hvilket er rigtigt: uden bruger er der intet auditspor.

### Rest-prep: to prep-bons på samme event-dag tælles ikke længere dobbelt (27. august 2026)
> Spec: `docs/CLAUDE_EVENT.md §19`. Migration 166.

Køkkenet kunne ikke se hvor meget der skulle laves til Ungdommens folkemøde: der lå **to**
prep-bons på hver dag — broens forudbestillinger (B4166, vokser ved hver ordre) og office'
egen fra forecasten (B4147). Forecasten ER dagens total og indeholder de forudbestilte,
men det stod kun som fritekst i broens køkkeninfo: *"indgår disse i den (lav dem ikke oveni)"*.

Det var ikke kun forvirring. Målt i drift 2. sep: forecast 400, forudbestilt 332,
registreret produktion **732**. Fire konsekvenser, hvoraf den første er den alvorlige:

1. **HQ-lageret ville blive trukket dobbelt.** Let-event prep-bons er undtaget §5-gaten og
   trækker uanset det globale flag ([db/helpers.js](db/helpers.js) `autoConsumeBonInventory`).
   Begge bons på LEVERET = råvarer for 732 ud af huset, mens der forlod huset 400. Fejlen
   dukker først op ved næste optælling som en uforklarlig difference.
2. `computeTopupSuggestion` + `computeReturnSuggestion` summerer alt prep → retur ville
   bogføre 332 for meget tilbage på HQ.
3. Ugeoversigt og kapacitet: 732 enh onsdag → falsk "Understaffed".
4. Køkkenet så to kort og skulle selv regne.

Samme fejlklasse som #305/#319 (memory `project_silent_sideeffect_failures`): to systemer
er uenige, og uenigheden er usynlig.

**Reglen** (Leif): `mål = max(forecast, forudbestilt)` pr. kategori pr. dag; office' bon
holder **resten** op til målet. `max()` er *"forecasten styrer, med mindre den bliver
overhalet af de faktiske ordrer"* — så behøver forecasten aldrig blive rettet bag ryggen på
nogen. Pr. dag og ikke på summen: ellers kunne en presset dag blive udlignet af en rolig.

**Den genberegnes frem for at blive rettet i hånden**, fordi forudbestillinger kan komme ind
helt frem til bestillingsfristen (30. aug for eventet 2.–3. sep). Der findes ikke noget godt
tidspunkt at rette på: for tidligt bliver forkert igen, for sent efterlader køkkenet uden
grundlag. Tre triggere: broens prep-push · `PUT /:id/forecast` · oprettelse/toggle.

**Værn:**
- **Opt-in pr. bon** (`bons.event_prep_auto_rest`) — en bon office har sammensat i hånden må
  ikke pludselig flytte sig. Fluebenet vises kun når dagen faktisk har forudbestillinger.
- **Frysen** stopper genberegningen når bonnen forlader `NY`/`GODKENDT` eller har trukket
  lager. Listen spejler broens `BRIDGE_ROLES.prep.reconcile` med vilje — gik de fra hinanden,
  kunne broen opdatere SIN bon på en dag hvor resten er frosset. Derefter er nye ordrer en top-up.
- **Kun kategorier med et mål røres** (`Tilbehør & Bokse` står urørt), og vi opfinder aldrig
  produkter — mangler der linjer i en kategori med et mål, rapporteres det.
- **Mixet bevares proportionalt**: det er office' valg af hvad der laves ekstra og må ikke
  overskrives af hvad kunderne tilfældigvis har bestilt.
- **Én rest-bon pr. (event, dag)** (partielt unique-indeks) — to ville trække hinanden fra.
- **En fejlet genberegning må aldrig koste kundens ordre**: broen kalder i try/catch og
  rapporterer fejlen i svaret. Samme princip som `goodsReceiptWebhook`.

**Rest = 0**: bonnen bliver **stående** med linjer på 0 og teksten *"⟳ 0 — hele dagens mål er
forudbestilt. Det er B4166 I skal lave efter."* Beslutning (Leif): *"de har set på 2 bonner i
lang tid, så det vil nok være mærkeligt hvis den pludselig forsvandt."* Automatisk aflysning
ville også være en destruktiv bivirkning af at en kunde bestilte. 0-mængde-linjer skjules på
køkkenkortet (`mapApiBonToCardData`) — de er ikke arbejde, og der findes **nul** 0-linjer i
driftshistorikken, så filteret kan ikke skjule noget der plejede at være synligt.

**Den oprindelige forecast bevares** (`event_forecast.original_qty`). Forecasten korrigeres
løbende; uden feltet gik "hvad gættede vi egentlig på?" tabt i samme øjeblik tallet blev
rettet. `PUT /forecast` sletter og genindsætter alt, så værdien bæres eksplicit med over.
**NULL = aldrig korrigeret** — eksisterende rækker backfilles bevidst ikke; vi ved ikke om de
er rettet, og et gæt ville se ud som en måling.

**Synligt for office:** forecast-tabellen viser `🔗 332 forudbestilt · 400 preppet · mål 400`
pr. dag, og `⚠ 732 preppet mod mål 400 — 332 for meget · ⟳ Ret B4147` når det er skredet —
**handlingen ligger i advarslen**, ikke kun i bon-listen langt nede på siden. Er der flere
office-prep-bons på dagen, gætter vi ikke hvilken der skal holde resten, men henviser til listen. Advarslen bygger
kun på SQL, ikke på Grocy — derfor falder tabellen nu tilbage på de kategorier der allerede
står på eventet når Grocy er nede; før forsvandt hele tabellen, og dermed advarslen, præcis
når man ikke kunne se hvorfor. Bon-listen mærker rollerne og har en `⟳ Hold resten`-knap på
en prep-bon der ikke er koblet (vises kun når den kan virke).

**Tests:** `npm run test:event-rest-prep` (59) + `test:event-rest-prep-http` (36) — den første
kører også den ÆGTE `/webhook/event-prep`-route med Grocy stubbet i require-cachen, så
bro-triggeren er efterprøvet og ikke bare inspiceret. **Mutations-testet:** 12 mutationer
(syv kerneregler + fem wiring-punkter) rulles hver især tilbage og fælder hver sin navngivne
assert; to af dem producerer drifts-tallet 732 igen. Regression grøn: event-bridge-prep 69
(inkl. "broen må ALDRIG røre en prep-bon office selv har lavet" — den holder, fordi rest-prep
er opt-in), event-menu 42, event-contact 26, event-labor 101, topup 35, prep-covers 33,
retur-trace 40, event-cancelled 26, event-polish 27, event-gate 15, prep-packing 12.
Browser-verificeret ende-til-ende mod syntetisk event i dev-DB; testdata ryddet.

> ⚠️ **Drift 2.–3. september:** B4147 og B4148 står stadig med hele forecasten. Slå
> `⟳ Hold resten` til på dem efter deploy — så retter de sig selv frem mod
> bestillingsfristen 30. august. Sker det ikke, skal de rettes ned i hånden **efter**
> den 30., før de sættes til LEVERET; ellers trækkes HQ-lageret for meget.

### Pakkeliste på tavlen — event i Bon ↔ arrangement i Whiteboard (27.–28. august 2026)
> bon-v2 [#563](https://github.com/liffez/bon-v2/pull/563) · whiteboard #25, #27, #28.
> Tavlens side er dokumenteret i `whiteboard/CLAUDE_arrangementer.md`.

Et event har to sider, og de ligger i hver sin app: **varerne** her (prep-bon, salg,
retur, lager, P&L — §5 i `CLAUDE_EVENT.md`) og **driften** på tavlen, hvor det hedder et
**arrangement** ("event" er optaget dér til CCP-hændelser). Tavlen kunne allerede klone en
pakke-skabelon til et arrangement; det der manglede, var at de to vidste om hinanden.

Navn, datoer og en reference tilbage står allerede i eventet. At skrive dem af i hånden på
tavlen var dobbeltarbejde — og en oplagt kilde til datoer der ikke stemte mellem
systemerne.

- **📋 Pakkeliste på tavlen** i event-hovedet åbner tavlens "Nyt arrangement" udfyldt:
  `<tavle>/?open=arrangement&name=&start=&end=&ref=`. Samme mønster som det eksisterende
  `?open=varemodtagelse`. Adressen kommer fra `/api/sidekick/config`
  (`WHITEBOARD_BASE_URL`); er den ikke sat, skjules knappen.
- **Skabelonvalget sendes bevidst ikke med.** Hvilket grej der skal med denne gang er det
  menneskelige valg — og det eneste Bon ikke kan vide.
- **`?event=N` åbner et event direkte.** Fandtes ikke før; alle events delte
  `?view=events`, så tavlens link kunne kun lande på listen. `_evGoto()` i
  [office/views/events.js](office/views/events.js) ejer nu både `_evCurrentId` og URL'en
  ét sted — holdes de adskilt, driver de fra hinanden, og et kopieret link peger et andet
  sted hen end skærmen viser.
- `ref` sendes som **URL**, ikke som navn: tavlen linker en URL direkte til målet, mens et
  navn kun kan blive til et opslag i Events-listen.

> **Hvorfor ingen API-kobling mellem apperne.** Brugeren ER transporten: hun klikker, ser
> tavlens dialog, og trykker selv opret. Derfor intet delt secret, ingen nginx-undtagelse,
> ingen ny migration — og ingen bivirkning der kan lykkes eller fejle bag ryggen på nogen.
> Det er præcis den fejlklasse der bed os i #305 og #319. Prisen er at Bon ikke får at vide
> at arrangementet blev oprettet, så knappen ser ens ud hver gang. Ved ~9 events om året er
> det til at leve med; vil vi have status, kan et rigtigt kald lægges ovenpå senere.

**På tavlens side** (kort, se dens egen CLAUDE-fil for detaljer): `PATCH
/api/arrangements/:id` tager nu også `name`/`event_start`/`event_end`/`bon_event_ref`, så
et forkert link kan rettes bagefter (**✎ Redigér**) i stedet for at være støbt fast — og
`scripts/link-arrangements-to-bon.js` koblede de gamle arrangementer, der kun bar et navn.
Det script **matcher på startdato, ikke navn**: navnene er menneskeskrevne og stemmer ikke
("Vig festival 2026" mod "Vig Festival", "Kultursalonerne gisselfeld" mod "Gisselfelt").

> ⚠️ **Tavlens database må aldrig skrives direkte mens dens server kører.** Whiteboard
> bruger sql.js — databasen ligger i hukommelsen og gemmes til fil ved ændringer, så en
> fil-skrivning bliver overskrevet ved næste gemning. Skriv gennem
> `http://localhost:3847/api/...` fra serveren selv (nginx-gaten rammer kun udefra); det
> validerer også og logger til `item_log`. At LÆSE filen er fint.

**Konvention:** et arrangements `event_start` er eventets **første dag** — ikke pakkedagen.
Pakning udtrykkes som `day_offset = -1` på opgaven. (De syv seedede skabeloner har alle
`day_offset = NULL`, altså udaterede tjekliste-opgaver, så en ændret arrangement-dato river
ikke forfaldsdatoer skæve.)

**Bevidst udeladt:** Bon viser ikke om der findes et arrangement på tavlen. Det kræver at
Bon spørger tavlen — altså den API-kobling der er valgt fra ovenfor.
### Forhandler-ordrer: hvem betaler, og hvem er maden til? (27. august 2026)

> **Ordet i UI'et er "Formidler" siden 15. september 2026** (Firma 360°, bekræftelser,
> ejer-mail, changelog-noter). Able videresælger ikke maden — de bestiller den på vegne
> af deres kunder — og "forhandler" fik kontoret til at tro at hver slutkunde skulle
> have sin egen firma-række. Kolonnen hedder stadig `is_reseller`; kun teksten er ny.
> Slutkunden får IKKE sin egen firma-række; navnet hører til på bonnen.
>
> **`npm run backfill:able-slutkunde`** skriver slutkunden på de Able-bons der er ældre
> end feltet, ud fra en liste et menneske har læst (17 bons: Lundbeckfonden, Worksome,
> BLS Capital, Scalepoint, Dignity, Per Aarsleff, Bigum, TBWA …). 43 bons uden et tydeligt
> spor røres ikke — fri tekst afgøres ikke af et regex. Dry-run default, `--apply` tager
> backup, idempotent. Kørt mod en kopi af driftsdata 15. september: 17 skrevet, anden
> kørsel 0.

Able er et frokostbestillings-firma. De lægger ordren ind på **vores egen**
bestillingsformular for deres kunder — og skriver slutkundens navn i formularens
**Firma-felt**, fordi der ikke er noget andet felt at skrive det i.

Webhooken matcher firma på **eksakt navn** og opretter en ny firma-række når navnet
ikke findes. Hver skrivemåde blev derfor sit eget firma: `Systematic / able`,
`Systematic  (Able)` (dobbelt mellemrum — en anden streng), `Cisco / able`,
`Brunata / able`, `able ApS` … **otte rækker** i drift. Bonnen landede på den række,
og så fulgte hverken e-conomic-kundenummeret (733), omsætningen eller den stående
rabat med — de sidder på Able.

Kunden blev derimod slået op på **email**, så `care@able.dk` ramte altid den rigtige
person. Resultatet var en bon med **Ables medarbejder som kunde og en skraldespand
som firma**.

- **Migration 167**: `companies.is_reseller` + `bons.end_customer_name` (+ partielt
  indeks). Ingen bagudfyldning: vi kan ikke vide hvilke gamle bons der havde en
  slutkunde, og et gæt ud fra fri tekst i `customer_wishes` ville være netop den
  slags data ingen bagefter kan skelne fra noget nogen har skrevet.
- **Webhooken** slår nu bestilleren op FØR firmaet afgøres. Er bestillerens eget
  firma markeret som forhandler, lander bonnen på **forhandleren**, og det tastede
  navn gemmes som slutkunde. Kender vi ikke bestilleren (ny medarbejder), falder vi
  tilbage til den gamle adfærd — vi gætter ikke på hvem der er forhandler ud fra et
  navn nogen har tastet. Changelog-linjen forklarer hvorfor bonnen ikke ligger på
  det navn der blev skrevet.
- **EAN skrives ikke på en forhandlers firma-række.** Et EAN i en forhandler-ordre
  hører til slutkunden; skrev vi det på Able, ville deres næste faktura gå til en
  fremmed EAN-modtager.

> ⚠️ **Routingen er en forudsætning for rabatten, ikke et pyntearbejde.**
> Triggeren `bons_seed_standing_discount` (migration 111) læser `discount_percent`
> fra **det firma bonnen ligger på**. Så længe bonnen landede på `Systematic / able`
> (rabat 0), kunne Ables 12,5 % ikke virke — uanset hvad der stod på Able-rækken.

**Rabatten var bygget, men usynlig.** `companies.discount_percent` har eksisteret
siden 001, triggeren siden 111, og `recalcBonTotal` + e-conomic-adapteren har hele
tiden regnet med den. Men **0 af 1.448 firmaer havde den sat**, og ordet "rabat"
fandtes ikke i én eneste skærm uden for tilbuds-wizarden. Sat via SQL ville bons
bare være 12,5 % billigere uden at nogen kunne se hvorfor — samme fejlklasse som
memory'ens `silent_sideeffect_failures`.

- **Firma 360° → Stamdata** har nu **Rabat** (dansk komma, `12,5 %`) og
  **Forhandler** (afkrydsning med forklaring + bekræftelse ved tilslag).
- **`PATCH /api/companies/:id/commercial`** — egen route frem for `/identifiers`,
  fordi de to felter ikke er identifikation men handelsvilkår. Afviser < 0 og ≥ 100:
  100 % er ikke en rabat, og et negativt tal ville lægge TIL fakturaen.
- **Bon-draweren** viser `Rabat 12,5 %` + `Bonens total (inkl. moms)` under
  linjesummen. Beløbet opfindes bevidst **ikke**: serveren regner rabatten af
  linjesum PLUS levering, og hvornår levering tælles med afhænger af en regel der
  bor på serveren. Vi viser satsen (et faktum) og serverens egen total (et andet).
- **Faktureringen** viser rabatlinjen med beløb — dér ER summen kun varelinjerne,
  og e-conomic trækker satsen pr. linje. Samtidig regner **KPI'en og listen** efter
  rabat; ellers stod der 520 kr to steder og 455 kr et tredje.

**Slutkunden kan findes.** Feltet er med i bon-listens søgeudtryk (bonnen ligger jo
på Able — hverken kunde- eller firmanavn indeholder "Systematic"), som valgfri
kolonne (**default fra** — den er kun udfyldt på forhandler-ordrer), og inline i
Firma-kolonnen som `Able → Systematic`. Vises også på bon-kortet (`Til: …`, altid —
også i today-context hvor adressen er foldet væk, for ordren afhentes ofte), i
info-modalen, i bon-draweren, på mobilen og i faktureringen.

> **Hvorfor tekst og ikke en FK til `companies`:** formularen giver os en streng, og
> et FK ville kræve at nogen manuelt koblede hver bon. Teksten er nok til at søge og
> filtrere på fra dag ét. Skal der senere aggregeres rigtig omsætning pr. slutkunde,
> lægges en kobling ved siden af — samme mønster som indbakkens
> `parsed_email` → kontaktpunkt.

**Tests**: `npm run test:forhandler` — 22 asserts mod de ægte endpoints over HTTP,
med skemaet bygget af de rigtige migrations i `:memory:`. **Mutations-testet:** syv
kerneregler rulles hver især tilbage og fælder navngivne asserts (forhandler-routing
8, slutkunde-navnet 2, EAN-værnet 1, eget-navn-checket 1, søgefeltet 1,
rabat-valideringen 1, `createBon`-feltet 2). Kontrolprøven `uden forhandler-markering
ville rabatten IKKE ramme` er selve pointen skrevet som en test. Regression grøn:
quote_convert 10, moms_audit 18, bon_lines 10, auto_fees 18, crm_companies 8,
migrate 6, fakturering-render 18, economic-invoice 103, web-order-lines 12.
Browser-verificeret ende-til-ende på en tom dev-DB: web-ordre → bon på Able med
slutkunde + 12,5 % rabat + ingen ny firma-række, kort, drawer, liste, søgning,
info-modal, mobil og fakturering. Kontrolprøve med en almindelig kunde: uændret.
Testdata ryddet.

> **Deploy — rækkefølgen betyder noget.** Migrationen er inert indtil nogen sætter
> flaget: `is_reseller` defaulter til 0, så alle 1.448 firmaer opfører sig præcis som
> før. Efter deploy: markér Able som forhandler og sæt 12,5 % i Firma 360°. Rabatten
> **snapshottes ved oprettelsen** — den rammer kun bons oprettet derefter, aldrig de
> eksisterende. De otte gamle `able`-rækker er ikke ryddet op her; det er data, ikke
> kode, og hører til stamdata-værktøjerne (`npm run audit:dubletter`).

**Efterspil fra første drifttest (28. august).** Fire ting kom retur:

- **Blyanten på et tomt stamdata-felt var usynlig** (`opacity: 0` indtil hover).
  For CVR og EAN går det, fordi der som regel står en værdi man sigter efter —
  men en ny `Rabat —`-række så ud som om den manglede en knap, så flaget blev
  sat og rabatten kunne ikke findes. Tomme rækker viser nu blyanten dæmpet, og
  hele rækken kan klikkes. Gælder alle de redigerbare felter.
- **Redigerings-rækken skød ud over kortet.** `.f3-edit-wrap` manglede
  `min-width: 0`; en flex-item har `min-width: auto` og kan derfor ikke krympe
  under sit indholds min-bredde. Målt: kortet slutter ved 626 px, wrap'en endte
  ved 668, og "Annullér" blev klippet af. Pre-eksisterende, men først synligt da
  rabat-feltet gav en grund til at åbne editoren.
- **Bon-statusser var farveløse i Firma 360° og Kunde 360°** — hardkodet
  `#e6eef3` og `#f0f0f0` i stedet for BON_CONFIG. Samme fejl som blev rettet i
  ugeoversigt/web-ordrer/kalender 19. maj; de to 360°-skærme blev overset.
  Ny `statusBadgeHtml(code, opts)` i `shared/utils.js` er nu ét sted at hente
  farve + etiket, med grå fallback hvis BonConfig ikke er loadet.
- **`scripts/merge-reseller-junk-companies.js`** rydder op i de rækker der nåede
  at blive oprettet før migrationen. **Ikke** en almindelig sammenlægning:
  rækkens NAVN er den eneste oplysning om hvem slutkunden var, så navnet skrives
  over i `bons.end_customer_name` FØR bonnen flyttes. Rækkerne udpeges én ad
  gangen med `expect_name` som spærre — en søgning på "able" fanger også
  **`A Table Story ApS`** (CVR 44129485), som intet har med Able at gøre.
  Per Aarsleff (3652/3654) og Brunata (3703) bærer ægte CVR og kontaktpunkter og
  har 0 bons; de skal **omdøbes**, ikke slettes, og det er et menneskes
  beslutning. Dry-run default, `VACUUM INTO`-backup, transaktion der ruller
  tilbage hvis antal bons eller omsætning flytter sig, idempotent.

  Kørt mod en kopi af driftsdata: Able 58 → **62 bons**, `Cisco` og `Systematic`
  bevaret som slutkunder, ni able-agtige rækker → fem aktive (Able + de fire vi
  bevidst ikke rører). B4194 (16.435 kr, VENTER) lå på en række uden
  e-conomic-nummer og kunne ikke faktureres — den kan den nu.

  **Slutkunden får ikke sin egen firma-række.** Systematic har kun handlet
  gennem Able og er derfor ikke kunde hos os; navnet hører til på bonnen.
  Cisco HAR handlet direkte, men findes allerede tre gange (CVR 20456493) —
  en omdøbning ville give den fjerde. `rename_to` findes i planen til den dag
  en slutkunde viser sig at handle direkte og ikke findes i forvejen.

- **CRM → Værktøjer → "Ryd tomme firmaer"** (`office/views/crm-verktoj.js`,
  ved siden af sammenlægnings-guiden, admin-only). Tre grupper, afkrydsning,
  søgning og "Læg de valgte væk". Rækkerne **deaktiveres**, slettes aldrig.

  > ⚠️ **`POST /empty-companies/deactivate` gentjekker HVERT id mod reglen.**
  > Listen i browseren kan være timer gammel, og i mellemtiden kan en bon være
  > landet på rækken — fx fordi nogen tastede firmanavnet i bestillingsformularen.
  > Rækker der ikke længere er tomme springes over og **rapporteres tilbage**;
  > ellers ville der stå "42 lagt væk" på en liste hvor man valgte 43.
  > Efterprøvet: bon lagt på kandidaten mellem hentning og POST →
  > `{deactivated: 1, skipped: 1}`, og rækken forbliver aktiv.

  Reglen bor i **`services/companyCleanup.js`** og deles af siden og scriptet.
  To kopier ville skride fra hinanden, og så ville siden vise noget andet end
  kommandolinjen fjerner.

- **`scripts/audit-empty-companies.js`** — den generelle regel fra drift: en
  firma-række beholdes hvis der er **en bon, en kontaktperson eller en mail**
  på den. Ellers er den et artefakt fra formularens fri-tekst-felt eller fra
  v1-importen (de fire Per Aarsleff-rækker er oprettet i samme sekund,
  2026-04-08 11:16:29, og har ingen af delene). Fire værn oveni: e-conomic-nr,
  `is_internal`, påmindelser og fremmednøgler fra events/kampagner/booking-tokens.
  Rækker **deaktiveres**, slettes aldrig — en changelog-linje kan pege på dem år
  efter. Dry-run default, `VACUUM INTO`-backup, transaktion der ruller tilbage
  hvis antal bons flytter sig.

  > ⚠️ **`rfm_scores` er bevidst IKKE et værn.** Tabellen er beregnet og har en
  > række for stort set hvert firma (1.346 af 1.452 i drift). Bruges den som
  > bevis på en relation, freder den alt: 377 kandidater → 0. Fanget under
  > afprøvning, hvor scriptet meldte "intet at rydde op" på et kartotek hvor
  > hver tredje række var tom.

  Rapporten viser også hvad der blev **fredet** og hvorfor (`37 med
  e-conomic-nummer · 3 med en note`). Et værktøj der kun viser hvad der ryger,
  er svært at stole på — man kan ikke se om reglen greb for bredt.

  Målt mod driftsdata: **1.361 → 987 aktive firmaer** (374 deaktiveret, 240 af
  dem med CVR fra berigelse). 0 bons rørt, 0 bons efterladt på en inaktiv række.
  Kør forhandler-oprydningen FØRST — ellers står dens fire rækker stadig med
  bons og bliver fredet.

  Rapporten grupperer i tre — **dubletter af et firma der handler** (kan lægges
  væk uden videre), **har CVR men ingen tvilling med bons** (ægte organisationer
  der aldrig blev til en ordre), og **uden CVR og uden spor** (noter og
  engangstekster tastet i formularens firma-felt: `Barnedåb`, `Zoo kort dag prep`,
  `ff`). `--csv` skriver hele listen til en fil med en tom `beslutning`-kolonne;
  374 linjer i en terminal kan ikke gennemgås, og en liste man ikke kan gennemgå
  bliver enten kørt i blinde eller slet ikke.

  Rapporten markerer hver kandidat der er **dublet af et aktivt firma med bons**
  (samme CVR). Det er den mest brugbare oplysning når 374 navne skal skimmes:
  `Akademisk Arkitektforening` ser ud som en rigtig kunde man ikke må røre —
  indtil man ser at `Arkitektforeningen` (samme CVR 62572310) står med 112 bons
  ved siden af. 106 af de 374 er sådan nogen.

  > ⚠️ **Skriv `firma #2490`, ikke `#2490`.** Bon-numre ser ud som `cafe-2490`
  > og `B4224`, så et bart `#2490` i en terminal læses som en bon. Det skete i
  > drift: listens `#2490 Akademisk Arkitektforening` blev slået op som bonnen
  > `cafe-2490`, som ligger på et helt andet firma (Danner, #2548) — og så ser
  > oprydningen ud til at ville fjerne et firma der handler.

  > Tre referencer blev fundet FØR første kørsel i drift, ikke bagefter:
  > `attachments` og `crm_custom_values` (begge `entity_type='company'`) er tomme
  > i dag, men referencerne findes — værnet skal være der før nogen begynder at
  > bruge dem. Og `companies.notes`: tre rækker bar en note. Alle tre viste sig
  > at være EAN-merge-stubbe (`--- Tidligere navne (EAN-merge) ---`), men reglen
  > freder dem alligevel og siger det højt, frem for at bygge en heuristik der
  > skal kende forskel på maskinens tekst og menneskets.

**Bredere fund — løst 14. september 2026 (se næste afsnit):** af 114 web-bestillinger
i drift lå **39** på et andet firma end kundens eget — `University of Copenhagen` mod
`Københavns Universitet`, `ATV` mod `Akademiet for de tekniske videnskaber`, `Stromma`
mod `Stromma Danmark A/S`. Fri tekst i et firma-felt er en dubletmaskine: 246 firmaer i
basen havde hverken CVR, EAN, kundenummer eller mere end én bon. Forhandler-reglen
rørte kun de firmaer der er markeret; den generelle sag var
[#567](https://github.com/liffez/bon-v2/issues/567) + [#607](https://github.com/liffez/bon-v2/issues/607).

### Web-bestillingens firma: kendt bestiller beholder sit firma, resten matches (#567 + #607, 14. september 2026)

Begge indgange fra bestillingsformularen — `routes/web-orders.js` (den nye) og
`routes/webhooks.js` (den gamle f-felt-formular) — slog firmaet op på **eksakt
navn** og oprettede en ny række når strengen ikke ramte tegn for tegn. Kunden blev
derimod slået op på e-mail og ramte altid rigtigt, så bonnen lå på ét firma og
kunden på et andet. "Landbrug & Fødevarer" fandtes **13 gange**, flere af dem som
det bogstavelige `LANDBRUG &amp; FØDEVARER` — et `&` blev escapet på vej ind og
gemt sådan, hvilket garanterede at navnematchet aldrig fandt den rigtige række.

**Reglen bor ét sted:** `services/orderCompanyResolver.js` (`resolveOrderCompany`),
kaldt af begge ruter. Forhandler-undtagelsen (migration 167) landede i sin tid kun i
den ene rute, fordi de havde hver sin kopi. Rækkefølgen (beslutning, Leif, 13. sep.):

| # | Betingelse | Udfald |
|---|---|---|
| 1 | bestillerens eget firma er en **forhandler** (`is_reseller`) | bonnen på forhandleren, det tastede navn = `end_customer_name` (uændret fra 167) |
| 2 | **kender vi bestilleren** (e-mail) og har hun et *aktivt* firma | **behold det.** Ingen ny række. Det tastede navn gemmes som `Firma: X` i kundeønskerne + i changelog'en |
| 3 | ellers | `matchCompany` (CVR → EAN → e-mail → navnelighed ≥ 85 %) — kun aktive firmaer. Rammer det en forhandler, gælder 1 |
| 4 | intet match | **ny række** — med afkodet navn, og changelog siger `nyt firma oprettet: X` |

- **HTML-entiteter afkodes FØR alt andet** (`decodeEntities`: navngivne inkl.
  `&aelig;`/`&oslash;`/`&aring;`, numeriske, og to lag for `&amp;amp;`).
  `normalizeName()` redder det ikke: den fjerner ikke-alfanumeriske tegn, så
  `&amp;` bliver tokenet `amp`, der overlever normaliseringen. Et escapet navn
  gemmes aldrig — hverken i `companies`, `web_orders.company` eller som slutkunde.
- **CVR og EAN trækkes ud af faktura-teksten.** EAN = 13 cifre (som før). CVR =
  8 cifre **kun med "CVR" foran** (`CVR 25529529`, `cvr-nr.: …`, `CVR DK…`) — et
  nøgent 8-cifret tal i et fritekstfelt er lige så tit et telefonnummer.
  Formularen har intet CVR-felt; kommer der ét (`data.cvr`), vinder det over teksten.
- **Ingen by som tiebreaker.** Leveringsadressen er ikke firmaets adresse, og
  matcheren ville diskvalificere et firma i Frederiksberg der får leveret i København.
- **`matchCompany` fik `{ activeOnly: true }`** (opt-in — berigelse og kampagner er
  uændrede). En række lagt væk af "Ryd tomme firmaer" må ikke få nye bons ved at
  ligne det tastede navn.
- **`similarity`'s delstreng-regel tæller nu kun hele ord.** `kable` og
  `sustainable foods` indeholder begge `able` og ville ellers score 0,95 mod
  forhandleren Able — og lægge en fremmed bon dér med "Kable ApS" som slutkunde.
  De 24 matcher-tests bruger allerede ord-grænser og er uændrede.
- **Synligt for office:** changelog-linjen på bonnen siger *hvorfor* den ligger hvor
  den ligger (`kunden skrev firma "X" — beholdt kundens firma Y`, `firma "X" matchet
  på navnelighed 90 % → Y`, `nyt firma oprettet: X`), og ejer-mailen viser både
  bonnens firma og `Kunden skrev: X`. Et forkert navnelighed-match skal kunne SES.
- Kendt risiko (fra #567): en person der reelt har skiftet arbejdsgiver bliver
  hængende på det gamle firma. `Firma: X`-noten er dét der gør det opdageligt;
  rettelsen er "Flyt til firma" i Kunde 360°.

**Tests**: `npm run test:web-order-firma` — 26 nye asserts mod de ægte endpoints
over HTTP (:memory:-DB af de rigtige migrations, begge indgange) + forhandler-
og matcher-suiterne. **Mutations-testet:** syv regler rulles hver især tilbage og
fælder navngivne asserts (kerneregel 1: 9 · afkodning: 3 · matcheren: 9 ·
forhandler: 5 · activeOnly: 1 · ord-grænse: 1 · CVR-præfiks: 1). Første udgave af
afkodnings-testen bestod af den forkerte grund — `Landbrug &amp; Fødevarer` matcher
også uden afkodning, fordi token-overlap ignorerer det ekstra `amp`; fixturen bruger nu
`Bager &amp; S&oslash;n`, hvor uafkodet giver 0,4. Regression grøn: web-order-lines
e2e 12, standing_discount, web_order_flag, forhandler 22, kampagner 124.

**Ikke gjort her:** de eksisterende dubletrækker retter ikke sig selv — det er #606
(oprydning), som nu kan køres uden at rodet vender tilbage. Og en kendt bestiller
UDEN firma får ikke automatisk det matchede/oprettede firma sat på sin kunde-række;
det er uændret fra før.

### CRM → Firmaer: "+ Nyt firma" (#612, 15. september 2026)

Et firma kunne kun opstå som biprodukt — via "+ Ny kunde" (som kræver en person der
måske ikke findes) eller via en bon med et ukendt firmanavn. Oprydningen i kartoteket
(#606, #599, #502, #504) kræver at man kan lave den *rigtige* række i hånden.

- **Knappen** ligger i Firmaer-fanens toolbar ([office/views/crm-firmaer.js](office/views/crm-firmaer.js)),
  formularen i `openModal`: ét CVR-felt der slår op på **både** nummer (8 cifre →
  `/api/cvr/:cvr`) og navn (`/api/cvr/search` → Virk ES som fallback, samme to kilder
  som `KundeSoeg.cvrSearchByName`), EAN, telefon, e-mail, DAWA-adresse og noter.
  Et CVR-hit udfylder navn/CVR/telefon/e-mail og lægger CVR-adressen i adressefeltet;
  et DAWA-valg vinder over den. Efter oprettelse åbnes Firma 360°.
- **"Findes allerede?" før oprettelse.** Nyt `GET /api/companies/match` kører
  `matchCompany` (CVR → EAN → e-mail → navnelighed, `activeOnly`) og svarer med navn,
  CVR, by og antal bons. Formularen viser det som en gul boks med **Åbn** / **Opret
  alligevel** — "opret alligevel" gælder kun for præcis dét match; rettes et felt,
  spørges der igen.
- **Serveren spærrer bevidst IKKE** på et CVR-sammenfald: afdelinger under samme
  juridiske enhed er separate firmaer (KU, kommunerne). Et sammenfald er et signal
  kontoret skal have set, ikke et forbud. Låst fast af en test.
- **`POST /api/companies` er hærdet** (gælder også KundeSoeg og Kunde 360°, som kalder
  det samme): `address_id` accepteres og valideres, CVR normaliseres til 8 cifre og EAN
  til 13 (ellers 400), e-mail og telefon lægges som **kontaktpunkter** (`manual`,
  privat, primær) via `ensureContactPoint`, og der skrives en changelog-linje.
  Kontaktpunkterne er ikke pynt: 053-triggerne fyrer kun ved UPDATE, så uden dem kunne
  et firma oprettet med e-mail hverken ses i Firma 360° eller matches på e-mail bagefter.

> ⚠️ `display:flex` på en boks overtrumfer `[hidden]`. "Findes allerede"-boksen stod som
> en tom gul bjælke under Noter indtil `.cf-new-match[hidden] { display: none }` — set i
> browseren, ikke af testen.

**EAN-opslag (samme dag, opfølgning).** Samme felt tager nu også **13 cifre**: nyt
`GET /api/cvr/ean/:ean` slår op i **NemHandelsregistret** (`nemhandelLookup`, som hidtil kun
blev brugt til batch-berigelse) og får den *registrerede enhed* + CVR — fx
`50570000 - KU-NS-SCIENCE-FAK (959)` · 29979812 — og henter derefter den juridiske enhed bag
CVR'et fra cvrapi ("Københavns Universitet"). EAN er den stærkeste nøgle for institutionerne,
netop dem der laver dubletter, og det er det tal kunden faktisk skriver på ordren.

- Hittet udfylder **navn = enheden** (afdelingen er firma-rækkens niveau — KU har mange),
  CVR, EAN og `legal_name` = den juridiske enhed. `POST /api/companies` tager nu `legal_name`.
- **Adressen fra cvrapi sendes bevidst ikke med** — den er hovedsædets (Nørregade 10), og en
  afdeling ligger sjældent dér. Adressen vælges med DAWA.
- Er cvrapi nede, kommer enheden og CVR stadig; `legal` er null. En ukendt EAN giver 404.
- Firmaer-listens søgefelt matcher nu også på EAN.
- `npm run test:ean-opslag` — 7 asserts; NemHandel og cvrapi stubbes med svar i registrenes
  egen form (HTML-fragmentet er klippet fra et live-svar 15/9), routen/parseren/søgningen rammes
  ægte. Mutations-testet (EAN ude af søgningen, cvrapi-fejl vælter routen, parseren mister CVR).
  Live: KU Science, KU Sund og et ukendt EAN svarer som forventet.

**Tests**: `npm run test:firma-opret` — 12 asserts mod de ægte endpoints over HTTP
(`:memory:` af de rigtige migrations). **Mutations-testet:** kontaktpunkter (fælder 2,
heraf e-mail-matchet — det er *derfor* de skal skrives), `activeOnly` (1), adresse-
validering (1), changelog (1). Regression grøn: forhandler 22, web-order-firma 26,
crm_companies 8, kunde-flyt 21, kampagne-import 23. Browser-verificeret ende-til-ende
mod en lokal dev-DB: lignende navn → "Findes allerede" → Åbn lander i Firma 360°;
CVR-søgning på "Ristet Rug" → hit udfylder felterne; DAWA-adresse valgt; oprettelse →
Firma 360° med adresse og to primære kontaktpunkter; DB-rækkerne efterprøvet og ryddet.

### Flyver: "Gå til bon" førte ingen steder hen (1. september 2026)

Knappen i flyver-modalen så død ud. To veje, begge stille:

**Kortet var på siden, men filtreret væk.** Et bon-kort forsvinder ikke fra DOM'en
når et filter er slået til — det får `display:none !important`
(`body:not(.show-lev) .bon-card[data-status="lev"]` m.fl. i `kitchen/today.html`).
`_gotoFlyverBon` fandt kortet med `getElementById`, scrollede til det og satte
highlight-klassen — alt sammen på noget usynligt. Det er den almindelige situation:
en flyver sendt om formiddagen ligger stadig i køen når bonen er leveret og
VIS LEVEREDE er slukket.

**Kortet var der slet ikke.** Fallbacken var
`window.location.href = '/kitchen/today.html#bon' + bonId`. Står man allerede på
`today.html`, er det kun et hash-skift — ingen navigation, ingen genindlæsning, og
`scrollToBonHash()` kaldes kun ved page load. Der skete bogstavelig talt ingenting.
Og hørte bonen til en anden dag, var today.html alligevel den forkerte side.

- **`kitchen/today.js` fik `window.revealBonCard(card)`** — den ejer filtrene, så den
  rydder dem: slukker `filter-igang`/`filter-klar`, tænder VIS LEVEREDE hvis kortet er
  leveret, opdaterer knappernes låse-tilstand og afbryder en igangværende leveret-fade.
  Fade-afbrydelsen er ikke kosmetik: uden `clearTimeout` ville 8-sekunders-timeren
  skjule kortet igen kort efter at man var hoppet til det.
- **`shared/flyver.js`** kalder den (via `typeof`, så sider uden filtre — fx Senere —
  er upåvirkede). Er kortet ikke på siden, afgør **leveringsdatoen** hvor man skal hen:
  i dag → I dag, senere → Senere. Køkkenet vil se *kortet*; draweren er en
  redigeringsflade og er derfor kun svaret i office (`zone-kitchen` skiller de to) eller
  når kortet ikke står nogen steder — en bon i fortiden, eller en bon vi ikke kunne
  hente. Navigation til samme sti gør et **reload**, for et hash-skift alene henter
  ikke bonen.
- **`scrollToBonHash()` i `shared/utils.js`** er den anden halvdel af rejsen og havde
  samme to huller: den scrollede til et filtreret kort uden at vise det, og gjorde intet
  når bonen ikke var på siden. Den kalder nu `revealBonCard` og falder tilbage til
  draweren. Det gælder også kalenderens "Gå til bon →", som bruger samme hash.
- Scroll + highlight kaldes direkte, ikke i `requestAnimationFrame`: rAF fyrer ikke i
  en skjult fane, og en køkkenskærm der lige er vækket ville så stå med samme døde knap.

**Tests**: `npm run test:flyver` — 21 (serverside, uændret) + **15 nye** i
`tests/flyver_goto_bon.test.js`, hvor de rigtige `shared/flyver.js`, `kitchen/today.js`
og `shared/utils.js` køres i en vm-sandkasse med en lille DOM og styrbare timere
(browserkode kan ikke `require`s). **Mutations-testet:** ni kerneregler rulles hver især
tilbage og fælder hver sin navngivne assert. Browser-verificeret mod en frisk lokal DB,
inkl. hele kæden i ét forløb: fra Senere → en leveret bon i dag → navigation til I dag →
hash-vejen tænder VIS LEVEREDE og viser kortet. Klikkene blev sendt som `MouseEvent`
gennem de ægte lyttere — browser-panelet var frosset (viewport 0×0), så fysiske museklik
var ikke mulige.

### Menu-rækkefølge og grupper i draweren (1. september 2026)

Bon-draweren og info-modalen viste emballage og levering **midt i maden**.
Køkkenets bon-kort har altid sorteret dem nederst — de to andre flader kendte
bare ikke reglen. Info-modalen *forsøgte* at skille tilbehør fra på
`bon_lines.is_accessory`, men det flag er aldrig sat (0 af ~8.200
emballage-linjer i drift), så opdelingen var reelt død kode. Draweren
sorterede slet ikke.

- **Én regel, tre flader**: `sortMenuLines` · `isBottomMenuLine` ·
  `menuLinePriority` · `normalizeMenuCategory` i [shared/utils.js](shared/utils.js).
  `_sortAndMergeMenu` (bon-kortet) bruger dem nu i stedet for sin egen kopi —
  kortets adfærd er uændret, låst fast af tests.
  Rækkefølgen er som hidtil: `03`/`05` (kager, drikke) → mad →
  `06 Emballage` → `x- Service` → `x-Levering`.
- **Kategorien afgør, ikke flaget.** Kategorierne i drift er rene efter
  normaliseringen (`06 Emballage`, `x-Levering`, `x- Service`), og de bærer
  data. `is_accessory` og kort-items' `style` beholdes som ekstra signal,
  aldrig som eneste — ellers ville reglen dø samme død som info-modalens.
- **Draweren merger stadig ikke.** Den er en editor: rå rækker, så man kan
  slette den enkelte. Kun *rækkefølgen* er ændret, og sorteringen er stabil,
  så to ens rå rækker beholder deres indbyrdes orden.

**Grupper kan nu laves i draweren** — samme grupper som køkkenets bon-kort
viser. Bonen bygges i draweren, så det er dér grupperingen hører hjemme.
Ingen migration og intet nyt endpoint: `bon_menu_groups` +
`bon_lines.menu_group_id` + `PUT /bons/:id/menu-groups` fandtes i forvejen
(migration 072).

- "Gruppér" → checkbokse på linjerne → "Saml i gruppe" → navnefeltet åbner
  af sig selv. Gruppen har titel, note, ▲▼ og opløs. Opløsning fjerner kun
  gruppen; linjerne bliver liggende.
- **Flytning mellem grupper** virker uden drag-drop: en allerede grupperet
  linje kan vælges og samles i en ny gruppe. Kortet kan kun gruppere løse
  linjer, så draweren kan her lidt mere end kortet.
- Auto-gem (600 ms debounce) som på kortet, med `✓ Gemt`-kvittering.
  **Flush før reload og før luk** — ellers ville en gruppe oprettet lige
  inden man tilføjer en vare (eller lukker) forsvinde uden en lyd.
- Serveren reconciler på `line_ids`, ikke på gruppe-id, så lokale nøgler må
  gerne blive stale mellem gem. Nye grupper får derfor bare en lokal nøgle
  (`n1`, `n2`, …) indtil serveren tildeler rigtige id'er.

> ⚠️ **Vores eget gem lukkede gruppér-tilstanden.** `PUT menu-groups`
> broadcaster `bon_updated`, draweren genindlæser ved det event, og `load()`
> nulstiller select-mode. Uden en vagt lukkede tilstanden sig selv 600 ms
> efter at brugeren havde oprettet en gruppe. `_groupBusy()` blokerer reload
> mens der er select-mode, ugemte ændringer eller fokus i varelisten — samme
> slags vagt som køkkenkortene fik i migration 072-runden.

En linje der peger på en slettet gruppe falder ned som **løs** frem for at
blive usynlig — den slags rækker findes, og en vare der forsvinder fra en bon
er værre end en vare der ligger forkert.

**Tests**: `npm run test:menu-order` — 59 asserts. Browser-kode kan ikke
`require`s, så `utils.js` og `bon_drawer.js` køres i en vm-sandkasse og de
rigtige funktioner kaldes direkte. **Mutations-testet:** syv kerneregler
rulles hver især tilbage og fælder navngivne asserts.

> Første udgave af sorteringstesten bestod delvist af den forkerte grund:
> B4165's kategorinavne er tilfældigvis næsten alfabetisk ordnede, så en ren
> `localeCompare` gav næsten samme svar (mutationen fældede kun 1 assert).
> Fixturen bruger nu fem ægte driftskategorier hvor alfabetisk og korrekt
> peger hver sin vej — `Tilbehør & Bokse` er mad og skal *over* `06 Emballage`,
> men sorterer alfabetisk under. Samme mutation fælder nu 3.

Browser-verificeret ende-til-ende mod en kopi af driftsdata (B4165, den bon
fejlen blev meldt på): emballage + levering nederst og dæmpet, gruppe oprettet
og navngivet, note gemt, rækkefølge flyttet, opløsning uden tab af linjer,
og gruppen bevaret da en vare blev slettet inden debouncen nåede at gemme.
De samme grupper vises i info-modalen og på køkkenets bon-kort. Kopien og
`.env` er slettet efter brug.

**Ikke bygget:** drag-drop af linjer mellem grupper i draweren (kortet har
det; ▲▼ + vælg-og-saml dækker behovet med mus), og rækkefølgen af *løse*
linjer persisteres fortsat ikke — den er altid den sorterede. Sidstnævnte er
en pre-eksisterende begrænsning fra migration 072.

### En kontaktperson kan flyttes til det rigtige firma (2. september 2026)

En mail fra `Communication <communication@iuno.law>` blev koblet med **Opret som
lead**. `createPrivateLead` giver aldrig et firma og tager navnet fra mailens
afsenderfelt — så vi fik en kontakt ved navn "Communication" uden forbindelse til
det IUNO-firma vi allerede havde i kartoteket, med kollegaen Jessica siddende på.

Ingen af delene kunne rettes. Der fandtes **intet `PATCH /api/customers/:id`** —
kun `/economic`, `/stage` og `/consent` — og `company_id` kunne kun ændres af
merge-guiden (der kræver to *firmaer*; her var det ene en kunde-række) eller af et
script. Eneste udvej var at oprette personen forfra og lade leadet ligge.

- **`PATCH /api/customers/:id`** tager `first_name`, `last_name`, `company_id`
  (`null` = privatkunde). `requireAuth()`, ikke admin — samme begrundelse som
  mailtrådens `/move`: den der opdager at en kontakt sidder forkert, skal kunne
  rette det med det samme. Changelog pr. felt, og kun for felter der faktisk
  flytter sig; et Gem uden ændringer skriver ingenting.
- **UI**: blyant i Kunde 360°s navneblok folder en editor ud med fornavn,
  efternavn og en firmasøgning (`/api/companies?q=`). Søgningen skriver kun i sin
  egen resultat-container — går den gennem `_k3RenderProfile()`, bygges inputtet
  forfra og mister fokus efter hvert tastetryk (samme fælde som indkøbslistens
  søgefelt havde).
- **Et efterladt *personligt* firma lægges væk.** `ensurePersonalCompanies`
  (`services/rfm.js`) laver ét pr. kunde uden firma, så uden det hober de sig op
  som spøgelser med den flyttede persons navn. Reglen er `services/companyCleanup`s
  egen `deactivateCompanies`, som gentjekker hele tom-reglen — en bon eller en
  mailtråd på rækken freder den. **Kun `is_personal`:** et rigtigt firma må aldrig
  forsvinde som bivirkning af at en kontaktperson flyttes; dertil findes
  CRM → Værktøjer → "Ryd tomme firmaer", hvor det er en bevidst handling.

**Omvejen virkede ikke, og det var en anden fejl.** Man kunne i princippet oprette
personen under firmaet og flytte mailtråden — men `moveThreadOwner` tager kun
adresser med `source = 'mail'` med, og `ensureContactPoint` hardkodede `'manual'`.
Rækkefølgen inde i `create-lead` afgjorde mærkningen: `createPrivateLead` skrev
adressen først som `'manual'`, hvorefter `learnSenderEmail` — som ville have sat
`'mail'` — fandt den og returnerede `reason: 'findes'`. To funktioner var uenige om
hvad adressen var, og den der skrev først vandt.

- `ensureContactPoint(db, …, value, source = 'manual')` og
  `createPrivateLead({ …, contactSource })`. Begge lead-veje i `routes/mail.js`
  sender `'mail'`. Default er uændret, så **bulk lead-import er urørt** — dér ER
  listen indtastet, og `'manual'` er rigtigt.
- En adresse der allerede findes beholder sin mærkning. Vi opgraderer aldrig et
  menneskes indtastning til et systemgæt.
- **Ingen backfill.** De eksisterende `'manual'`-adresser kan ikke skelnes sikkert:
  changelog-sporet (`notes LIKE 'opret-lead-fra%'`) giver **0 træffere** i dev-DB'en
  mod 1.495 email-kontaktpunkter, så en heuristik ville gætte. Rettelsen gælder
  fremadrettet; de gamle flyttes i hånden med den nye knap.

**Tests**: `npm run test:kunde-flyt` — 21 asserts mod de ægte endpoints over HTTP,
med skemaet bygget af de rigtige migrations i `:memory:`. **Mutations-testet:** syv
kerneregler rulles hver især tilbage og fælder navngivne asserts. Den vigtigste
assert er ikke `source = 'mail'` i sig selv, men at adressen *derfor* følger med når
tråden flyttes — kolonneværdien alene beviser ingenting. Kontrolprøven holder fast i
at en manuelt indtastet adresse fortsat **ikke** flyttes.

> Fixturen blev rettet undervejs, ikke koden: den lod to kunder dele ét personligt
> firma, hvilket `ensurePersonalCompanies` aldrig laver.

Browser-verificeret ende-til-ende mod syntetiske rækker i dev-DB'en (oprettet og
slettet igen): flytning + navneændring, changelog, det personlige firma lagt væk,
det rigtige firma urørt, tomt fornavn afvist, Annullér, og ✕ → privatkunde.
Panelet var frosset (viewport 0×0), så klikkene blev sendt gennem de ægte lyttere
frem for som fysiske museklik.

> ⚠️ **Editoren skød 18 px ud over kortets kant** — fundet ved at måle, ikke ved at
> kigge. Siden er `content-box`, så `width: 100%` + padding + border overflyder;
> `box-sizing: border-box` på felterne. Samme fælde som `.f3-edit-wrap` havde i
> Firma 360°.
### Vagthunden råbte op om to bons der gjorde det rigtige (2. september 2026)

Alarm-mailen kl. 06: *"Lagertræk fejlede på 2 bon(s)"* — #B4147 og #B4167 fra
Ungdommens folkemøde. Ingen af dem havde fejlet.

- **B4167** er dagens **salgsbon**. På et let event må en salgsbon per §5 ALDRIG
  trække HQ-lager — prep-bonnen (B4166) ejer trækket, og den havde gjort sit.
- **B4147** er en **rest-prep** ("holder resten"). Hele dagens mål var
  forudbestilt, så linjerne står bevidst på 0. Der var intet at trække.

Begge var altså den rigtige tilstand, meldt som en fejl. Og det er ikke uskyldigt:
en alarm der melder det samme hver morgen om noget der ikke er galt, holder folk op
med at læse — hvilket er præcis det svigt #305 blev bygget for at forhindre.

**Vagthunden aflæste et flag i stedet for at regne reglen ud.**
`autoConsumeBonInventory` markerer godt nok en gated salgsbon med
`event_prep_owns_stock` — men **kun når bonen passerer LEVERET**. En salgsbon
tastes og betales direkte (BETALT), så gaten kører aldrig, flaget bliver på 0, og
bonen er ikke til at skelne fra en hvor trækket gik galt.

> ⚠️ **Vi har været her før — og lappede symptomet.** Migration 164 (24. august)
> løste nøjagtig samme alarm for #B4202/#B4207 ved at **bagudfylde flaget** på bons
> med `payment_type = 'pos'`. Filteret var for smalt: Ungdommens folkemødes
> salgsbons betalte **`cash`**, og alarmen kom igen ni dage senere med nye numre.
> `bonOwnsStockCostSql`'s egen docstring sagde det allerede — *"Reglen skal
> genberegnes, ikke aflæses"* — men vagthunden gjorde det modsatte.

- **`bonOwnsStockCostSql('b')`** (§5-gaten som SQL, samme sted driftsregnskabet
  henter den) bruges nu i vagthunden. Grænsen går ved event-**modellen**, ikke ved
  betalingstypen: et **festival**-event trækker fra sin egen lokation, så dér ejer
  salgsbonnen sit træk og skal stadig frem hvis det mangler.
- **"Intet at trække" ser nu på mængden**, ikke kun på om linjen har en opskrift.
  En rest-prep på 0 kan ikke trække noget. Ekstra pakke-varer tæller **med** (de kan
  tilføje et produkt der ikke står på nogen linje); pakke-overrides tæller ikke — de
  kan kun ændre en mængde der allerede findes.
- **De tre opslag partitionerer nu bevisligt samme mængde**: `KANDIDAT`,
  `EJER_TRAEKKET` og `HAR_NOGET_AT_TRAEKKE` står som fragmenter der bruges positivt
  ét sted og negativt et andet. Skrevet ud hver for sig kunne de skride fra hinanden,
  og så ville en bon falde ned mellem dem og hverken blive alarmeret eller talt.
- **De tavse bons nævnes ved navn** i loggen (`#B4147` · `#B4167, #B4168`) frem for
  at forsvinde. Ellers kan man ikke se forskel på "ingen problemer" og "kontrollen
  kigger det forkerte sted" — samme princip som resten af scriptet.

Migration 164's bagudfyldning bliver stående. Den skriver begrundelsen på selve
bonen, så et menneske kan se hvorfor der ikke blev trukket; den er bare ikke
længere dét der holder alarmen tavs.

**Tests**: `npm run test:deduct-watchdog` — 24 → **36 asserts**, og
`scripts/test-pos-bon-no-stock.js` 5 → **6**. Sidstnævnte fastholdt den gamle,
for smalle regel (*"en almindelig event-salgsbon uden træk meldes STADIG"*) og er
rettet til den der faktisk holder, med festival-kontrolprøven ved siden af.
**Mutations-testet:** seks kerneregler rulles hver især tilbage og fælder hver sine
navngivne asserts. Den sjette slap først igennem — testen dækkede ikke overlappet
mellem "gated" og "intet at trække", som er præcis udgiftsbonnerne (B4168/B4153);
hullet er lukket. Regression grøn: event-rest-prep 59, event-labor 101,
drift-location 60, event-retur 40, event-return-cost 35, event-rest-prep-http 36,
event-covers 33, autobatch-packing 14, drift-cost 13, drift-labor-gap 11.

Verificeret mod en kopi af driftsdata sat i den tilstand skærmbilledet viser:
**før** gengiver mailen ordret (begge bons, exit 1), **efter** siger loggen
*"1 leveret bon(s) har intet at trække: #B4147"* + *"2 let-event bon(s) trækker med
vilje ikke HQ-lager: #B4167, #B4168"* og exit 0. Kontrolprøve: fjernes B4166's træk,
alarmerer den stadig med exit 1. Kopien er slettet.

**Efterspil: det de falske alarmer havde skjult.** Med støjen væk stod fire ægte
fund frem — #B4238/#B4239/#B4240/#B4253 med `partial`, altså et træk hvor nogle
produkter fejlede og lageret derfor er for højt. Første gang tilstanden opstår i
drift (kopien fra 28. august har **nul** partial-rækker), og det afslørede at
beskeden om dem løj:

> `#B4239 (2026-09-02, LEVERET, partial) — har ALDRIG passeret LEVERET`

`findPartial` henter ikke `saw_leveret`, så `aarsag()` faldt i den grenen for hver
eneste partial-linje — om bons der står som LEVERET og hvis træk beviseligt ER kørt
(det er definitionen på `partial`). Alarmen pegede dermed på den forkerte handling:
*"sæt bonen til LEVERET"* i stedet for *"ret de fejlede produkter i Grocy"*.
Pre-eksisterende siden årsagsteksten kom til 24. august; usynlig indtil der fandtes
en partial-række.

- **`fmtPartial`** er nu adskilt fra `fmt`. Et delvist træk har sin egen årsag og
  må ikke låne den anden forespørgsels felter.
- **Alarmen navngiver de fejlede produkter** (`— fejlede: Rødløg, Mayonnaise`),
  hentet fra `grocy_consume`-postens payload. Det er den eneste handling der kan
  tages, så den hører i alarmen — ikke bag et opslag i UI'et. Samme princip som de
  tre årsagstekster. Højst 6 navne (`MAX_FAILED_NAMED`), dubletter væk
  (parent-substitution nævner samme produkt to gange).
- **`failedProductNames`** spejler alle tre historiske payload-former (sentinel,
  rå array, `{state,results}`) og returnerer tom liste ved uventet indhold — så
  falder alarmen tilbage på changelog-henvisningen frem for at vælte. En tavs
  vagthund er præcis den fejl den selv findes for at forhindre.

Testen voksede 36 → **47 asserts**; elleve mutationer i alt, alle fanget.

> ⚠️ **Fælde i testen selv:** bonnerne står som en komma-liste på én linje, og hver
> post indeholder selv et komma (datoen). To asserts brugte `#num[^,]*navn` og
> stoppede derfor for tidligt — de fejlede mod en KORREKT besked. Segmentet skæres
> nu ved næste bon-nummer.

**Og så var spørgsmålet hvorfor.** Alarmen siger nu HVILKE produkter der fejlede,
men ikke hvorfor — og uden det kan man ikke vide om lageret skal rettes i hånden,
om en kobling mangler, eller om Grocy var nede i to sekunder. Svaret har hele tiden
ligget i `changelog`: `consumeRecipes` gemmer hvert produkts `err.message` i
`grocy_consume`-payloaden. Der var blot ingen måde at læse den uden at åbne hver
bon i UI'et, én ad gangen. Tredje gang i samme runde at oplysningen fandtes uden
at kunne ses.

**`npm run diagnose:partial-consume`** (`--days N` / `--bon B4239`, read-only,
intet `--apply`) lister fejlene pr. bon og **grupperer dem på besked**.
Grupperingen ER værdien: fire bons der fejler på de samme produkter med den samme
besked er ÉN årsag, ikke fire uheld — og det kan kun ses når de står ved siden af
hinanden. Grocys tekster bærer mængder og id'er, så beskeden normaliseres (tal →
`N`) før den grupperes; uden det bliver hver fejl sin egen gruppe, og rapporten
viser "fire urelaterede problemer" om noget der er ét. Grupperne sorteres efter
hvor mange bons de rammer.

> **Hvad `success: false` betyder — værd at holde fast i.** Mængden er allerede
> klampet til det der ER på lageret (`Math.min(needed, available)`), så det er
> **ikke** "for lidt på lager": den situation giver `success: true` + `partial` +
> en linje på indkøbslisten. En fejl her er selve Grocy-kaldet der svarede noget
> andet end 2xx — stale stock-snapshot, en manglende kobling, eller Grocy nede.

Testen voksende 47 → **54 asserts**; tretten mutationer i alt, alle fanget.

### Links til opskriften: tre steder, én regel (3. september 2026)

Køkken-dashboardets "Lav snart" fortæller HVAD der skal laves, men man skulle selv
finde opskriften bagefter — via Opskrifter, søgefelt og kategori-chip. Tre trin for
noget der stod på skærmen.

Hele maskineriet fandtes allerede. `?recipe=ID` har været i `recipe_viewer.js` siden
CO₂-rapporten, og `prep-ahead` har altid leveret `recipe_id`. De to var bare aldrig
koblet sammen. Ændringen er ren wiring: rækken er nu et `<a>` — hele rækken, ikke kun
navnet, for dashboardet står på en touchskærm hvor et navn er et lille mål.

**Batch-antallet følger med** (`&batches=N`), så vieweren åbner i den mængde der skal
laves frem for på 1 portion. Omregningen bor i **vieweren**, ikke i dashboardet:
`portioner = batches × base_servings`, og `base_servings` er en Grocy-egenskab som kun
vieweren har hentet. (Ét batch er hele opskriften som den står i Grocy — ikke én
portion; `collectRecipeNeedsFlat` ganger multiplieren direkte på råvarerne. I grocy-hq
er `base_servings` 1 i dag, men den antagelse har kostet en fejl før, jf. #349.)

> **Batch-tallet sendes KUN når udbyttet er oplyst i Grocy.** Er det ikke
> (`make_status: 'ukendt'`), sætter resolveren `batches: 1` som fallback — og det tal
> må ikke rejse videre som var det en måling, for så ville vieweren vise en mængde
> ingen har regnet. Samme fejlklasse som #305/#319.

**En blokeret række linker også.** Det viste sig stærkere end forudset: opskriften er
netop dér man ser hvad der mangler (Æbler 0, Rosiner 0 — rødt, med indkøbskurv ved
siden af hver). Fra "Lav snart" er man nu ét klik fra at lægge det manglende på
indkøbslisten.

Tooltip nævner opskriftens navn — men kun når det ikke allerede står i underteksten.
På en blokeret række viser underteksten mangellisten, så navnet ER ny information dér;
på en åben række ER underteksten netop navnet.

#### Råvarer-modalens underopskrifter

Samme rejse fra den anden ende: Produktion-fanens gyldne rækker viser hvad der skal
blandes hjemmefra, men ikke hvordan.

**Kun navnet er linket, ikke hele rækken.** Rækken har allerede en handling — den folder
mangellisten ud (#349) — og de to må ikke kappes om samme klik. Derfor `stopPropagation`.

**Mængden sendes som `?portions=N`, ikke `batches`.** `sub_recipes[].servings` ER antal
portioner: resolveren regner `mult = scaledServings / base_servings`, præcis som
vieweren. Der er intet at omregne, og dermed intet at regne forkert. De to parametre er
ikke duplikering — de svarer på hver sit spørgsmål, fra hver sin kaldere, og ingen af
dem skal gætte den andens tal.

**Ny fane her, samme fane på dashboardet.** Modalen er noget man står midt i og skal
kunne vende tilbage til; dashboardet er et sted man navigerer FRA. Samme mønster som
varemodtagelsens og indkøbslistens genveje til "opret produkt".

> ⚠️ **Undtagen i kiosk-mode.** `enterKiosk()` kalder `requestFullscreen()`, og uden
> fanebjælke kan en køkkentablet ikke lukke en ny fane igen — brugeren strander.
> `_subRecipeNav` sætter derfor `target` ved KLIK-tid (`kiosk`-klassen eller
> `document.fullscreenElement`), ikke ved render: man kan trykke KIOSK efter at modalen
> er åbnet. Den sætter kun `target` og lader browseren navigere, så cmd-/midterklik
> virker uændret.

> ⚠️ **`_esc` er en LOKAL const i `_buildRavarerHtml`, ikke en global.** En top-level
> helper der bruger den kaster `ReferenceError` og brækker hele råvarer-modalen. Fanget
> af testen, ikke af browseren — i produktion havde det været en tavs, total fejl.
> Escaperen sendes derfor ind som parameter.

> ⚠️ **En assert der kaster er et dårligere signal end en der fejler.** Mutationen der
> fjernede `if (!rid) return ''` gav en stak-udskrift i stedet for en rød linje, så den
> lignede et brudt testscript frem for en fanget fejl. Kaldene går nu gennem en wrapper
> der fanger. Samme lære som i #481.

> ⚠️ **En assert der måler startværdien måler ingenting.** `eq(nav().title, '…i ny fane')`
> bestod fordi attrappen blev født med den værdi — ikke fordi handleren satte den. Med
> forkerte startværdier faldt den, og så viste browseren fejlen: efter et kiosk-klik blev
> "Åbn opskriften" hængende på et `_blank`-link, så tooltip'en lovede noget andet end der
> skete. Attrapper starter nu på `IKKE-SAT`, og en sekvens-test (kiosk → ikke-kiosk på
> SAMME element) låser rettelsen fast.

#### Kan-laves-råvarerne i samme modal

Tredje reference, samme rejse: "Langtids Stegt Gris · skal laves: Langtids stegt Gris"
peger på præcis de opskrifter "Lav snart" viser (`make_recipe_id` + `make_batches`).

**`make_recipe_id` er selv det rigtige filter.** En vare der ligger på hylden får aldrig
et — grenen med dækning returnerer `{producible: true, make_status: null}` uden id. Så
kun de rækker hvor der faktisk skal laves noget bliver links, og listen får ikke
understregninger på hver anden linje. Efterprøvet i drift: Rødkål- og Rødløg-Sylt er
producerbare og forbliver ren tekst, mens Langtids Stegt Gris og Æble chuthney linker.

> **Navnet er PRODUKTETS, ikke opskriftens** — "Æble chuthney" mod "Æble chuthney
> Produktion". Derfor navngiver tooltip'en opskriften: man skal kunne se hvor man
> lander, når de to ikke hedder det samme.

#### Reglen bor ét sted

Tre kaldere peger nu på samme viewer, og de ved hver sit om mængden. Skrevet tre gange
ville betingelsen "hvornår må et batch-tal sendes med" skride fra hinanden — nøjagtig
sådan #428 opstod. `recipeUrl({recipeId, portions, batches, trustBatches})` i
`shared/utils.js` ejer den; `_paHref` (dashboard), `_subRecipeLink` og `_makeRecipeLink`
(modal) er tre kald til den. `utils.js` loades alle steder `modal.js` er — efterprøvet,
ikke antaget.

En test asserterer direkte at dashboardet og kan-laves-rækken bygger **samme URL af
samme tal**, så divergens fælder en assert frem for at ligge og gemme sig. Bekræftet i
drift: begge flader gav `?recipe=29&batches=1` for Æble chuthney.

**Tests**: `npm run test:prep-ahead-link` — 70 asserts. `kitchen/index.html`,
`shared/modal.js` og `shared/utils.js` er browser-kode og kan ikke `require`s, så
funktionerne skæres ud af filerne og køres i en vm-sandkasse — de SAMME funktioner
browseren bruger, ikke en kopi (samme mønster som `test-recipe-viewer-nested.js`).
**Mutations-testet:** 25 kernerettelser rulles hver især tilbage og fælder hver sin
navngivne assert. Regression grøn: menu-order-groups 59, modal_outside_click 30,
safe_navigate 8, portioner 32, recipe-viewer-nested 12, subrecipe-status 16,
yield-model 14, gram-chaining 6, resolver-graph 8, packing-units 18, prep-packing 12,
recipe-factor 8.

> ⚠️ **Handleren må ikke overskrive tooltip'en.** `_subRecipeNav` satte en fast tekst,
> så et kan-laves-links "Åbn Langtids stegt Gris" blev til "Åbn opskriften" ved første
> klik — navnet var tabt for altid. Etiketten bæres nu i `data-open-label`, og handleren
> hæfter kun " i ny fane" på. Fundet ved at læse den nye kode op mod den eksisterende,
> ikke af testen.

#### Højre kolonne kunne ikke scrolles (fundet ved drifttest)

At gøre rækkerne klikbare afslørede en **pre-eksisterende** fejl: køkken-dashboardets
højre kolonne klippede sit indhold uden nogen vej til det. Målt på 1366×728 (ThinkPad
L14, baseline for kitchen-density) — og byte-identisk på `main`, så den er ikke ny:

| Kort | Viste | Indhold | Skjult |
|---|---|---|---|
| Vagtplan | 184 px | 405 px | **221 px** |
| Lav snart | 146 px | 316 px | **170 px** |
| Prep · kommende dage | 130 px | 277 px | **147 px** |

`.card` har `overflow:hidden`, og kortene arvede `flex-shrink: 1`. De gav derfor efter
og klippede resten — i stedet for at beholde deres højde og lade nogen scrolle.
`.content` HAR `overflow-y:auto`, men fik aldrig noget at scrolle: kortene havde jo
allerede krympet. Resultatet var indhold der hverken kunne ses eller nås.

**Landede på: kortene i fuld højde, kolonnen scroller.** `.right-col > * {
flex-shrink:0 }` — kortene klemmes aldrig, for de har `overflow:hidden`, så et krympet
kort skjuler bare sit indhold uden scrollbar. Ét sted at skubbe i stedet for tre.

Vejen dertil er værd at kende, for begge mellemstationer så rigtige ud:

> **Scroll inde i hvert kort** (kategori-listens model, som Leif pegede på) holdt
> kortene på plads med deres overskrift. Forkastet i drift: *"det er ikke rart at
> vagtplanen og prep de scroller"* — en vagtplan man skal scrolle i for at se dagens
> hold er værre end en kolonne man skubber én gang.

> **`min-height` på kroppene** skulle sikre hvert kort en mindstehøjde. Det fik dem til
> at klippe igen, fordi kortet SELV intet gulv havde og krympede under sit indhold.
> Fanget ved at måle `scrollHeight > clientHeight` pr. kort, ikke ved at kigge.

> ⚠️ **En negativ margin plus en overflow-værdi giver en sidelæns scrollbar.**
> `a.pa-row { margin-inline:-4px }` (til at strække hover-fladen ud til kortets kant)
> gjorde rækken 246px bred i en 242px container. Alene var det harmløst — men da
> kroppen fik `overflow-y:auto`, blev `overflow-x` **implicit beregnet til `auto`**
> (CSS-regel: er den ene akse ikke `visible`, bliver den anden `auto`), og "Lav snart"
> kunne scrolles sidelæns. Meldt i drift. Marginen er væk; efterprøvet ved at genskabe
> fejlen og fjerne præcis den ene ting.

Målt efter (1366×728): intet klippet, ingen intern scroll, ingen sidelæns scroll, alle
6 rækker i "Lav snart" synlige, og kolonnen scroller 558px. På **1920×1080** (Iiyama
ProLite T2752MSC — den 27" touchskærm køkkenet får) scroller kolonnen 27px; alt andet
er synligt på én gang. Ved 900×800 (row-layout) er intet klippet.

Kolonne-scrollet er verificeret med et **ægte musehjul-scroll** (0 → 500 af 538).
Syntetiske `wheel`-events flytter ikke scroll i Chrome, så en tidligere måling så ud som
om intet virkede — det målbare dér er om eventet `preventDefault`-es, og det gør det ikke.

**"Lav snart" viser alle varer.** Listen blev klippet ved 6 med et `+ N mere` nedenunder
— men den tekst var ikke klikbar og førte ingen steder, så man kunne se AT der manglede
noget uden at kunne få at vide hvad. Meldt i drift: *"det duer ikke at der står '1 mere'
og man ikke kan få at se hvad det er."* Grænsen gav mening dengang kortet ikke kunne
scrolles; nu scroller kolonnen, så der er intet at spare på. `.pa-foot` er død CSS og
fjernet.

Layoutet holder ved enhver længde — målt på 1366×728 med 7 (drift), 15 og 30 varer:
intet klippes, og Prep-kortet er nåeligt ved scroll i alle tre tilfælde.

> **Bevidst ikke ændret:** `.content { max-width:1280px }` betyder at dashboardet fylder
> 67 % af en 1920px skærm — 320px tomt i hver side. Afklaret med Leif: det er en bevidst
> læsbarhedsgrænse der gælder alle skærme, også kontorets, og der klippes intet.

**Ikke gjort:** pakkelistens underopskrifter. Dér har hver række et redigerbart
mængdefelt, som et link ville konkurrere med. Og "Lav snart" viser fortsat højst 6
rækker med "+ N mere" nedenunder — en blindgyde, for teksten er ikke klikbar. Nu hvor
kolonnen kan scrolle, kunne grænsen hæves; det er en produktbeslutning, ikke en fejl.

### Rabatten rammer varerne — ikke levering og gebyrer (4. september 2026)

Faktura 4194 gav Able 12,5 % rabat på **miljøgebyret**. Et gebyr er et gebyr.

Rabatten SKAL komme fra bon — e-conomics egen prisgruppe fyrer ikke gennem API'et.
Det stod i specen fra juni, og Ables egne fakturaer viser det renere end nogen
dokumentation: 4094 (tastet manuelt i e-conomic) 12,5 % · 4150 (vores udkast, samme
kunde, samme prisgruppe) **0 %**. `/price-groups` svarer 501, så satsen kan ikke engang
læses derfra.

- **Migration 168** — `settings.economic_no_discount_categories`, default
  `["x-Levering","x- Service","06 Emballage"]`. Kategori-styret, ikke hårdkodet: en ny
  gebyrtype koster en afkrydsning i **Settings → e-conomic** frem for en kodeændring.
  Tom liste = rabat på alt (den gamle adfærd), så en tastefejl kan ikke fjerne en rabat
  i stilhed.
- **`discountForLine()` er ÉN kilde**, som alle tre linjeveje kalder — varelinje, bundt
  (slider-boks) og leverings-synteselinjen. Skrevet tre gange ville de skride fra
  hinanden; det var netop dét der producerede #444. Synteselinjen har ingen bonlinje at
  hente kategori fra og låner `x-Levering`, så den følger listen begge veje.
- Navne normaliseres (trim, ét mellemrum, små bogstaver). Kategorien hedder `x- Service`
  **med mellemrum efter bindestregen** — `x-Service` ville ellers ryge lydløst forbi.
  En linje UDEN kategori beholder rabatten: vi udelader kun det vi positivt kan genkende.

**Snapshottet kan nu rettes.** Triggeren fra migration 111 fyrer kun ved INSERT, så en
rabat aftalt i dag ramte aldrig de bons der allerede lå i køen — og
`offer_discount_percent` stod ikke i PATCH-allowlisten, så satsen kunne hverken rettes
fra skærmen eller API'et. Sattes den forkert, fandtes der ingen vej tilbage. Det kostede
to kreditnotaer i august (4150 → 4177 → 4178 og 4161 → 4179 → 4180), hvor eneste ændring
var 12 % lagt på hver linje i hånden.

- Feltet er patchbart, valideret **0 ≤ x < 100** — 100 % er ikke en rabat, og en negativ
  sats ville lægge TIL fakturaen.
- `POST /api/bons/:id/reapply-discount` henter den stående sats igen. Bevidst handling
  med sin egen changelog-linje, ikke en bivirkning af at gemme. Samme prioritet som
  triggeren: firmaet vinder over personen.
- Bon-draweren viser bonens sats **ved siden af** firmaets stående (`getBon` leverer nu
  begge). Uden de to tal side om side er forskellen usynlig — og det var dét der kostede
  kreditnotaerne. Knappen "Hent 12,5 % fra firmaet" vises kun når satserne afviger; en
  knap der altid er en no-op er værre end ingen knap.

> ⚠️ **Emballage i default'en er en ÆNDRING af praksis.** Da Ables fakturaer blev tastet
> manuelt, fik emballage 12,5 % som alt andet — sådan opfører e-conomics prisgruppe sig.
> Beslutningen var at emballage ikke skal rabatteres, men den kan rulles tilbage i
> Settings uden kodeændring. Ables fakturaer bliver dermed en anelse dyrere end de plejer.

**Drive-by:** `is_reseller` manglede i sammenlægnings-vælgeren (`routes/admin-merge.js`).
Uden den ville en fletning hvor forhandleren er **taber** tavst tabe markeringen — og så
holder slutkunde-routingen (migration 167) op med at virke for det firma.

**Tests:** `tests/standing_discount.test.js` (17 — mod de ægte endpoints over HTTP, skema
bygget af de rigtige migrations i `:memory:`) + 15 nye i `scripts/test-economic-invoice.js`
(**118/0**). **Mutations-testet:** ti mutationer, alle fanget af hver sin navngivne assert.
En af testens egne asserts fejlede undervejs og havde ret — fixturen indsatte bons uden at
regne totalen, så ethvert beløb ville have målt fixturen frem for koden.

**Ikke gjort her:** `able ApS` (id 3551) skal lægges ind under `Able` (3570) — begge peger
på e-conomic-kundenr 733, så rabatten skulle ellers sættes to steder. Det er en
datahandling: CRM → Værktøjer → Sammenlæg firmaer, med `Able` som vinder. 1 bon, 0 kontakter.

### En ret bag en note faldt ud af web-bestillingen (4. september 2026)

B4259: kunden bestilte 7 retter, bonen fik 4. `3× Kyllingen (1 without mayonaise)`
manglede helt. Ingen sagde noget — bon-kortet så komplet ud.

Fejlen sad i formularen, ikke i bonen. Bestillingssiden holder to repræsentationer
af de samme retter: teksten i kundeønske-feltet og `menu_items[]`, hvorfra
bon-linjerne genereres (#382). Redigerer kunden teksten, genberegnes `menu_items[]`
fra den — og `getCurrentCount` kørte én regex **pr. menuret** hen over hele teksten
med et lookahead der krævede linjeslut lige efter navnet:

```js
new RegExp(`(^|\\n)(\\d+)\\s*[×x]\\s*${escaped}(?=\\s*(?:\\n|$))`, 'i')
```

Noten i parentesen stod i vejen, så Kyllingen talte 0 og forsvandt ud af
bestillingen. Lookahead'et var der af en god grund — uden det ville `Kyllingen`
også ramme `Kyllingen BBQ- Salat` — men prisen var at ethvert ord bag retnavnet
dræbte retten.

**Ikke en engangsfejl.** Af 50 web-ordrer med ret-linjer i teksten er **24 uenige**
med deres eget `menu_items[]`. Blandt de 13 bons der har fået auto-genererede linjer:
B4222 (`1 x Falaflen (GLUTENFRI)` — office tastede den manglende ret i hånden),
B4174, B4224. Samme parentes, samme udfald.

**Og den modsatte fejl fandtes.** Genberegningen tildelte tællingen til **hver**
menuret med det pågældende navn. Menuen har haft dubletter (r161/r25, r162/r53 …),
så B4145 fik 14 linjer for 8 bestilte retter — overbestilling. Den nuværende menu
har ingen dubletter, så fejlen er sovende, men mekanismen lå der.

- **Én parsing i stedet for én regex pr. ret.** `parseWishes()` læser hver linje
  én gang og finder den ret hvis navn står **forrest** og slutter på en ordgrænse;
  længste match vinder. Så overlever noten (`Kyllingen (1 uden mayo)` → Kyllingen),
  `Kyllingen BBQ- Salat` vinder stadig over `Kyllingen` på sin egen linje, og
  `Fisken` rammer ikke `Fiskens`. Tællingen går til **ét** id, så dubletter i
  menuen ikke længere bestilles to gange.
- **Kundens note bevares ved optælling.** Et klik mere på Kyllingen giver
  `4× Kyllingen (1 uden mayo)`, ikke `4× Kyllingen`. Den gamle kode skrev linjen
  om fra navnet alene.
- **Fri tekst bliver stadig ikke til en bestilling.** `36× kyllinge salat m. brød`
  matcher ingen ret, og vi gætter ikke. Linjen bliver stående i feltet, og bonens
  advarsel gør office opmærksom på den.

**Advarslen er den anden halvdel**, for parsingen kan aldrig blive perfekt —
`Trøflen slider` mod menuens `Trøflen - slider` (B4174) er et match ingen regel
kan tage uden at risikere at ramme forkert. Bon-draweren viser derfor to udledte
mærker, i samme sprog som fakturavagten (#319):

| Mærke | Fyrer når |
|---|---|
| Kundens bestilling og bonens varer stemmer ikke | en ret-linje i kundeønskerne har ingen modsvarende bon-linje, eller antallet afviger |
| N enheder til M pax | der er **færre** enheder end gæster, og bonen har varer |

Begge er **udledt, ikke gemt**: ingen migration, de virker på alle eksisterende
bons med det samme, og de forsvinder af sig selv når office har lagt linjen på.
Verificeret begge veje — advarslen kom tilbage da linjen blev slettet igen.

**Og begge tier på en bon der ikke kan rettes.** Grænsen går ved **fakturering**,
ikke ved levering: en LEVERET bon skal stadig faktureres, så en manglende varelinje
betyder en for lille faktura — det er netop dér mærket handler om penge (B4222 var
LEVERET). Er fakturaen sendt, er der intet at gøre, og et mærke man ikke kan handle
på lærer folk at ignorere mærket — samme svigt som vagthunden i #305. `bonIsClosed()`
dækker FAKTURERET · BETALT · AFSLUTTET · AFLYST, præcis dem med
`status_definitions.is_terminal = 1`. Listen skrives ud frem for at hente feltet,
fordi draweren kun kender `status_code` indtil bonen hentes igen — og mærket skal
slukke i samme øjeblik status skifter.

**Og ret-linje-advarslen gælder kun web-bestillinger.** Dér er kundeønske-feltet
maskingenereret fra kundens menu-valg og BURDE matche varelinjerne. På en almindelig
bon er feltet en note fra en telefonsamtale, som office allerede har oversat til
linjer — at den ikke matcher ordret er normalt. `getBon` leverer `from_web_order`
(EXISTS mod `web_orders`, autoritativ; alle 123 web-bons i drift har også
`[Form:]`-markøren, men koblingen er kilden). Pax-noten er ikke afgrænset — den
handler om pax mod enheder og gælder enhver bon.

> ⚠️ **Det første tal her var forkert.** "24 uenige web-ordrer" målte tekst mod
> `menu_items[]` — men advarslen sammenligner tekst mod bonens **faktiske linjer**.
> Kørt med den rigtige sammenligning rammer den **369 bons**, hvoraf **342 er
> almindelige bons**. En stikprøve på 6 af dem gav 5 falske: `9 x Sliderboks, med
> 3 stk:` mod en bon der har de tre sliders, `2 x standard kartoffel samt 1 x
> standard fisk` som én sætning, `4 x Tunen` mod bonens `"Tunen"`. Uden afgrænsningen
> havde mærket været ubrugeligt.

De to filtre tilsammen, målt med den ægte `wishLineDiff` mod driftsdata:

| | Bons der ville advare |
|---|---|
| uden afgrænsning | 369 |
| kun web-bestillinger | 27 |
| … og kun dem der kan rettes | **3** |

De tre er B4173, B4174 og B4225 — alle gennemgået i drift og fundet i orden. To er
fritekst der aldrig kan matches (`2× Glutenfri efter kokkens valg`, `10× sliderbox
med`). De forsvinder når bonsene faktureres. B4222 tav af sig selv, da Falaflen blev
lagt på — selvhelbredningen er dermed bekræftet i drift, ikke kun i test.

**Matchningen tåler skilletegn** (tilføjet efter drifttest). Menuen skriver
`Trøflen - slider` og `"Tunen"`; kunden skriver `Trøflen slider` og `Tunen`.
`_normDish()` gør bindestreger og gentagne mellemrum til ét mellemrum og fjerner
anførselstegn — målt mod driftsdata gav det **61 nye match og nul linjer der skiftede
fra én ret til en anden**. Ordgrænsen holder (`Fisken` rammer stadig ikke `Fiskens`),
og en sammenskrivning uden skilletegn matcher ikke.

> Normalisering ændrer længden, så noten kan ikke skæres af den normaliserede tekst.
> `_normDish` returnerer derfor et **kort** fra hvert normaliseret tegn tilbage til
> originalens index, og noten skæres dér. `toLowerCase()` kan give flere tegn for ét
> (tyrkisk İ), så hvert resultat-tegn får originalens index — kortet er altid lige så
> langt som teksten. Et anførselstegn der **klistrer** til navnet spises med
> (`"Tunen" (uden løg)` → noten `(uden løg)`); står der et mellemrum imellem, er det
> kundens eget og bliver stående (`Fisken "med ekstra"`).

Risikoen ved at være tolerant er fejlmatch, så den blev målt før den blev bygget: af
205 distinkte varenavne i drift smelter 7 sammen — alle **samme vare med anden
stavning** (`cookie ` ≡ `Cookie`, ` Falaflen` ≡ `Falaflen`), ingen to forskellige
retter. Og **0 af 3119 bons** har to af deres egne linjer der smelter sammen, så
matchet forbliver entydigt dér hvor det bruges. Bestillingsmenuens 36 retter: ingen
kollisioner. Efter tolerancen advarer B4174 kun om `Grisen slider` mod menuens
`Grisen på Rug slider` — dér mangler der ord i midten, og det kan ikke tages uden
fuzzy matching, som ville kunne ramme den forkerte ret.

Pax-noten falder fra 15 til 1 bons; det ene er ikke et udtryk for at den er død —
driftskopien er fra 28. august, så næsten alt fra 2026 er lukket. Fremadrettet vises
den på bons under arbejde, som er hvor den hører hjemme.

> **Pax-mærket går kun én vej.** Flere enheder end pax er helt normalt: en
> slider-bon har 2-3 pr. gæst. Målt på 2026 ville **137 af 139** slider-bons være
> tavse, og de sidste 2 har 0 enheder *med* varer på bonen — altså den stale
> `total_units`-cache, ikke en slider-norm. I alt fyrer mærket på **13 af 455**
> bons (2,9 %), sjældent nok til at blive læst. Og kun når bonen har varer: en
> netop oprettet, tom bon er ufærdig, ikke forkert.

`7 enheder til 8 pax` nævnes også, selvom kunden godt må bestille færre retter end
gæster. Forskellen på "én spiser ikke med" og "en ret faldt ud" er ikke vores at
afgøre — teksten siger derfor *tjek*, ikke *fejl*.

Første udgave af pax-mærket var bevidst dæmpet (11,5 px, næsten hvid baggrund) for
ikke at larme om noget der ikke altid er en fejl. Efter drifttest blev det løftet til
samme vægt som ret-linje-advarslen — 13 px, mættet amber, ⚠ og to linjer. Når et
mærke kun fyrer på under 3 % af bons, må det godt fylde når det endelig gør; det er
netop sjældenheden der gør det læseværdigt.

> ⚠️ **Reglen findes to steder.** Formularen er single-file uden imports, så
> `matchDish` i `public/embed/bestilling.html` spejler `matchDishName` i
> `shared/utils.js`. §3 i testen asserterer at de svarer ens på 12 tilfælde —
> går de fra hinanden, viser formularen noget andet end bonen får. Samme mønster
> som `_vmFindFactor` mod `findConversionFactor`.

**Fravalgt:** at sende noten videre som `special_request`. "1 without mayonaise"
gælder 1 af 3 kyllinger; lagt på en linje med antal 3 ville den påstå at alle tre
er uden mayo. Teksten står i kundeønskerne, og office kan splitte linjen.

**Tests:** `npm run test:wish-lines` — 41 asserts. Browser-kode kan ikke `require`s,
så både `shared/utils.js` og formularens egen blok køres i en vm-sandkasse; det er
de samme funktioner browseren bruger. **Mutations-testet:** ni kernerettelser
rulles hver især tilbage og fælder hver sin navngivne assert. To slap igennem
første runde og blev lukket: emballage-filteret i `wishLineDiff` viste sig **inert**
(og skadeligt i det ene tilfælde hvor det virkede — nævner kunden en transportkasse,
skal antallet kunne sammenlignes) og er fjernet, og en assert **kastede** i stedet
for at fejle, så mutationen så ud til at slippe. Regression grøn: menu-order 59,
prep-ahead-link 70, modal 30, nav 15, portioner 32, flyver 15, dato 8,
inbox-learn 53, mail-tid 20.

Browser-verificeret ende-til-ende mod en kopi af dev-data: formularen bevarer
retten når noten skrives (badgen bliver 3, ikke 0), noten overlever et nyt klik,
fri tekst bestilles ikke, og begge mærker i draweren tændes og slukkes med
linjerne. Testdata og den lokale kopi er slettet. Panelet var frosset (viewport
0×0), så klikkene gik gennem de ægte lyttere frem for som fysiske museklik.

**Ikke rørt:** de 24 historiske web-ordrer retter sig ikke selv — men advarslen
gør dem synlige næste gang bonen åbnes.


### Kundemailen følger nu samme menu-rækkefølge som kort, drawer og info-modal (13. september 2026)

Bekræftelsesmailen til kunden viste varerne i rå DB-rækkefølge — emballage midt i
maden — selvom bon-kort, drawer og info-modal for længst deler én sortering
(`sortMenuLines` i `shared/utils.js`). Mailens vareliste blev bygget **tre steder**
(`_buildMailVars` i `bon_kort.js` og `bon_drawer.js` + `MailThread.buildVars` på
mobil), og ingen af kopierne fik sorteringen med. Præcis den drift CLAUDE.md
advarer om ved `_buildMailVars`.

- **Én kilde**: `MailThread.buildVars` (`shared/mail_thread.js`) sorterer med
  `sortMenuLines` FØR gruppe-opdelingen, så linjerne inde i en menu-gruppe også
  følger reglen (som på kortet). Grupperne selv følger fortsat `sort_order`.
  De to andre kopier delegerer nu hertil; drawerens ekstra felter
  (`co2Transport`, `co2MedTransport`, `leveringsMetode`) er flyttet med ind.
- **Et dødt filter er fjernet**: kopierne filtrerede på kategori `'emballage'` /
  `'levering'`, men kategorierne hedder `06 Emballage` / `x-Levering` siden
  normaliseringen, så emballage har hele tiden stået i mailen. Den står der
  stadig — nu nederst. **Beslutning (Leif, 13. september 2026): emballagen
  SKAL med i kundemailen.** Filtrér den ikke ud igen.
- `kitchen/logistik.html` loader nu `mail_thread.js` (den havde draweren uden).

**Tests**: `npm run test:menu-order` fik en sektion 9 (84 PASS) med B4274 som
fixture. Mutations-testet: fjernes sorteringen, falder 4 asserts. Verificeret i
browser mod kopi af dev-data: drawer-rækker og mailtekst er identiske, mens den rå
DB-rækkefølge er en anden.

### Lageroversigten viser "sidst tjekket" — og stempler selv (#613, 14. september 2026)

Køkkenet ville kunne se hvornår en vare sidst var tjekket, uanset om det skete i
lageroversigten eller i optællingen. Feltet fandtes (Grocy-userfield `LastCheckedAt`,
som optællingen viser som "Sidst: dato (enhed)"), men lageroversigtens eget "Gem"
skrev det ikke — og det er den vej køkkenet retter lageret til daglig.

**Målt mod grocy-hq 14/9:** 49 af 81 varer på lager havde et stempel, det nyeste fra
19. august. Grocys `stock_log` viste 112 rettelser siden da — ingen stemplet, alle
20–40 s fra hinanden (én vare ad gangen = lageroversigten; optællingen skriver i ét
ryk). Samme fejlklasse som #305/#319: handlingen skete, sporet blev aldrig sat.

- **Lageroversigtens Gem stempler `LastCheckedAt`** (`_soStampChecked` i
  [shared/stock_overview.js](shared/stock_overview.js)) — ved ændring, ved "Ingen
  ændring" og ved "behold lagerets tal". **Et tjek uden ændring er også et tjek**
  (beslutning, Leif): varen ER set, og tallet passede. Stemplet skrives EFTER
  lager-skrivningen og må aldrig vælte den; fejler det, siges det i en warn-toast
  frem for at blive slugt.
- **Kun datoen.** `LastCheckedUnit` er optællingens felt — den bruger enheden til at
  afgøre hvilken køl/frys-liste varen hører til (`_icVisibleInUnit`), og
  lageroversigten kender kun Grocy-lokationen. Sættes enheden ikke, kan optællingen
  ikke tro at varen "blev rullet" til den gamle enhed i dag.
- **Mærke på kortet, til højre under blyanten** (ikke i enheds-linjen — den skal have
  plads til omregningerne `≈ 0.7 Kasse · ≈ 110.8 Antal`): gråt `✓ 3d siden` /
  `✓ 11. sep`, kursivt `aldrig tjekket`, orange ⏳ og rødt ⏰ efter `HverDag`-intervallet
  — samme regler og farver som optællingen. Tooltip med præcis tid, enhed og interval.
  Søjlen er 30 px knap + 2 px + 12 px tekst = 44 px = kortets indholds-minimum, så
  kortet bliver **ikke højere** (målt: alle 114 kort 68 px, med og uden mærke). I
  "vælg flere" skjules hele søjlen, som blyanten gjorde før — ellers ombrydes
  enheds-linjen på brede kort, og gridet strækker hele rækken.
- **Pille "N ikke tjekket"** (aldrig set, eller intervallet overskredet) ved siden af
  "udløbet"/"lav", og **sortering "ældst tjekket først"** inden for hver gruppe
  (aldrig tjekket øverst; huskes i `localStorage`).
- **`npm run backfill:sidst-tjekket`** (`scripts/backfill-last-checked.js`) sætter
  stemplet fra seneste `inventory-correction`/`purchase` i `stock_log` pr. produkt —
  KUN hvor loggen er nyere end det eksisterende stempel, aldrig hvor der intet spor
  er (vi opfinder ikke et tjek). Uden det står oversigten rød på næsten alt fra dag
  ét: 178 af 180 varer har `HverDag=7`. Dry-run default, `--apply` skriver, `--test`
  mod grocytest. Dry-run mod drift: 146 sættes, 32 uden spor, 2 hvor optællingen er nyere.

> **Grocys `stock_log` giver HTTP 500 — men kun uden `limit`.** `/objects/stock_log`
> og `?limit=100000` fejler på 0,4 s (hele tabellen, ~75.000 rækker, læses ind før
> den skæres til); `?limit=20000` svarer på 0,7 s med 9 MB. Det er altså ikke
> datamængden men det manglende loft. Kald loggen altid med `limit` + `query[]`
> (type, dato) — som scriptet gør. Der er intet at rette i Grocy for det.

> ⚠️ **`stock_log.row_created_timestamp` er LOKAL tid**, mens `LastCheckedAt` er UTC
> med `Z`. Bekræftet mod data: optællingens stempler 17/7 kl. 14:06–14:29Z ligger ud
> for log-rækker kl. 16:10–16:30 — præcis to timer (CEST). Skrives loggens tal råt,
> bliver hvert stempel to timer for nyt. Scriptet konverterer Europe/Copenhagen → UTC.

> ⚠️ **`/stock`'s indlejrede `product` har INGEN userfields.** Første udgave læste
> `LastCheckedAt` derfra og viste "aldrig tjekket" på alt — fundet i browseren, ikke
> af testen. Userfields skal læses fra `/objects/products` (`_soProductsMap`).
> Testen har nu et indlæsnings-scenarie der fælder netop det.

**Tests:** `npm run test:last-checked` — 57 asserts. `stock_overview.js` køres i en
vm-sandkasse med stubbet API (browser-kode kan ikke `require`s); gem-stien, filter,
sortering, rendering, indlæsning og backfill-scriptets rene regler.
**Mutations-testet:** ni kerneregler rulles hver især tilbage og fælder 1–5 navngivne
asserts. Regression grøn: `test:run-optaelling` 112/0. Browser-verificeret mod
grocytest: Gem uden ændring → toast "Ingen ændring · tjek registreret", `✓ i dag`,
stemplet landet i Grocy med enheden urørt (rullet tilbage bagefter); pille og
sortering virker.

**Deploy:** kør `npm run backfill:sidst-tjekket` på serveren (dry-run først, så
`--apply`) efter deploy — ellers ser alt forfaldent ud den første uge.

### Inaktive varer kan genaktiveres fra lageroversigten (#615, 14. september 2026)

Optællingens "Varen findes ikke mere" sætter lageret til 0 og markerer varen **inaktiv**
i Grocy — den slettes ikke. Men inaktive varer var filtreret helt ud af lageroversigten,
så den eneste vej tilbage var Grocys eget UI, og ✎-modalens Aktiv-felt kunne i praksis
kun bruges til at deaktivere.

- **Pille "N inaktive"** i statusbaren viser en egen liste; søg/lokation/gruppe virker
  ovenpå. Total-pillen tæller fortsat kun aktive — ikke det viste udsnit.
- **Inaktivt kort**: dæmpet, stiplet kant, `inaktiv`-badge, intet justeringspanel (intet
  lager at rette), og `↺ Aktivér` ved siden af ✎ i én række, så kortet ikke vokser.
  Knappen sender **kun** `{active: 1}` — lageret røres ikke; det står på 0 efter
  "findes ikke mere", og næste skridt er brugerens.
- **✎-modalens Aktiv-felt virker begge veje**: varen flytter mellem de to lister i
  stedet for bare at forsvinde ved deaktivering.
- **Én item-bygger** (`_soItemFromProduct`) deles af "Tilføj vare", inaktiv-listen og
  genaktivering. `_soProductsMap` rummer nu ALLE produkter (så ✎ kan åbne en inaktiv);
  `_soAllProducts` er fortsat kun aktive. En inaktiv vare med lagerpost holdes ude af den
  aktive liste — før stod den der, fordi `/stock` ikke filtrerer på `active`.

**Tests:** `npm run test:stock-inactive` — 35 asserts (vm-sandkasse). Mutations-testet:
seks kerneregler fælder hver 1–5 asserts. Sletning af produkter skal fortsat ske i Grocy.

### DAWA-adressesøgning: København først (15. september 2026)

Adresselisten i bon-draweren, tilbud, events, Kunde 360°, prisberegneren og på
kundernes bestillingsside viste dem der lå længst væk først — og var kort.
"Vesterbrogade 10" gav Viborg, Kolding, Gilleleje og otte etager i Hedensted;
København V var der slet ikke. Målt mod DAWA: **heller ikke blandt de første 30**,
så at hente flere og sortere klient-side hjælper ikke — adressen mangler i svaret.

- **`dawaAutocomplete(q, {limit, fuzzy})`** i [shared/utils.js](shared/utils.js) spørger
  DAWA **to gange parallelt**: afgrænset til hovedstadsområdet (`kommunekode`-filter,
  20 kommuner) og uden filter. Lokale hits først, resten bagefter, **hver blok sorteret
  efter postnummer** (laveste = København), dubletter på adresse-id fjernet, 10 forslag.
  Fejler den lokale forespørgsel, vises den globale alene — ranking-laget må ikke
  vælte søgningen.
- **Fælde:** DAWA svarer **0 hits** når `fuzzy=true` kombineres med et filter. Den
  lokale forespørgsel kører derfor altid uden fuzzy; kun den globale får det.
- Fem call sites bytter deres `fetch` ud én-til-én (samme item-form `{tekst, adresse}`):
  bon_drawer, crm-kunde360, events, logistik (prisberegner), tilbud.
  **`public/embed/bestilling.html` bærer en KOPI** (`dawaSearch`) — siden er single-file
  uden imports. Testen asserterer at kopien giver samme svar som utils.js.
- **Tilbud gemmer nu adressen fra DAWA's felter**, ikke ved at splitte teksten på
  komma/mellemrum. Splitningen gav husnr `"1."` på etage-adresser
  (`Vesterbrogade 10, 1., 1620 …`) og aldrig koordinater. Kaldte desuden det
  generelle `/autocomplete`-endpoint og læste `d.adresse.href`, som ikke findes dér.

**Tests:** `npm run test:dawa` — 12 asserts (den rigtige utils.js i vm-sandkasse med
fetch-attrap + paritet mod bestillingssidens kopi). Mutations-testet: fem
tilbagerulninger (global først · lokal fuzzy · ingen dedupe · ingen postnr-sortering ·
kommuneliste drevet fra hinanden i kopien) fælder hver sine navngivne asserts.
Browser-verificeret mod live DAWA i bestillingsside, bon-drawer, tilbud og prisberegner;
adresserne lander i `addresses` med rigtige felter og koordinater.

**Ikke rørt:** `tools/bestilling_v2.html` (den gamle formbuilder-formular, ude af drift).

### Pengestrøm: "Udestående" var for højt — nummer-match, aldrig sendte og et sync-hul (15. september 2026)

Kortet sagde 189.331 kr / 47 fakturaer. Kontoret vidste at mange af dem var betalt —
bare ikke bogført hos e-conomic endnu, og det er netop mellem de opdateringer
pengestrømmen skal hjælpe. Målt mod en kopi af driftsdata gik tallet til
**132.910 kr / 36** uden at røre én e-conomic-bekræftet betaling. Fire ting lå bag:

1. **De aldrig sendte talte med.** `outstanding` var `SUM(beloeb) WHERE betalt = 0` —
   inkl. de 7 "aldrig sendt"-fakturaer (#319, 45.366 kr) som "Forfaldne" allerede
   holdt ude. `outstandingFigures()` i `routes/cashflow.js` er nu ét sted for
   udestående / sandsynligt betalt / forventet ind, og de to første udelader
   `NOT_INVOICED` som Forfaldne gør.
2. **Bank-matchet så aldrig e-conomics fakturanummer.** `runMatchLogic` sammenlignede
   bankens cifre med `inv.id` — der er `"B4145"`, aldrig ens med `4131`. Så
   "FAKTURA 4131" (2808,75) blev et beløbs-gæt på B4228, mens B4145 — som ER 4131 —
   stod udestående. "FAKTURA 4174" havde med conf ≥ 70 markeret den **forkerte**
   faktura betalt. `matchByEconomicNumber` kører nu FØRST ved CSV-upload og:
   vinder over beløbs-gæt (conf < 95; manuelle 100 røres aldrig), **markerer betalt**
   (bankens virkelighed før e-conomic er ajour), måler beløbet mod e-conomics eget
   bruttobeløb fra spejlet, og kobler også via spejlets overskrift (`#B4130`) når
   ingen cf_invoice bærer nummeret.
   > ⚠️ **Tilbagerulning kræver at e-conomic selv siger "åben".** Første udgave rullede
   > en faktura tilbage når den kun var betalt af den flyttede tx (samme dato, ingen
   > anden postering). Mod driftsdata ramte det 25 fakturaer e-conomic HAVDE bekræftet —
   > afstemningen daterer nemlig en bekræftet betaling med bankposteringens dato, så
   > datoen kan ikke skelne "gættet" fra "bekræftet". Nu kun når spejlets `remainder > 0`.
   > Og betalt markeres i et **andet pas**, efter alle flytninger — ellers kan en faktura
   > der først rulles tilbage og så får sin rigtige postering ende som ubetalt.
3. **Fakturabeløbet var bonens, ikke fakturaens.** Ældre `cf_invoices.beloeb` mangler
   leveringen (total_price uden delivery_price), så nummer-matchet faldt på
   beløbstolerancen og kortet summerede forkerte tal. `reconcile` retter beløbet til
   e-conomics `gross_amount` for 1:1-koblede numre (aldrig samlefakturaer — kan ikke
   fordeles). `amountsCorrected` i svaret.
4. **Sync-hul: enhver bon-opdatering nulstillede "betalt".** `syncCashflowInvoice`s
   UPDATE skrev `betalt = <fra bon-status>` — så en bank-bekræftet betaling forsvandt
   igen når nogen rettede `delivery_price` på en FAKTURERET bon. Betalt kan nu kun
   gå OP herfra, og et beløb med e-conomic-nummer overskrives ikke fra bonen.

**Synligt for kontoret:** kortets undertekst siger "36 fakturaer sendt, ikke betalt ·
7 aldrig sendt holdt ude" og — som klikbar linje — "N ser betalt ud i banken (X kr) —
bekræft →", som åbner fanen *Sandsynlig betalt* (tallet er fanens eget). Det er den
manuelle vej: beløbs-gæt bekræftes af et menneske; nummer-verificerede står der aldrig,
de er allerede betalt. Afstemningens kvittering nævner nu "markeret betalt ud fra
banken", "flyttet fra en faktura de var gættet på" og "fakturabeløb rettet".
Uenigheds-linjen hedder "betalt i banken, men står stadig åbne hos e-conomic" — det er
den forventede tilstand, ikke en fejl.

**Hullet i nummer-koblingen (fundet ved drifttest samme dag).** Numre blev kun koblet
fra delta-scanningen af *nye* fakturaer. Var Bon-bonnen ikke faktureret i Bon endnu da
e-conomic-fakturaen blev scannet, var der ingen række at skrive nummeret på — og
vandmærket rykkede videre, så der blev aldrig spurgt igen. Fakturaen stod derefter som
"åben hos e-conomic uden kobling i Bon" (drift: #B4169, #B4130, #B4226, #B4194, #B4256,
#B4253), og bankposteringen "4159" (6.554 kr) lå som usikkert gæt på B4169. Den ubetalte
liste er fuld tilstand og bærer samme overskrifter, så `reconcile` kobler nu også fra den
(`linkInvoice` er én funktion for begge kilder; tæller ikke som scannet, rykker ikke
vandmærket). Reconcile-testen 48/0, +7 asserts.

**Manuel kobling af e-conomic-fakturaer uden bon-nummer (Derby-casen).** De fakturaer
der er tilbage på listen "åbne hos e-conomic uden kobling i Bon" har intet bon-nummer i
overskriften ("Madbilletter til Derby") og kan kun kobles af et menneske. Listen lå før
kun i afstemningens alert og kunne ikke handles på. Nu ligger den som et panel på
Overblik (`GET /api/cashflow/economic/unlinked` — ud fra spejlet, uden netværk) med
bon-nummer-felt + Kobl (`POST /api/cashflow/economic/link`). Reglen i `linkEconomicInvoice`:
har bonens cf_invoice intet nummer, sættes det dér (beløbet bliver e-conomics); har den
allerede ét — Derby: 4202 + 4204 til B4255 — oprettes en **ekstra række uden bon_id**, så
sync'en ikke rører den og afstemningen ejer den via nummeret. Betalt-status følger
e-conomic i samme greb: åben dér uden bankpostering bag → ubetalt igen. Det er den ene
situation hvor et beløbs-gæt må rulles tilbage uden e-conomic-nummer på rækken: B4255 stod
"betalt" af "FAKTURA 4186" (som er B4128), og et menneske har netop sagt hvad den rigtige
faktura er. Bank-matchet kører bagefter, så en postering med nummeret i teksten kobles med.
Kan ikke kobles til to bons (409). Sync-testen +17 asserts (100 PASS).

**Deploy:** ingen migration. Tryk **⟳ Synk e-conomic** én gang efter deploy — den kører
nummer-matchet på de eksisterende bankposteringer (driftskopien: 106 koblinger, heraf
4 nye betalte og 74 historiske omkoblinger uden ændret betalt-status) og retter beløbene.

**Tests:** `npm run test:cashflow` — sync 83 PASS (de 4 FAIL er de kendte
90-dages-fixtures), reconcile 41/0, rytme 18/0, ledger 25/0 + 23/0. Mutations-testet:
ni tilbagerulninger (kun-ukoblede, ingen betalt-markering, beløb mod bonens tal, ingen
tilbagerulning, tilbagerulning uden e-conomic-krav, ét pas, sync-nulstilling,
sync-overskrivning, aldrig-sendte med igen, ingen beløbsrettelse) fælder hver 3–12
navngivne asserts. Browser-verificeret mod en kopi af driftsdata; kopien og `.env.test`
slettet efter brug.

## Næste opgave

> ✏️ Tracker-oprydning 29. juni 2026 — koden er på migration 119; status-sektionen ovenfor
> stoppede ved 21. maj. Bygget men nu efterdokumenteret (egne sektioner ovenfor):
> **Driftsregnskab, Produktionsbatch, E-conomic-adapter, Lobo/Byekspressen, Outreach+CRM-triks,
> Event-modul.** 6 GitHub-issues lukket som færdige (#64, #70, #71, #77, #85, #132). 30 issues
> stadig åbne.
>
> **Reelt tilbageværende arbejde (verificeret mod kode 29. juni):**
> - **CO₂-epic #88 (#105–113)** — ✅ **F0–F7 KOMPLET og merget** (16. juli 2026). Se sektionen "CO₂-modul" ovenfor for detaljer. Kort: råvarefaktorer importeret fra Katrines CONCITO-ark, beregningsmotor (opskrift-CO₂ = Σ kg×faktor), frosset snapshot pr. bon, transport-CO₂, og en Office-rapport under CO₂-sektionen (dækning · datakvalitet · CO₂ over tid m. kategori-stak · pr. opskrift m. drill-down pr. råvare · synonym-panel · emballage-tildeler · vejeværktøj). **Kun F8 (ESG-eksport) mangler — og det er bevidst et separat eksternt modul** der trækker data fra Bon, ikke en CO₂-pill (Leifs beslutning). **De reelle udeståender er DATA, ikke kode:** (1) køkkenet skal veje ~22 tælle-varer (værktøj: CO₂ → Vej tælle-varer), (2) Katrine skal levere emballage-faktorer fra Klimakompasset + B-listen af krydderi-faktorer. Dækningen stiger af sig selv når de lander. Spec: `docs/CLAUDE_CO2.md`
> - **Festival/multi-lokation #81 (#98–103)** — ~20 % færdigt. `locations`-tabel + `getGrocyConfig(locationId)` findes; festival-specifikke dele (flags `multi_location`/`festival_enabled`, transfer HQ↔Trailer, afstemnings-view) er ustartede. Event-modulet ER IKKE Festival (separat "let event fra HQ"-model). Bygges lidt senere. Spec: `docs/festival/`
> - **Form Builder #82 (#119–125)** + **field-type-engine #79** — kun spec (`docs/formbuilder/`), ingen kode
> - **Kunde-portal #83 (#89–97)** — kun spec (`docs/kunde-portal/`), kun `external_ref`-kroge findes
> - **Menu-agent #78** — kun spec (`docs/CLAUDE_MENU_AGENT.md`), ingen Anthropic-SDK-brug
> - **Mindre features:** #236 leveringsomkostnings-rapport, #165 indkøbs-forecast, #215 leveringsafstand fra bons, #136 Grocy-SSO-genvej
> - **Tech-debt:** #237 fælles `createBon()`-helper (bon-oprettelse duplikeret i 5 routes), #72 slet ubrugt `services/hokaAdapter.js`, #133 6 tidszone-follow-ups (14 `toISOString().slice` tilbage), #194 bug (drift-levering-tal er incl-moms salgspris)
> - **Test-specs:** #74 T_CRM, #75 T_CASHFLOW (sidste 2 tracks)
> - **Ops/ekstern:** #84 Delivery go-live (kør `backfill-geocode.js` mod prod + udfyld templates), #60 Booking-deploy (cron + settings + CORS), #66 Inco-creds, #73 Grocy-audit Trailer+Test, #234 geokod ~425 v1-adresser, #69 malware credential-rotation (memory)
>
> **Delivery Spor 2 KOMPLET (S2.0-S2.3, 21. maj 2026).** ORS-vej-routing, DAWA-geokodning, `route_planner`, rute-endpoints, logistik-viewet med Leaflet-kort + historik-heatmap, fælles pickup-model, drag-drop rute-planlægning, delt logistik (køkken + office), courier-mobil (`mobile/views/levering.js`) med depart/leveret/problem-flow, og logistik live-mode. 222 delivery-tests grønne, browser-verificeret end-to-end. Detaljer i Status-sektionen "Delivery — Spor 2". **Mangler kun S2.4** (By-expressen API) som afventer Sebastians credentials — Spor 2 fungerer fuldt uden den via manuel popout-booking. `scripts/backfill-geocode.js` skal køres mod prod-DB før go-live.
>
> **Fase 1a–1e + 3A + 3B + 3D + 4 + 5 + 6 (komplet inkl. 6g) + 7 (CRM) + Office CRM redesign + 8 (Fakturering) + 9 (Tilbud) + Mail-vedhæftninger + CRM service-kald + Firma-oprydning + 10 (Mobil Shell) + 10b (Roller & Rettigheder) + 11 (Ugeoversigt) + Priser i planlægningsbon + Hjælpesystem + Whiteboard Sidekick + Web-bestillinger (webhook) + Mail-skabelon management + 12 (Rapporter) + PIN-management + CVR-berigelse (653/1232 firmaer) + 13 (Cashflow) + Mail chat-boble layout + Embed-bestillingsformular + Delivery Spor 1 (manuel bestilling) + Moms-refaktorering + Kontakter & Firma 360° + Test-suite (Fase 1+2+3 minus CRM/Cashflow) + Office sidebar v2 + Density toggle + Bon-kort redesign + Margin-analyse + Mobile Nye pending-inbox + Office UX-fixes (status-farver, SSE bons-list, responsive sidebar, drawer historik + expandable notes, web-order toast) + Kunde-flags (alle 7 faser) + Kalender-opgradering (status som baggrund + total øverst + kalender-density) komplet.**
>
> **Test-suite: KOMPLET for 6/9 office-tracks (13. maj 2026).** 437 PASS · 0 FAIL · 3 SKIP. 9 patches anvendt (A–I) der lukkede 30+ findings inkl. SSE-payload-konsistens, privilege-escalation i force-mode, partially_approved-status, tilbud-modul-konsistens. 0 åbne medium+ findings tilbage. Detaljer i `docs/TEST_OBSERVATIONS.md` og hver `tests/specs/T_*.md`. Resterende: T_CRM, T_CASHFLOW, T_V1_AFSTEMNING (weekenden).
>
> **Moms-refaktorering: KOMPLET (1. maj 2026).** Tilbuds-prisbug der lagde 25 % oven på incl-priser er rettet og forebygget. 13 områder migreret til `Moms.*` helpers, pre-commit-hook aktiv, 28-områders audit-suite (`tests/moms_audit_e2e.test.js`) grøn. To latente bugs fundet undervejs (#003 + #008 i `KENDTE_DATABUGS.md`). Visningsregler + autoritativ regel i `BON_V2_PRINCIPPER.md` sektion 6b+6c.
>
> **Kontakter & Firma 360°: KOMPLET (april–maj 2026).** Polymorf `contact_points`-tabel + Firmaer-fane parallelt med Kunder + Firma 360°-side med berig-knap (CVR-diff-merge med checkbox-bekræftelse). Web-scraping nedgraderet til manuelt paste-flow. CVR-kontaktpunkter altid `is_public=1` (offentlige); manuelt indtastede default'er til `is_public=0` (juridisk sikker default for cold outreach). Backfill kørt mod alle eksisterende firmaer + kunder.
>
> **E-conomic-adapter (`docs/CLAUDE_ECONOMIC_ADAPTER.md`)**: spec klar, ikke bygget. Kort fil — moms-konvertering (`inclToExcl()` på linje-priser), payload-format, success-flow (gem `invoice_number`, skift status til FAKTURERET). Test-placeholder #7 i `moms_audit_e2e.test.js` aktiveres når koden bygges.
>
> **Menu-agent (`docs/CLAUDE_MENU_AGENT.md`)**: spec klar, ikke bygget. AI-agent der oversætter kundens fritekst-ønsker til bon-linjer. Strikt regel: agenten må IKKE returnere priser — kun `product_name`, `quantity`, `grocy_recipe_id`, `category`/`block_type`. Server snapshot'er priser ved insert.
>
> **Delivery — Spor 1 (manuel bestilling): KOMPLET inkl. popout-vindue (19. maj 2026).** Office kan nu bestille bud (By-expressen, Taxa) direkte fra bon-drawer i både kitchen og office. **Felt-for-felt-popout:** Klik "📦 Bestil hos…" åbner et separat popup-vindue (`/delivery/note/:bon_id`) der kan placeres ved siden af leverandørens hjemmeside. Hvert felt rendres som klikbar chip (klik = kopier til clipboard). By-expressen bruger step-grouping ("Trin 2: Afhentning" / "Trin 3: Levering") så kontoret ser præcis hvilke felter der hører til hvilket Lobo-trin. Sammensatte felter (fx `{bon_id} · {total_boxes} kasser`) pakker flere variabler i ét felt. Toggle til "Samlet tekst"-mode for legacy-flow. Manglende felter markeres som `[mangler]` + ⚠-ikon + ikke-klikbare. Leveringsindikator på bon-kort viser hvem der henter (🚴 By-expressen / 🚕 Taxa) eller "📍 Ikke planlagt endnu". Klik på indikator åbner drawer scrollet til BESTIL BUD. `bons.delivery_method` synkroniseres automatisk fra valgt vehicle.type — alle eksisterende lister/filter/displays virker uændret. 84 unit + 46 integration tests grønne. Den gamle `shared/manual_booking_modal.{js,css}` er slettet. Næste: udfyld templates + felt-konfiguration via Settings → Leveringsmetoder før første brug.
>
> **Embed-bestilling: KOMPLET.** Erstatter JotForm på `ristetrug.dk/bestil`. iframe på `bon.ristetrug.dk/embed/bestilling` med config + menu hentet live fra `settings`-tabellen. Foldout, quick-chips, inline menu-picker med allergen-toggle, sandwichvalg-subtekst, DAWA-autocomplete, OSRM-leveringsestimat, smart cutoff-logik (per-ugedag delivery_days + cutoff_days), postMessage høj-resizer. Webhook bagudkompatibel — gamle formularer fortsætter med at virke. Strukturerede `menu_items[]` sendes parallelt med tekst (klar til automatisering). Settings-UI til menu-redigering (kategorier, tags, allergener) — ingen WordPress-redeploy ved ændringer. Næste skridt: Leif erstatter JotForm-iframe i DIVI med snippet fra `docs/wordpress_divi_snippet.html`.
>
> **Fase 14 — Booking-modul: KOMPLET (alle 14 milepæle).** End-to-end booking-flow verificeret fra sælger-mail → kunde-klik → submit → bekræftelse → reminder-cron. Sælgere kan indsætte personligt booking-link i CRM Kunde 360° fritekst-mail. Admins kan konfigurere alt via Settings (mødetyper, kontaktårsager, slot-logik, default-ejer, erindringsindstillinger, intro/thankyou-tekster). Cron-script `scripts/booking-reminders.js` kører hver hele time og sender erindringsmail N dage før møder. Hardening: usædvanlig token-aktivitet logges. Bon v2's booking-modul er klar til deploy.
>
> **Bon v1 → v2 cutover er sket (26. maj 2026).** v2 er nu i drift som det primære system. Resterende arbejde er drift-stabilitet, deploy-opgaver og test-afdækning.
>
> **Åbne afhængigheder:**
> - DMI API-nøgle (vejr på dashboards) — Leif finder frem til eksisterende nøgle (Open-Meteo bruges midlertidigt)
> - ~~Bon v1-datamigration~~ — afsluttet ved cutover; sync-v1.js cron kan slukkes når Leif bekræfter
> - Byekspressen credentials — ryk sebastian@by-expressen.dk (blokerer Spor 2's 3D.5, ikke Spor 1)
> - **Delivery Spor 1 deploy**: Office skal udfylde 1) `booking_template` (samlet tekst fallback) og 2) felt-konfigurationen (`booking_fields_json` — felt-editor under hver vehicle) for By-expressen + Taxa via Settings → Leveringsmetoder. Seed-data ligger der allerede efter migration 071, men juster ud fra hvilke felter office faktisk paster ind hos leverandøren. URL'er er allerede sat (`https://byexpressen.groupnet.at/lobo/#!//coreLogin/` + `https://taxa.nu/`).
> - ~~Formbuilder webhook-URL + HTML til ristetrug.dk/bestil~~ — embed-formular klar på `bon.ristetrug.dk/embed/bestilling`, indlejres via DIVI Code Module (snippet i `docs/wordpress_divi_snippet.html`)
> - **Embed-bestilling deploy**: Leif erstatter JotForm-iframe i WordPress DIVI med snippet'et fra `docs/wordpress_divi_snippet.html`. Ingen WordPress-redeploy nødvendig ved menu-ændringer derefter — alt styres fra Settings → Bestilling — Menu.
> - Formbuilder field-type-engine (`grocy_product_picker`, `chip_group`, `info_box`, `option_group`): erstatter den hardcodede `embed/bestilling.html` med rigtige field-types. Spec skrives separat. Ikke akut — den nuværende embed-form fungerer indtil videre.
> - ~~Whiteboard API URL~~ — `WHITEBOARD_BASE_URL` i `.env`, Sidekick henter via `/api/sidekick/config`
> - Whiteboard CORS: tilføj `https://bon.ristetrug.dk` til `ALLOWED_ORIGINS` i Whiteboard's `.env` ved deploy
> - ~~Hørkram credentials~~ — `HOKA_USERNAME` + `HOKA_PASSWORD` sat i `.env`
> - ~~CVR review~~ — 653 firmaer har CVR (429 auto + 224 manuelt reviewet). 77 CVR-duplikat-grupper er forventede (afdelinger under samme CVR). Yderligere review kan gøres via `tools/cvr-review.html`
> - Inco credentials — til webshop-login (har også API, men bruges ikke endnu)
> - `services/hokaAdapter.js` — bruges ikke af bestillingsflowet (erstattet af proxy-logik i `routes/horkram.js`). Review om den skal slettes eller beholdes til andre formål.
> - **Booking-modul (Fase 14)**: ved deploy skal cron-job konfigureres: `0 * * * * cd /home/leif/bon-v2 && node --experimental-sqlite scripts/booking-reminders.js >> logs/reminders.log 2>&1` — scriptet exit'er stille hvis modulet er deaktiveret eller hvis time ikke matcher `booking_reminder_send_at_time`.
> - **Booking-modul**: `booking_public_url_base` (settings-felt) skal sættes til `https://bon.ristetrug.dk` ved deploy — ellers virker `{{booking_link}}` ikke korrekt i mails. Konfigureres via Settings → Booking — Smagsprøve. Den skal blive på app-domænet: den bygger også office-links i interne mails. Skal kunderne have et pænt domæne, sættes `booking_customer_url_base` i stedet (fx `https://kontakt.ristetrug.dk`), og det domæne skal have en vhost der bærer `/book/*` og `/b/:token` — se `deploy/hetzner/nginx/sites-available/kontakt.ristetrug.dk.conf`.
> - **Booking-modul**: `booking_default_owner_user_id` skal sættes via Settings UI før public-flowet virker. Submit-webhooks 503'er ellers.
> - **Booking-modul**: ved deploy skal `https://bon.ristetrug.dk` (eller den valgte URL hvor `/book/*` hostes) tilføjes til `WEBHOOK_ALLOWED_ORIGINS` i `server.js` hvis kunden lander på et andet domæne (fx ristetrug.dk-iframe). I dag er ristetrug.dk allerede inkluderet.
> - **T_CRM-spec**: scope er routes/companies.js + routes/crm.js (callbacks, call-log, kunde-relations). Større suite — kandidat efter weekenden
> - **T_CASHFLOW-spec**: routes/cashflow.js (admin-only CSV-upload, faktura-CRUD, bank-matching). Stort scope
> - **T_V1_AFSTEMNING**: ikke længere cutover-blokker (cutover sket 26. maj 2026). Kan stadig være nyttig som baseline-snapshot ved mistanke om data-divergens — prioritet sunket
> - **F75-F80** (T_DASHBOARD): forventede findings der IKKE materialisede — dashboard-koden er allerede mere moden end forventet. Ingen patch nødvendig
>
> **Åbne design-beslutninger:**
> - shared/-mappe opdeling i undermapper — udskydes til senere refaktorering
> - ~~orders.js migrering fra JSON-fil til SQLite~~ — routes/orders.js bruger SQLite (tools/bestiliing/orders.js JSON-version er deprecated)
> - **Mobil-zonen har SSE-realtid** (`mobile/index.html` lytter på `bon_created`/`bon_updated`/`bon_status`/`mail_received` og dispatcher til `_mbHandleSSE` i bons-view + opdaterer "Nye"-tælleren i bundnav). Ikke alle views har endnu en `_m{view}HandleSSE` (oversigt/crm/levering er guardet med `typeof === 'function'` så de er no-ops indtil de tilføjes). Mønster ved nye view-handlers: extract `bon_id`, re-load hvis aktivt åbent, debounced ellers (se `_mbHandleSSE`).
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
> - Planlægningsbon priser: salgspriser fra Grocy er INKL. moms (25%), kostpriser er EKSKL. moms — margin beregnes altid på salg u/moms vs. kostpris
> - Planlægningsbon: moms-toggle (m/moms ↔ u/moms) på linje-priser, footer altid faktura-format (Netto, Moms 25%, Total inkl. moms, Kostpris, Margin %)
> - Booking-modul: to separate flows (smagsprøve med kalender, kontakt uden kalender) — ikke ét generelt
> - Booking-modul: bon = deal-mønstret fastholdes — booking opretter `crm_activity` med `type='meeting'` (smagsprøve) eller `type='task'` (kontakt). Ingen ny "bookings"-tabel.
> - Booking-modul: `done_at IS NULL` udtrykker "planlagt" (matcher 019-skema og index `idx_crm_act_pending`). Spec'ens `outcome='planned'` blev IKKE implementeret — kolonnen findes ikke. Patch P1 i `docs/CRM_Booking_Spec_v2_PATCH.md`.
> - Booking-modul: `result='callback'` for kontakt-tasks med reason `ring_op` — så de lander i `v_callbacks_pending` og dukker op på "Ring tilbage"-listen automatisk. Andre årsager får `result=NULL` (almindelige tasks).
> - Booking-modul: `meeting_types` og `contact_reasons` er konfigurerbare opslagstabeller med `is_system`-flag (samme mønster som `activity_purposes`). System-typer kan ikke deaktiveres i UI. Public side filtrerer på `is_active=1 AND is_bookable=1` så admin kan skjule typer uden at slette.
> - Booking-modul: takkesider og intro-tekster gemmes i `page_templates`-tabel med `{{variabel}}`-substitution (analog til `mail_templates`, men med `title` + `body_text`, ingen `subject`)
> - Booking-modul: `booking/smagning.html` + `booking/kontakt.html` hostes offentligt på `/book/smagning` og `/book/kontakt` (flyttet fra `tools/` i september 2026, da `/tools` er bag login og blokeret i nginx på prod).
> - Booking-modul: GET-endpoints (meeting-types, contact-reasons, slots) returnerer `{available:false, reason}` i stedet for 503 ved disabled/unconfigured — kun submit-webhooks 503'er. Patch P3.
> - Booking-modul: `/webhook/*` mountes med samme CORS-middleware som web-orders (allowed origins: ristetrug.dk + bestil-form.netlify.app). Ny path-prefix: `/webhook/booking-smagning` + `/webhook/booking-kontakt`.
> - Booking-modul: race-condition guard i webhook — slot-tjek + INSERT i samme transaction (`db/compat.js` `transaction(db, fn)`). Patch P2.
> - Booking-modul: slot-beregning respekterer dagens bons (pickup_time/delivery_time + buffer-zoner fra settings) + planlagte meetings. Algoritme i `services/bookingMatcher.js`.
> - Booking-modul: `booking_default_owner_user_id` SKAL være sat før public submit-webhooks virker (returnerer 503). Public GET-endpoints viser bare `{available:false, reason:'unconfigured'}`.
> - CRM Dashboard: nyt panel "Kommende bookede møder" (full-width, viser tid + kunde + mødetype + booking-kilde) + briefing-tæller "🤝 X bookede møder denne uge". SSE re-loader ved `crm_activity_created`.
> - CRM Kunde 360°: meeting-aktiviteter er klikbare → modal med fuld detalje. Timeline viser `due_at` (mødetidspunkt) i stedet for `created_at` for meetings. "Næste event"-stat inkluderer både fremtidige bons og planlagte meetings.
> - Booking-modul status (29. apr 2026): KOMPLET. M1–M12 + M5b/c implementeret og verificeret end-to-end via `scripts/test-booking-e2e.js`.
> - Booking-modul M7 (28. apr 2026): `renderTemplate` blev holdt synkron (vs. spec'ens async) — `node:sqlite` + `crypto.randomBytes` er begge sync, så ingen kaskaderende async-spredning. `{{booking_link}}` fjernes uden synlige rester hvis `customerId` eller `booking_public_url_base` mangler (advarsel logges). Pre-eksisterende drop-bug i `sendFromTemplate({ smtpPrefix })` blev fixet som side-gevinst — tidligere faldt `routes/orders.js`'s `'smtp_kontakt'`-flag silent ned til `bon@`. Booking-bekræftelse + intern notif sendes via `smtp_kontakt` med thread-context `{ type: 'customer', number: customerId }` så `#k-NNN`-tag i subject sikrer korrekt IMAP-routing ved kundens svar.
> - Booking-modul M8 (29. apr 2026): Kort URL-format valgt fremfor HTML-mails (spec sektion 12 fastholdes — plain-text kun). `/b/:token` mountes som standalone `routes/booking-redirect.js` på app-root, ikke som del af `bookingRouter` (ellers ville `/b/meeting-types` etc. utilsigtet være eksponeret). Open-tracking sker KUN i `GET /api/booking/token/:token` (kaldes af JS efter sidereload), ikke i `/b`-redirect — så vi ikke dobbelt-tæller når kunden lander via kort URL. `sendBookingMails` videregiver nu `userId: ownerId` til `sendFromTemplate` så bekræftelsesmailens `{{booking_link}}`-token bindes til samme sælger som håndterede bookingen → personlig "du booker hos X"-banner. Frontend-banner title-caser fornavne (`leif` → `Leif`) for visningen. Mødetyper med `is_bookable=0` (gennemgang, smagning_gennemgang) er bevidst skjult fra public siden — de eksisterer som mødetyper for sælgere men kan ikke vælges af kunder online; sælgers token-intent vil pege på en bookable type.
> - **Moms-doktrin (1. maj 2026)**: Grocy-salgspriser er INCL. moms (autoritativt). DB gemmer INCL. moms (`bon_lines.unit_price`/`line_total`, `bons.total_price`, `delivery_price`) — `cost_price` er den eneste EX-moms-værdi i bon-domænet. Frontends og backend bruger udelukkende `shared/moms.js` helpers — ingen `* 1.25`/`* 0.25`/`/ 1.25` uden for helper-filen + `tests/`. Pre-commit-hook blokerer overtrædelser. E-conomic adapteren er den eneste kanal der konverterer til EX moms (linje-priser kræver det). Audit-suiten (`tests/moms_audit_e2e.test.js`) dækker 28 områder med T-5 testbon (23.650 incl → 18.920 ex + 4.730).
> - **Kontaktpunkter (april–maj 2026)**: Polymorf `contact_points`-tabel (entity_type = company|customer) erstatter den gamle "ét felt per email/phone på companies/customers". `companies.email`/`phone` + `customers.email`/`phone` beholdes som denormaliseret cache holdt i sync af 4 SQLite-triggers + `syncPrimaryCache()` helper. CVR/NemHandel-kontaktpunkter altid `is_public=1`; manuelt indtastede default'er til `is_public=0`. Backfill kørt: alle eksisterende felter migreret til `source='manual'`, `is_public=0`, `is_primary=1` (juridisk sikker default).
> - **Berig-knap = firma-handling**: Firma-berigelse (CVR-diff-merge) ligger på Firma 360°-siden, ikke på Kunde 360°. Kunde 360° viser firmanavnet som klik-link der navigerer til Firma 360°.
> - **Web-scraping nedgraderet (april 2026)**: Auto-fetch af URL'er er fjernet pga. robots.txt-, anti-bot- og GDPR-risici. Erstattet af manuelt paste-flow: bruger klistrer HTML/tekst ind, `services/contactExtractor.js` kører email/telefon-regex + heuristik, viser kandidater til checkbox-bekræftelse.
> - **E-conomic-adapter (spec klar, ikke bygget)**: Linje-priser konverteres til EX moms via `inclToExcl()` ved payload-build. `cost_price` er allerede ex moms — IKKE konverter igen. Adapter-flow: send payload → modtag faktura-nummer → gem på `bons.invoice_number` → skift status til FAKTURERET. Test #7 i `tests/moms_audit_e2e.test.js` er placeholder der aktiveres når koden bygges.
> - **Menu-agent (spec klar, ikke bygget)**: AI-agent må IKKE returnere priser — kun `product_name`, `quantity`, `grocy_recipe_id`, `category`/`block_type`. Server snapshot'er priser ved `POST /api/bons/:id/lines`. Hvis preview senere skal vise priser → udelukkende via `Moms.*` helpers + de 7 visningsregler.
> - **Delivery popout (19. maj 2026)**: Bud-bestilling er flyttet fra overlay-modal til **separat popup-vindue** (`window.open` med target `rr-delivery-note-${bonId}` så flere bookings kan håndteres parallelt). Hvert felt i popoutet er en mini-template med `{variabel}`-syntaks — sammensatte felter (`{bon_id} · {total_boxes} kasser`) tillader at pakke flere variabler i ét chip-klik. By-expressen bruger `step`-property til at gruppere felter pr. Lobo-wizard-trin. Bagudkompatibilitet: vehicles uden `booking_fields_json` viser kun "Samlet tekst"-mode. Frontend bruger `Array.isArray(payload.fields)` til at detecte konfiguration — ingen separat `_configured`-flag. `services/booking_template.js` har en intern `_renderWithMeta(template, vars)` der returnerer `{ text, hasMissing }`; `renderTemplate()` (eksisterende public API) er uændret signatur men implementeret via samme helper. Auth: separat `requireAuthRedirect` middleware i `routes/delivery_views.js` fordi `shared/auth.js`'s `requireAuth` er JSON-orienteret — HTML-popout redirecter til `/login.html?next=…` ved manglende session. Den gamle `shared/manual_booking_modal.js` er slettet uden feature-flag-periode — popoutet er funktionelt superset af modalen.
> - **Kunde-flags (19. maj 2026)**: Polymorf datamodel `entity_flags(entity_type, entity_id)` matcher contact_points-mønstret. To handlinger: `ack` (per-bon, lever videre — "Forstået"-knap) og `dismiss` (permanent — "Færdig — fjern"-knap). UI-wording bevidst valgt klarere end spec'ens "Set"/"Gjort". Strip auto-collapse: 1 flag = open, 2+ = collapsed. Bevarer brugerens åbnede tilstand ved ack/dismiss — nulstilles kun ved bon-skift via `setBonId`. Firma-flag vises på ALLE bons under firmaet (bevidst — fx "Fakturaer til Anne" skal popoppe overalt). Strippen vises på alle bon-statusser uanset om bonen er aktiv eller afsluttet — status-filter (`b.status_code IN (aktive)`) kan tilføjes senere hvis støj bliver et problem. Dismissed flag bliver synlige som læse-only items i Kunde 360° Aktivitet-tab; Firma 360° Aktivitet-tab er ikke implementeret endnu (kræver firma-aggregering af crm_activities).
> - **SSE-event-konvention (13. maj 2026)**: alle `bon_*`-events bruger `{id, ...metadata}`. Polymorfe events (`mail_*`, `po_*`, `supplier_*`) bevarer semantiske FK-navne (`bon_id`, `customer_id` etc.) fordi de kan referere flere entiteter. Frontend skal IKKE bruge fallback-pattern `data.id || data.bon_id` — vælg én eller den anden afhængigt af event-type.
> - **Force-mode auth (13. maj 2026, revideret aug 2026)**: force kræver en gyldig session — men ikke længere admin-rolle. Audit-user-id kommer fra `req.session.userId`, ALDRIG fra `body.user_id`: efter at rollekravet er væk, er auditsporet det eneste der peger på et menneske, så afsenderen må ikke kunne skrive en anden i historikken. Privilege-escalation-vektoren fra Patch D er stadig lukket.
> - **Partially approved (13. maj 2026)**: ny status-værdi på `goods_receipts` når mindst én item-Grocy-fejl. Bevidste skips (missing-status, no-pid) tæller ikke. UI-rendering kommer i Fase 3 varemodtagelses-listview.
> - **Tilbud-status convert-only (13. maj 2026, revideret 13. august 2026)**: `offer_status='won'` kan KUN sættes via `POST /api/quotes/:id/convert` — som nu opretter en NY bon (`source_quote_id`) og låser bilaget i stedet for at flippe `is_offer`. PATCH `/:id/status` accepterer kun draft/sent/lost/expired, og afvises helt (409) mens tilbuddet er låst.
> - **Test-spec-format**: Hver track har spec i `tests/specs/T_*.md` med 11 sektioner (formål, forudsætninger, strategi, cases, eksempel, fejlsignaler, filer, hvad-vi-ved, næste, status, findings). Findings nummereret F* (track-lokale), observations #NNN (globale i TEST_OBSERVATIONS.md).

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
PUT    /api/bons/:id/menu-groups { groups: [...] }       routes/bons.js (reconcile menu-gruppering)
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
GET    /api/grocy/userfields                             routes/grocy.js (alle entiteters userfield-meta)
POST   /api/grocy/products                                routes/grocy.js (opret produkt)
POST   /api/grocy/quantity-unit-conversions               routes/grocy.js (opret QU-konvertering)
POST   /api/grocy/stock/:id/add                           routes/grocy.js (initial lagerbeholdning + pris)
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
GET    /api/companies/match?name=&cvr=&ean=&email=       routes/companies.js ("findes allerede?" — matcheren, kun aktive; #612)
GET    /api/companies/:id                                routes/companies.js
POST   /api/companies                                    routes/companies.js (+address_id; e-mail/telefon → kontaktpunkter; changelog)
GET    /api/cvr/:cvr                                     routes/cvr.js
GET    /api/cvr/search?q=                                routes/cvr.js
GET    /api/cvr/ean/:ean                                 routes/cvr.js (NemHandel: registreret enhed + CVR; cvrapi: juridisk enhed)
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
GET    /api/mail/inbox?status=open|archived|all&q=       routes/mail.js (samlet indbakke + arkiv-søgning + suggested_customer)
POST   /api/mail/unmatched/:id/restore                   routes/mail.js (fortryd arkivering)
POST   /api/mail/threads/:id/move  {customer_id|bon_id}  routes/mail.js (flyt fejlkoblet tråd + lærte adresser)
POST   /api/mail/test                                    routes/mail.js (admin)
GET    /api/settings/locations                           routes/settings.js
GET    /api/settings/internal-senders                    routes/settings.js (admin — interne mail-afsendere + ramte kunder)
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
PATCH  /api/companies/:id/commercial                     routes/companies.js (stående rabat + forhandler-markering)
GET    /api/companies/:id/enrich-preview                 routes/companies.js (CVR diff uden gem)
POST   /api/companies/:id/enrich                         routes/companies.js (anvend delmængde af diff)
POST   /api/companies/:id/extract-contacts               routes/companies.js (paste-flow → kandidater)
PATCH  /api/customers/:id       { first_name?, last_name?, company_id? }  routes/customers.js
PATCH  /api/customers/:id/economic                       routes/customers.js
GET    /api/contact-points?entity_type=&entity_id=       routes/contact-points.js
POST   /api/contact-points                               routes/contact-points.js
PATCH  /api/contact-points/:id                           routes/contact-points.js
DELETE /api/contact-points/:id                           routes/contact-points.js (auto-promote næste primary)
PATCH  /api/contact-points/:id/toggle-public             routes/contact-points.js
GET    /api/flags?entity_type=&entity_id=&include_dismissed= routes/flags.js
POST   /api/flags                                        routes/flags.js (entity_type + entity_id + title + body?)
PATCH  /api/flags/:id                                    routes/flags.js (title/body — kun aktive flag)
POST   /api/flags/:id/ack                                routes/flags.js ("Forstået" — per-bon, UPSERT)
POST   /api/flags/:id/dismiss                            routes/flags.js ("Færdig" — permanent)
GET    /api/crm/companies                                routes/crm.js (Firmaer-fane aggregeret listview)
GET    /api/crm/company/:id                              routes/crm.js (Firma 360° detaljer + contact_points)
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
GET    /api/purchasing/suppliers/mail-overview?unread_only=  routes/purchasing.js
GET    /api/purchasing/suppliers/:id/mail                    routes/purchasing.js
POST   /api/purchasing/suppliers/:id/mail                    routes/purchasing.js (send fri kommunikation)
PATCH  /api/purchasing/suppliers/:id/mail/read               routes/purchasing.js
GET    /api/purchasing/suppliers/:id/mail-threads            routes/purchasing.js
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
GET    /api/goods-receipts/schema                          routes/goods-receipts.js (FVST-skema fra Whiteboard)
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
GET    /api/help-content                                   routes/help.js
POST   /api/help-content                                   routes/help.js (admin)
GET    /api/sidekick/config                                routes/sidekick.js
POST   /api/mail/templates                                  routes/mail.js (admin, opret)
DELETE /api/mail/templates/:key                             routes/mail.js (admin, slet)
POST   /webhook/bestilling                                 routes/web-orders.js (public, CORS)
GET    /embed/bestilling?menu=                             routes/embed.js (public, CSP frame-ancestors)
GET    /embed/config                                       routes/embed.js (public)
GET    /embed/menus/:id.json                               routes/embed.js (public, 60s cache, manual/grocy via menu_source)
GET    /embed/grocy-preview                                routes/embed.js (auth, tvungen Grocy-render til import-modal)
GET    /api/settings/bestilling/menu/:id                   routes/settings.js (admin)
PUT    /api/settings/bestilling/menu/:id                   routes/settings.js (admin, validér + auto-bump version)
GET    /api/web-orders?status=                             routes/web-orders.js
GET    /api/reports/summary                                routes/reports.js
GET    /api/reports/monthly                                routes/reports.js
GET    /api/reports/top-customers?by=revenue|orders        routes/reports.js
GET    /api/reports/categories                             routes/reports.js
GET    /api/reports/monthly-table                          routes/reports.js
GET    /api/reports/lego?months=&year=                     routes/reports.js
GET    /api/reports/cumulative                             routes/reports.js
GET    /api/reports/top-categories                         routes/reports.js
GET    /api/cvr/virk-search?q=                             routes/cvr.js (Virk ES proxy)
POST   /api/cashflow/upload                                routes/cashflow.js (CSV, admin)
GET    /api/cashflow/transactions?from=&to=&unmatched=     routes/cashflow.js (admin)
GET    /api/cashflow/invoices?tab=                         routes/cashflow.js (admin)
POST   /api/cashflow/invoices                              routes/cashflow.js (admin)
PATCH  /api/cashflow/invoices/:id                          routes/cashflow.js (admin)
DELETE /api/cashflow/invoices/:id                          routes/cashflow.js (admin)
GET    /api/cashflow/stats                                 routes/cashflow.js (admin)
GET    /api/cashflow/weekly                                routes/cashflow.js (admin)
POST   /api/cashflow/match/:txId                           routes/cashflow.js (admin)
DELETE /api/cashflow/match/:txId                           routes/cashflow.js (admin)
GET    /api/cashflow/analyse                               routes/cashflow.js (admin)
GET    /api/cashflow/payment-behavior                      routes/cashflow.js (admin)
GET    /api/cashflow/upcoming                              routes/cashflow.js (admin)
GET    /api/booking/meeting-types                           routes/booking.js (public)
GET    /api/booking/contact-reasons                         routes/booking.js (public)
GET    /api/booking/page-templates/:key                     routes/booking.js (public)
GET    /api/booking/slots?date=&meeting_type=               routes/booking.js (public)
GET    /api/booking/token/:token                            routes/booking.js (public, bumper open_count)
GET    /api/booking/meeting-types/intent                    routes/booking.js (auth, alle aktive types til CRM popover)
GET    /b/:token                                            routes/booking-redirect.js (302 → tools-side)
POST   /webhook/booking-smagning                            routes/booking.js (public, CORS)
POST   /webhook/booking-kontakt                             routes/booking.js (public, CORS)
GET    /api/booking/admin/meeting-types                     routes/booking.js (admin)
POST   /api/booking/admin/meeting-types                     routes/booking.js (admin)
PATCH  /api/booking/admin/meeting-types/:id                 routes/booking.js (admin)
GET    /api/booking/admin/contact-reasons                   routes/booking.js (admin)
POST   /api/booking/admin/contact-reasons                   routes/booking.js (admin)
PATCH  /api/booking/admin/contact-reasons/:id               routes/booking.js (admin)
GET    /api/booking/admin/page-templates                    routes/booking.js (admin)
PATCH  /api/booking/admin/page-templates/:key               routes/booking.js (admin)
GET    /api/crm/meetings/upcoming?days=&limit=              routes/crm.js
PATCH  /api/crm/activity/:id/done                           routes/crm.js
GET    /api/delivery/vehicles?include_inactive=             routes/delivery.js
GET    /api/delivery/vehicles/:id                           routes/delivery.js
POST   /api/delivery/vehicles                               routes/delivery.js (admin)
PATCH  /api/delivery/vehicles/:id                           routes/delivery.js (admin)
DELETE /api/delivery/vehicles/:id                           routes/delivery.js (admin, soft-delete)
GET    /api/delivery/template-variables                     routes/delivery.js
GET    /api/delivery/booking-payload?bon_id=&vehicle_id=    routes/delivery.js
POST   /api/delivery/book                                   routes/delivery.js
POST   /api/delivery/cancel                                 routes/delivery.js
POST   /api/delivery/actual-cost                            routes/delivery.js
GET    /api/delivery/events?bon_id=                         routes/delivery.js
POST   /api/delivery/calculate                              routes/delivery.js (single-bon forslag — Spor 2)
GET    /api/delivery/health                                 routes/delivery.js (ORS up/down)
GET    /api/delivery/overview?date=                         routes/delivery.js (leveringsoversigt)
GET    /api/delivery/routes?date=                           routes/delivery.js
POST   /api/delivery/routes                                 routes/delivery.js (opret tom tur)
PUT    /api/delivery/routes/:id                             routes/delivery.js
DELETE /api/delivery/routes/:id                             routes/delivery.js (kun draft/computed)
POST   /api/delivery/routes/:id/stops                       routes/delivery.js (tilføj stop)
DELETE /api/delivery/routes/:id/stops/:bon_id               routes/delivery.js (fjern stop)
PUT    /api/delivery/routes/:id/stops/reorder               routes/delivery.js (omarrangér stop)
POST   /api/delivery/routes/:id/compute                     routes/delivery.js (route_planner — forslag)
POST   /api/delivery/routes/:id/apply                       routes/delivery.js (beregn + skriv forslag)
POST   /api/delivery/routes/:id/pickup-time                 routes/delivery.js (manuel/auto afhentningstid)
POST   /api/delivery/routes/:id/actual-cost                 routes/delivery.js
POST   /api/delivery/routes/:id/book                        routes/delivery.js (markér ekstern booking)
POST   /api/delivery/routes/:id/depart                      routes/delivery.js (S2.3 — courier: rute → active)
POST   /api/delivery/stops/:id/status                       routes/delivery.js (S2.3 — courier: leveret/problem)
POST   /api/delivery/incidents                              routes/delivery.js (S2.3 — log problem, multipart foto)
GET    /api/delivery/courier/today                          routes/delivery.js (S2.3 — courierens egne ruter)
GET    /api/delivery/history-map?from=&to=&method=          routes/delivery.js (historiske leveringer)
```

---

## Status-flow

```
NY → VENTER → GODKENDT → IGANG → KLAR → LEVERET → FAKTURERET → AFSLUTTET
                                              ↘ BETALT
Fra alle: → AFLYST
```

Med `force: true` kan enhver **indlogget** bruger sætte hvilken som helst status — efter bekræftelse i UI'et, og skiftet skrives i historikken med `was_forced` + brugerens id fra sessionen. Admin-kravet faldt aug 2026: auth er rolle-baseret med delte konti, så det ramte roller og ikke ansvar.
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
1. maj 2026 — Moms-refaktorering færdig
   - 13 områder migreret til Moms.* helpers
   - Pre-commit-hook aktiveret
   - 2 latente bugs fundet og fixet (se KENDTE_DATABUGS.md #003, #008)
   - Grocy-audit forberedt for weekenden (se CLAUDE_GROCY_AUDIT.md)

4. maj 2026 — CLAUDE.md synkroniseret med /docs
   - Tilføjet "Ved opstart"-pegere til CLAUDE_TILBUD_PRIS, CLAUDE_KONTAKTER, CLAUDE_MOMS_AUDIT(_AUTO), CLAUDE_ECONOMIC_ADAPTER, CLAUDE_MENU_AGENT
   - Udvidet moms-reglen i "Vigtige regler" med komplet doktrin
   - Filstruktur opdateret: routes/contact-points.js, services/contactExtractor.js, shared/moms.js, shared/contactPoints.js
   - Nye sektioner under "Status": Moms-refaktorering + Kontakter & Firma 360°
   - API-base reference udvidet med contact-points + companies enrich/extract + crm/companies + crm/company/:id
   - Beslutninger taget: moms-doktrin, kontaktpunkter, berig-knap = firma-handling, web-scraping nedgraderet, e-conomic + menu-agent specs

13. maj 2026 — Test-suite Fase 1+2+3 (Office) komplet
   - 9 patches anvendt: A (goods-receipts kritiske), B (validation), C (API consistency POST+PATCH),
     D (force-mode med session-rolle), E (partially_approved), F (SSE konsolidering),
     G (invoices consistency), H (fakturering UI), I (quotes consistency)
   - 6/9 office-tracks fuldt dækket: BONS_LIST, BON_DRAWER (core + lines), FAKTURERING, TILBUD, DASHBOARD
   - 437 PASS · 0 FAIL · 3 SKIP — 0 åbne medium+ findings
   - Konventioner etableret: bon_*-events bruger {id}, force-mode bruger session-rolle, §6c moms 3-felts pattern
   - Resterende: T_CRM, T_CASHFLOW, T_V1_AFSTEMNING (weekenden)

*Sidst opdateret: 13. maj 2026 — test-suite-arbejdet (Fase 1+2+3 minus CRM/Cashflow) logget. 9 patches (A-I) anvendt og dokumenteret. 437 PASS · 0 FAIL · 3 SKIP. 0 åbne medium+ findings. Detaljer i `docs/TEST_OBSERVATIONS.md`.*

*19. maj 2026 — opdateret med 7 nye sektioner der dækker 39 commits siden 13. maj: Mail-oprydning (migration 066+067), Office sidebar v2 (23 → 8 punkter), Settings Grocy AKTIV-badge + miljø-badge, Density toggle (Komfort/Kompakt/Tæt), Bon-kort redesign + SSE re-render bug-fix, Mobile-zone udvidelser (Nye pending-inbox + Overblik 14d/Måned), Office Opskrifter & priser (margin-analyse), Office UX-fixes (status-farver, SSE bons-list `bon_status`, responsive sidebar med hamburger-drawer, drawer historik-knap, expandable notes, web-order toast, "Afleveret"-kolonne).*

*19. maj 2026 (senere) — Kunde-flags-feature dokumenteret. Migration 069 + `routes/flags.js` + `shared/flag_strip.js` + bon-drawer-strip + listview-badge + Kunde/Firma 360°-sidebar + dismissed flag i timeline. Tre commits: `c99c959` (fase 1-4), `d72a93d` (fase 5-6), `c0edb31` (fase 7). Alle 7 faser komplet. Spec: `docs/CLAUDE_KUNDE_FLAGS.md`.*

*19. maj 2026 (kalender-opgradering) — `shared/calendar.{js,css}` skiftet fra venstrekant-stribe til fuld status-baggrund (raw `BON_CONFIG.color` + `BON_CONFIG.text` direkte — ingen luminans-helper). Dagstotal flyttet til toppen af cellen. Tilbud rendres som ghost (50%-tint + stiplet). `window.CalendarDensity`-modul i `shared/density.js` tilbyder per-kalender override (default `inherit`) + Settings UI. Bonus-fix: `routes/kitchen.js` calendar-endpoint JOIN'er nu `price_categories` så production-bon's blå override faktisk virker (pre-eksisterende bug). Spec opdateret: `docs/CLAUDE_KALENDER.md`.*

*19. maj 2026 (delivery popout) — Bud-bestillings-modal erstattet med separat popup-vindue (`/delivery/note/:bon_id`). Migration 071 tilføjer `delivery_vehicles.booking_fields_json` med felt-array hvor hvert felt er en mini-template med `{variabel}`-syntaks. `services/booking_template.js` udvidet med `_renderWithMeta()` + `renderFields()`. `buildBookingPayload` returnerer nu `fields` array. Ny route `routes/delivery_views.js` serverer popout-HTML. `views/delivery/note.{html,css,js}` er standalone side med klikbare felt-chips, step-grouping (By-expressens Lobo-trin), SSE-live-opdatering, sticky header/footer, popup-blocked-fallback. Settings → Leveringsmetoder har felt-editor med ▲▼ reorder + variabel-chip-target switch til fokuseret felt-template. Den gamle `shared/manual_booking_modal.{js,css}` er slettet. 84/84 unit tests grønne. Spec: `docs/CLAUDE_DELIVERY_POPOUT.md`.*

*20. maj 2026 (Delivery Spor 2 — S2.0 + S2.1) — Vej-routing via OpenRouteService + DAWA-geokodning. Migration 073 (`delivery_routes`/`delivery_route_stops`/`delivery_incidents` + `geo_calculations` genskabt med nullable `bon_id`). Nye services: `routing.js` (ORS-wrapper m. afstands-cache), `geocode.js` (DAWA), `delivery_calc.js` (single-bon forslag), `route_planner.js` (computeRoute/applyRouteProposal). `routes/delivery.js` udvidet med `/calculate`, `/health` + 11 rute-endpoints. `office/views/logistik.js`+`.css` — leveringsoversigten (erstatter placeholderen). Constraint-forslag i bon-draweren. Constraint-princip: brud er advarsler, aldrig spærringer — office bestemmer. 143 delivery-tests grønne. Bevidst udskudt: Leaflet-kort, rute-popout-booking, `/history`. Spec: `docs/delivery/CLAUDE_DELIVERY_SPOR2.md`.*

*5. juli 2026 (#251 — re-baseline af Grocy-live test-tracks) — Opfølgning på PR #248 (deterministiske tracks). De 11 Grocy-afhængige tracks re-baselinet mod nuværende kode + live grocytest via fuld procedure pr. track (kill port 4322 → `test:reset` → `test:snapshot` → `test:patch` → frisk `test:server` → track). **Resultat: 392 PASS · 3 FAIL · 5 SKIP.** 10 tracks fuldt grønne og matcher deres dokumenterede baseline præcist — **ingen stale fixtures at rette, ingen ægte produkt-bugs** (modsat #248's ~12 stale assertions). T_GROCY 14/16, T_STOCK 31/31, T_RECIPES 20/20, T_INDKOB_LISTE 38/39, T_INDKOB_SETUP 47/47, T_INDKOB_ADMIN 50/50, T_INDKOB_HORKRAM 54/56, T_VAREMOD_PATCH 26/26, T_VAREMODTAGELSE_FULL 67/67, T_OPSKRIFTER 35/35. De 3 FAIL er alle i **T_INVENTORY (10/13)** og er miljø-betinget — ikke regression: fem grocytest-produkter er udtømt til ~0 lager (pid 16 Kylling-BBQ, 28 Spinat, 33 Rødløg-Sylt, 48 Mayo-Vegansk, 72 Transport Kasser), så `consume` ikke har noget at trække fra ("fik 0"). Consume-logikken bekræftet virksom af T_GROCY/T_STOCK/T_VAREMODTAGELSE_FULL (alle muterer Grocy-lager, alle grønne). 10/13 = accepteret baseline (grocytest-lager toppes IKKE op unilateralt). Spec §41 kræver tilstrækkelig stock som precondition.*

*17. august 2026 (prep-modal) — Enter i antal-feltet indsendte event-modalens `<form>` og oprettede bonnen efter første linje (synligt i drift: B4099/B4100/B4101 på Vig Festival inden for to minutter). `_evModal` blokerer nu Enter-submit for alle fire roller, navngiver knappen efter den bon der oprettes og tæller linjerne. Prep/top-up bruger `VarePicker` i detached mode med ny `priceField: 'cost'` (bonnen er 0 kr — kostprisen er det tal der driver Vareforbrug). Ens varer slås sammen. Fælde fundet undervejs: `VarePicker`s knapper manglede `type="button"`, så et klik på "Tilføj" eller en kategori indsendte formularen — kun synligt ved fysisk museklik, ikke via Enter eller `dispatchEvent`. PR #466. Bekræftet i drift samme dag.*
