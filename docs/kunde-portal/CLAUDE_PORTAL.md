# CLAUDE_PORTAL.md — Multi-afdelings bestillingsportal

> **Til Simon:** Denne spec beskriver "Bestillingsportalen" — en selvstændig kunde-vendt webapp hvor store kunder med flere afdelinger kan samle bestillinger inden de sendes som én aggregeret bon til Bon v2.
> Mockups ligger i projektet: `portal_dashboard_v2.html`, `portal_department_v2.html`, `portal_admin.html`, `portal_customer_v2.html`.
> **Status:** Designet (UI låst). Datamodel + API-kontrakt klar til implementering.

---

## 1. Hvad portalen er — og ikke er

### Det er

En selvstændig webapp på `portal.ristetrug.dk` hvor en stor B2B-kunde kan:

- Opdele bestillingen mellem flere afdelinger (hver med egen bestiller)
- Aggregere alle afdelingers ønsker til én samlet bon
- Sende den aggregerede bon til Ristet Rug via Bon v2's eksisterende API

Strukturelt mønster: **Samme model som event-bestillingssystemet og whiteboard.** Selvstændig app der lever ved siden af Bon v2 og kommunikerer via API.

### Det er ikke

- En frokostordning (recurring abonnement) — det er ad-hoc multi-afdelings bestilling
- Et CRM eller kunde-kontaktstyringssystem — det bruger Bon v2's CRM
- En generel form-løsning — det er én specifik flow-type med fast struktur
- En modtagelses-platform i Bon v2 — Bon v2 modtager bare én helt almindelig bon

---

## 2. Arkitektur

### Højniveau dataflow

```
┌──────────────────────────────────┐
│   GROCY                          │
│   - Opskrifter (menu)            │
│   - Allergen-flags               │
│   - Kategorier (vegetar etc.)    │
└──────────────┬───────────────────┘
               │ adapter-læsning
               ▼
┌──────────────────────────────────┐
│   BON v2                         │
│   - Grocy-adapter (kanonisk)     │
│   - GET /api/menu/items          │
│   - POST /api/bons (modtag)      │
└──────────────┬───────────────────┘
               │ HTTPS / JSON
               ▼
┌──────────────────────────────────┐
│   PORTAL                         │
│   - Egen SQLite                  │
│   - Egen Express + Vanilla JS    │
│   - Egen auth                    │
└──────────────────────────────────┘
```

### Stack

Samme som Bon v2 — ingen alternativer.

| Lag | Valg |
|-----|------|
| Backend | Node.js / Express |
| Database | SQLite via better-sqlite3 |
| Frontend | Vanilla HTML/CSS/JS |
| Realtid | SSE (kun for dashboardet, hvor afdelinger bestiller live) |
| Auth | `express-session` med SQLite store, magic-link tokens for afdelinger |
| Styling | Vanilla CSS, samme tokens som Bon v2 (importeres) |

### Hvor data bor

| Data | Ejer | Hvorfor |
|------|------|---------|
| Menu/opskrifter | **Grocy** (læses via Bon v2-adapter) | Single source of truth for produkter — samme princip som Bon v2 |
| Kunde-konti, afdelinger, runder | **Portal-DB** | Portal-specifik logik, ingen tilsvarende i Bon v2 |
| Aggregeret bon | **Bon v2** | Bon v2 er master for alle bonner uanset oprindelse |
| Faktura | **Bon v2 → e-conomic** | Eksisterende flow, ingen ændringer |

### Grocy-integration

**Portalen henter aldrig direkte fra Grocy.** Det går via Bon v2's eksisterende adapter:

```
Portal → GET https://bon.ristetrug.dk/api/menu/items
       → Bon v2 kalder Grocy via adapter
       → Returnerer cached/live opskrifter med flags
```

Begrundelse:
- Single source of truth — én Grocy-adapter, ikke to
- Hvis Grocy skiftes ud (Fase 8 multi-lokation, eller helt nyt system), ændres kun Bon v2
- Portalens udvikler skal ikke kende Grocy's quirks
- Bon v2 kan caching, hvilket hjælper med ydelse

**Endpoint der skal eksistere i Bon v2 (måske allerede):**

```
GET /api/menu/items
  → returnerer: [
      {
        "grocy_recipe_id": 1001,
        "name": "Falaflen",
        "tags": ["vegetar"],
        "flags": ["glutenfri"],
        "description": "...",
        "is_active": true
      },
      ...
    ]
```

Hvis dette endpoint ikke findes i Bon v2 endnu, skal det laves som en del af denne fase.

---

## 3. Datamodel

### 3.1 Portal-DB tabeller

```sql
-- ==========================================
-- KUNDE-KONTI
-- ==========================================
CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                       -- "Novo Nordisk A/S"
    cvr TEXT,
    ean TEXT,                                 -- valgfri (offentlige kunder)
    invoice_email TEXT,
    delivery_address TEXT,                    -- standard leveringsadresse
    delivery_method TEXT,                     -- 'taxa' | 'byekspressen' | 'volvo'
    delivery_price_estimate REAL,             -- bagt ind i prisestimatet
    show_prices INTEGER DEFAULT 0,            -- bool: vis priser i portalen
    lock_after_deadline INTEGER DEFAULT 1,
    auto_reminder INTEGER DEFAULT 0,
    economy_email TEXT,                       -- CC på bekræftelse (valgfri)
    status TEXT DEFAULT 'active',             -- 'active' | 'paused' | 'archived'
    paused_at DATETIME,
    bon_v2_customer_id INTEGER,               -- løst link til Bon v2 customers
    bon_v2_company_id INTEGER,                -- løst link til Bon v2 companies
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- AFDELINGER (under en kunde-konto)
-- ==========================================
CREATE TABLE departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    name TEXT NOT NULL,                       -- "HR Afdeling"
    contact_name TEXT,
    contact_email TEXT NOT NULL,
    magic_token TEXT UNIQUE,                  -- aktuel UUID — ny ved email-skift
    token_created_at DATETIME,
    status TEXT DEFAULT 'active',             -- 'active' | 'inactive'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- KONTO-BRUGERE (bestillingsansvarlig + evt. økonomi)
-- ==========================================
CREATE TABLE account_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    name TEXT,
    email TEXT NOT NULL UNIQUE,
    role TEXT DEFAULT 'orderer',              -- 'orderer' | 'admin'
    last_login_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- BESTILLINGSRUNDER
-- ==========================================
CREATE TABLE order_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    delivery_date DATE NOT NULL,
    delivery_time TEXT,                       -- "11:30"
    delivery_address TEXT,                    -- kan overskrive customer-default
    deadline_at DATETIME,
    status TEXT DEFAULT 'open',               -- 'open' | 'sent' | 'cancelled'
    sent_at DATETIME,
    bon_v2_external_ref TEXT UNIQUE,          -- UUID, sendes i bon-payload
    bon_v2_bon_id INTEGER,                    -- udfyldes når Bon v2 svarer
    bon_v2_bon_number TEXT,                   -- "1247"
    notes_to_kitchen TEXT,                    -- fra bestillingsansvarlig
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER REFERENCES account_users(id)
);

-- ==========================================
-- AFDELINGENS SUB-BESTILLING i en runde
-- ==========================================
CREATE TABLE department_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES order_rounds(id),
    department_id INTEGER NOT NULL REFERENCES departments(id),
    pax INTEGER DEFAULT 0,
    notes TEXT,                               -- allergier, ønsker fra afd.
    submitted_at DATETIME,
    submitted_via_token TEXT,                 -- magic-token brugt
    status TEXT DEFAULT 'draft',              -- 'draft' | 'submitted'
    UNIQUE(round_id, department_id)
);

-- ==========================================
-- LINJER på afdelings-bestilling
-- ==========================================
CREATE TABLE department_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department_order_id INTEGER NOT NULL REFERENCES department_orders(id),
    grocy_recipe_id INTEGER NOT NULL,         -- direkte fra Grocy
    name_snapshot TEXT,                       -- gemt på submit-tidspunkt
    quantity INTEGER NOT NULL,
    line_notes TEXT
);

-- ==========================================
-- KUNDENS MENU-VALG (delsæt af Grocy)
-- ==========================================
CREATE TABLE customer_menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    grocy_recipe_id INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    UNIQUE(customer_id, grocy_recipe_id)
);

-- ==========================================
-- UDSOLGT-FLAG (per runde eller globalt)
-- ==========================================
CREATE TABLE sold_out_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grocy_recipe_id INTEGER NOT NULL,
    round_id INTEGER REFERENCES order_rounds(id),  -- NULL = globalt
    note TEXT,
    set_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cleared_at DATETIME
);

-- ==========================================
-- MAGIC-LINK LOG (sikkerhed + debugging)
-- ==========================================
CREATE TABLE magic_link_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department_id INTEGER REFERENCES departments(id),
    token_used TEXT,
    used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    result TEXT                                -- 'success' | 'expired' | 'invalid'
);
```

### 3.2 Ændring i Bon v2-DB

Én ny kolonne på `bons` for sporbarhed begge veje:

```sql
ALTER TABLE bons ADD COLUMN external_ref TEXT;
ALTER TABLE bons ADD COLUMN external_source TEXT;
-- external_source: 'portal' | 'event' | 'formbuilder' | 'jotform' | NULL
-- external_ref:    UUID/string der peger tilbage til kilden

CREATE INDEX idx_bons_external_ref ON bons(external_ref);
```

Bon v2's drawer/detalje-view skal vise et link tilbage til portalen hvis `external_source = 'portal'`:
- Link-format: `https://portal.ristetrug.dk/admin/round/{external_ref}`
- Tekst: "Åbn i Portal" eller "Bestilling fra Novo-portalen"

### 3.3 Grocy

**Grocy ændres ikke i denne fase.** Portalen læser opskrifter via Bon v2's adapter, som allerede kender Grocy.

Krav til Grocy-data (skal være på plads inden portalen kan bruges):
- Opskrifter har et tag for kategori: `vegetar`, `vegansk`, `koed`, `fisk`
- Opskrifter har separate flags for: `glutenfri`, `lactosefri`
- Aktive opskrifter er markeret `is_active`
- Hver opskrift har et menneske-læseligt navn (`name`) og evt. beskrivelse

Hvis flag-strukturen i Grocy ikke er klar endnu, er det forudsætning for portalen.

---

## 4. Bruger-roller og adgang

| Rolle | Hvor | Login | Kan |
|-------|------|-------|-----|
| Afdelings-bestiller | `portal.ristetrug.dk/d/{token}` | Magic-link, ingen password | Bestil for sin afdeling |
| Bestillingsansvarlig | `portal.ristetrug.dk/login` | Email + magic-link login (én-gangs kode) | Se alle afdelinger, sende bon, redigere afdelinger |
| Økonomi (3. person) | — | Får CC på eksisterende bestillingsbekræftelse fra Bon v2 | Ingen direkte portal-adgang i v1 |
| Ristet Rug admin | `portal.ristetrug.dk/admin` | Login (kobles til Bon v2-auth via shared session-cookie hvis muligt) | Alt — opret kunder, override, marker udsolgt |

### Magic-link mekanik

**Hver afdeling har én aktiv `magic_token` (UUID).**

- Token genereres ved oprettelse af afdelingen
- Mailes til `contact_email` i en velkomst-mail (når kunden er oprettet og afdelinger tilføjet)
- URL-format: `portal.ristetrug.dk/d/{token}`
- Token gælder så længe afdelingen er aktiv
- **Hvis `contact_email` ændres → ny token genereres → gammel udløber**
- Token-brug logges i `magic_link_log`

**Sikkerhed:**
- Token er 128-bit UUID, statistisk umuligt at gætte
- Rate limit på endpoint: max 100 requests/min per IP
- Ved suspekt aktivitet (mange forskellige tokens fra samme IP): block + alert til admin

---

## 5. Bon-flow (portal → Bon v2)

### Når bestillingsansvarlig trykker "Send til Ristet Rug"

1. Portal validerer at runden er åben og har mindst én afdelings-bestilling
2. Portal aggregerer alle linjer på `grocy_recipe_id` på tværs af afdelinger
3. Portal genererer `external_ref = uuid()`
4. Portal POST'er til Bon v2:

```http
POST https://bon.ristetrug.dk/api/bons
Content-Type: application/json
Authorization: Bearer <portal_api_key>

{
  "customer_id": 123,
  "company_id": 456,
  "delivery_date": "2026-11-14",
  "pickup_time": "11:00",
  "delivery_time": "11:30",
  "delivery_address": "Novo Nordisk Park 1, 2880 Bagsværd",
  "delivery_provider": "taxa",
  "pax": 47,
  "kitchen_info": "🏢 Fra portalen — 5 afdelinger har bestilt\nIngen specielle allergier rapporteret",
  "internal_notes": "Bestilt af Mette Hansen via portalen",
  "lines": [
    { "grocy_recipe_id": 1001, "product_name": "Falaflen", "quantity": 14 },
    { "grocy_recipe_id": 1002, "product_name": "Fisken", "quantity": 21 },
    { "grocy_recipe_id": 1003, "product_name": "Frikadellen", "quantity": 10 },
    { "grocy_recipe_id": 1004, "product_name": "Skipper", "quantity": 2 }
  ],
  "external_source": "portal",
  "external_ref": "round_a3f2c1d9-..."
}
```

5. Bon v2 svarer:

```json
{
  "bon_id": 1247,
  "bon_number": "1247",
  "status": "NY"
}
```

6. Portal opdaterer `order_rounds`:
   - `status = 'sent'`
   - `bon_v2_bon_id = 1247`
   - `bon_v2_bon_number = "1247"`
   - `sent_at = now()`

7. Bon v2's eksisterende bestillingsbekræftelses-flow trigger:
   - Mail til `customer.email` (Mette)
   - CC til `customer.economy_email` hvis sat
   - Beskrivelse af bonnen + bon-nummer

### Hvis bestillingsansvarlig vil ændre efter send

V1: ikke muligt direkte i portalen. Portal viser i stedet:
> "Bonnen er sendt og har nummer #1247. Yderligere ændringer skal aftales direkte med Ristet Rug pr. telefon eller mail."

Bon v2's almindelige flow gælder — kunden ringer, kontoret ændrer i bonnen.

V2 (deferred): Mulighed for at portalen sender PUT-opdatering til Bon v2 hvis bonnen er i status NY.

### Override fra Ristet Rug-side

**"Marker ret som udsolgt"** (fra admin-mockup):

1. Admin vælger ret(ter) der er udsolgt
2. Skriver evt. besked til Mette
3. Portal opretter `sold_out_flags`-rækker (per runde eller globalt)
4. Mail sendes til:
   - Bestillingsansvarlig (Mette)
   - Hver afdeling der allerede har bestilt den ret
5. Portalen viser den udsolgte ret som disabled for afdelinger der ikke har bestilt endnu

---

## 6. UI-zoner og mockups

| Mockup | Zone | Bruger | Status |
|--------|------|--------|--------|
| `portal_dashboard_v2.html` | Bestillingsansvarliges dashboard | Mette | ✅ designet |
| `portal_department_v2.html` | Afdelings-bestillingsside | Lars (magic-link) | ✅ designet |
| `portal_admin.html` | Ristet Rug admin — runder | Leif/kontoret | ✅ designet |
| `portal_customer_v2.html` | Ristet Rug admin — kunde-detalje | Leif/kontoret | ✅ designet |

### Designsystem

Genbruger Bon v2's CSS-tokens (`--brown`, `--yellow-pale`, `--green` etc.). Lato font.

**To visuelle zoner:**
- **Kunde-vendt** (dashboard, afdelings-side): hvid topbar med Ristet Rug-logo, varm beige bund
- **Admin** (Ristet Rug): mørk brun topbar (`--brown-dark`) — visuel adskillelse, så det er tydeligt at man er på "vores" side

### Mobile-først

Især afdelings-bestillingssiden — Lars klikker linket fra telefonen. Alle paddings og afstande reduceres på <600px.

---

## 7. Faser

### Fase 1 — V1 (denne implementering)

| # | Komponent | Beskrivelse |
|---|-----------|-------------|
| 1.1 | Portal-DB schema | Migrations for alle tabeller ovenfor |
| 1.2 | Bon v2 schema | `external_ref` + `external_source` på `bons` |
| 1.3 | Bon v2 endpoint | `GET /api/menu/items` (hvis ikke findes) |
| 1.4 | Magic-link auth | Token-generation, validering, logging |
| 1.5 | Konto-bruger login | Email + engangskode (uden password) |
| 1.6 | Afdelings-bestillingsside | UI fra `portal_department_v2.html` |
| 1.7 | Bestillingsansvarliges dashboard | UI fra `portal_dashboard_v2.html` |
| 1.8 | Ristet Rug admin — aktive runder | UI fra `portal_admin.html` |
| 1.9 | Kunde-detalje-side | UI fra `portal_customer_v2.html` |
| 1.10 | Bon-API integration | POST til Bon v2 ved send, lagring af bon-ref |
| 1.11 | Udsolgt-flag flow | Mark + besked + UI-disable på afdelings-side |
| 1.12 | Pause-tilstand | Konto-toggle + dashboard-banner |
| 1.13 | Hetzner deployment | Subdomain `portal.ristetrug.dk` |

### Fase 2 — Deferred

| Komponent | Note |
|-----------|------|
| Modal: "Tilføj kunde" wizard | Lille — kan komme efter første kunder er oprettet manuelt |
| Modal: "Tilføj afdeling" | Lille — kan inline-redigeres i kunde-side først |
| Central menu-administration | Hører hjemme her hvis Bon v2 ikke har det allerede |
| "Vis som Mette" — view as customer | Praktisk debug-tool, kan udskydes |
| Frontend-redigering af sendt bon | Kun hvis kunderne efterspørger det — ellers v2 |
| SSE for live-opdatering på dashboard | Pollende v1, SSE i v2 hvis ydelse kræver det |
| Push-notifikationer ved deadline | Mail er nok i v1 |
| Analytics-dashboard for Ristet Rug | "Hvilke kunder bestiller mindst, hvilke retter er populære" — adskilt projekt |

---

## 8. Forudsætninger

Skal være på plads inden Fase 1 kan starte:

| # | Krav | Status |
|---|------|--------|
| 1 | Grocy-opskrifter har tags + flags (`vegetar`, `glutenfri` etc.) | I gang (Leif arbejder på det) |
| 2 | Bon v2 kan tage imod bon med `external_source` + `external_ref` | Bon v2-ændring som del af Fase 1 |
| 3 | Bon v2 endpoint `GET /api/menu/items` | Bon v2-ændring som del af Fase 1 |
| 4 | Hetzner-konto har plads til ny app + subdomain | Tjekkes |
| 5 | Mail-flow eksisterer (bestillingsbekræftelse) | ✅ findes allerede i Bon v2 |

---

## 9. Forretningsregler

| Regel | Detalje |
|-------|---------|
| Én aggregeret bon pr. runde | Ikke én bon pr. afdeling. Alle afdelinger leverer til samme adresse |
| Pax-allokering vejledende | Send-knap er aktiv selv hvis pax ≠ valgte menupunkter |
| Afdelinger ser aldrig priser | Uanset konto-indstilling |
| Bestillingsansvarlig ser priser | Hvis `customers.show_prices = 1` |
| Magic-link er afdelings-specifik | Ny email ved skift af kontakt → ny token, gammel udløber |
| Levering bagt ind i pris-estimat | Beregnes ved konto-opsætning ud fra `delivery_address` + `delivery_method` |
| Faktura altid samlet | Hvis kunde skal have separate fakturaer → separate konti |
| Bon v2 er master | Når bonnen er sendt, sker alle ændringer i Bon v2, ikke i portalen |

---

## 10. Åbne afklaringer

| # | Spørgsmål | Hvor afklares |
|---|-----------|---------------|
| 1 | Hvor central menu-administration ligger (Bon v2 eller portal)? | Inden Fase 1.3 |
| 2 | Skal portalen have egen Hetzner-instans eller dele med Bon v2? | Deployment-fase |
| 3 | Shared session-cookie mellem Bon v2 og portal admin? | Hvis Ristet Rug-admin skal slippe for double-login |
| 4 | Cache-strategi for menu (Bon v2 → portal): TTL eller webhook? | Implementations-detalje, ikke blocker |
| 5 | API-key håndtering portal → Bon v2 | Generér én ved deployment, gem i env |

---

## 11. Reference

- Mockups: `portal_dashboard_v2.html`, `portal_department_v2.html`, `portal_admin.html`, `portal_customer_v2.html`
- Tilknyttede principper: `BON_V2_PRINCIPPER.md` (datakilde-ejerskab, no-lappeløsninger)
- Datamodel-reference: `bon_v2_datamodel_v2.md` (for Bon v2-siden af integration)
- Designsystem: `bon_v2_zoner_og_layout.md` (CSS-tokens + skrifttyper)

---

*Sidst opdateret: maj 2026 — efter design-session med Leif*
