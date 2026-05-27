# CLAUDE.md — Bon v2 / Ristet Rug
> Instruktioner til Claude Code. Læs hele dokumentet før du skriver én linje kode.

---

## Hvad er dette projekt?

**Bon v2** er et ordre- og kundestyringssystem for **Ristet Rug**, et dansk cateringfirma.  
Det kombinerer et ordresystem (bon-flow) med et nano-CRM — alt i ét system, ingen separate apps.

Systemet bruges dagligt af Leif (salgschef) og hans kone via browser på lokalt netværk.  
Hans bror bygger den tekniske del. Leif definerer krav og UI.

---

## Stack (ikke til diskussion)

| Lag | Valg |
|-----|------|
| Backend | **Node.js + Express** |
| Database | **SQLite** (via `better-sqlite3`) |
| Frontend | HTML/CSS/JS — server-rendered eller vanilla JS. Ingen React, ingen bundler. |
| CSS | Vanilla CSS med custom properties — ingen Tailwind, ingen Bootstrap |

> ⚠️ Brug **ikke** Python, Flask, FastAPI, React, Vue, Next.js, eller andre frameworks.  
> Hold dependencies minimale. Bon v2 er allerede i gang — match det eksisterende system.

### Typisk Express-struktur
```
server.js          ← app entry point
routes/
  bons.js
  customers.js
  crm.js
  ...
db/
  database.js      ← SQLite connection + migrations
  views.js         ← CREATE VIEW statements
public/
  css/
  js/
views/             ← HTML templates (eller inline i routes)
```

### Database-forbindelse
```javascript
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'bon_v2.db');
db.pragma('foreign_keys = ON');
```

### API-mønster
Alle endpoints på `/api/...`, returnerer JSON.
```javascript
GET /api/customers?stage=vip&category=catering&days=90

POST /api/activity  →  { customer_id, bon_id, type, result, sentiment, text }

// Alle writes returnerer
{ success: true, id: ... }

// Fejl
{ error: "besked" }  +  passende HTTP-statuskode
```

---

## Reference-filer (læs dem — de er facit)

| Fil | Beskrivelse |
|-----|-------------|
| `CRM_Design_Document_v2.md` | **Autoritativ spec** — læs ved tvivl om krav eller arkitektur |
| `crm_server.py` | Python-prototype — **reference for logik og SQL**, ikke for stack |
| `crm-mockup.html` | UI-prototype: dashboard, kundeliste, pipeline |
| `crm-kunde360.html` | UI-prototype: 360° kundeprofil |
| `crm-kunde360-aktivitet.html` | UI-prototype: aktivitetstimeline |
| `crm-kunde360-smileys.html` | UI-prototype: sentiment-picker og trendlinje |

> `crm_server.py` er en Python-prototype og bruges **kun** som reference for SQL-queries og forretningslogik.  
> Al ny kode skrives i Node.js/Express. Kopier aldrig Python-kode direkte.

> Mockup-HTML-filerne er **facit for UI-layout og interaktion**. Åbn dem ved tvivl om design.

---

## Arkitekturbeslutninger (ikke til diskussion)

### Bon er omdrejningspunktet
- `bons`-tabellen ER vores deal. Der er **ingen separat deals-tabel**.
- En forespørgsel starter som en aktivitet på kunden. Når der er nok info → opret bon med `is_offer=1`.
- Pipeline-boardet er en **filtreret visning** af bons — ikke en separat datastruktur.

### crm_activities dækker alt
- Opkald, service-kald, noter, møder, opgaver, mails — alt er rækker i `crm_activities`.
- **Ingen separat `service_calls`-tabel.**
- En aktivitet kan linke til BÅDE `customer_id` OG `bon_id` — begge nullable, mindst én sat.

### Tilbud = bon med is_offer=1
- Felter på `bons`: `is_offer`, `offer_status`, `offer_sent_at`, `offer_valid_until`
- `offer_status`: draft / sent / won / lost / expired

---

## Datamodel

### Kerne-tabeller
```
users             — medarbejdere med roller
companies         — firmaer (CVR, EAN, faktura)
customers         — kontakter linket til firma
bons              — ordrer OG tilbud
bon_lines         — ordrelinjer
status_definitions / status_transitions
price_categories  — catering / festival / produktion
changelog         — audit trail
```

### CRM-tabeller
```
crm_customer_meta    — stage, tags, owner, samtykke, næste opfølgning
crm_activities       — id, customer_id, bon_id, type, result, sentiment, text,
                        due_at, done_at, owner_user_id, created_at
crm_custom_fields    — EAV: tilføj felter uden migration
crm_custom_values    — værdier til custom fields
crm_unmatched_emails — manuel mail-capture arbejdsindbakke
```

### crm_activities feltregler
- `type`: call, service_call, meeting, task, note, followup, offer_sent, email_in, email_out
- `result`: reached, busy, no_answer, voicemail, callback, email_instead
- `sentiment`: positive / neutral / negative — **kun sat** når `result = 'reached'` eller `'callback'`. NULL ellers.

### Bon-status flow
```
NY → VENTER → GODKENDT → IGANG → KLAR → LEVERET → FAKTURERET → BETALT → AFSLUTTET
TILBUD → (won) → GODKENDT
TILBUD → (lost/expired) → AFLYST
```

### SQL-views (opret ved app-start hvis de ikke findes)
```sql
v_service_calls_pending   -- leveringer uden service-kald (7 dage)
v_callbacks_pending       -- kunder der afventer callback
v_hard_to_reach           -- 3+ mislykkede forsøg
v_service_call_log        -- opkaldshistorik med sentiment
v_call_stats_weekly       -- ugentlig reach-rate
v_sentiment_per_customer  -- seneste 6 opkald pr. kunde (til trendlinje)
v_offer_pipeline          -- åbne tilbud
v_dormant_customers       -- sovende kunder 60d+
v_customer_overview       -- 360° nøgletal pr. kunde
v_my_tasks_today          -- åbne opgaver sorteret efter deadline
```
> Se `crm_server.py` for de præcise CREATE VIEW statements — brug dem som reference.

---

## Hvad er bygget i Bon v2 (live i dag)

### Dashboard (`/`)
- **KPI-bånd øverst:** Omsætning MTD · Enheder MTD · Åbne bons (NY/VENTER/GODKENDT/IGANG/KLAR) · Ufaktureret
- **Bons · 10 dage:** Søjlediagram med akkumuleret kurve, toggle Enheder/Kr
  - Farver per kategori: Store / Catering / Festival / Produktion / Waiste
  - Bruger-avatarer (initialer i bobler) på datapunkter
- **I DAG-panel:** Bons i dag · Enheder · Pax · Pickup
  - Advarselsbanner ved manglende emballage/råvare
  - Kategori-breakdown tabel
- **PREP-panel:** Næste leveringsdag — bon-liste med kunde, firma, enheder
- **Top Produkter MTD:** Rangliste med %-bar
- **CRM · Opfølgning:** Placeholder — "CRM kommer i næste fase"

### Bons-liste (`/bons`)
- **Søgefelt:** "Søg bon#, navn, firma..."
- **Hurtigfiltre:** `I DAG` · `NY` · `ULÆST MAIL` · Dato-picker · `Alle`
- **Oversigtslinje:** "X dag · Y bonner · Z pax · W enheder"
- **Kolonner:** BON# · DATO · TID · STATUS · KUNDE · FIRMA · PAX/ENH · BUD · MAIL
- **Status-badges:** farvekodet pill (se farver nedenfor)
- **Mail-badge:** orange tæller for ulæste mails på bon
- **`+ Ny bon`** knap øverst højre

### Sidebar — komplet struktur
```
[🛡 Ristet Rug]

OVERBLIK
  📊 Dashboard          ✅ bygget

ORDRER
  📋 Bons               ✅ bygget
  📅 Kalender           ✅ bygget
  📦 Planlægning        ✅ bygget

CRM
  📊 CRM                ← skal bygges (pipeline, forslags-motor, serviceopkald)
  👤 Kunder             ← skal bygges (kundeliste + 360° profil)
  📨 Indbakke           ← skal bygges (mail-capture)

DRIFT
  🚛 Logistik           disabled
  🍳 Køkken             disabled
  🛒 Indkøb             disabled

ØKONOMI
  💰 Fakturering        disabled
  📈 Rapporter          disabled

TEAM
  📅 Vagtplan           → åbner vagtplan.html i ny fane (kan integreres bedre senere)
  🖊 Whiteboard         → åbner whiteboard.ristetrug.dk i ny fane
  📋 SOP                → åbner sop.ristetrug.dk i ny fane

──────────────────
⚙ Settings
→ Log ud
[K] Brugernavn (avatar)
```

> **Disabled nav-items:** vises i sidebar, kan ikke klikkes, dæmpet farve.  
> **CRM ≠ Kunder** — to separate sider med forskelligt indhold.

### Kalender (`/kalender`) ✅ BYGGET

- Måneds-navigation: ◄ Marts 2026 ►
- Søgefelt: "Søg bon#, kunde, firma..."
- Tabel med kolonnerne: BON# · DATO · STATUS · PAX · ENHEDER · KUNDE · FIRMA · BETALING · TID · TYPE
- Sorteret kronologisk — dato stigende som default
- Status-badges (LEV, KLAR, IGANG, GODKENDT, VENTER INFO) — samme farver som bons-listen
- TYPE-kolonne: pickup / delivery
- BETALING-kolonne: mobilepay / invoice
- `+ Ny bon` og kalender/liste-toggle øverst højre

### Planlægning (`/planlægning`) ✅ BYGGET

**Vagtplan for perioden** — øverste sektion:
- Ugedagskolonner (Man/Tir/Ons/Tor/Fre) med medarbejdernavne under hver dag

**Periode-filter:**
- Fra/Til dato-picker + ◄ ► navigation
- Status-filter chips: NY · VENTER INFO · GODKENDT · IGANG · KLAR · LEV · FAKTURERET · BETALT · AFSLUTTET · TILBUD

**Bons i perioden:**
- "X bons · Y enh" oversigtslinje
- Tjekboks per bon — "Vælg alle"
- Kolonner: ✓ · BON# · STATUS · KUNDE/FIRMA · DATO · ENHEDER

**Aggregeret produktionsoversigt** — nederste sektion:
- "X varer · Y enheder" oversigtslinje
- Knapper: `🥕 Råvarer` · `≡ Sammentælling`
- Tabel: ANTAL · VARE · KATEGORI
- Kategorier: Sandwich, Slider, emballage, levering, mad — med forskellig typografi (fed = mad, kursiv = logistik)

---



Prioriteret rækkefølge:

1. **Kunder-side** (`/customers`)
   - Kundeliste med stage-filter (VIP/Aktiv/Sovende/Lead), kategori-filter, dato-filter
   - Hover-actions: Ring, Note, Åbn profil
   - Hurtig note popup (1 klik)

2. **360° Kundeprofil** (`/customers/:id`)
   - 2-kolonne layout: venstre 300px (statisk info) + højre (faner)
   - KPI-bånd: Ordrer · Gæster · Stemning · Næste event
   - Faner: Bons & ordrer / Aktivitet / Tilbud
   - Sentiment trendlinje (6 seneste opkald, farvede prikker med pile)
   - Mønstre & Indsigt-boks (SQL-beregnet, ingen AI)

3. **CRM-side** (`/crm`) — service-kald ✅ allerede bygget, resten mangler
   - Daglig briefing (max 4 punkter, klikbare)
   - Smart forslags-motor (overdue, sæson, leads, tilbud, sovende)
   - ✅ Service-kald liste (se "Hvad er bygget" nedenfor)
   - Sentiment-picker 😊/😐/😟 ved reached/callback
   - **Ny: Send mail til kontaktperson** (se "Mail til kontakt" nedenfor)

4. **Pipeline-board** (del af CRM-siden)
   - Kanban: Ny forespørgsel / Tilbud sendt / Afventer svar / Bekræftet / Tabt
   - Drag & drop opdaterer bon-status
   - Kort: kundenavn, eventdato, pax, beløb, badges (VIP, event snart, svar mangler)
   - Klik åbner sidepanel (ikke ny side)

5. **Opret forespørgsel** — popup: firma → kontakt → dato → gæster → gem som bon NY

6. **Tilbudsmodul** (wizard) — forespørgsel → udfyld → opret bon med `is_offer=1`

### CRM-side — Service-kald (`/crm`)  ✅ BYGGET I BON V2

**KPI-bånd øverst:** Service-kald (Venter) · Callbacks (Venter) · Svære at nå (3+ forsøg) · Reach-rate (denne uge)

**Faner:** `Service-kald [N]` · `Callbacks [N]` · `Opkaldslog`

**Service-kald liste:**
- Filter: "Vis leveringer fra de seneste [7 dage ▾]"
- Hver række viser: kundenavn · bon-link (#cafe-3340) · firma · pax · telefonnummer
- Dage-badge (f.eks. `6 dage`) — antal dage siden levering
- **`📞 Ring`** knap (grøn) — kalder `tel:` URL → iPhone via macOS Continuity Calls
- **`✓ Håndteret`** knap — markerer som klaret uden at logge opkald
- Fold-ud ordrehistorik: "▼ vis ordrer" viser seneste 5 ordrer med indhold

**Opkaldsregistrering (modal ved Ring):**
- Resultat: reached / busy / no_answer / voicemail / callback / email_instead
- Note-felt
- Sentiment-picker 😊/😐/😟 — vises kun ved `reached` eller `callback`

---

## Mail til kontaktperson (mangler — skal bygges)

Der er i dag ingen måde at sende en mail direkte fra systemet. Dette er et hul.

> **Forudsætning:** En kontaktperson skal være oprettet som Kunde i systemet med en mailadresse, før man kan sende mail. Mail-knappen vises kun hvis `customers.email` er udfyldt.

**Hvad der skal bygges:**
- `📧 Mail`-knap på kundekortet, servicekald-listen og 360° profilen
- Åbner en simpel compose-popup med: Til (autofyldt fra kontakt), Emne, Besked
- Afsendelse via `mailto:` link (åbner brugerens mail-klient) **eller** via en SMTP-route på serveren
- Aktiviteten logges automatisk som `type: email_out` i `crm_activities`
- Hvis `mailto:` bruges: brugeren bekræfter afsendelse manuelt i en lille dialog efterfølgende, så aktiviteten alligevel logges

**Placering af Mail-knap:**
- Service-kald liste: ved siden af Ring-knappen (sekundær, mindre)
- 360° kundeprofil hover-actions
- Svære-at-nå liste (der foreslås automatisk mail efter 3+ forsøg)

> Beslutning om SMTP vs mailto: afventer — byg `mailto:` først, det er simplest og kræver ingen server-config.

---

### Sidebar (varm brun/chokolade)
```css
--sidebar-bg:      #4A3728;
--sidebar-hover:   #5C4433;
--sidebar-active:  #6B5040;
--sidebar-text:    #E8DDD0;
--sidebar-muted:   #8A7060;   /* disabled items */
--sidebar-section: #7A6050;   /* sektions-labels */
--sidebar-width:   180px;
```

### Generel palette
```css
--color-bg:        #FAF8F5;
--color-surface:   #FFFFFF;
--color-accent:    #8B6914;   /* guld/bronze */
--color-text:      #1A1A1A;
--color-muted:     #6B7280;
--color-border:    #E5E0D8;

--color-red:       #DC2626;
--color-gold:      #D97706;
--color-green:     #16A34A;
--color-blue:      #2563EB;
--color-purple:    #7C3AED;
```

### Status-badge farver
```
NY           → grå
VENTER       → guld/amber
TILBUD       → lilla
GODKENDT     → grøn
IGANG        → blå
KLAR         → mørkegrøn
LEVERET      → tonet grøn
FAKTURERET   → orange
BETALT       → grøn
AFSLUTTET    → grå
AFLYST       → rød
```

### Typografi
```css
--font-heading: 'Playfair Display', Georgia, serif;
--font-body:    'DM Sans', system-ui, sans-serif;
```

### Skriftstørrelser
Systemet skal være let at læse — fejl på den store side frem for den lille.

```css
--text-xs:   13px;   /* sekundære labels, timestamps */
--text-sm:   14px;   /* tabel-indhold, badges */
--text-base: 15px;   /* brødtekst, liste-items — minimum for primært indhold */
--text-md:   16px;   /* vigtige felter, knapper */
--text-lg:   18px;   /* sektionsoverskrifter */
--text-xl:   22px;   /* sideoverskrifter */
--text-2xl:  28px;   /* KPI-tal på dashboard */
```

> Brug **aldrig** under 13px. Tabel-indhold skal minimum være 14px.  
> Systemet bruges primært på desktop/stor skærm — prioritér læsbarhed over kompakthed.

### UI-regler
- **Maks 1 klik** til ring, note, tilbud — ingen ekstra bekræftelsesdialog
- **Hover-actions:** handlingsknapper vises KUN ved mouseover på listeelementer
- **Detaljevisninger åbner i sidepanel** — ikke ny side, ikke modal
- **Dansk tekst** overalt — ingen engelske labels i UI
- Ingen CSS-frameworks — vanilla CSS

### Sentiment
| Smiley | Felt-værdi | Farve |
|--------|-----------|-------|
| 😊 | positive | grøn |
| 😐 | neutral | guld |
| 😟 | negative | rød |

Picker vises **kun** ved type `call`/`meeting` og result `reached`/`callback`.

---

## macOS-integration

```javascript
// Ring til en kunde — routes til iPhone via macOS Continuity Calls
function ringKunde(telefon) {
    window.location.href = `tel:${telefon}`;
}
```

`GET /lookup?phone=NUMMER` — returnerer kundeinfo til macOS Shortcut (⌘⌥R → clipboard → localhost).

---

## Forretningsregler

- **VIP:** 10+ ordrer ELLER 50.000+ kr omsætning
- **Dormant:** 60+ dage siden seneste ordre
- **Service-kald trigger:** bon leveret inden for 7 dage uden opfølgning
- **Svær at nå:** 3+ mislykkede kontaktforsøg → foreslå mail
- **Sentiment trendlinje:** kun seneste 6 opkald — ét dårligt fra for et år siden må ikke overdøve fem gode siden

---

## Fravalg

| Fravalg | Begrundelse |
|---------|-------------|
| Separat deals-tabel | Bon er deal |
| Separat service_calls-tabel | Aktivitet i crm_activities |
| Python | Bon v2 kører Node.js/Express |
| React / Vue / bundler | Unødvendig kompleksitet |
| IMAP-sync | Manuel mail-capture via paste |
| Open/click tracking på 1:1 mail | Kun på marketing-mail (eksternt) |
| Lead source-tracking | Ikke konsistent nok endnu |

---

## Nyttige kommandoer

```bash
node server.js
PORT=3001 node server.js
npx nodemon server.js   # development
```
