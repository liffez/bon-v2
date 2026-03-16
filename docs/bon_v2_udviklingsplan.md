# Bon v2 — Overordnet udviklingsplan
*Opdateret: marts 2026*

---

## Princip: Bon v1 kan lukkes ned efter Fase 3

Rækkefølgen er styret af ét mål: at Bon v2 kan overtage Bon v1's rolle hurtigst muligt.
Køkkenet er selvforsynende fra Fase 2. Kontoret er selvforsynende fra Fase 3.

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
| `kitchen/index.html` — Kitchen Dashboard | 🔲 |
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
| `office/calendar.html` — Kalender (sidebar-punkt, genbruger shared/calendar.js) | 🔲 |
| `office/dashboard.html` — Office Dashboard | 🔲 |
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

### 🔧 Fase 2 — Køkken komplet
*Delvist — today/later/calendar er i produktion. Resten afventer.*

Resterende views (rækkefølge efter prioritet):
1. **Kitchen Dashboard** (`kitchen/index.html`) — dagens tal, vagter, alerts, quick links
2. **Kategori-overblik** — totaler pr. kategori for hele dagen (nyttigt til morgenbriefing)
3. **Opskrifter** (`kitchen/recipes.html`) — Grocy, skalering, ingredienser *(prototype klar)*
4. **Lagerstatus** (`kitchen/stock.html`) *(prototype klar)*
5. **Varemodtagelse** (`kitchen/goods-receipt.html`) *(mockup v2 klar)*
6. **Indkøb + Bestilling** (`kitchen/purchasing.html` + `kitchen/orders.html`)

Delte services der stadig mangler:
- `consumeRecipe()` — trigger ved LEVERET via `triggers_json`-handleren
- `addToShoppingList()` — til Indkøb (Fase 6)

*Fase 2 behøver ikke være 100% komplet inden Bon v1 lukkes ned.*

---

### 🔲 Fase 3 — Office basis
*Mål: Bon v1 kan lukkes ned*

| Opgave | Note |
|--------|------|
| `office/calendar.html` | Lille — genbruger shared/calendar.js, sidebar-punkt |
| `office/dashboard.html` | Mockup klar (`11_dashboard.html`) |
| Ugeoversigt | Smartplan vagter + bonner kombineret |
| Tilbud | Mockup klar (`tilbud-v3b.html`), skema klar (`is_offer`) |

**Rækkefølge:** Kalender → Dashboard → Tilbud → Ugeoversigt

---

### 🔲 Fase 4 — Mail ind + CRM + Formbuilder
*Ordrer ind automatisk, salg og opfølgning i systemet*

**Mail ind (UI):**
- Manuel indbakke for umatched mails (routing-backend er bygget i Fase 1e)
- Mail-tråd i drawer (bon_mails) og på kundekort (customer_mails)
- ✉-ikon + tæller i listview og kalender

**CRM:**
- CRM-aktiviteter (opkald, noter, møder, opgaver, opfølgning)
- Nano CRM migration fra prototype til Bon v2
- CVR-lookup integration (Virk ElasticSearch — credentials afventer erst.dk)
- Smart suggestions: overdue regulars, sæsonpåmindelser, ubesvarede leads

**Formbuilder:**
- Formbuilder v6 HTML publiceres til ristetrug.dk/bestil
- Webhook-URL sættes i formbuilder admin-panel

---

### 🔲 Fase 5 — Levering
*Arkitektur besluttet (se `leveringsbooking_beslutning.md`)*

| Udbyder | Metode |
|---------|--------|
| Byekspressen | Lobo API v3 — automatisk |
| Taxa | Clipboard-kopi + taxa.nu — manuel |
| Volvo | Intern log |
| Afhentning | Flag på bon |

UI: Leverings-strip på alle bon-kort · Modal ved GODKENDT uden levering (ikke-blokerende)

**Blokeret af:** Credentials + kundernr + produkt-ID fra Martin Ross (sebastian@by-expressen.dk)

---

### 🔲 Fase 6 — Grocy skriv + Indkøb
*Bygger på Grocy-adapteren fra Fase 2*

- `consumeRecipe()` trigger ved LEVERET
- `addToShoppingList()` — indkøbsbehov fra bonner
- Purchase order flow: bestilling → bekræftelse → modtagelse
- Indkøbsliste UI (kobles til Grocy shopping list)
- Multi-lokation support (HQ + Trailer — separate Grocy-instanser)
- Fødevarestyrelse: sporbarhed, temperaturer, goods receipt

---

### 🔲 Fase 7 — Integrationer
*Fakturering uden manuel håndtering*

- e-conomic: bon → faktura
- EAN-validering ved ordreregistrering
- EAN learning system (lærer mønstre per EAN-nummer)
- Statistik: omsætning, populære produkter, leveringsdata

---

## Parallelle spor
*Kan bygges uafhængigt af faserækkefølgen*

| Spor | Status | Note |
|------|--------|------|
| **Whiteboard** (daglige opgaver, rengøring) | 🔲 | Selvstændigt system |
| **SOP-system** | ✅ Kører | Excalidraw-baseret |
| **Cash flow dashboard** | 🔲 Spec klar | `/cashflow` mini-app, spec i CLAUDE_cashflow.md |
| **Bud-app** | 🔲 | Browser-baseret, QR-kode, Fase 5+ |
| **Opskrift-UI** | 🟡 Prototype | Afventer Grocy-dataoprydning |
| **Menu-agent (AI)** | 🔲 Spec klar | Spec i CLAUDE_MENU_AGENT.md — kan bygges når Fase 3B er i gang |

---

## Åbne punkter og afhængigheder

| Punkt | Status |
|-------|--------|
| Byekspressen credentials (Martin Ross / sebastian@by-expressen.dk) | ⏳ Ikke rykket endnu |
| Virk ElasticSearch credentials (erst.dk) | ⏳ Afventer godkendelse |
| Formbuilder webhook-URL sat + HTML publiceret til ristetrug.dk/bestil | ⏳ Afventer |
| Ny server deployment (Hetzner/DO + Nginx + SSL) | ⏳ Planlægges |
| Datamigration Bon v1 → v2 | ⏳ Planlægges parallelt med Fase 3 |
| Leveringsmetode-ikoner til settings-tabel | 🔵 Fase 4+ (nu hardcodet i bons-list.js) |
| `consumeRecipe()` trigger ved LEVERET | 🔵 Fase 6 |
| Menu-agent: `ANTHROPIC_API_KEY` i `.env` | ⏳ Simon tilføjer når klar til implementering |
| Menu-agent: `menuAgentPromptBase.txt` redigeres fra systemdokument | ⏳ Leif/Simon gennemgår inden implementering |

---

## Designsystem — nøglefarver

```css
--brand-primary:       #8e631f;
--brand-primary-light: #f1e6b2;
--color-background:    #f5f4f2;
--color-border:        #d7d1ca;
```

Font: Lato. Body-klasse: `zone-kitchen` eller `zone-office`.
