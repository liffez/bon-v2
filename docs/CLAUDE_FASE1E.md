# CLAUDE_FASE1E.md — Fase 1e: Settings UI + Mail
> Læs CLAUDE.md og docs/bon_v2_datamodel_v2.md FØR du starter.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

1. **Migration 012** — `customer_mails` tabel + `mail_templates` tabel + settings-seed
2. **`services/mailService.js`** — SMTP udgående + IMAP polling + routing
3. **`routes/users.js`** — bruger-CRUD
4. **`routes/mail.js`** — skabelon GET/PATCH
5. **`settings/index.html`** — Settings UI med to adgangsniveauer

---

## To adgangsniveauer

| Niveau | Rolle | Sektioner de ser |
|--------|-------|-----------------|
| Operationel admin | `office` + `admin` | Brugere, Priskategorier, Betalingstyper |
| Teknisk admin | `admin` only | + Grocy, Mail, Formbuilder, System |

Frontend skjuler tekniske sektioner hvis `user.role !== 'admin'`.
Backend kræver `requireAuth('admin')` på tekniske ruter.

---

## Migration 012

Fil: `db/migrations/012_mail_and_templates.sql`

```sql
-- Tilføj matched_by til bon_mails (til debug/statistik)
ALTER TABLE bon_mails ADD COLUMN matched_by TEXT;

-- Kunde-linkede mails (#K-tags) — spejlbillede af bon_mails
CREATE TABLE customer_mails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER REFERENCES customers(id),
    company_id   INTEGER REFERENCES companies(id),
    message_id   TEXT,
    in_reply_to  TEXT,
    from_address TEXT,
    to_address   TEXT,
    subject      TEXT,
    body_text    TEXT,
    body_html    TEXT,
    direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    is_read      INTEGER NOT NULL DEFAULT 0,
    is_flagged   INTEGER NOT NULL DEFAULT 0,
    matched_by   TEXT,
    received_at  DATETIME,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customer_mails_customer ON customer_mails(customer_id);
CREATE INDEX idx_customer_mails_company  ON customer_mails(company_id);

-- Mail-skabeloner
CREATE TABLE mail_templates (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT NOT NULL UNIQUE,
    label     TEXT NOT NULL,
    subject   TEXT NOT NULL,
    body_text TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed: bekræftelsesskabelon
INSERT INTO mail_templates (key, label, subject, body_text) VALUES (
    'booking_confirmation',
    'Ordrebekræftelse',
    'Bekræftelse af din bestilling (#{{bonNummer}})',
    'Kære {{kundeNavn}},

Tak for din bestilling. Vi bekræfter hermed følgende ordre:

Bon-nummer: #{{bonNummer}}
Leveringsdato: {{leveringsDato}}
Leveringstidspunkt: {{leveringsTidspunkt}}
Adresse: {{leveringsAdresse}}
Antal: {{pax}} pers.

{{ekstraInfo}}

Med venlig hilsen
{{firmanavn}}'
);

-- Settings seed: mail signatur
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('mail_signature', 'Med venlig hilsen
Ristet Rug
Prinsesse Charlottesgade 16, 2200 København N
Tlf: +45 XX XX XX XX', 'Afsendersignatur — tilføjes automatisk til alle udgående mails');

-- Settings seed: SMTP
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('smtp_host',     '',              'SMTP server (fx mail.simply.com)'),
    ('smtp_port',     '587',           'SMTP port (587=STARTTLS, 465=SSL)'),
    ('smtp_user',     '',              'SMTP brugernavn'),
    ('smtp_from',     '',              'Afsenderadresse (fx bon@ristetrug.dk)'),
    ('smtp_enabled',  '0',             '1 = udgående mail aktiv');

-- Settings seed: IMAP bon@
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('imap_bon_host',     '',    'IMAP server for bon@-postkasse'),
    ('imap_bon_port',     '993', 'IMAP port'),
    ('imap_bon_user',     '',    'IMAP brugernavn (bon@ristetrug.dk)'),
    ('imap_bon_enabled',  '0',   '1 = polling aktiv'),
    ('imap_bon_interval', '5',   'Polling interval (minutter)');

-- Settings seed: IMAP kontakt@
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('imap_kontakt_host',     '',    'IMAP server for kontakt@-postkasse'),
    ('imap_kontakt_port',     '993', 'IMAP port'),
    ('imap_kontakt_user',     '',    'IMAP brugernavn (kontakt@ristetrug.dk)'),
    ('imap_kontakt_enabled',  '0',   '1 = polling aktiv'),
    ('imap_kontakt_interval', '5',   'Polling interval (minutter)');
```

**Note:** SMTP password og IMAP passwords gemmes i `.env`, IKKE i settings-tabellen:
```
SMTP_PASSWORD=
IMAP_BON_PASSWORD=
IMAP_KONTAKT_PASSWORD=
MAIL_BON_TAG=B
MAIL_CUSTOMER_TAG=K
```

---

## `services/mailService.js`

### Struktur

```javascript
// services/mailService.js
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { getDb } = require('../db/database');

// --- SMTP ---
async function sendMail({ to, subject, bodyText, bonId = null }) { ... }
async function sendFromTemplate({ templateKey, to, vars, bonId = null }) { ... }

// --- IMAP routing ---
async function pollMailbox(config) { ... }  // én postkasse
async function startPolling() { ... }       // starter begge pollers med interval

// --- Intern ---
function parseTag(subject) { ... }          // returnerer { type: 'bon'|'customer'|null, ref }
function renderTemplate(body, vars) { ... } // {{variabel}} substitution + signatur appended

module.exports = { sendMail, sendFromTemplate, startPolling };
```

### `sendFromTemplate`

Henter skabelon fra DB, kører `renderTemplate`, kalder `sendMail`.
Gemmer udgående mail i `bon_mails` (direction='outbound') hvis `bonId` er sat.

### `parseTag(subject)`

```javascript
function parseTag(subject) {
    const bonTag  = process.env.MAIL_BON_TAG      || 'B';
    const custTag = process.env.MAIL_CUSTOMER_TAG || 'K';
    const bonMatch  = subject.match(new RegExp(`#${bonTag}(\\d+)`));
    const custMatch = subject.match(new RegExp(`#${custTag}(\\d+)`));
    if (bonMatch)  return { type: 'bon',      ref: parseInt(bonMatch[1]) };
    if (custMatch) return { type: 'customer', ref: parseInt(custMatch[1]) };
    return { type: null, ref: null };
}
```

### `pollMailbox(config)`

For hver ulæst mail siden sidst:
1. Hent UID + emne + from + message-id + in-reply-to
2. Kald `parseTag(subject)`
3. Hvis `type === 'bon'`:
   - Opslag: find bon via bon-nummer → `bon_id`
   - INSERT i `bon_mails` (direction='inbound', is_read=0, body_text=null)
   - SSE broadcast: `bon_updated` med `{ id: bon_id, unread_mail_count: N }`
4. Hvis `type === 'customer'`:
   - Opslag: find match via `#K{id}` direkte som `customer_id` eller `company_id`
   - INSERT i `customer_mails` (direction='inbound')
5. Marker mail som læst i IMAP (SEEN flag) så den ikke hentes igen

**Body gemmes ikke** — kun routing-metadata (besked-ID, emne, afsender, tidspunkt).

### `startPolling()`

Kaldes fra `server.js` ved opstart (kun hvis `smtp_enabled` og/eller `imap_*_enabled = '1'`).
Bruger `setInterval` med interval fra settings.

---

## `routes/users.js`

Kræver `requireAuth('admin')` på alle ruter.

```
GET    /api/users              → liste alle (id, name, email, role, is_active)
POST   /api/users              → opret (name, email, role, password)
PATCH  /api/users/:id          → rediger (name, email, role, is_active)
POST   /api/users/:id/password → sæt nyt password { password }
```

`POST /api/users` hasher password med bcrypt (genbruger `hashPassword` fra `db/helpers.js`).

---

## `routes/mail.js`

```
GET   /api/mail/templates          → alle skabeloner
GET   /api/mail/templates/:key     → én skabelon
PATCH /api/mail/templates/:key     → opdater subject + body_text
POST  /api/mail/test               → send test-mail til angivet adresse (admin only)
```

`POST /api/mail/test` body: `{ to, templateKey }` — renderer skabelon med dummy-data og sender.

---

## Udvidelser af eksisterende ruter

### `routes/price_categories.js`

Tilføj:
```
POST  /api/price-categories         { code, label, sort_order }
PATCH /api/price-categories/:id     { label, sort_order }
```

`code` er uændret efter oprettelse (bruges som FK-reference i DB).

### `routes/payment_types.js`

Tilføj:
```
POST  /api/payment-types         { code, label, sort_order }
PATCH /api/payment-types/:id     { label }
```

---

## `server.js` — tilføj ved opstart

```javascript
const { startPolling } = require('./services/mailService');

// Efter routes er mountet:
startPolling().catch(err => console.error('Mail polling fejl:', err));
```

---

## `settings/index.html`

Eget shell (som defineret i `bon_v2_zoner_og_layout.md`).
Kræver auth — `requireAuth()` server-side + `checkAuth()` client-side.

### Layout

```
┌─────────────────────────────────────────────────┐
│  ⚙ Settings                          [Log ud]   │
├──────────────┬──────────────────────────────────┤
│              │                                  │
│  Brugere     │   [Sektion-indhold]              │
│  Priskate-   │                                  │
│  gorier      │                                  │
│  Betalings-  │                                  │
│  typer       │                                  │
│  ─────────   │                                  │
│  (admin)     │                                  │
│  Grocy       │                                  │
│  Mail        │                                  │
│  Formbuilder │                                  │
│  System      │                                  │
│              │                                  │
└──────────────┴──────────────────────────────────┘
```

Venstre sidebar: 160px fast. Aktiv sektion highlightes.
Tekniske sektioner (Grocy, Mail, Formbuilder, System) skjules hvis `user.role !== 'admin'`.

---

### Sektion: Brugere

Liste over alle brugere (navn, email, rolle, aktiv).
"+ Ny bruger"-knap åbner inline formular i bunden af listen.

Felter per bruger: Navn, Email, Rolle (dropdown: admin/office/kitchen/delivery), Aktiv (toggle).
"Sæt password"-knap → lille inline formular med password + bekræft.
Deaktivering er soft-delete (is_active = 0) — ikke sletning.

---

### Sektion: Priskategorier

Liste med `code` (låst, grå), `label` (redigerbar), `sort_order` (redigerbar).
"+ Ny"-knap åbner inline formular: code + label + sort_order.
Gem-knap per række (vises når feltet er dirty).

---

### Sektion: Betalingstyper

Identisk mønster som Priskategorier.

---

### Sektion: Grocy (admin only)

Én blok per lokation fra `locations`-tabellen.

Felter: `name` (låst), `grocy_api_url`, `grocy_api_key` (password-felt, vis/skjul toggle).
"Test forbindelse"-knap → `GET /api/grocy/products?location={code}&limit=1` → grønt/rødt badge.

---

### Sektion: Mail (admin only)

**Udgående (SMTP)**
Felter: Host, Port, Brugernavn, Password (vis/skjul), Fra-adresse, Aktiv (toggle).
"Send test-mail"-knap → input til modtager-adresse → `POST /api/mail/test`.

**Indgående — bon@ postkasse**
Felter: Host, Port, Brugernavn, Password (vis/skjul), Polling-interval (min), Aktiv (toggle).

**Indgående — kontakt@ postkasse**
Samme felter.

**Signatur**
Textarea: `mail_signature` fra settings.
Vises under skabelonen. Appended automatisk til alle udgående mails af `renderTemplate` efter `--`-separator.
Gem-knap → `PATCH /api/settings/mail_signature`.

**Skabelon: Ordrebekræftelse**
Emne: redigerbar tekstlinje.
Brødtekst: `<textarea>` med variabelliste vist som hjælp:
`{{kundeNavn}}` `{{bonNummer}}` `{{leveringsDato}}` `{{leveringsTidspunkt}}` `{{leveringsAdresse}}` `{{pax}}` `{{ekstraInfo}}` `{{firmanavn}}`
Gem-knap → `PATCH /api/mail/templates/booking_confirmation`.

---

### Sektion: Formbuilder (admin only)

Tabellignende visning af `FIELD_MAP` fra settings (`formbuilder_field_map` nøgle, JSON).
To kolonner: "Formular-felt" (fx `f2`) og "Bon-felt" (fx `customer_name`).
Redigerbar inline.
"Nulstil til standard"-knap.

Standard-JSON gemmes som konstant i `routes/webhooks.js` og bruges ved nulstilling.

---

### Sektion: System (admin only)

Fra `settings`-tabellen:

| Nøgle | Label | Type |
|-------|-------|------|
| `company_name` | Firmanavn | text |
| `bon_number_prefix` | Bon-nummer præfiks | text |
| `bon_number_next` | Næste bon-nummer | number |
| `default_pax_per_box` | Pax per kasse | number |
| `session_duration_office` | Session-varighed kontor (dage) | number |
| `session_duration_kitchen` | Session-varighed køkken (dage) | number |

Gem-knap → `PATCH /api/settings/:key` per felt.

---

## npm-pakker der skal tilføjes

```
nodemailer   ← SMTP afsendelse
imapflow     ← IMAP polling (prototype eksisterer allerede)
```

Kræver godkendelse — men begge er allerede kendte i projektet.

---

## Rækkefølge

1. Migration 012 (kør `npm run migrate`)
2. `services/mailService.js` — parseTag + renderTemplate + sendMail (SMTP)
3. `routes/users.js` + `routes/mail.js`
4. Udvid price_categories + payment_types ruter
5. IMAP polling (`pollMailbox` + `startPolling`) — kan testes med `imap_*_enabled=0`
6. `settings/index.html` — byg sektion for sektion

---

## Test-kommandoer

```bash
# Opret bruger
curl -s -X POST http://localhost:4321/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@ristetrug.dk","role":"office","password":"test123"}' | jq

# Hent skabelon
curl -s http://localhost:4321/api/mail/templates/booking_confirmation | jq

# Opdater priskategori-label
curl -s -X PATCH http://localhost:4321/api/price-categories/1 \
  -H "Content-Type: application/json" \
  -d '{"label":"Butik"}' | jq

# Test SMTP (kræver smtp_enabled=1 og korrekt config)
curl -s -X POST http://localhost:4321/api/mail/test \
  -H "Content-Type: application/json" \
  -d '{"to":"leif@ristetrug.dk","templateKey":"booking_confirmation"}' | jq
```
