# Bon v2 — Arkitektur & Struktur
## Diskussionsdokument · Februar 2026

> **Formål:** Saml de vigtigste arkitekturbeslutninger på ét sted, så Leif og hans bror kan gennemgå strukturen inden implementering. Dokumentet dækker tre hovedområder: databasestruktur, mail-arkitektur og settings/konfiguration.

---

## 1. OVERORDNET SYSTEMARKITEKTUR

### Bon som centralt nav

Bon-systemet er navet i hele operationen. Alt kobler sig til en bon eller en kunde.

```
                    ┌─────────────────────────────┐
                    │           IND                │
                    │  Bestillingsform (formbuilder)│
                    │  Mail → parsning             │
                    │  Kontaktform                 │
                    │  Event-bestilling            │
                    │  Smagebooking (→ CRM lead)   │
                    │  Manuel oprettelse           │
                    └──────────┬──────────────────┘
                               │
                               ▼
    ┌──────────┐        ┌──────────────┐        ┌──────────┐
    │ SETTINGS │───────→│     BON      │───────→│    UD    │
    │          │        │              │        │          │
    │ Firma    │        │ Status-flow  │        │ Levering │
    │ Roller   │        │ Kunde+Firma  │        │ Faktura  │
    │ Statusser│        │ Linjer       │        │ Lagertræk│
    │ Kategorier│       │ Changelog    │        │ Mail     │
    │ Levering │        │ Mail-tråde   │        │ Print    │
    │ Grocy    │        └──────┬───────┘        └──────────┘
    └──────────┘               │
                               ▼
                    ┌─────────────────────────────┐
                    │          VIEWS               │
                    │  Kalender (totaler pr. dag)  │
                    │  Listview (søg, opret ny)    │
                    │  Ugeoversigt (vagter+totaler)│
                    │  Køkken I Dag                │
                    │  Køkken Senere               │
                    │  Planlægning (inkl. levering)│
                    └─────────────────────────────┘
```

### Separate systemer (ikke del af Bon-databasen)

| System | Beskrivelse | Kobling til Bon |
|--------|-------------|-----------------|
| **Grocy** | Lagermotor (varer, opskrifter, beholdning, leverandører) | Bon læser/skriver via API (adapter pattern) |
| **SOP** | Procedurer via Excalidraw-diagrammer + dokumenter/videoer | Selvstændigt, ingen direkte kobling |
| **Whiteboard** | Daglige opgaver, rengøring, drift, kommunikation | Kan evt. generere opgaver fra bonner (fremtid) |
| **Smartplan** | Vagtplanlægning | Læses via API, vises i ugeoversigt |
| **e-conomic** | Fakturering/bogholderi | Fremtidig integration (bon → faktura) |

### Beslutning: Single-tenant arkitektur

Hver installation har sin egen database (SQLite-fil). Ingen deling af data mellem kunder.

**Fordele:**
- GDPR-simpelt: Hver kunde ejer sin data
- Teknisk simpelt: Ingen risiko for data-læk
- Nem backup/restore per kunde
- SQLite kræver ingen database-server

**Konsekvens:**
- `tenant_id` kolonner kan fjernes fra skemaet (eller beholdes som fremtidssikring)
- Settings-tabellen konfigurerer den enkelte installation
- Setup-script til nye installationer

---

## 2. DATABASE-STRUKTUR

### Hvad der allerede er designet og fungerer

Disse tabeller er gennemarbejdede og behøver ikke ændres:

- **Kernetabeller:** `users`, `customers`, `companies`, `bons`, `bon_lines`, `bon_changelog`
- **CRM-udvidelse:** `crm_customer_meta`, `crm_activities`, `crm_custom_fields`, `crm_custom_values`, `crm_unmatched_emails`
- **Tilbud:** `is_offer`/`offer_status` felter på `bons`-tabel
- **Indkøb:** `suppliers`, `supplier_products`, `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines`

### NYE tabeller der skal tilføjes

#### 2.1 System Settings

```sql
-- ==========================================
-- SYSTEM SETTINGS
-- ==========================================
-- Konfiguration af hele installationen.
-- Bruges af settings-UI og af systemet selv.

CREATE TABLE system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,                              -- JSON eller simpel værdi
    category TEXT NOT NULL,                  -- Gruppering i settings-UI
    label TEXT,                              -- Menneskelig beskrivelse
    field_type TEXT DEFAULT 'text'           -- text|number|bool|json|select
        CHECK (field_type IN ('text', 'number', 'bool', 'json', 'select')),
    options_json TEXT,                       -- For select: ["option1","option2"]
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id INTEGER REFERENCES users(id)
);
```

**Foreslåede settings-kategorier og nøgler:**

| Kategori | Nøgle | Type | Eksempel-værdi | Beskrivelse |
|----------|-------|------|----------------|-------------|
| **company** | `company_name` | text | "Ristet Rug" | Firmanavn |
| **company** | `company_cvr` | text | "12345678" | CVR-nummer |
| **company** | `company_address` | text | "Gade 1, 2100 Kbh" | Adresse |
| **company** | `company_phone` | text | "12345678" | Telefon |
| **company** | `company_logo_path` | text | "/assets/logo.png" | Logo til print/mail |
| **mail** | `mail_bon_address` | text | "bon@ristetrug.dk" | Mailadresse til bon-korrespondance |
| **mail** | `mail_contact_address` | text | "kontakt@ristetrug.dk" | Mailadresse til generel kontakt |
| **mail** | `mail_imap_host` | text | "imap.simply.com" | IMAP-server |
| **mail** | `mail_imap_port` | number | "993" | IMAP-port |
| **mail** | `mail_imap_user` | text | "bon@ristetrug.dk" | IMAP-bruger |
| **mail** | `mail_imap_password` | text | (krypteret) | IMAP-password |
| **mail** | `mail_smtp_host` | text | "smtp.simply.com" | SMTP-server |
| **mail** | `mail_smtp_port` | number | "587" | SMTP-port |
| **mail** | `mail_from_name` | text | "Ristet Rug" | Afsendernavn |
| **bon** | `bon_number_prefix` | text | "B" | Præfiks til bonnumre (B1234) |
| **bon** | `bon_number_next` | number | "3001" | Næste bonnummer |
| **bon** | `customer_number_prefix` | text | "K" | Præfiks til kundenumre (K567) |
| **bon** | `customer_number_next` | number | "600" | Næste kundenummer |
| **bon** | `default_order_type` | select | "catering" | Standard ordretype |
| **bon** | `order_types_json` | json | ["catering","pickup","event"] | Tilgængelige ordretyper |
| **bon** | `statuses_json` | json | (se nedenfor) | Status-flow konfiguration |
| **bon** | `order_deadline_time` | text | "12:00" | Bestillingsfrist (kl.) |
| **bon** | `order_deadline_days_before` | number | "1" | Dage før levering |
| **grocy** | `grocy_url` | text | "https://grocy.ristetrug.dk" | Grocy API URL |
| **grocy** | `grocy_api_key` | text | "xxx" | Grocy API-nøgle |
| **grocy** | `grocy_location_name` | text | "HQ" | Lokationsnavn |
| **delivery** | `delivery_methods_json` | json | (se nedenfor) | Leveringsmetoder med priser |
| **delivery** | `pax_per_box` | number | "16" | Antal pax per kasse |
| **delivery** | `default_delivery_method` | select | "bicycle" | Standard leveringsmetode |
| **integration** | `smartplan_enabled` | bool | "1" | Smartplan aktiv |
| **integration** | `smartplan_api_url` | text | "..." | Smartplan API |
| **integration** | `economic_enabled` | bool | "0" | e-conomic aktiv |
| **integration** | `economic_api_key` | text | "" | e-conomic API-nøgle |

**Status-flow konfiguration (JSON eksempel):**

```json
{
  "statuses": [
    {"key": "new", "label": "Ny", "color": "#1a237e"},
    {"key": "waiting", "label": "Venter info", "color": "#f9a825"},
    {"key": "approved", "label": "Godkendt", "color": "#2e7d32"},
    {"key": "in_progress", "label": "Igang", "color": "#43a047"},
    {"key": "delivered", "label": "Leveret", "color": "#546e7a"},
    {"key": "invoiced", "label": "Faktureret", "color": "#6a1b9a"},
    {"key": "completed", "label": "Afsluttet", "color": "#ad1457"},
    {"key": "cancelled", "label": "Aflyst", "color": "#c62828"}
  ],
  "transitions": {
    "new": ["waiting", "approved", "cancelled"],
    "waiting": ["approved", "cancelled"],
    "approved": ["in_progress", "cancelled"],
    "in_progress": ["delivered", "cancelled"],
    "delivered": ["invoiced"],
    "invoiced": ["completed"],
    "cancelled": []
  }
}
```

**Leveringsmetoder (JSON eksempel):**

```json
[
  {
    "key": "bicycle",
    "label": "Cykel (Byekspressen)",
    "base_cost": 100,
    "base_customer_price": 154,
    "extra_box_cost": 50,
    "extra_box_customer_price": 50,
    "max_boxes": 4,
    "max_distance_km": 8,
    "included_boxes": 2
  },
  {
    "key": "taxi",
    "label": "Taxa",
    "base_cost": 136,
    "cost_per_km": 19,
    "zones": [
      {"postcodes": ["2300","2720","2730","2820"], "customer_price": 425},
      {"postcodes": ["2800","2600","2605","2625"], "customer_price": 575},
      {"postcodes": ["2620","2760","2770"], "customer_price": 650}
    ]
  },
  {
    "key": "own_vehicle",
    "label": "Volvo (egen bil)",
    "base_cost": 0,
    "notes": "Intern kørsel"
  },
  {
    "key": "pickup",
    "label": "Afhentning",
    "base_cost": 0,
    "customer_price": 0
  }
]
```

#### 2.2 Mail Messages

```sql
-- ==========================================
-- MAIL MESSAGES
-- ==========================================
-- Alle mails der er knyttet til systemet.
-- Kan kobles til bon, kunde, eller begge.
-- Tråde grupperes via thread_id.

CREATE TABLE mail_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,                   -- Ren subject (uden #B1234 tags)
    bon_id INTEGER REFERENCES bons(id),
    customer_id INTEGER REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'archived')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mail_threads_bon ON mail_threads(bon_id);
CREATE INDEX idx_mail_threads_customer ON mail_threads(customer_id);

CREATE TABLE mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES mail_threads(id),
    message_id TEXT,                         -- Email Message-ID header
    in_reply_to TEXT,                        -- Email In-Reply-To header
    direction TEXT NOT NULL                  -- 'in' eller 'out'
        CHECK (direction IN ('in', 'out')),
    from_email TEXT NOT NULL,
    from_name TEXT,
    to_email TEXT NOT NULL,
    to_name TEXT,
    cc TEXT,                                 -- JSON array af emails
    subject TEXT NOT NULL,
    body_text TEXT,                          -- Ren tekst
    body_html TEXT,                          -- HTML version
    has_attachments INTEGER NOT NULL DEFAULT 0,
    sent_at DATETIME,
    received_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX idx_mail_messages_thread ON mail_messages(thread_id);
CREATE INDEX idx_mail_messages_msgid ON mail_messages(message_id);

CREATE TABLE mail_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES mail_messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    file_path TEXT,                          -- Sti til gemt fil
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### 2.3 Brugerroller og rettigheder

```sql
-- ==========================================
-- ROLLER
-- ==========================================
-- Simpelt rolle-system: en bruger har én rolle.
-- Rettigheder defineres per rolle i settings.

-- Tilføj til eksisterende users-tabel:
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'
    CHECK (role IN ('admin', 'office', 'kitchen', 'delivery', 'staff'));
```

---

## 3. MAIL-ARKITEKTUR

### Princip: Ticket-system med emnefelts-parsing

```
┌─────────────────────────────────────────────────────────┐
│                    INDGÅENDE MAIL                        │
│                                                         │
│  bon@ristetrug.dk                                       │
│  kontakt@ristetrug.dk                                   │
│  Forward fra info@ristetrug.dk                          │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │  PARSER EMNE    │
              │                 │
              │  Søg efter:     │
              │  #B1234 → bon   │
              │  #K567 → kunde  │
              │  Begge → begge  │
              │  Ingen → inbox  │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐──────────────┐
          │            │            │              │
          ▼            ▼            ▼              ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │Bon-tråd  │ │Kunde-tråd│ │Begge     │ │Ufordelt  │
    │          │ │          │ │          │ │inbox     │
    │Knyttes   │ │Knyttes   │ │Knyttes   │ │          │
    │til bon   │ │til kunde │ │til begge │ │Vises i   │
    │#B1234    │ │#K567     │ │          │ │indbakke  │
    └──────────┘ └──────────┘ └──────────┘ │til manuel│
                                           │tildeling │
                                           └──────────┘
```

### Mail-flow i detaljer

**Udgående mail fra systemet:**
1. Bruger skriver mail i bon-viewet → systemet sender via SMTP
2. Emnefeltet får automatisk `#B1234` (eller `#K567` for CRM-mails)
3. Mailen gemmes i `mail_messages` med korrekt thread_id

**Indgående mail:**
1. System poller IMAP med jævne mellemrum (fx hvert 2. minut)
2. Parser emnefeltet for `#B[nummer]` og/eller `#K[nummer]`
3. Matcher mod eksisterende tråd via In-Reply-To header ELLER emne-tag
4. Hvis match → tilknyt automatisk
5. Hvis ingen match → læg i ufordelt indbakke (bruger `crm_unmatched_emails` eller ny mail i inbox)

**Forward fra info@ristetrug.dk:**
1. Bruger forwarder mail og tilføjer `#B1234` eller `#K567` i emnefeltet
2. System parser og tilknytter automatisk

### Vigtige edge cases at diskutere

| Situation | Forslag |
|-----------|---------|
| Mail uden tag, men fra kendt kunde-email | Vis i indbakke med forslag: "Kendes som kunde K567?" |
| Kunde svarer uden at bevare emne-tag | Match via In-Reply-To header (fallback) |
| Ny henvendelse (ingen kunde endnu) | Vis i indbakke → bruger opretter kunde → mail knyttes |
| Samme mail relevant for flere bonner | Primær bon i emne, kan manuelt tilknyttes flere |

---

## 4. NUMMERING

### Bonnumre og kundenumre

```
Bonnummer:    #B3001, #B3002, #B3003 ...
Kundenummer:  #K600, #K601, #K602 ...
```

- **Præfiks er konfigurerbart** (via settings) så andre installationer kan bruge fx `#O` for ordre
- **Numre er fortløbende** og tildeles automatisk ved oprettelse
- **Bruges i emnefelter** til mail-routing
- **Vises på alle prints** (følgeseddel, faktura, bon-kort)

### Internt ID vs. vist nummer

```sql
-- bons-tabellen har BÅDE et internt id og et vist nummer
bons.id = 47              -- Internt database-ID (aldrig vist til brugere)
bons.bon_number = "B3001" -- Vist nummer (bruges i mail, print, UI)
```

Dette er allerede i det eksisterende skema, men vigtigt at holde konsekvent.

---

## 5. MODULER OG FREMTIDIG UDVIDELSE

### Modul-tænkning

Systemet er designet så moduler kan tilføjes uden at ændre kernen:

```
┌─────────────────────────────────────────────────────────┐
│                    KERNE (altid aktiv)                   │
│                                                         │
│  Bonner · Kunder/Firmaer · Statusflow · Changelog       │
│  Users · Roller · System Settings · Mail                │
└─────────────────────────────────────────────────────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
┌─────────┐┌─────────┐┌─────────┐┌─────────┐┌─────────┐
│  CRM    ││ Indkøb  ││ Tilbud  ││Levering ││Faktura  │
│         ││         ││         ││beregning││         │
│crm_*    ││purchase_││is_offer ││delivery_││economic_│
│tabeller ││order_*  ││felter   ││config   ││integr.  │
└─────────┘└─────────┘└─────────┘└─────────┘└─────────┘
  Aktiv?     Aktiv?     Aktiv?     Aktiv?     Aktiv?
  settings   settings   settings   settings   settings
```

Hvert modul kan slås til/fra via settings. UI viser kun aktive moduler.

### Settings for moduler

```sql
-- Eksempel: Moduler i system_settings
INSERT INTO system_settings (key, value, category, label, field_type)
VALUES
    ('module_crm_enabled', '1', 'modules', 'CRM', 'bool'),
    ('module_purchasing_enabled', '1', 'modules', 'Indkøb & varemodtagelse', 'bool'),
    ('module_offers_enabled', '1', 'modules', 'Tilbud', 'bool'),
    ('module_delivery_calc_enabled', '1', 'modules', 'Leveringsberegning', 'bool'),
    ('module_economic_enabled', '0', 'modules', 'e-conomic fakturering', 'bool');
```

---

## 6. GROCY-INTEGRATION

### Adapter pattern (uændret fra tidligere beslutning)

```
Bon v2  â←→  Grocy Adapter  â←→  Grocy API
                │
                │  I fremtiden kan adapteren pege
                │  på en anden backend
                ▼
          Grocy Adapter Interface:
          - getProducts()
          - getStock()
          - consumeRecipe(recipeId, servings)
          - addToShoppingList(items)
          - getRecipe(id)
          - getRecipes()
```

### Settings for Grocy-forbindelse

Hver installation konfigurerer sin Grocy-forbindelse i `system_settings`:

```
grocy_url         = "https://grocy.ristetrug.dk"
grocy_api_key     = "xxx"
grocy_location_name = "HQ"
```

For installationer med flere lokationer (fx HQ + festival-trailer) kan der tilføjes en `locations`-tabel:

```sql
CREATE TABLE locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grocy_url TEXT,
    grocy_api_key TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
);
```

---

## 7. ÅBNE SPØRGSMÅL TIL DISKUSSION

### Arkitektur

1. **tenant_id beholdes eller fjernes?** Single-tenant kræver det ikke, men det kan gøre fremtidig multi-tenant nemmere. Anbefaling: Fjern det — det forenkler og YAGNI (You Ain't Gonna Need It).

2. **SQLite vs. PostgreSQL?** SQLite er perfekt til single-tenant, enkelt at backup'e og deploye. PostgreSQL giver bedre concurrent access hvis der er mange samtidige brugere. For jeres størrelse: SQLite er rigeligt.

3. **Frontend-stack?** Bon v1 bruger hvad? Vue.js mockups eksisterer allerede. Skal v2 bygges i Vue, React, eller vanilla JS?

### Mail

4. **IMAP polling vs. webhook?** Polling er simpelt men har delay. Webhook (fx via Mailgun/Postmark) giver instant delivery men koster penge og er en ekstern afhængighed.

5. **Skal systemet sende mails direkte via SMTP, eller via en mail-service?** SMTP via Simply.com er gratis men kan have deliverability-issues. En service som Postmark/Mailgun har bedre deliverability.

6. **Mail-skabeloner?** Skal der være konfigurerbare mail-skabeloner for bekræftelse, statusopdatering, tilbudsmail osv.?

### Settings

7. **Settings UI:** Skal settings være én stor side med kategorier, eller separate sider per kategori?

8. **Hvem kan ændre settings?** Kun admin, eller også office-rollen?

### Integration

9. **Whiteboard ↔ Bon:** Skal der bygges en integration hvor bon-statusændringer skaber Whiteboard-opgaver? Eller holdes de helt adskilt?

10. **SOP ↔ Whiteboard:** SOP linker allerede til Whiteboard via "Åbn procedure". Er der behov for mere?

---

## 8. SAMMENFATNING: HVAD SKAL ÆNDRES I DB

### Nye tabeller (3 stk)

| Tabel | Formål | Kompleksitet |
|-------|--------|-------------|
| `system_settings` | Al konfiguration | Simpel |
| `mail_threads` | Gruppering af mails | Simpel |
| `mail_messages` + `mail_attachments` | Mailarkiv knyttet til bon/kunde | Medium |

### Ændringer på eksisterende tabeller (1 stk)

| Tabel | Ændring |
|-------|---------|
| `users` | Tilføj `role` kolonne |

### Valgfri tilføjelse

| Tabel | Formål | Hvornår |
|-------|--------|---------|
| `locations` | Multi-lokation Grocy | Når festival-trailer er aktuel |

### Intet ændret

Alt det eksisterende — bonner, kunder, firmaer, CRM, indkøb, varemodtagelse, changelog — forbliver som det er.

---

*Dokument genereret d. 14. februar 2026*
