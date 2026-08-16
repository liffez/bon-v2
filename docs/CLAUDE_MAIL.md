# CLAUDE_MAIL.md — Mail-system: design & implementering
> Fase 4 — Mail ind + CRM
> Læs `bon_v2_datamodel_v2.md` og `BON_V2_PRINCIPPER.md` før implementering.
> Prototype verificeret — 8/8 parser-tests bestået.

---

## 1. PRINCIPPER

- **Databasen er sandheden** om al korrespondance — ikke IMAP, ikke sendt-mappe
- **Indgående** læses fra indbakken via IMAP
- **Udgående** gemmes i `mail_messages` (`direction = 'out'`) i samme operation som SMTP-afsendelse — sendt-mappen røres aldrig
- **IMAP er read-only** — systemet markerer ikke, flytter ikke, sletter ikke mails
- **Bon v1-format ignoreres aktivt** — parser skipper alle mails med `#Bon:` i emnet
- **Tags er en settings-ting** — `#` er den eneste konstant, alt andet er konfigurerbart

---

## 2. MAILBOKSE

| Mailboks | Primær kontekst | Tag-format |
|----------|----------------|------------|
| `bon@ristetrug.dk` | Bon-korrespondance | `#b-{nummer}` |
| `kontakt@ristetrug.dk` | CRM / generel henvendelse | `#k-{nummer}` |

`info@ristetrug.dk` forwardes til en af de to ovenstående.

**Landing-mailboks bruges som kontekst-hint i UI:**
- Mail landet i `bon@` → foreslå tilknyt bon + evt. opret kunde
- Mail landet i `kontakt@` → foreslå opret/tilknyt kunde

---

## 3. SUBJECT-PARSER

Parser køres på alle indgående mails. Resultat afgør routing.

### Format Bon v2
```
#b-3001           → bon-match      → opslag i bons
#t-3001           → tilbud-match   → opslag i bons (is_offer = 1)
#k-600            → kunde-match    → opslag i customers
#b-3001 #k-600    → begge
(ingen)           → ufordelt indbakke
```

`#` er fast markør. Alt efter `#` er konfigurerbart via settings.

### Prefix-konfiguration (settings)

| Settings-nøgle | Default | Opslag i |
|----------------|---------|----------|
| `mail_tag_bon_prefix` | `b-` | `bons` |
| `mail_tag_offer_prefix` | `t-` | `bons` (`is_offer = 1`) |
| `mail_tag_customer_prefix` | `k-` | `customers` |

Parseren bygger regex dynamisk fra settings — aldrig hardcoded:
```js
// utils/mail-parser.js → getPrefixes()
const bonRegex      = new RegExp(`#${bonPrefix}(\\d+)`, 'i')
const offerRegex    = new RegExp(`#${offerPrefix}(\\d+)`, 'i')
const customerRegex = new RegExp(`#${customerPrefix}(\\d+)`, 'i')
```

Alle tre steder der bruger prefixes slår op i `settings`-tabellen:

| Sted | Brug |
|------|------|
| `utils/mail-parser.js` — `getPrefixes()` | Bygger regex dynamisk ved hvert kald |
| `services/mailService.js` — `sendMail()` | Henter prefix for bon/tilbud/kunde via `buildTag()` |
| `services/mailService.js` — `pollMailbox()` | Henter alle tre prefixes til parser-kald |

### Tilbud → bon konvertering
Tilbud og bonner ligger i samme tabel (`bons`), men har hver sin nummerserie —
`T-`-serien til tilbud, bon-serien til bons. Prefix i udgående mails følger tilstanden:
```
Tilbud sendt:     #t-22    → offer_status = 'sent'  (tilbudsrækken)
Kunde accepterer: #b-3260  → ny bon med source_quote_id → tilbuddet
```
Fra 13. august 2026 er tilbuddet og bonnen **to rækker**: konvertering opretter en ny bon
og lader bilaget blive liggende som vundet og låst. `#t-22` peger derfor stadig på
tilbuddet efter accept — `matchBonByTagNumber` matcher `#t-` mod `is_offer = 1` og `#b-`
mod `is_offer = 0`, så de to tags ikke kan krydse. Før flippede konverteringen rækken, og
et svar på tilbudsmailen kunne ikke længere matches.

### Bon v1-format — ignorer
```
#Bon:cafe-3380        → skip (Bon v1 modtaget)
sendt:#Bon:cafe-3380  → skip (Bon v1 sendt-workaround)
```
```js
const BON_V1 = /#Bon:/i  // → ignorer hele mailen
```

### Thread-matching (rækkefølge)
1. `In-Reply-To` header → slå op i `mail_messages.message_id`
2. Subject-tag `#b-` / `#t-` / `#k-` → slå op i `bons.bon_number` / `customers.id`
3. Ingen match → ufordelt indbakke

---

## 4. VIDERESENDELSE (FORWARD)

Forwarded mails mangler altid tag → lander i ufordelt indbakke.

System forsøger at parse forwarded-blok i brødtekst:
```
-------- Forwarded Message --------
From: Peter Hansen <peter@firma.dk>
Subject: Forespørgsel om frokost
```

Parsed data bruges **kun til præudfyldning** — aldrig til automatisk handling.

### Flow i UI
```
Ufordelt indbakke
→ System har fundet: peter@firma.dk / Peter Hansen
→ Tjek mod customers.email + companies
  → MATCH:    "Ser ud til at være K423 – Peter Hansen. Tilknyt?"
  → INTET:    "Ukendt afsender." + præudfyldt opret-kunde formular
→ Bruger bekræfter altid
```

Landing-mailboks som hint:
- `kontakt@` → vis "Opret/tilknyt kunde"
- `bon@` → vis "Opret/tilknyt kunde" + "Opret bon"

---

## 5. EDITOR

| Kontekst | Editor | Begrundelse |
|----------|--------|-------------|
| Bon-mail (bon-drawer) | Simpelt `textarea` + skabeloner | Korte operative beskeder |
| CRM-mail (kundekort) | Rig editor — Quill eller TipTap | Tilbudsmails, vedhæftninger, billeder |

**Strategi:** Start med simpelt `textarea` på begge. Opgrader CRM-editoren i separat iteration når infrastrukturen er på plads (trin 11 i rækkefølgen).

Skabeloner tilgængelige i begge kontekster via `GET /api/mail/templates`.
Variable: `${firstName}`, `${deliveryDate}`, `${bonNumber}`, `${totalPrice}` osv.

---

## 6. HVAD SYSTEMET SKAL KUNNE

### I bon-kontekst (bon-drawer)
| Funktion | Note |
|----------|------|
| Send udgående mail til kunde | `#b-{nummer}` auto-tilføjet af backend |
| Skabeloner | "Tak for bestilling", "Bekræftelse", "Ændring" |
| Tråd-visning | Al korrespondance på bon, nyeste øverst |
| Indgående match | Via `In-Reply-To` eller `#b-`-tag |
| Ulæst-tæller | ✉-badge i listview og kalender |
| Ufordelt indbakke | Mails til `bon@` uden tag |

### I CRM-kontekst (kundekort)
| Funktion | Note |
|----------|------|
| Send udgående mail til kunde | `#k-{nummer}` auto-tilføjet af backend |
| Indgående match | Via `In-Reply-To` eller `#k-`-tag |
| Mailhistorik | Al korrespondance samlet på kunden på tværs af bonner |
| Ufordelt indbakke | Mails til `kontakt@` uden tag |
| Kendt afsender | From-email kendes → vis forslag til tilknytning |
| Forward-flow | Parse + præudfyld → bruger bekræfter |

---

## 7. DATABASE MIGRATION — `011_mail.sql`

`bon_mails` er i skemaet men tom og ubrugt — **erstattes** i denne migration.

```sql
-- 011_mail.sql

DROP TABLE IF EXISTS bon_mails;

CREATE TABLE IF NOT EXISTS mail_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    bon_id INTEGER REFERENCES bons(id),
    customer_id INTEGER REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'archived')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_threads_bon      ON mail_threads(bon_id);
CREATE INDEX IF NOT EXISTS idx_mail_threads_customer ON mail_threads(customer_id);

CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES mail_threads(id),
    message_id TEXT,
    in_reply_to TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    from_email TEXT NOT NULL,
    from_name TEXT,
    to_email TEXT NOT NULL,
    to_name TEXT,
    cc TEXT,                        -- JSON array
    subject TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    sent_at DATETIME,
    received_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid  ON mail_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread ON mail_messages(is_read, direction);

CREATE TABLE IF NOT EXISTS mail_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES mail_messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    file_path TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mail_unmatched (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox TEXT NOT NULL,          -- 'bon@...' eller 'kontakt@...'
    message_id TEXT,
    from_email TEXT,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    received_at DATETIME,
    parsed_name TEXT,               -- Forward-parse resultater (præudfyldning)
    parsed_email TEXT,
    parsed_company TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'linked', 'ignored')),
    linked_customer_id INTEGER REFERENCES customers(id),
    linked_bon_id INTEGER REFERENCES bons(id),
    handled_by_user_id INTEGER REFERENCES users(id),
    handled_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_unmatched_status   ON mail_unmatched(status);
CREATE INDEX IF NOT EXISTS idx_mail_unmatched_customer ON mail_unmatched(linked_customer_id);
```

---

## 8. KODE — FRA PROTOTYPE TIL BON V2

### `utils/mail-parser.js` (ny fil)
Kopiér `mail-prototype/utils/parser.js` → `utils/mail-parser.js`.

Eneste ændring — prefix-lookup fra `settings`-tabellen i stedet for `process.env`:
```js
// utils/mail-parser.js → getPrefixes()
const rows = getDb().prepare(
  `SELECT key, value FROM settings
   WHERE key IN ('mail_tag_bon_prefix','mail_tag_offer_prefix','mail_tag_customer_prefix')`
).all();
// Returnerer { bon: 'b-', offer: 't-', customer: 'k-' }
```
**NB:** Tabellen hedder `settings` (ikke `system_settings`).

### `services/mailService.js` (udvid eksisterende)
Den eksisterende fil har SMTP + IMAP stub — erstat/udvid med logik fra prototypen:

- `sendMail()` fra `mail-prototype/services/mail-sender.js`
  - Gemmer i `mail_messages` (`direction='out'`) **før** SMTP-kald
  - Henter prefix fra `system_settings`
- `poll()` fra `mail-prototype/services/mail-poller.js`
  - Skriver til `mail_messages` + `mail_threads` + `mail_unmatched`
  - Henter alle tre prefixes fra `system_settings`

---

## 9. API ENDPOINTS (`routes/mail.js`)

Udvid eksisterende `routes/mail.js`:

```
GET    /api/bons/:id/mail              — Tråde + mails for én bon
POST   /api/bons/:id/mail              — Send udgående bon-mail
PATCH  /api/bons/:id/mail/:msgId/read  — Marker som læst

GET    /api/customers/:id/mail         — Tråde + mails for én kunde
POST   /api/customers/:id/mail         — Send udgående CRM-mail

GET    /api/mail/unmatched             — Åbne ufordelte mails
PATCH  /api/mail/unmatched/:id         — Link til kunde/bon eller ignorer

POST   /api/mail/poll                  — Manuel poll (fejlfinding)
GET    /api/mail/status                — IMAP/SMTP status + poll-tidspunkt

-- Bevar uændret:
GET    /api/mail/templates
PATCH  /api/mail/templates/:key
POST   /api/mail/test
```

---

## 10. SSE EVENTS

| Event | Payload | Trigger |
|-------|---------|---------|
| `mail_received` | `{ bon_id, customer_id, thread_id, unread_count }` | IMAP poll finder ny mail |
| `mail_sent` | `{ bon_id, customer_id, thread_id }` | Udgående mail sendt |
| `mail_unmatched` | `{ count }` | Ny ufordelt mail |

---

## 11. SETTINGS-NØGLER

Seed i migration 018 (`018_mail_threads.sql`).

**Mail-tag prefixes** (bruges af parser + sendMail til subject-tags):

| Nøgle | Default | Bruges til |
|-------|---------|------------|
| `mail_tag_bon_prefix` | `b-` | `#b-3001` i emnelinjer |
| `mail_tag_offer_prefix` | `t-` | `#t-3001` i emnelinjer |
| `mail_tag_customer_prefix` | `k-` | `#k-600` i emnelinjer |

**NB:** Disse er **separate** fra dokument-nummerprefixes (`bon_number_prefix`, `quote_number_prefix`) der bruges til bonnummer/tilbudsnummer-generering. Mail-tags og dokumentnumre kan konfigureres uafhængigt.

**SMTP/IMAP konfiguration** (allerede i settings fra migration 013/014):

| Nøgle | Default |
|-------|---------|
| `smtp_host` | `asmtp.unoeuro.com` |
| `smtp_port` | `587` |
| `smtp_user` | `bon@ristetrug.dk` |
| `smtp_kontakt_user` | `kontakt@ristetrug.dk` |
| `imap_bon_host` | `imap.simply.com` |
| `imap_bon_port` | `993` |
| `imap_bon_user` | `bon@ristetrug.dk` |
| `imap_kontakt_host` | `imap.simply.com` |
| `imap_kontakt_port` | `993` |
| `imap_kontakt_user` | `kontakt@ristetrug.dk` |

Passwords ligger i `.env` (aldrig i settings-tabellen).

---

## 12. IMPLEMENTERINGSRÆKKEFØLGE

```
1.  Migration 011_mail.sql
2.  utils/mail-parser.js        (fra prototype — prefix fra settings)
3.  services/mailService.js     (udvid eksisterende med sender + poller)
4.  routes/mail.js              (bon + kunde + unmatched endpoints)
    ── backend klar, test med curl/Postman ──
5.  bon_drawer.js               (mail-sektion, simpelt textarea)
6.  SSE events
7.  office listview             (unread badge)
8.  office/views/mail-inbox.js  (ufordelt indbakke)
9.  Kundekort                   (mailhistorik)
10. Tilbud                      (#t- prefix)
    ── separat iteration ──
11. CRM-editor upgrade          (Quill eller TipTap)
```

---

## 13. VERIFICERINGSMATRIX (prototype — bestået)

> **NB:** Sektion 14–15 (vedhæftninger) er endnu ikke implementeret.

| Scenarie | Input | Resultat |
|----------|-------|---------|
| Bon-match | `#b-3001 Frokost fredag` | ✓ `bon_id: 3001` |
| Tilbud-match | `#t-3001 Re: Tilbud` | ✓ `bon_id: 3001` (is_offer=1) |
| Kunde-match | `#k-600 Opfølgning` | ✓ `customer_id: 600` |
| Begge | `#b-3001 #k-600 mail` | ✓ begge sat |
| Ingen tag | `Forespørgsel om mad` | ✓ ufordelt |
| Bon v1 modtaget | `#Bon:cafe-3380` | ✓ ignoreret |
| Bon v1 sendt | `sendt:#Bon:cafe-3380` | ✓ ignoreret |
| Forward known | From: peter@finansforbundet.dk | ✓ navn + firma parsed |
| Forward ukendt | From: ny@nytfirma.dk | ✓ email + firma-gæt parsed |

---

## 14. VEDHÆFTNINGER I UDGÅENDE MAIL

### Arkitektur — to attachment-tabeller

Systemet har **to** separate tabeller for vedhæftninger:

| Tabel | Formål | FK |
|-------|--------|-----|
| `attachments` (migration 003) | Generiske entitets-filer (PDF'er på bons/tilbud/kunder) | `entity_type` + `entity_id` |
| `mail_attachments` (migration 018) | Filer sendt/modtaget i en specifik mail | `message_id` → `mail_messages` |

**Flow for udgående mail med vedhæftning:**
1. Fil uploades → gemmes i `attachments` med `entity_type`/`entity_id`
2. Mail sendes med reference til `attachment_id` fra `attachments`
3. Backend resolver `attachment_id` → `file_path`, sender via nodemailer
4. Backend kopierer referencen til `mail_attachments` (med `message_id` FK)

Indgående vedhæftninger (fra IMAP) gemmes direkte i `mail_attachments`.

### Ny npm-pakke: `busboy`

Multipart/form-data parsing kræver en pakke. **Busboy** er rent JavaScript (ingen native compilation) og matcher reglen i CLAUDE.md.

```json
"busboy": "^1.6.0"
```

### Nyt endpoint: `POST /api/attachments/upload`

Placering: `routes/attachments.js` (ny fil)

```
POST /api/attachments/upload
  Content-Type: multipart/form-data
  Fields: file (required), entity_type (optional), entity_id (optional)

  Validering:
    - Max 10 MB per fil
    - Tilladte MIME-typer: application/pdf, image/*, application/vnd.openxmlformats*
    - Auth required (requireAuth())

  Gemmer fil i: data/attachments/{entity_type}/{entity_id}/{timestamp}-{filename}
  Ad-hoc (ingen entity): data/attachments/temp/{timestamp}-{filename}

  Opretter række i `attachments`-tabellen:
    entity_type, entity_id, file_name, file_path, mime_type, size_bytes

  Returnerer: { attachment_id, filename, size_bytes, mime_type }
```

### `sendMail()` — ændringer i `services/mailService.js`

Aktuel signatur (bevares, udvides):
```js
async function sendMail({
  to, subject, text,              // ← NB: hedder `text`, ikke `body`
  context, bonId, customerId,     // ← camelCase, ikke snake_case
  inReplyTo, references,
  smtpPrefix, userId,
  attachments = []                // ← NY parameter
})
```

Attachment-håndtering:
```js
// 1. Resolve attachment_id → file_path via `attachments`-tabellen
const resolved = attachments.map(a => {
  const row = db.prepare(
    'SELECT file_name, file_path, mime_type FROM attachments WHERE id = ?'
  ).get(a.attachment_id);
  if (!row) throw new Error(`Attachment ${a.attachment_id} ikke fundet`);
  return { path: row.file_path, filename: row.file_name, contentType: row.mime_type };
});

// 2. Sæt has_attachments flag på mail_messages-rækken
//    (den eksisterende INSERT sættes til: has_attachments: resolved.length > 0 ? 1 : 0)

// 3. Gem mail_attachments-rækker (kopierer reference for mail-historik)
for (const att of resolved) {
  db.prepare(`INSERT INTO mail_attachments (message_id, filename, mime_type, file_path)
              VALUES (?, ?, ?, ?)`).run(msgId, att.filename, att.contentType, att.path);
}

// 4. Tilføj til nodemailer mailOptions
mailOptions.attachments = resolved;  // nodemailer forstår { path, filename, contentType }
```

### API — ændring til send-endpoints

`POST /api/bons/:id/mail` og `POST /api/customers/:id/mail` accepterer:

```json
{
  "to": "kunde@firma.dk",
  "subject": "Tilbud på frokost",
  "text": "Kære Peter...",
  "attachments": [
    { "attachment_id": 42 },
    { "attachment_id": 17 }
  ]
}
```

**NB:** Body-feltet hedder `text` (ikke `body`) — matcher den faktiske `sendMail()` signatur.
Endpointet forbliver JSON (`Content-Type: application/json`). Fil-upload sker via det separate `/api/attachments/upload` endpoint.

### Compose UI — "Vedhæft"-knap

Tilføjes i mail-compose i **begge** kontekster (bon-drawer + CRM kundekort):

```
[ Til: kunde@firma.dk            ]
[ Emne: Bekræftelse              ]    ← tags tilføjes af backend
[ ________________________________]
[ Beskedtekst ...                 ]
[________________________________ ]
[ 📎 Vedhæft ]                [ Send ]

Valgte filer som pills:
  📎 tilbud-T42.pdf  ✕    📎 foto.jpg  ✕
```

**Upload-flow:**
1. Bruger klikker "Vedhæft" → native `<input type="file">` åbner
2. Fil vælges → `POST /api/attachments/upload` med `entity_type` + `entity_id`
3. Svar: `{ attachment_id, filename, size_bytes }` → vis som pill
4. Ved "Send" → `attachment_id`'er sendes med i JSON-body
5. Flere filer: gentag trin 1–3

**Begrænsninger:**
- Max 10 MB per fil (valideres frontend + backend)
- Tilladte MIME-typer: `application/pdf`, `image/*`, `application/vnd.openxmlformats*`
- Max 5 vedhæftninger per mail

### Visning af vedhæftninger i mail-historik

`GET /api/bons/:id/mail` returnerer allerede `attachments[]` per besked (via `mail_attachments` join).
Frontend skal vise dem som klikbare links:

```
← Peter Hansen  10:23
  "Vedhæftet er fakturaen..."
  📎 faktura-2026.pdf (245 KB)     ← klikbar download-link
```

Download-endpoint: `GET /api/attachments/:id/download` (streamer filen, auth required).

### Tilbud-specifik integration

**Use case:** "Send tilbud som mail" fra tilbudsmodulets step 4.

**Flow:**
1. Frontend genererer PDF via jsPDF (som nu, client-side)
2. Frontend uploader PDF som Blob: `POST /api/attachments/upload` med `entity_type='bon'` + `entity_id={bonId}`
3. Får `attachment_id` tilbage
4. Åbner mail-compose med pre-filled data + `attachment_id` i attachments-listen
5. Bruger klikker Send → mail sendes med PDF vedhæftet

**Ingen server-side PDF-generering nødvendig** — client-side jsPDF + upload er tilstrækkeligt.

---

## 15. IMPLEMENTERINGSRÆKKEFØLGE (vedhæftninger)

```
1.  npm install busboy
2.  routes/attachments.js          (upload + download endpoints)
3.  services/mailService.js        (udvid sendMail med attachments parameter)
4.  routes/bons.js                 (POST /:id/mail accepterer attachments[])
5.  shared/bon_drawer.js           (vedhæft-knap + pills i compose-UI)
6.  shared/bon_drawer.js           (vis vedhæftninger i mail-historik)
7.  office/views/tilbud.js         ("Send som mail" med PDF-upload)
    ── CRM kundekort: samme mønster som bon-drawer ──
8.  office/views/crm-kunde360.js   (vedhæft i CRM mail-compose)
```

---

*Dokument oprettet: marts 2026*
*Vedhæftnings-spec opdateret: april 2026 — tilpasset faktisk kodebase*
