# CLAUDE_BON_V2_BASELINE.md

> Kontekst-anchor for Bon v3-design-arbejdet i dette projekt.
> Dokumentet beskriver Bon v2 som det er i dag (maj 2026) — det system v3 skal udvide og delvist erstatte.
> Opdatér efter større arkitektur-skift.

---

## Forretningskontekst

**Ristet Rug** er en catering i København. Levering af sandwiches og catering til kontorer, organisationer, universiteter, Rigshospitalet og andre større virksomheder, plus en foodtruck (trailer). Foodtrucken udgør ca. 10 % af omsætningen og bruges aktivt fra sommer-sæsonen.

**Holdet bag Bon v2:**
- **Leif** — medejer, teknisk lead. Laver pt. det meste af udviklingen via Claude Code.
- **Simon** (Leifs søn) — programmør, pt. sygemeldt.
- **Bror** — programmør med fokus på backend, database og deployment. Var hovedkraft bag Bon v1, kommer ind på v2 lejlighedsvis (v2 er en ny kodebase, men genbruger v1's velprøvede koncepter — kalender, flyver, kitchen_selects, mail-integration).

Ingen andre rører ved koden.

---

## Autoritative dokumenter

Disse er ground truth for v2. Al kode skal passe med dem. Hvis noget ikke passer ind, opdateres dokumentet *først* — der lappes ikke.

| Dokument | Indhold |
|----------|---------|
| `BON_V2_PRINCIPPER.md` | Ufravigelige regler — inkl. moms-doktrin (§ 6b + 6c) |
| `bon_v2_datamodel_v2.md` | Databaseskema, tabeller, kolonner |
| `bon_v2_zoner_og_layout.md` | Filstruktur, zoner, designsystem |
| `BON_V2_KOM_IGANG.md` | Praktisk reference, API-oversigt, setup |
| `CLAUDE.md` (rod) | Statusoversigt — hvad er bygget, næste opgave |

**Det centrale princip:** Bon v1 endte med for mange lappeløsninger. Bon v2 er skrevet fra bunden for at undgå det samme. Når noget ikke passer ind i strukturen, **redesignes strukturen — der lappes ikke**.

---

## Stack og deployment

**Stack:**
- Node.js v22.22.2 + Express
- SQLite via `node:sqlite` (indbygget i Node 22+) — kører med `--experimental-sqlite` flaget
- Vanilla JS frontend — ingen frameworks (`var`/`function`/`document.querySelector`)
- Selektiv Vue.js i office (eksisterende valg, videreføres)
- SSE til realtime
- express-session til auth, eget SQLite session-store
- Vanilla CSS med tokens fra `shared/tokens.css`

**Disciplin:** ingen Docker, ingen frameworks, ingen build-step, ingen ORM, ingen native npm-pakker, native installs hele vejen igennem.

**Deployment:**
- Hetzner CX23 (4 GB RAM)
- Sti: `/home/leif/bon-v2`
- Database: `/home/leif/bon-v2/data/bon.db`
- Port: `4321` (proxy via nginx)
- systemd-service: `/etc/systemd/system/bon-v2.service`, `User=leif`
- Domæne: `bon.ristetrug.dk`. Session-cookie sat på `.ristetrug.dk` (parent-domain) så søsterapps kan SSO'e via nginx `auth_request` mod `/api/auth/me`.
- nginx reverse proxy + SSL via certbot
- Repo: GitHub `liffez/bon-v2`

**Sprog:**
- UI: dansk
- Kode, kommentarer, tabel- og kolonnenavne: engelsk

---

## Moms-doktrin (kritisk for v3)

Formaliseret 1. maj 2026 i `BON_V2_PRINCIPPER.md` § 6b + 6c. Hele Bon v2 bruger `shared/moms.js` til moms-beregninger — pre-commit hook forhindrer bart `1.25` eller `0.25` udenfor den fil.

### Hvor moms ligger gemt

| Felt | Moms-status |
|------|-------------|
| Grocy salgspriser (`SalespriceCatering` mfl.) | **Incl. 25 % moms** |
| Grocy råvare-/kostpriser | **Ex moms** |
| `bon_lines.unit_price` | **Incl. moms** (snapshot fra Grocy) |
| `bon_lines.cost_price` | **Ex moms** (snapshot fra Grocy) |
| `bons.delivery_price` | **Incl. moms** (kundepris) |
| `bons.delivery_cost` | **Ex moms** (intern kostpris) |
| `bons.total_price` | **Incl. moms** |
| Indkøb (purchase orders, leverandørpriser) | **Ex moms** |

### Visnings-disciplin (de 7 regler)

Hvert pris-tal i UI skal have moms-basis synligt **i samme visuelle blok som tallet** — ikke i tooltip, ikke i help-icon, ikke nederst på siden. Tabel-headers arver til rækker. KPI-kort viser basis ved tallet.

| Visningstype | Default basis |
|---|---|
| Bon-detalje, tilbud (kunde-vendt) | Incl. moms |
| Cashflow / pengestrømme | Incl. moms (faktiske bankbevægelser) |
| Rapporter / dashboards / analyse | Ex moms (regnskabskonvention) |
| Faktura / e-conomic-eksport | Ex moms pr. linje + separat moms |

API-endpoints til analyse skal udstille `revenue_excl_moms`, `revenue_incl_moms` og `vat_collected` så frontend ikke selv beregner.

### Konsekvens for v3

Enhver ny prismodel, kalkulator eller margin-beregning skal arve fra moms-helpers. Egen moms-logik i v3-kode er per definition en lappeløsning.

---

## Database

Én SQLite-fil til Bon v2. Whiteboard og hver Grocy-instans har deres egne separate SQLite-filer — ingen delt database.

**Migrationer:** `db/migrations/NNN_<navn>.sql`. Aktuelt ved 041 (`041_users_role_expand.sql`) — opdatér ved nye migrationer.

**Centrale tabeller (kerne):**

| Tabel | Indhold |
|-------|---------|
| `bons` | Hovedentitet. `bon_number`, `status_id`, `location_id`, `delivery_date`, `total_price` m.fl. |
| `bon_lines` | Linjer på en bon (`unit_price` incl moms, `cost_price` ex moms — snapshot fra Grocy) |
| `customers` | Kunder. Kan tilhøre en `company` |
| `companies` | Virksomheder med CVR, EAN, `discount_percent` mm. |
| `addresses` | Leverings- og fakturaadresser med koordinater fra Datafordelingen |
| `contact_points` | Telefon, mail osv. — kan tilhøre customer eller company |
| `web_orders` | Staging-tabel for indkommende webhook-bestillinger |
| `users` | `id, name, email, role, pin, password_hash, modules_json, is_active` |
| `settings` / `system_settings` | Key/value-konfiguration. Bl.a. rollerettigheder, modul-flags, `default_grocy_location_id`, session-varighed |
| `locations` | Fysiske lokationer (`hq`, `test`, `trailer`) med `grocy_api_url` per lokation |
| `status_definitions` + `status_transitions` | Konfigurérbart status-flow |
| `changelog` | Auto-logget audit-trail på alle bon-ændringer |
| `notifications` + `notification_reads` | Flyver-system med persistent besked |
| `mail_threads` + `mail_messages` + `mail_templates` | Mailarkiv og skabeloner |
| `crm_*` (5 tabeller) | nano-CRM (meta, activities, custom_fields, custom_values, unmatched_emails) |
| `delivery_routes` + `delivery_route_stops` + `delivery_vehicles` + `delivery_incidents` | Leverings-modul |
| `goods_receipts` mm. | Varemodtagelse v3 (FVST + lager) |
| `purchase_orders` + `purchase_order_lines` | Indkøb |
| `cashflow_*` | Bankbevægelser, fakturaer, matching |

**SQLite-konventioner:**
- SQLite ignorerer `ALTER TABLE ... CHECK`. Når constraints skal ændres bruges recreate-mønster: kopiér til `_new`, drop original, rename.
- `PRAGMA wal_checkpoint(TRUNCATE)` køres på produktionsdata før migrationer.
- `db/compat.js` indeholder wrapper + transaction-helper for `node:sqlite` kompatibilitet.

---

## Status-flow

```
NY → VENTER → GODKENDT → IGANG → KLAR → LEVERET → FAKTURERET → AFSLUTTET
                                              ↘ BETALT
Fra alle: → AFLYST
```

Status-transitions er **UX-guidance, ikke håndhævelse**:
- Admin kan altid sætte hvilken som helst status med `force: true`
- POS-ordrer (Zettle) sættes direkte til BETALT
- Hele flowet er konfigurérbart i `status_definitions` + `status_transitions`-tabellerne

---

## Autentificering og roller

**Mekanisme:** express-session, parent-domain cookie, SSO til søsterapps via `/api/auth/me` (returnerer bruger + `permissions`-blob så frontend rendrer nav uden hardcodede rolle-defaults).

**Login-typer:**
- PIN-login (desktop, brugergrid)
- Password-login (mobilzonen, til personlige køkken-brugere)

**Roller:**
- `admin` — alt
- `office` — daglig drift, kontoret
- `kitchen` — fælles køkken-konto
- `kitchen_personal` — personlig køkken-bruger (mobilzonen)
- `delivery` — chauffører

**Rettighedsmodel:**
- Defaults defineres per rolle i `settings` som JSON-blobs (`role_permissions_<role>`)
- Per-bruger-overrides via `modules_json` på `users`
- Moduler i rettighedssystemet: `crm`, `tilbud`, `okonomi`, `rapporter`, `settings`, `modtag`
- `userCan(user, module)` afgør adgang. 60s cache på defaults.
- `requireAuth(...roles)` middleware på routes; admin har altid adgang.

**Zoner:**
- `/office/` — admin og office (sidebar-shell, SPA-lignende, dynamisk view-load)
- `/kitchen/` — fælles køkken-skærm (topbar, MPA, tablet/touch-first)
- `/mobile/` — personlige køkken-brugere (PIN-login, 5-tab nav)
- `/settings/` — selvstændigt kontrolpanel

---

## Moduler — produktionsstatus

Alle moduler er i bevægelse — ingen ligger 100 % færdige og urørte. Status pr. maj 2026:

### I drift

| Modul | Note |
|---|---|
| **Kitchen I dag / Senere / Dashboard** | Kerne-flow færdigt. SSE, statusknapper, prep-checks |
| **Office listview + drawer + kalender** | Fuldt funktionsdygtigt. 5 filtre, SSE, BonDrawer |
| **Mobile shell** | PIN-login, 5-tab nav (bons/modtag/crm/oversigt) |
| **nano-CRM** | 360°-kundevisning, aktiviteter, custom fields. Mobile aktivitetshistorik færdig |
| **Web orders webhook** | Indkommende ordrer fra WordPress-formular landing i `web_orders`-staging |
| **Embed-bestillingsformular** | `bon.ristetrug.dk/embed/bestilling` indlejret i WordPress (DIVI iframe). Erstattede JotForm |
| **Mail-systemet** | 2 SMTP-transports (bon@ + kontakt@) + 2 IMAP-mailboxes via Simply.com. IMAP polling hvert 5. min. Tag-routing via `#B{num}` og `#K{num}` i emne |
| **Mail-skabeloner** | `booking_confirmation`, `order_email` mfl. i `mail_templates`-tabellen |
| **Indkøb** | Suppliers, purchase orders, mail-tråd per PO |
| **Varemodtagelse v3** | FVST-compliance, lager-træk, fotos, brugere. Erstatter ældre `receiving.js` |
| **Hørkram-integration** | Via `hokaAdapter.js` med cookie-jar auth — basket, search, orders |
| **Booking-system** | Smagebookings + kontaktbookings. Meeting-types, contact-reasons, page-templates, slots, tokens. Booking-redirect på `/b/:token` |
| **Rapporter-modul** | Summary, monthly, top-customers, categories, lego-chart, cumulative |
| **Cashflow-modul** | Admin-only. CSV-upload, faktura-matching, payment-behavior, weekly, upcoming |
| **Contact-points** | Selvstændig entity med toggle-public + paste-extractor (HTML/tekst → kontakter) |
| **Firma-oprydning / merge** | 3-trins wizard, alternate_names, force-flag ved CVR-mismatch, SSE-event |
| **Events / Stripe** | Stripe-baseret events- og betalings-system fra v1's tid |
| **Smartplan-integration** | OAuth2, shifts + worklogs + employees |
| **Vagtplan / ugeoversigt** | Smartplan-vagter + bonner kombineret |
| **Goods receipts → Whiteboard webhook** | Fire-and-forget integration |
| **Sidekick config** + **help-content** | Whiteboard sidekick på tværs af zoner |
| **Moms-refaktorering** | 13 områder migreret til `shared/moms.js` helpers. Pre-commit hook aktiveret |

### Spec klar / under bygning

| Modul | Note |
|---|---|
| **Delivery-modul (3D)** | Stort spec-arbejde. `delivery_vehicles` + `delivery_routes` skema klar. Vehicles CRUD + booking-payload + book + actual-cost + events bygget. Office plan-mode + I dag-mode + courier mobile under udvikling. Spec: `CLAUDE_DELIVERY.md` (1.371 linjer) |
| **By-expressen som manual_clipboard** | Fungerer som taxa indtil API-credentials kommer fra Sebastian. SQL-switch til API når klar — ingen kode-ændring. Spec: `PLAN_BYEKSPRESSEN_3D4.md` |
| **OSRM + VROOM self-hosted** | Til ruteoptimering. OSRM port 5000, VROOM port 3000 |
| **Tilbud (CLAUDE_TILBUD_PRIS.md)** | `is_offer`, `offer_status`, `offer_sent_at`, `offer_valid_until` på `bons`. Mockup: `tilbud-v3b.html` |

### Spec klar — venter på implementering

| Modul | Note |
|---|---|
| **Menu-agent (AI)** | `CLAUDE_MENU_AGENT.md`. Anthropic SDK. Forslag til bon-linjer ud fra pax + ønsker. Kræver `ANTHROPIC_API_KEY` |
| **E-conomic adapter** | `CLAUDE_ECONOMIC_ADAPTER.md`. Bygger på moms-helpers. Konverterer bon → faktura-payload (ex moms pr. linje + separat moms-felt) |
| **Bestillingsportal** | Multi-afdelings B2B-portal på `portal.ristetrug.dk` (selvstændig app som whiteboard). UI låst, datamodel + API-kontrakt klar. Spec: `CLAUDE_PORTAL.md` |
| **Formbuilder-udvidelse** | Ægte field-types (`info_box`, `chip_group`, `menu_picker`) der erstatter den hardcodede embed/bestilling.html |
| **Kopiér bon** | `POST /api/bons/:id/copy` + UI i drawer |
| **Bud-tidspunkt auto-beregning** | Byekspressen: leveringstid − 45 min. Taxa/Volvo: leveringstid − (OSRM køretid + 15 min) |
| **Leveringsmetode-ikoner i settings** | Pt. hardcoded i `BL_DELIVERY_ICONS`. Skal flyttes til settings-tabel |

---

## Integrationer

| Integration | Formål |
|-------------|--------|
| **Grocy (4 instanser)** | Lager, opskrifter, indkøb. Via `services/grocyAdapter.js`. URL pr. lokation i `locations.grocy_api_url`. Under udvikling bruges `grocytest`; skift til `grocycafe` ved release |
| **Hørkram (hoka.dk)** | Leverandør-prisfeed via `services/hokaAdapter.js` med cookie-jar auth |
| **WordPress** | Indkommende bestillinger via embed-iframe `/embed/bestilling` + ældre webhook → `web_orders` |
| **Datafordelingen** | DK adresser + koordinater (afløser DAWA som lukkes april 2026) |
| **OpenRouteService → OSRM/VROOM** | Ruteoptimering (cykel/bil). Migrerer til self-hosted på Hetzner |
| **Anthropic API** | Menu-agent (planlagt). `MENU_AGENT_MODEL` i `.env` |
| **e-conomic** | Bogføring (credentials i `.env`). Adapter under spec'ing |
| **Smartplan** | Vagtplanlægning. OAuth2 via `SMARTPLAN_CLIENT_ID` + `SMARTPLAN_CLIENT_SECRET` |
| **By-expressen** | Ekstern kurer. **Credentials ikke modtaget endnu** — kører som manual clipboard-flow indtil Sebastian leverer |
| **Stripe** | Events-betaling |
| **Virk ElasticSearch** | CVR-lookup. Credentials afventer godkendelse fra erst.dk |

---

## Søsterapps og samlet infrastruktur

På samme Hetzner CX23 kører ud over Bon v2:

- **Whiteboard** — eget repo, egen SQLite, egen subdomain (`whiteboard.ristetrug.dk`). Bruger Bon v2's session via nginx `auth_request` mod `/api/auth/me`. SSO virker. Realtime via SSE.
- **SOP** — Standard Operating Procedures-viewer. Excalidraw-diagrammer med klikbare områder linkende til docs/videoer. Mestendels statiske filer. `sop.ristetrug.dk`. Kører kun 08:00–17:00 hverdage via cron (passiv viewer).
- **Grocy x4** — `grocy-hq` (`grocycafe`), `grocy-test` (`grocytest`), `grocy-trailer` og `kaelder`. Samme server, hver sin PHP-FPM-pool og SQLite-fil. Auth via Bon v2 SSO bortset fra kælder.
- **Kælder** (vinlager-app) — separat Vue.js-frontend mod kælder-Grocy. Egen auth, ikke Bon v2 SSO. Bruger barcode-level vintage userfields til vin/portvin/whisky.
- **Bestillingsportal (planlagt)** — `portal.ristetrug.dk`. Selvstændig app som Whiteboard. Egen SQLite, egen auth.

**Cron-jobs (delvis liste — skal verificeres mod `scripts/`):**
- `booking-reminders.js` — påmindelser
- `sync-v1.js` — pull fra Bon v1 på Linode (deaktiveres efter cutover Bølge 3)
- IMAP polling-job (mail-routing hvert 5. min)
- SQLite-backup script

---

## Konventioner og workflow

**Spec-først:**
Større opgaver dokumenteres i `.md`-filer (`CLAUDE_*.md`-mønster) før implementation. Eksempler: `CLAUDE_DELIVERY.md`, `CLAUDE_PORTAL.md`, `CLAUDE_BESTILLING_FORM.md`, `CLAUDE_MENU_AGENT.md`, `CLAUDE_ECONOMIC_ADAPTER.md`. Specs leveres ofte til Simon eller bror som implementerings-input.

**AI-workflow:**
- **Claude.ai-projekter:** design, sparring, scoping
- **Claude Code:** implementation, med `CLAUDE.md` som vedvarende kontekst-anker i repo'et
- Mønster: spec → review → implement → smoke-test

**Disciplin:**
- Validering sker i serveren — frontend stoler ikke på sig selv
- Changelog auto-logges af serveren ved alle bon-ændringer (status, felter, linjer)
- SSE til realtid — aldrig polling, aldrig WebSockets
- Migrationsfiler køres aldrig om
- Grocy ejer lager og opskrifter — Bon v2 læser via adapter, skriver aldrig direkte

**Filstruktur (typisk):**
- `db/migrations/NNN_*.sql`, `db/database.js`, `db/compat.js`, `db/helpers.js`, `db/session-store.js`
- `routes/*.js` (~30 routes)
- `services/*.js` (`grocyAdapter`, `hokaAdapter`, `ingredientResolver`, `smartplanAdapter`, `mailService`, `booking_template`, `delivery_log`, `contactExtractor`, `quConvert`, `goodsReceiptWebhook`)
- `shared/` (`moms.js`, `tokens.css`, `bon_kort.js`, `api.js`, `utils.js`, `sse.js`, `contactPoints.js`)
- Zone-mapper: `/office/`, `/kitchen/`, `/mobile/`, `/settings/`
- `scripts/` (cron, sync, vedligehold)

---

## Cutover Bon v1 → Bon v2 (status maj 2026)

Bon v1 kører stadig på Linode som kilde indtil cutover-bølge 3. Detaljeret plan ligger i `CLAUDE_CUTOVER.md`.

**Tre bølger:**

1. **Bølge 1 — SOP + Whiteboard** flyttes fra Linode til Hetzner.
2. **Bølge 2 — Grocy x4 flyttes**. Bon v2's `locations.grocy_api_url` opdateres til nye `grocy-*`-domæner.
3. **Bølge 3 — Bon v1 sættes i readonly**. WordPress-iframe skiftes fra Jotform til Bon v2 embed (allerede gjort på `/bestil`). `sync-v1.js`-cron deaktiveres. Linode lukkes ned 4 uger senere.

Indtil Bølge 3 er Bon v2 ikke selvstændig kilde — `sync-v1.js` pull'er stadig fra v1.

---

## Strategisk retning

### Bon v3 — internt

v3 har to spor der løber parallelt:

1. **Udvidelser af v2** — primær fokus. Nye features og forbedringer af eksisterende moduler (CRM, web orders, ruteoptimering, events, firma-oprydning, levering, fakturering, tilbud, menu-agent, e-conomic).
2. **Grocy-erstatning som forsøg** — v3 skal teste om vi selv kan bygge lager-, opskrifts- og indkøbsmotoren bedre end Grocy. Hvis det lykkes inden for v3-perioden, indgår det. Hvis det viser sig for stort, parkeres det og bliver kernen i v4.

Adapter-pattern'et i `services/grocyAdapter.js` betyder at en eventuel intern motor kan koble på som en alternativ backend — Grocy fjernes ikke før den interne erstatning er testet i drift.

**Aftalt fire-lags designsekvens for Grocy-erstatningen:**
1. Kerneentiteter og relationer
2. UoM og prismodel
3. Kalkulationslogik (roll-up cost gennem multi-level opskrifter, allergen/økologi-propagering)
4. UI/UX og mockups

**Allerede aftalte design-principper:**
- Brug UUIDs og `tenant_id` fra start — så v4 kan bygges uden at retro-fitte multi-tenancy
- Fleksibel dual-mode margin: sæt pris → se margin, ELLER sæt target margin → beregn pris
- Lot-baseret lagerværdi (FIFO eller vægtet gennemsnit)
- Append-only stock movement ledger
- Volumen-til-vægt-konvertering pr. ingrediens (identificeret som potentiel konkurrencefordel — både Grocy og Odoo har huller her)
- **Arve moms-doktrinen fra v2** — egen moms-logik er per definition en lappeløsning

**Inspirationskilder:**
Tracezilla, CalcuEasy, Apicbase (sammenligning lavet i april). Odoo-arkitekturmønstre værd at kopiere: move-based ledger, phantom BoMs, three-unit-per-product, Chatter activity log. Mønstre at lade være med at kopiere fra Odoo: lead/opportunity-split, lead scoring, email campaigns, territory-features.

### Bon v4 — multi-tenant SaaS

Hvis v3 fungerer i drift, kommercialiseres som SaaS for små danske fødevarevirksomheder. Niche-positionering. Vanilla JS / SQLite-stack giver lave hosting-omkostninger som konkurrencefordel.

---

## Hvad er IKKE i v3-scope

| Modul | Status |
|-------|--------|
| nano-CRM | Bliver i v2, evt. udvidelser |
| Web orders / webhook / embed-form | Bliver i v2 |
| Booking-system | Bliver i v2 |
| Cashflow-modul | Bliver i v2 |
| Rapporter-modul | Bliver i v2, evt. udvidelser |
| Ruteoptimering | Bliver i v2, migrerer til VROOM self-hosted |
| Events / Stripe | Bliver i v2 |
| Firma-oprydning | Bliver i v2 |
| Mobilzone og rolle/rettighedssystem | Bliver i v2, deler sandsynligvis fundament med v3 |
| Mail-systemet | Bliver i v2, deles sandsynligvis med v3 |
| Whiteboard, SOP, Kælder | Uberørte |

---

## Verificér / tjek inden brug

Et par ting i ovenstående bygger på inferens og bør bekræftes:

- **Aktuel migrations-nummerering** (041) — opdateres når nye migrationer tilføjes.
- **Cron-jobs-listen** — der er sandsynligvis flere end de fire nævnte. Tjek `scripts/`-mappen.
- **`BON_V2_PRINCIPPER.md` § 2 + § 7** siger stadig `better-sqlite3` — patch står klar separat (kører `node:sqlite` i virkeligheden).
- **Moms-konventionen for indkøb** (purchase orders ex moms) — bekræftet af Leif april 2026, men værd at re-verificere ved e-conomic-integration.

---

*Oprettet: maj 2026. Opdatér når større antagelser ændrer sig.*
