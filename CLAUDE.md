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
Skift til produktion (`grocycafe`) sker først ved release.

`default_grocy_location_id = 3` (Test) i settings-tabellen styrer dette.
Lokationer defineres i `locations`-tabellen: HQ=grocycafe, Trailer=grocytrailer, Test=grocytest.

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
│   ├── booking_template.js   ← Render template + variabler + cost-estimat (Spor 1)
│   ├── delivery_log.js       ← Booking-events + actual cost + sync delivery_method (Spor 1)
│   ├── routing.js            ← ORS vej-routing (getDistance/getRoute) + geo_calculations-cache (Spor 2)
│   ├── geocode.js            ← DAWA-geokodning af adresser (Spor 2)
│   ├── delivery_calc.js      ← Single-bon leverings-forslag: afstand + vogn-anbefaling (Spor 2)
│   ├── route_planner.js      ← Rute-orchestrator: computeRoute/applyRouteProposal (Spor 2)
│   ├── contactExtractor.js   ← Parse pasted HTML/tekst for emails+telefoner (paste-flow til scraping)
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
│   ├── utils.js      ← Status-mapping, connectSSE(), mapApiBonToCardData(), scrollToBonHash()
│   ├── moms.js       ← Moms-helpers (inclToExcl, momsOfIncl, computeMomsFields) — eksponeres som window.Moms i browser
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
- **Standalone scripts bruger `openDb()`** fra `db/compat.js` — aldrig `DatabaseSync` direkte
- **Transactions via `transaction(db, fn)`** — aldrig `db.transaction()` (eksisterer ikke i node:sqlite)
- **`logChange({...})`** — objekt-API, aldrig positionelle argumenter
- **Nye npm-pakker kræver godkendelse** — spørg først, og ingen native/compiled pakker
- **Moms-håndtering (autoritativ regel — sektion 6b+6c i `BON_V2_PRINCIPPER.md`)**
  - Grocy salgspriser ER incl. moms (alle `Salesprice*`-userfields på `recipes`)
  - Grocy råvarepriser + `costprice` (recipe fulfillment `costs`) er ex moms
  - `bon_lines.unit_price`, `bon_lines.line_total`, `bons.total_price`, `bons.delivery_price` er **INCL. moms**
  - `bon_lines.cost_price` er **EX moms**
  - Frontends regner ALDRIG selv moms — de bruger:
    - Pre-beregnede felter fra API (`total_incl_moms`, `total_excl_moms`, `moms_amount`)
    - Helpers fra `shared/moms.js` (også eksponeret som `window.Moms`): `inclToExcl`, `momsOfIncl`, `computeMomsFields`
    - Server-side: `db/helpers.js` re-eksporterer samme helpers
  - **Ingen magic `* 1.25` / `* 0.25` / `/ 1.25` uden for `shared/moms.js` og `tests/`** — pre-commit-hook blokerer det
  - E-conomic kræver linje-priser EX moms — `inclToExcl()` ved konvertering (jf. `CLAUDE_ECONOMIC_ADAPTER.md`)
  - Test-bonen T-5: 23.650 incl → 18.920 ex + 4.730 moms (i `tests/moms_audit_e2e.test.js`)
  - 7 visningsregler for labels (`Total inkl. moms`, `(ex moms)` osv.) i sektion 6c

---

## Opgave- og projekt-tracking (GitHub)

Opgaver, bugs og projekter trackes i **GitHub issues** på `liffez/bon-v2` (etableret 2. juni 2026).
Tidligere lå det spredt i denne fils "Åbne afhængigheder", MEMORY.md og docs/-mapper — nu ét sted.

- **Board:** GitHub Projects "Bon v2" — <https://github.com/users/liffez/projects/3>
  - Kolonner (Status-felt): `Backlog` · `Klar` · `I gang` · `Review` · `Done`
- **Labels:** `deploy`, `afventer-ekstern`, `bug`, `sikkerhed`, `tech-debt`, `test`, `feature`, `projekt` (epic)
- **Epics** (`projekt`-label) = store projekter med spec-mapper i `docs/`, hver med fase-checkliste:
  - #81 Festival / multi-lokation (`docs/festival/`)
  - #82 Form Builder (`docs/formbuilder/`)
  - #83 Kunde-portal (`docs/kunde portal/`)
  - docs/-specs forbliver source-of-truth; epics linker til dem og tracker fremdrift via checkbokse.

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
> FRA BRANCHEN, FØR der merges. Merge med `--delete-branch` sletter branchen og rydder
> dermed worktree-sessionen op — og så er sessionen væk netop når brugeren opdager
> noget der skal rettes. Merge er derfor ALTID sidste skridt, efter godkendelse i drift.
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
gh pr merge --squash --delete-branch                   # SIDSTE skridt — kun efter godkendelse
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

**Forbehold ved branch-test:** branches med nye `db/migrations/`-filer kører migrationen
ved restart — vær påpasselig med at hoppe frem/tilbage mellem branch og main ved
migrations-PR'er (migrationen ruller IKKE tilbage ved checkout af main). Husk også
hård browser-refresh (Cmd+Shift+R) efter deploy — JS/CSS kan være cachet.

**Regler:**
- Migrations kører automatisk ved server-start. Hvis commit'en indeholder en ny `db/migrations/`-fil → genstart kræves
- Settings-ændringer der peger på Grocy/Smartplan/SMTP kræver ikke genstart (læses ved hver brug eller har egen cache-invalidation)
- Hvis PR'en kun rører `docs/`, `*.md` eller `tests/` → ingen `git pull` på server nødvendig

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
> - **Smagsprøve** (`tools/booking-smagning.html`) — kalender-baseret, konfigurerbare mødetyper
> - **Kontakt** (`tools/booking-kontakt.html`) — formular uden kalender, opretter task på Ring-tilbage-listen

- [x] Migration 051: `meeting_types`, `contact_reasons`, `booking_tokens`, `page_templates` + 7 nye kolonner på `crm_activities` (`meeting_type_id`, `contact_reason_id`, `duration_min`, `guest_count`, `event_type`, `booked_via`, `reminder_sent_at`)
- [x] 4 mail-skabeloner seedet (`booking_smagning_confirmation`, `booking_smagning_reminder`, `booking_kontakt_confirmation`, `booking_internal_notification`) + 4 page-templates (intro/thankyou × 2)
- [x] 18 booking-settings (slot-logik, ejer, tokens, erindring, master-toggles)
- [x] `routes/booking.js` — public + admin endpoints
  - `GET /meeting-types` + `/contact-reasons` + `/page-templates/:key` (returnerer `{available:false, reason}` ved disabled/unconfigured i stedet for 503 — patch P3)
  - `GET /slots?date=&meeting_type=` (slot-beregning, 10/10 testcases)
  - `POST /webhook/booking-smagning` + `POST /webhook/booking-kontakt` (CORS via samme middleware som web-orders)
  - Admin CRUD for meeting_types/contact_reasons/page_templates (kun admin-rolle)
- [x] `services/bookingMatcher.js` — `computeSlotsForDate()`, `isSlotStillFree()`, `matchOrCreateCustomer()`, `resolveSalesOwner()`
  - Slot-beregning respekterer: blokerede ugedage, min/max dage frem, eksisterende meetings, buffer-zoner omkring bons (pickup_time/delivery_time)
  - Race-condition guard: re-tjek + INSERT i transaction
- [x] `tools/booking-smagning.html` — kalender med navigation, slot-grid, formular, intro/thankyou fra page_templates, localStorage pre-fill, honeypot
- [x] `tools/booking-kontakt.html` — kontaktårsag-grid, formular, samme stil
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
- [x] **M8 (komplet)**: Kort URL `GET /b/:token` (302 redirect til tools-siden + 410/400 for ukendt/ugyldigt token) i `routes/booking-redirect.js` mountet på `/b`. Token info-endpoint `GET /api/booking/token/:token` returnerer customer + intent_meeting_type + sales_user, bumper `open_count` + sætter `opened_at` (ikke ved redirect — kun ved JS-lookup, så ingen dobbelt-tælling). `tools/booking-smagning.html` + `tools/booking-kontakt.html` udvidet med token pre-fill (kontakt-felter + intent-mødetype auto-vælges + personlig velkomst-banner med title-cased navne). Token videregives ved submit → `handleSmagningBooking` + `handleKontaktBooking` sætter `booked_via='token_link'`, marker token forbrugt, springer intern notif over. `sendBookingMails` passer `userId: ownerId` til `sendFromTemplate` så `{{booking_link}}` i bekræftelsesmail bindes til samme sælger som håndterede bookingen. `mailService` rendrer `{{booking_link}}` som kort URL `${baseUrl}/b/${token}`. Verificeret via 24 asserts i `scripts/test-m8.js` (HTTP mod spawned server) + live-test mod hotmail/anne@ristetrug.dk med rigtig SMTP.
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
- [x] **`shared/moms.js`** — fælles helpers: `inclToExcl`, `excrToIncl`, `momsOfIncl`, `computeMomsFields`. Eksponeres som `window.Moms` i browser, re-eksporteres fra `db/helpers.js` på server-siden
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

## Næste opgave

> ✏️ Opdateret 21. maj 2026.
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
> - **Booking-modul**: `booking_public_url_base` (settings-felt) skal sættes til `https://bon.ristetrug.dk` ved deploy — ellers virker `{{booking_link}}` ikke korrekt i mails. Konfigureres via Settings → Booking — Smagsprøve.
> - **Booking-modul**: `booking_default_owner_user_id` skal sættes via Settings UI før public-flowet virker. Submit-webhooks 503'er ellers.
> - **Booking-modul**: ved deploy skal `https://bon.ristetrug.dk` (eller den valgte URL hvor `tools/booking-*.html` hostes) tilføjes til `WEBHOOK_ALLOWED_ORIGINS` i `server.js` hvis kunden lander på et andet domæne (fx ristetrug.dk-iframe). I dag er ristetrug.dk allerede inkluderet.
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
> - Booking-modul: `tools/booking-smagning.html` + `tools/booking-kontakt.html` hostes i `tools/` (mønster-konsistent med `tools/bestilling (1).html`). Pænere URL via nginx reverse-proxy ved deploy uden kode-ændring.
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
> - **Force-mode auth (13. maj 2026)**: rolle-tjek mod `req.session.userId` (IKKE body.user_id). Body bruges KUN til audit-felter. Privilege-escalation-vektor lukket i Patch D.
> - **Partially approved (13. maj 2026)**: ny status-værdi på `goods_receipts` når mindst én item-Grocy-fejl. Bevidste skips (missing-status, no-pid) tæller ikke. UI-rendering kommer i Fase 3 varemodtagelses-listview.
> - **Tilbud-status convert-only (13. maj 2026)**: `offer_status='won'` kan KUN sættes via `POST /api/quotes/:id/convert` (der samtidig sætter `is_offer=0`, `status_id=GODKENDT`). PATCH `/:id/status` accepterer kun draft/sent/lost/expired.
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
GET    /api/companies/:id/enrich-preview                 routes/companies.js (CVR diff uden gem)
POST   /api/companies/:id/enrich                         routes/companies.js (anvend delmængde af diff)
POST   /api/companies/:id/extract-contacts               routes/companies.js (paste-flow → kandidater)
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
