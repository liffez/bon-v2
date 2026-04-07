# CLAUDE_MAIL_IMPL.md — Mail implementering i Bon v2
> Læs `bon_v2_datamodel_v2.md` og `BON_V2_PRINCIPPER.md` før du starter.
> Prototypen i `mail-prototype/` er verificeret og klar til at flyttes ind.

---

## OVERBLIK

Mail-systemet har to kontekster der deler samme infrastruktur:

| Kontekst | Mailboks | Tag | Tråd knyttes til |
|----------|----------|-----|-----------------|
| Bon | `bon@ristetrug.dk` | `#b-{nummer}` | `bon_id` |
| Tilbud | `bon@ristetrug.dk` | `#t-{nummer}` | `bon_id` (quote) |
| CRM/Kunde | `kontakt@ristetrug.dk` | `#k-{nummer}` | `customer_id` |

Databasen er sandheden. IMAP er read-only kilde for indgående.

---

## TRIN 1 — Database migration

Opret `db/migrations/011_mail.sql`.

`bon_mails`-tabellen eksisterer i skemaet men er tom og ubrugt.
Den **erstattes** af `mail_threads` + `mail_messages` + `mail_attachments`.
Tilføj desuden `crm_unmatched_emails` til ufordelt indbakke.

```sql
-- ==========================================
-- 011_mail.sql
-- ==========================================

-- Fjern den gamle, ubrugte bon_mails-tabel
DROP TABLE IF EXISTS bon_mails;

-- Mail-tråde — kan knyttes til bon, kunde eller begge
CREATE TABLE IF NOT EXISTS mail_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,              -- Ren subject (uden tags)
    bon_id INTEGER REFERENCES bons(id),
    customer_id INTEGER REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'archived')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_threads_bon      ON mail_threads(bon_id);
CREATE INDEX IF NOT EXISTS idx_mail_threads_customer ON mail_threads(customer_id);

-- Enkeltmails — indgående og udgående
CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES mail_threads(id),
    message_id TEXT,                    -- Email Message-ID header
    in_reply_to TEXT,                   -- Email In-Reply-To header
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    from_email TEXT NOT NULL,
    from_name TEXT,
    to_email TEXT NOT NULL,
    to_name TEXT,
    cc TEXT,                            -- JSON array
    subject TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,  -- Kræver handling
    sent_at DATETIME,
    received_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid  ON mail_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread ON mail_messages(is_read, direction);

-- Vedhæftede filer
CREATE TABLE IF NOT EXISTS mail_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES mail_messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    file_path TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Ufordelt indbakke — mails uden tag-match
CREATE TABLE IF NOT EXISTS mail_unmatched (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox TEXT NOT NULL,              -- 'bon@...' eller 'kontakt@...'
    message_id TEXT,
    from_email TEXT,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    received_at DATETIME,
    -- Forward-parse resultater (præudfyldning)
    parsed_name TEXT,
    parsed_email TEXT,
    parsed_company TEXT,
    -- Behandling
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

## TRIN 2 — Flyt prototype-kode ind

Prototype-filerne er klar til direkte flytning med minimal tilpasning.

### `utils/mail-parser.js` (ny fil)
Kopiér `mail-prototype/utils/parser.js` → `utils/mail-parser.js`.

Eneste ændring: prefix-lookup skal hente fra `settings`-tabellen (ikke `system_settings`) i stedet for `process.env`:

```js
// utils/mail-parser.js → getPrefixes()
const rows = getDb().prepare(
  "SELECT key, value FROM settings WHERE key IN ('mail_tag_bon_prefix','mail_tag_offer_prefix','mail_tag_customer_prefix')"
).all();
// Returnerer { bon: 'b-', offer: 't-', customer: 'k-' }
```

### `services/mailService.js` (udvid eksisterende)
Den eksisterende `mailService.js` har SMTP + IMAP stub.
Erstat/udvid med logikken fra:
- `mail-prototype/services/mail-sender.js` → `sendMail()`
- `mail-prototype/services/mail-poller.js` → `poll()`

Tilpasninger i forhold til prototypen:
- `sendMail()` gemmer i `mail_messages` (`direction='out'`) **før** SMTP-kald
- `poll()` skriver til `mail_messages` + `mail_threads` + `mail_unmatched` i stedet for in-memory array
- Hent prefixes fra `system_settings` via `getDb()`

---

## TRIN 3 — API endpoints (`routes/mail.js`)

Udvid den eksisterende `routes/mail.js` med:

### Bon-mail endpoints
```
GET    /api/bons/:id/mail              — Hent alle tråde + mails for én bon
POST   /api/bons/:id/mail              — Send udgående mail om bon
PATCH  /api/bons/:id/mail/:msgId/read  — Marker som læst
```

### Kunde-mail endpoints
```
GET    /api/customers/:id/mail         — Hent alle tråde + mails for én kunde
POST   /api/customers/:id/mail         — Send udgående mail til kunde
```

### Ufordelt indbakke
```
GET    /api/mail/unmatched             — Hent åbne ufordelte mails
PATCH  /api/mail/unmatched/:id         — Link til kunde/bon eller ignorer
```

### Eksisterende endpoints (bevar uændret)
```
GET    /api/mail/templates
PATCH  /api/mail/templates/:key
POST   /api/mail/test
```

### Poller-kontrol (admin)
```
POST   /api/mail/poll                  — Manuel poll (til fejlfinding)
GET    /api/mail/status                — IMAP/SMTP status + poll-tidspunkt
```

---

## TRIN 4 — Bon-drawer: mail-sektion

Mail vises i `shared/bon_drawer.js` som en sektion i drawer'en.

### Layout
```
─────────────────────────────────────
✉ KORRESPONDANCE          [Ny mail ▼]
─────────────────────────────────────
[Tråd: Frokost torsdag]
  ← Leif Zeeberg  10:23  "Kan vi få..."
  → Ristet Rug    10:45  "Selvfølgelig..."
  ← Leif Zeeberg  11:02  "Super tak"
─────────────────────────────────────
[Skriv svar...]          [Skabelon ▼]
                              [Send]
```

### Adfærd
- Henter `GET /api/bons/:id/mail` ved åbning af drawer
- Ny mail → `POST /api/bons/:id/mail` med `context: { type: 'bon', number: bon_number }`
- Tag `#b-{nummer}` tilføjes automatisk af backend — frontenden ser det aldrig
- Ulæste mails markeres automatisk ved visning
- Skabeloner hentes fra `GET /api/mail/templates`
- SSE: `mail_received`-event trigger reload af mail-sektionen

### Ulæst-badge
- `bon_drawer.js` viser ✉-badge med antal ulæste
- `office/views/bons-list.js` viser badge i listview-rækken
- Backend: `GET /api/bons` returnerer `unread_mail_count` per bon (allerede i API-spec)

---

## TRIN 5 — Kundekort: mail-historik

Mail vises på kundekortet i CRM-sektionen.

### Layout
```
─────────────────────────────────────
✉ MAILHISTORIK             [Ny mail]
─────────────────────────────────────
Re: Tilbud sommerfest    #b-3001  ↗
  3 beskeder · sidst 2 dage siden

Forespørgsel konference          ↗
  1 besked · 14 dage siden
─────────────────────────────────────
```

- Viser alle tråde knyttet til `customer_id` på tværs af bonner
- Klik på tråd → åbner den tilknyttede bon-drawer (hvis `bon_id` sat)
- Ny mail fra kundekort → `POST /api/customers/:id/mail` med `#k-{nummer}`

---

## TRIN 6 — Ufordelt indbakke (office)

Ny view: `office/views/mail-inbox.js` — vises som sidebar-punkt under "Post".

### Layout pr. mail
```
┌─────────────────────────────────────────────────┐
│ peter@finansforbundet.dk · kontakt@  · 14:23    │
│ "Forespørgsel om sommerfrokost"                 │
│                                                  │
│ Forward-parsed: Peter Hansen · Finansforbundet  │
│ [Opret kunde]  [Find eksisterende]  [Ignorer]   │
└─────────────────────────────────────────────────┘
```

- `mailbox`-felt viser om den kom til `bon@` eller `kontakt@`
- `bon@` → vis ekstra knap: "Opret bon"
- Forward-parsed data præudfylder opret-kunde formular
- `PATCH /api/mail/unmatched/:id` med `{ status: 'linked', linked_customer_id, linked_bon_id }`

---

## TRIN 7 — Tilbud: mail-kontekst

Tilbud bruger `#t-{nummer}` prefix i udgående mails.

Backend-logik i `sendMail()`:
```js
// Afgør prefix baseret på bon-type
const prefix = bon.is_offer ? settings.offer_number_prefix : settings.bon_number_prefix;
// Ved offer_status = 'won' → skift til bon-prefix automatisk
```

Mail-tråden følger bonen — ved konvertering fra tilbud til bon er `bon_id` den samme,
og historikken bevares. Kun prefix i nye udgående mails skifter.

---

## TRIN 8 — SSE events

Tilføj til `shared/sse.js`-broadcast:

| Event | Payload | Trigger |
|-------|---------|---------|
| `mail_received` | `{ bon_id, customer_id, thread_id, unread_count }` | IMAP poll finder ny mail |
| `mail_sent` | `{ bon_id, customer_id, thread_id }` | Udgående mail sendt |
| `mail_unmatched` | `{ count }` | Ny ufordelt mail |

Frontend lytter:
```js
sse.addEventListener('mail_received', e => {
  // Reload mail-sektion hvis relevant bon er åben
  // Opdater ulæst-badge i listview
});
```

---

## TRIN 9 — Settings

Mail-konfiguration er seeded i migration 013/014 (SMTP/IMAP) og 018 (tag-prefixes).
Tabellen hedder `settings` (ikke `system_settings`).

**Mail-tag prefixes** (seeded i migration 018):

| Nøgle | Default | Bruges til |
|-------|---------|------------|
| `mail_tag_bon_prefix` | `b-` | `#b-3001` i emnelinjer |
| `mail_tag_offer_prefix` | `t-` | `#t-3001` i emnelinjer |
| `mail_tag_customer_prefix` | `k-` | `#k-600` i emnelinjer |

**NB:** Disse er **separate** fra dokument-nummerprefixes (`bon_number_prefix`, `quote_number_prefix`).

**SMTP/IMAP** (seeded i migration 013/014) — se `CLAUDE_MAIL.md` sektion 11 for fuld liste.
Passwords ligger i `.env` (aldrig i settings-tabellen).

---

## RÆKKEFØLGE

```
1. Migration 011_mail.sql
2. utils/mail-parser.js (fra prototype)
3. services/mailService.js (udvid eksisterende)
4. routes/mail.js — bon + kunde + unmatched endpoints
5. bon_drawer.js — mail-sektion
6. SSE events
7. office listview — unread badge
8. office/views/mail-inbox.js — ufordelt indbakke
9. Kundekort — mail-historik
10. Tilbud — #t- prefix
```

Trin 1-4 er ren backend og kan testes med curl/Postman.
Trin 5-10 er UI og bygger oven på verificeret backend.

---

## VIGTIGE REGLER (gentaget fra BON_V2_PRINCIPPER.md)

- IMAP er **read-only** — marker ikke, flyt ikke, slet ikke
- Udgående mails gemmes i `mail_messages` **før** SMTP-kald
- Tags tilføjes af **backend** — aldrig af frontend
- `bon_mails`-tabellen er droppet i migration 011 — brug den ikke
- Bon v1-format (`#Bon:`) ignoreres aktivt i parseren

### Tags er en settings-ting — ingen undtagelser

Prefixes må **aldrig** være hardcoded — hverken i services, routes, utils eller frontend.
`#` er den eneste konstant i hele systemet.

Alle tre steder der bruger prefixes skal slå op i `system_settings`:

| Sted | Brug |
|------|------|
| `utils/mail-parser.js` | Bygger regex dynamisk ved hvert kald |
| `services/mailService.js` — `sendMail()` | Henter prefix for bon/tilbud/kunde |
| `services/mailService.js` — `poll()` | Henter alle tre prefixes til parser-kald |

Konfigurer ét sted, virker overalt. Så kan en anden installation bruge `#o-` for ordre uden at røre koden.

---

*Dokument oprettet: marts 2026*
*Baseret på verificeret prototype (8/8 parser-tests bestået)*
