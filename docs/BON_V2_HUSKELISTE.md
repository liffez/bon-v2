# BON_V2_HUSKELISTE.md — Åbne småting og pligter
> Ting der ikke er specifikke nok til en fase-spec endnu,
> men som SKAL med — enten før Bon v1 endelig nedlægges, eller som almindelig oprydning post-cutover.
> Opdateres løbende — tjekkes ved start af hver session.
>
> Større projekter og paraplyer ligger i `BON_V2_ROADMAP.md`.

---

## Kalender / overblik

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Produktions-bon — blå farve | Blå baggrundsfarve i kalender-blok. Inline `--bon-color: #4a7ab0` (ikke kun CSS attribute-selector — inline beats specificitet). Calendar-endpoint leverer nu `price_category` så frontend-detection virker | `price_category = 'produktion'` | ✅ Done — original commit c1274b9, fixed end-to-end 19. maj 2026 |
| Produktions-bon — ikon | 🔧 (svensk nøgle) vises på bon-blok | `price_category = 'produktion'` | ✅ Done — kalender (month + list) + bon-kort (commit c1274b9) |
| Mail-ikon | ✉ konvolut vises når bon har tilknyttet mail | `bon_mails` COUNT > 0 | ✅ Done — kalender + bon-kort + listview |
| Status-farver fra BonConfig | Web-orders, kalender-listevisning og ugeoversigt brugte raw `status_color` fra DB (blege `#f1e6b2`) i stedet for BON_CONFIG-paletten | `BON_CONFIG.statuses` | ✅ Done — commit c1274b9 |
| Status som baggrundsfarve | Hele bon-rækken farves efter status (fuld baggrund med `--bon-color`, ikke venstrekant-stribe). Tekstfarve fra `BON_CONFIG.statuses[code].text` direkte (ikke luminans-beregning). Production-bon override bevaret | `BON_CONFIG.statuses` | ✅ Done — 19. maj 2026, spec `CLAUDE_KALENDER.md` |
| Dagstotal øverst i celle | Total (enheder + bons) vises som første element i hver dagscelle med dotted bottom-border, ikke nederst | `bons` aggregeret pr. dag | ✅ Done — 19. maj 2026 |
| Tilbud som ghost-blok | `is_offer = 1` rendres med 50%-tint af status-farven + stiplet border | `data-offer="true"` | ✅ Done — 19. maj 2026 |
| Bon-blok afrunding | `border-radius: 4px` på alle bon-rækker (matcher resten af systemet) | — | ✅ Done — 19. maj 2026 |
| Kalender-density-override | Kalenderen kan have eget tæthedsvalg særskilt fra global density. Default `inherit` (følger global). Settings → Denne enhed → "Tæthed — kalender (særskilt)" | `localStorage.bon_v2_calendar_density` | ✅ Done — 19. maj 2026, `window.CalendarDensity` |

---

## Drawer / office bon-detalje

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Kopier bon | Knap i drawer — kopierer alle felter til ny bon med status NY og nyt bon-nummer | `POST /api/bons/:id/copy` | ✅ Done — endpoint i `routes/bons.js`, "⎘ Kopiér"-knap i drawer-header (kalder `copyBon()` i `shared/api.js`). Kopierer bon_lines + menu_groups. Nulstiller workflow-felter (status→NY, prep, inventory_deducted, courier, tilbuds-flag, v1_id) |
| Mail-ikon i drawer | Vis ✉ + antal mails når bon_mails > 0 | `bon_mails` COUNT | ✅ Done — mail-historik i drawer |
| Historik-knap i drawer-header | Åbner `showHistorik`-modal med fuld changelog (status, felter, mail, prep) | `GET /api/bons/:id/changelog` | ✅ Done — commit a76b9d0 |
| Expandable note-felter | Klik på sublabel (Kundeønsker, Faktura info, Køkken info, Interne noter) folder hele textarea ud uden scroll | drawer-noter | ✅ Done — commit ff0cfd7 |

---

## Office UI

| Krav | Detalje | Hvor | Status |
|------|---------|------|--------|
| Topbar-notif på web-ordre | Grøn toast nederst-højre ved SSE `bon_created` med `source='web_order'`. Klik → åbner bon i drawer. Auto-fade efter 12s | `office/index.html` + `shared/components.css` | ✅ Done (19. maj 2026) |
| Owner-mail på nye ordrer | Settings-key `web_order_notification_email` + skabelon `web_order_owner_notification`. Sendes fire-and-forget med klikbart drawer-link | Migration 062 + `routes/web-orders.js:370` | ✅ Done — allerede implementeret tidligere |
| SSE `bon_status` til bons-list | Bons-list reagerede ikke på `bon_status`-event — krævede manuel refresh efter status-skift. Fakturering/dashboard/rapporter/ugeoversigt lyttede allerede | `office/index.html` + `office/views/bons-list.js` | ✅ Done — commit b436492 |
| Responsive sidebar | Sidebar forsvandt brutalt ved <768px uden replacement. Hamburger-toggle + overlay-drawer ved <900px, lukker ved backdrop/Escape/sidebar-link | `office/index.html` | ✅ Done — commit 1de0e58 |

---

## Mobile shell

| Krav | Detalje | Hvor | Status |
|------|---------|------|--------|
| `customer_name`-fallback | Mobile bons-list viser "Ukendt"/"?" pga. field name mismatch (`contact_name_full` vs `customer_name`) | `mobile/views/bons.js:462` + `:642` | ✅ Done — commit c1274b9 |
| Mobile SSE | `mobile/index.html` har ingen `connectSSE()`, så mobil-bons opdateres kun ved pull-to-refresh. Bevidst lavt prioriteret, men værd at have på listen | `mobile/index.html` | ✅ Done — `connectSSE` lyttende på bon_created/bon_updated/bon_status. Dispatch via `_mDispatchSSE` til view-specifik handler (`_mbHandleSSE` på bons-view re-loader debounced). Badge-tæller refreshes |

---

## Formbuilder & embed

| Krav | Detalje | Status |
|------|---------|--------|
| Faktura/EAN-felt | Textarea til EAN og faktura-info (f12) | ✅ Done — `ean_info`-textarea på linje 596-597 i `public/embed/bestilling.html`, gemmes som `bons.invoice_info` + 13-cifret EAN parses og gemmes på `companies.ean` (`routes/web-orders.js:181-188`) |
| Auto-kopi navn + tlf til kontaktperson | Kopierer fra bestiller-felterne, kan overskrives — webhook gemmer i `day_contact_name`/`day_contact_phone` | ✅ Done — `syncContactFields()` i `public/embed/bestilling.html:1282-1303`. `first_name`/`last_name` → `contact_person`, `phone` → `contact_phone`. Stopper når brugeren manuelt redigerer feltet (`manuallyEdited`-flag) |
| EAN-udtræk i webhook | Regex `5\d{12}` trækker EAN ud fra faktura-felt og gemmer på firma | ✅ Done (Fase 1d) |
| Embed-bestilling deploy | Swap JotForm-iframe i WordPress DIVI til ny embed-form | `docs/wordpress_divi_snippet.html` | ❌ Mangler — Leif gør det |

---

## Levering / logistik

| Krav | Detalje | Status |
|------|---------|--------|
| Bud-tidspunkt auto-beregning | Byekspressen: leveringstid − 45 min. Taxa/Volvo: leveringstid − (OSRM køretid + 15 min). Systemet foreslår `courier_arrival_time`, kontoret kan justere | ❌ Mangler — `courier_arrival_time`-felt findes, men auto-beregning ikke implementeret. Afventer Byekspressen credentials |
| Listview: "Afleveret til bud"-kolonne | Timestamp fra `delivery_events` — vises i dagens overblik | ✅ Done — `handover`-kolonne i `office/views/bons-list.js:57` + render linje 626–632 (commit `6e63625`) |
| Delivery Spor 1 deploy | Templates for By-expressen + Taxa skal udfyldes via Settings → Leveringsmetoder, ellers viser modalen "template ikke konfigureret" | ❌ Mangler — afventer credentials |

---

## Settings / ikoner

| Krav | Detalje | Status |
|------|---------|--------|
| Leveringsmetode-ikoner i settings | Ikoner for `delivery_method` (bike=🚲, taxi=🚕, volvo=🚛, pickup=🏠) flyttet fra hardcoded til `settings.delivery_method_icons`. `shared/delivery_icons.js` loader via `/api/settings/delivery-icons`. Editor under Settings → System. Bons-list, bon_kort_builder, bon_drawer og logistik bruger nu samme kilde. | ✅ Done — migration 077, editor i `settings/index.html` |

---

## CRM

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Verificér skema-udvidelser på `crm_activities` | `mobile/views/crm.js` POSTer `result`, `sentiment`, `purpose_id` til `/api/crm/activity` — verificér mod prod og opdatér `bon_v2_datamodel_v2.md` så det matcher virkeligheden | `crm_activities` | ⚠ Migration 019 har `result`, `sentiment`, `service_call` — men `purpose_id`/`activity_purposes` skal verificeres |
| `type` CHECK-constraint tillader `service_call` | Mobil CRM bruger typen `service_call` | `crm_activities.type` | ✅ Done — bekræftet i migration 019 (`db/migrations/019_crm_columns.sql:29`) |
| Aktivitetshistorik på mobil kundedetalje | Sektion mellem stats og typiske produkter — viser tidligere noter, opkald, mails, tilbud. Spec: `docs/CLAUDE_CRM_MOBIL_HISTORIK.md` | `crm_activities` JOIN `bons` + `users` + `activity_purposes` | ✅ Done — commit 7f921e9 (CRM mobil: Aktivitetshistorik på kundedetalje) |

---

## Integrationer

| Krav | Detalje | Status |
|------|---------|--------|
| Whiteboard CORS | `bon.ristetrug.dk` skal i `ALLOWED_ORIGINS` på Whiteboard-server | ❌ Mangler |
| Whiteboard → Grocy `addStock` | Bon v2 udstiller endpoint via Grocy-adapter, Whiteboard kalder det fra sit varemodtagelses-flow | ❌ Mangler — endpoint + auth-mønster mangler |

---

## Konfiguration & deploy

| Krav | Detalje | Status |
|------|---------|--------|
| Booking-modul deploy | Kræver `booking_public_url_base`, `booking_default_owner_user_id` og cron-job for reminders (`scripts/booking-reminders.js`) | ❌ Mangler — 3 ting før prod |
| `ANTHROPIC_API_KEY` i `.env` | Ikke i `.env.example`, ikke i `.env` på server. Menu-agent venter på den (`docs/CLAUDE_MENU_AGENT.md`) | ❌ Mangler |
| DMI vs Open-Meteo | Open-Meteo bruges p.t. uden nøgle. Beslut: skift til DMI eller behold Open-Meteo og slet DMI-item helt | ❓ Ikke besluttet |

---

## Test-tracks

| Krav | Detalje | Status |
|------|---------|--------|
| T_CRM | Test-track for CRM-modulet | ❌ Mangler |
| T_CASHFLOW | Test-track for cashflow-modulet | ❌ Mangler |
| T_V1_AFSTEMNING | Baseline-snapshot så vi kan re-køre afstemning hvis der opstår mistanke om data-divergens | ❌ Mangler |
| T_PO_FLOW_E2E | E2E-test der binder opret PO → send mail → modtag svar → varemodtagelse → Grocy `addStock` sammen. Eksisterende specs (T_INDKOB_LISTE, T_INDKOB_SETUP, T_INDKOB_ADMIN, T_INDKOB_HORKRAM) dækker delene | ❌ Mangler — `T_PO_FLOW_E2E.md` |

---

## Data-oprydning

| Krav | Detalje | Status |
|------|---------|--------|
| 77 CVR-duplikatgrupper | Review om de skal merges eller accepteres som afdelinger | ❌ Mangler |

---

---

## Afventer eksternt

| Krav | Detalje | Blokerer |
|------|---------|----------|
| By-expressen credentials | Sebastian skal kontaktes igen | Bud-tidspunkt auto-beregning, Delivery Spor 1 templates |

---

## Kræver afklaring

| Krav | Detalje | Status |
|------|---------|--------|
| Fremtidige ordrer usynlige | Vag — hvor præcist? Kalender + `later.html` + bons-list "Alle"-filter viser fremtid. Kun "I DAG"-mutex i bons-list skjuler dem (by design). Brug for konkret eksempel | ❓ Afklaring fra Leif |

---

## Generelt / andet

| Krav | Detalje | Status |
|------|---------|--------|
| Mobilvenlige views | Listview + drawer skal fungere på telefon — både office og kitchen-roller | ✅ Done — Fase 10 Mobil Shell (`mobile/`) komplet med PIN-login, 5-tab nav, bons/modtag/crm/oversigt-views |

---

## Sammenfatning — stadig åbne huller

Grupperet efter type. Sortér frit efter prioritet.

### 🟢 Quick wins (et Claude Code-pass)
1. **Whiteboard CORS** — `bon.ristetrug.dk` i `ALLOWED_ORIGINS` (cross-repo)

### 🟡 Lidt større småting (timer)
3. **CRM `purpose_id` skemaverifikation** — bekræft mod prod
4. **Whiteboard → Grocy `addStock`** — endpoint via adapter

### 🚀 Deploy / ops
12. **Booking-modul deploy** — 3 settings + cron
13. **Delivery Spor 1 templates** — afventer credentials
14. **Embed-bestilling JotForm swap** — Leif gør det
15. **`ANTHROPIC_API_KEY`** i `.env`
16. **DMI vs Open-Meteo** — beslutning

### 🧪 Test-tracks
17. **T_CRM**
18. **T_CASHFLOW**
19. **T_V1_AFSTEMNING** (baseline-snapshot)
20. **T_PO_FLOW_E2E**

### 🧹 Data-oprydning
21. **77 CVR-duplikatgrupper**

### ⏸ Afventer eksternt
22. **By-expressen credentials** — blokerer #6 i levering-sektionen og Delivery Spor 1

### ❓ Kræver afklaring
23. **Fremtidige ordrer usynlige** — konkret eksempel mangler

---

*Sidst opdateret: 19. maj 2026 — opdateret efter session: kalender-farver, SSE bons-list, sidebar-toggle, drawer-historik, expandable notes lukket. Falsk `better-sqlite3`-item fjernet (eneste reference er korrekt kontrast-eksempel).*
