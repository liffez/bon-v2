# Bon v2 — Overordnet udviklingsplan v3
*Opdateret: 18. marts 2026*

---

## Princip: Bon v1 kan lukkes ned når alle disse er opfyldt

| Krav | Fase |
|------|------|
| Bon v2 håndterer ordreindgang (formbuilder webhook aktiv) | 3C + 5a |
| Mail virker — ind og ud på bon@ og kontakt@ | 4 |
| Server oppe på Hetzner, testet og stabil | 5a |
| Datamigration v1 → v2 gennemført og verificeret | 5a |
| Kontoret er selvforsynende (listview, kalender, drawer) | 3A ✅ |
| Køkkenet er selvforsynende (today, later, Grocy-skriv) | 2 |

---

## Hvad der er bygget

### Fundament og backend ✅
| Artefakt | Status |
|----------|--------|
| Databaseskema — 14 migrationsfiler | ✅ |
| Express server, SQLite, SSE, statusflow, changelog | ✅ |
| Modulær route-struktur (`routes/`, `db/`, `services/`) | ✅ |
| Grocy adapter (readonly) — recipes, products, stock, unit conversions | ✅ |
| Smartplan adapter — OAuth2, shifts + worklogs | ✅ |
| Auth — email+password, sessions, roller (admin/office/kitchen/delivery) | ✅ |
| Mail service — SMTP udgående (2 transports) + IMAP polling + tag-routing | ✅ |
| CVR/EAN lookup — Virk ES + NemHandel scraping | ✅ |
| Formbuilder webhook — honeypot, firma/kunde find/opret, EAN-udtræk, DAWA | ✅ |

### Shared komponenter ✅
| Komponent | Status |
|-----------|--------|
| `shared/bon_kort.js` — kort-komponent med action-bar, prep, køkkeninfo, drag-drop | ✅ |
| `shared/calendar.js` — kalender + listevisning, Smartplan, SSE | ✅ |
| `shared/modal.js` — historik, bon-info, råvarer (Grocy + lager) | ✅ |
| `shared/flyver.js` — nødbesked-system, SSE, banner, kvittering | ✅ |
| `shared/vare_picker.js` — Grocy-opskriftspicker, kategori-nav, snapshot-gem | ✅ |
| `shared/bon_opret_modal.js` — hurtig bon-oprettelse | ✅ |
| `shared/bon_drawer.js` — fuld bon-redigering, URL-sync, dirty-tracking, VARER | ✅ |
| `shared/kunde_soeg.js` — kunde/firma-søg, CVR-opslag, to-trins opret | ✅ |
| `shared/login.html` — fælles login (email+pw auto-detect) | ✅ |

### Kitchen-views ✅ / 🔲
| View | Status |
|------|--------|
| `kitchen/today.html` — Køkken I dag | ✅ |
| `kitchen/later.html` — Køkken Senere | ✅ |
| `kitchen/calendar.html` — Kalender (delt med office) | ✅ |
| `kitchen/index.html` — Kitchen Dashboard | ✅ |
| `kitchen/vagtplan.html` — Ugeoversigt (Smartplan-vagter) | ✅ |
| Kategori-overblik (totaler pr. kategori for dagen) | 🔲 |
| `kitchen/recipes.html` — Opskrifter (Grocy, skalering) | 🟡 Prototype klar |
| `kitchen/stock.html` — Lagerstatus | 🟡 Prototype klar |
| `kitchen/goods-receipt.html` — Varemodtagelse | 🟡 Mockup v2 klar |
| `kitchen/purchasing.html` — Indkøbsliste | 🔲 |
| `kitchen/orders.html` — Bestilling/PO | 🔲 |

### Office-views ✅ / 🔲
| View | Status |
|------|--------|
| `office/index.html` + `office/views/bons-list.js` — Listview | ✅ |
| `office/views/dashboard.js` — Office Dashboard | ✅ |
| `office/calendar.html` — Kalender (sidebar-punkt, genbruger shared/calendar.js) | 🔲 |
| Ugeoversigt (Smartplan + bonner) | 🔲 |
| Tilbud (pipeline, is_offer, mockup klar) | 🔲 |

### Settings ✅
| Modul | Status |
|-------|--------|
| `settings/index.html` — 7 sektioner | ✅ |
| Brugere, Priskategorier, Betalingstyper | ✅ |
| Grocy-konfiguration per lokation | ✅ |
| Mail (SMTP × 2, IMAP × 2, signatur, skabelon) | ✅ |
| Formbuilder feltmapping | ✅ |
| System-indstillinger | ✅ |

---

## Udviklingsplan fremad

### ✅ Fase 0 — Fundament
*Komplet*

### ✅ Fase 0b — Backend refaktorering
*Komplet*

### ✅ Fase 1 — Bon-kerne + Auth + Settings
*Komplet*
- Auth + roller, bon-opret, drawer, kunde-søg, VarePicker
- Formbuilder webhook
- Settings UI + mail service

### ✅ Fase 2 — Køkken komplet (delvist)
*today / later / calendar / dashboard / vagtplan er i produktion. Resten afventer.*

> **Grocy-integration er fundamentalt for at køkkenet kan fungere fuldt ud.**
> En bon kan ikke vise korrekte menuer, priser og lagerstatus — eller opdatere Grocy ved LEVERET —
> uden at denne integration er på plads. Fase 2 er ikke done før Grocy-laget virker begge veje.

Resterende (rækkefølge efter prioritet):
1. **Kitchen topbar redesign** — dropdown til Grocy-aktiviteter (opskrifter, lager, indkøbsliste)
2. **Opskrifter** (`kitchen/recipes.html`) *(prototype klar)*
3. **Lagerstatus** (`kitchen/stock.html`) *(prototype klar)*
4. **Varemodtagelse** (`kitchen/goods-receipt.html`) *(mockup v2 klar)*
5. **`consumeRecipe()`** — trigger ved LEVERET via `triggers_json`-handleren → skriver forbrug til Grocy
6. **Indkøbsliste** (`kitchen/purchasing.html`) — `addToShoppingList()` kobles til Grocy shopping list
7. **Bestilling/PO** (`kitchen/orders.html`) — udskydes, kompleks

*Fase 2 behøver ikke være 100% komplet inden Bon v1 lukkes ned — men Grocy-skriv (punkt 5) skal være på plads.*

---

### ✅ Fase 3A — Office Listview
*Komplet*

### ✅ Fase 3B — Dashboards
*Komplet — kitchen + office dashboard, legoklods-chart, vagtplan, vejr*

### 🔲 Fase 3C — Office resterende
*Mål: Bon v1 kan lukkes ned*

| Opgave | Note |
|--------|------|
| `office/calendar.html` | Lille — genbruger shared/calendar.js, sidebar-punkt |
| Ugeoversigt | Smartplan vagter + bonner kombineret |

**Rækkefølge:** Kalender → Ugeoversigt

---

### 🔲 Fase 4 — Mail UI + CRM + Tilbud + Jotform
*Ordrer ind, salg og opfølgning i systemet*

**Mail UI:**
- Indbakke for umatched mails (routing-backend bygget i 1e)
- Mail-tråd i drawer (bon_mails) og på kundekort (customer_mails)
- ✉-ikon + tæller i listview og kalender
- Gælder begge mailboxe: bon@ og kontakt@ristetrug.dk

**CRM + Tilbud:**
- CRM-aktiviteter (opkald, noter, møder, opgaver, opfølgning)
- Nano CRM migration fra prototype til Bon v2
- CVR-lookup via Virk ElasticSearch (credentials klar)
- Smart suggestions: overdue regulars, sæsonpåmindelser, ubesvarede leads
- Tilbud (`is_offer` flow) — mockup + skema klar, bundlet med CRM

**Jotform webhook:**
- `/api/webhooks/jotform` — kopi af bestilling-webhook med Jotform field-mapping
- Erstatter Bon v1's nuværende Jotform-integration

### 🔲 Fase 4b — Whiteboard + SOP integration
- Whiteboard sidekick-integration til Bon v2 dashboards (iframe/embed)
- SOP-system kobling fra Whiteboard
- Whiteboard og SOP kører allerede — dette er integrationslaget

---

### 🔲 Fase 4c — Cash flow dashboard *(parallelt spor — blokerer intet)*
- `/cashflow` mini-app på samme server
- Bankafstemning, e-conomic sekundær kilde
- Spec klar: `CLAUDE_cashflow.md`
- Kan bygges når som helst uafhængigt af de øvrige faser

---

### 🔲 Fase 5a — Hetzner deployment + datamigration
*Infrastruktur — sker parallelt med 4x, går live inden 5b*

- Hetzner VPS + Nginx reverse proxy + Let's Encrypt SSL
- Bon v2 og Bon v1 kører side om side til verifikation
- Datamigration v1 → v2 når tilliden er der

### 🔲 Fase 5b — Ordreindgang komplet
*Alle kanaler aktive — kræver 5a (server live)*

- Formbuilder v6 HTML → ristetrug.dk/bestil
- Event bestilling webhook
- Smage booking webhook
- Webhook-URL sættes i hvert systems admin-panel

### 🔲 Fase 5c — Menu-agent (AI)
*Naturlig forlængelse af automatisk ordreindgang*
- `POST /api/bons/:id/menu-suggestion` — Anthropic API
- Grocy-opskrifter → bon-linjer med emballageberegning
- Preview-panel i drawer + opret-modal
- Spec klar: `CLAUDE_MENU_AGENT.md`
- *Rykkes til efter Fase 8 hvis implementeringen viser sig sværere end ventet*

---

### 🔲 Fase 6 — Levering (Byekspressen + Taxa)
*Arkitektur besluttet*

| Udbyder | Metode |
|---------|--------|
| Byekspressen | Lobo API v3 — automatisk |
| Taxa | Clipboard-kopi + taxa.nu — manuel |
| Volvo | Intern log |
| Afhentning | Flag på bon |

UI: Leverings-strip på alle bon-kort · Modal ved GODKENDT uden levering (ikke-blokerende)
**Blokeret af:** Credentials fra Martin Ross (sebastian@by-expressen.dk)

---

### 🔲 Fase 7 — E-conomic + EAN + iZettle
- e-conomic: bon → faktura
- EAN-validering ved ordreregistrering + learning system
- iZettle/POS integration (direkte BETALT-bon)
- Statistik: omsætning, populære produkter, leveringsdata

---

### 🔲 Fase 8 — Multi-lokation Grocy
- HQ + Trailer som separate Grocy-instanser (pt. hardcodet til test)
- Lokations-skift i UI — hvilken Grocy-instans er aktiv
- **Vare-flytning mellem lokationer** — håndterer overførsel af varer fra én Grocy-installation til en anden (fx fra HQ til Trailer inden festival)
- Lagerstatus på tværs af lokationer

---

### 🔲 Fase 9 — ESP32/MQTT sensorer
- Temperatur-, energi- og vægtsensorer
- MQTT broker integration
- Sandsynligvis separat mini-app eller Grocy-integration

---

## Åbne afhængigheder

| Punkt | Status |
|-------|--------|
| Byekspressen credentials (sebastian@by-expressen.dk) | ⏳ Ikke rykket endnu |
| Menu-agent: `ANTHROPIC_API_KEY` i `.env` | ⏳ Simon tilføjer når klar |
| Menu-agent: `menuAgentPromptBase.txt` | ⏳ Leif/Simon gennemgår inden implementering |
| Formbuilder webhook-URL + HTML til ristetrug.dk/bestil | ⏳ Afventer 5a (server live) |
| Datamigration Bon v1 → v2 | ⏳ Planlægges parallelt med Fase 4 |
| Leveringsmetode-ikoner → settings-tabel | 🔵 Fase 4+ (nu hardcodet i bons-list.js) |
| `consumeRecipe()` trigger ved LEVERET | 🔵 Fase 2 (Grocy-skriv)

---

## Designsystem — nøglefarver

```css
--brand-primary:       #8e631f;
--brand-primary-light: #f1e6b2;
--color-background:    #f5f4f2;
--color-border:        #d7d1ca;
```

Font: Lato. Body-klasse: `zone-kitchen` eller `zone-office`.
