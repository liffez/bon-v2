# CRM Booking-modul — Spec

> Status: udkast — april 2026
> Forudsætning: Mail-system (Fase 1e), CRM (Fase 7), Tilbudsmodul (Fase 9) — alle bygget.

---

## 1. Formål

Erstatning for HubSpot-mødebooking. To brugsmønstre:

1. **Offentlig booking-side** (kunde-vendt) — kunden vælger mødetype, dato og tid. Lander som `crm_activity` med `type='meeting'`.
2. **Booking-link i mail** — token-baseret link der pre-udfylder formularen og auto-linker mødet til eksisterende kunde. Drives af `mail_templates` med ny variabel `{{booking_link}}`.

## 2. Arkitektur-i-én-linje

> En booking er en `crm_activity` med `type='meeting'`, `due_at=booking-tidspunkt` og `purpose_id` der peger på mødetypen. Punktum.

Ingen ny "bookings"-tabel. Ingen separat data-silo. Booking-modulet er en *publikum-vendt indgang* til den eksisterende aktivitets-model.

---

## 3. Datamodel — migration 050

```sql
-- db/migrations/050_booking.sql

-- Mødetyper (Smagning, Gennemgang, S+G, Andet)
-- Bemærk: hvis activity_purposes-tabellen allerede eksisterer, INSERT bare ind i den.
CREATE TABLE IF NOT EXISTS activity_purposes (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  duration_min    INTEGER NOT NULL,
  description     TEXT,
  is_bookable     INTEGER NOT NULL DEFAULT 0,   -- 1 = vises på offentlig booking-side
  is_system       INTEGER NOT NULL DEFAULT 0,   -- 1 = kan ikke slettes, kun deaktiveres
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO activity_purposes (key, label, duration_min, description, is_bookable, is_system, sort_order) VALUES
  ('tasting',              'Smagning',              45, 'Smag på vores menuer og bliv inspireret', 1, 1, 10),
  ('walkthrough',          'Gennemgang',            30, 'Planlæg dit arrangement i detaljer',       1, 1, 20),
  ('tasting_walkthrough',  'Smagning + Gennemgang', 75, 'Det fulde program — smag og planlæg',     1, 1, 30),
  ('other_meeting',        'Andet',                 30, 'Uforpligtende snak om jeres event',        1, 1, 40);

-- Felter på crm_activities (allerede der: type, due_at, customer_id, text, sentiment, owner_user_id)
-- Tilføj kun det vi mangler:
ALTER TABLE crm_activities ADD COLUMN purpose_id        INTEGER REFERENCES activity_purposes(id);
ALTER TABLE crm_activities ADD COLUMN duration_min      INTEGER;
ALTER TABLE crm_activities ADD COLUMN guest_count       INTEGER;        -- "antal gæster" fra booking-form
ALTER TABLE crm_activities ADD COLUMN event_type        TEXT;           -- 'lunch'/'reception'/'wedding' osv. — fri tekst for nu
ALTER TABLE crm_activities ADD COLUMN booked_via        TEXT;           -- 'public_form'/'token_link'/'internal'/'phone'
ALTER TABLE crm_activities ADD COLUMN ical_uid          TEXT;           -- iCal UID hvis sendt som calendar-invite

-- Booking-tokens (én pr. mail-udsendelse)
CREATE TABLE booking_tokens (
  token              TEXT PRIMARY KEY,                -- 16+ tegn random
  customer_id        INTEGER REFERENCES customers(id),
  company_id         INTEGER REFERENCES companies(id),
  sales_user_id      INTEGER REFERENCES users(id),    -- hvem skal mødet lande hos
  intent_purpose_id  INTEGER REFERENCES activity_purposes(id),  -- forvalgt mødetype, NULL = lad kunden vælge
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at         TEXT NOT NULL,                    -- typisk +60 dage
  opened_at          TEXT,                             -- første gang linket åbnes
  open_count         INTEGER NOT NULL DEFAULT 0,
  booking_activity_id INTEGER REFERENCES crm_activities(id),
  notes              TEXT                              -- valgfri intern note ("sendt efter tilbud #T-2398")
);

CREATE INDEX idx_booking_tokens_customer ON booking_tokens(customer_id);
CREATE INDEX idx_booking_tokens_expires  ON booking_tokens(expires_at);

-- Settings (alle som rows i settings-tabellen)
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('booking_enabled',           '1',         'Master-toggle for offentlig booking-side'),
  ('booking_min_days_ahead',    '2',         'Tidligste booking-dato (dage frem fra i dag)'),
  ('booking_max_days_ahead',    '90',        'Seneste booking-dato'),
  ('booking_blocked_weekdays',  '[0]',       'JSON-array. 0=søndag, 6=lørdag'),
  ('booking_workday_start',     '09:00',     'Tidligste mødetid (hh:mm)'),
  ('booking_workday_end',       '16:30',     'Seneste mødestart (hh:mm)'),
  ('booking_slot_step_min',     '30',        'Slot-granularitet i minutter'),
  ('booking_event_buffer_before_min', '120', 'Buffertid før event-leveringer (minutter)'),
  ('booking_event_buffer_after_min',  '60',  'Buffertid efter event-leveringer'),
  ('booking_default_owner_user_id',   '',    'Bruger der får møder fra anonymt link (tomt = systemejer)'),
  ('booking_token_ttl_days',          '60',  'Levetid for booking-tokens i dage'),
  ('booking_public_url_base',         '',    'Fx https://bon.ristetrug.dk — bruges i {{booking_link}}');
```

`is_bookable` styrer at vi senere kan tilføje purposes der KUN bruges internt (fx `'lead_qualification'`) uden at de dukker op på den offentlige side.

---

## 4. Backend — `routes/booking.js`

Ny route-fil. Mounted i `server.js`. Følger mønstret fra `routes/webhooks.js` og `routes/web-orders.js`.

### 4.1 Endpoints (overblik)

```
GET    /api/booking/purposes                              public, ingen auth
GET    /api/booking/slots?date=YYYY-MM-DD&purpose=tasting&token=xxx   public
POST   /webhook/booking                                   public, CORS, altid 200
GET    /api/booking/token/:token                          public — returnerer pre-fill data
POST   /api/booking/tokens                                auth — generér nyt token (til mail-compose)
GET    /api/booking/tokens/recent                         auth — daglig briefing: åbnet men ikke booket
PATCH  /api/booking/settings                              admin — opdatér booking-settings (delt med /api/settings)
```

### 4.2 `GET /api/booking/purposes` — offentlig

```json
[
  { "key": "tasting",             "label": "Smagning",              "duration_min": 45, "description": "..." },
  { "key": "walkthrough",         "label": "Gennemgang",            "duration_min": 30, "description": "..." },
  { "key": "tasting_walkthrough", "label": "Smagning + Gennemgang", "duration_min": 75, "description": "..." },
  { "key": "other_meeting",       "label": "Andet",                 "duration_min": 30, "description": "..." }
]
```

Filtreret med `WHERE is_bookable = 1 AND is_active = 1 ORDER BY sort_order`.

### 4.3 `GET /api/booking/slots` — slot-beregning

Request: `?date=2026-04-28&purpose=tasting&token=xxx` (token valgfrit — bruges hvis token har bestemt sales-ejer, så tider er ift. den person)

```javascript
// Pseudo-implementation — i routes/booking.js
function getSlots({ date, purposeKey, token }) {
  const db = getDb();

  // 1. Hent purpose for varighed
  const purpose = db.prepare('SELECT duration_min FROM activity_purposes WHERE key = ? AND is_bookable = 1')
                    .get(purposeKey);
  if (!purpose) throw new Error('invalid_purpose');

  // 2. Hent settings
  const cfg = loadBookingSettings(db);  // returnerer parsed settings
  const slotStep = cfg.slot_step_min;
  const duration = purpose.duration_min;

  // 3. Find sales-ejer (fra token eller default)
  const ownerId = token
    ? db.prepare('SELECT sales_user_id FROM booking_tokens WHERE token = ? AND expires_at > datetime("now")').get(token)?.sales_user_id
    : cfg.default_owner_user_id;

  // 4. Generér alle potentielle slots for dagen
  const slots = generateSlots(date, cfg.workday_start, cfg.workday_end, slotStep);

  // 5. Hent eksisterende meetings for ejer (eller alle hvis ingen ejer)
  const meetings = db.prepare(`
    SELECT due_at, duration_min FROM crm_activities
    WHERE type = 'meeting' AND DATE(due_at) = ?
      AND outcome IN ('planned', 'reached')
      ${ownerId ? 'AND owner_user_id = ?' : ''}
  `).all(date, ...(ownerId ? [ownerId] : []));

  // 6. Hent events fra bons (kun for "alle ejere"-blokering — egne møder blokerer kun egen kalender,
  //    men store leveringer blokerer hele firmaet)
  const events = db.prepare(`
    SELECT delivery_time, total_units, pax FROM bons
    WHERE delivery_date = ? AND is_offer = 0 AND is_internal = 0
      AND status_id NOT IN (SELECT id FROM status_definitions WHERE code = 'AFLYST')
  `).all(date);

  // 7. Markér slots som tilgængelige/optagede
  return slots.map(slot => {
    const slotEnd = addMinutes(slot, duration);

    // Konflikt med møde?
    const meetingConflict = meetings.find(m => overlaps(slot, slotEnd, m.due_at, addMinutes(m.due_at, m.duration_min || 30)));
    if (meetingConflict) {
      return { time: formatTime(slot), available: false, reason: 'Optaget' };
    }

    // Konflikt med event-buffertid?
    const eventConflict = events.find(e => {
      const eventStart = new Date(`${date}T${e.delivery_time}`);
      const eventEnd = addMinutes(eventStart, 60);  // levering antages 1 time
      const bufferStart = subMinutes(eventStart, cfg.event_buffer_before_min);
      const bufferEnd = addMinutes(eventEnd, cfg.event_buffer_after_min);
      return overlaps(slot, slotEnd, bufferStart, bufferEnd);
    });
    if (eventConflict) {
      return { time: formatTime(slot), available: false, reason: `Buffertid for begivenhed kl ${eventConflict.delivery_time}` };
    }

    return { time: formatTime(slot), available: true };
  });
}
```

Returner:
```json
{
  "date": "2026-04-28",
  "purpose": "tasting",
  "duration_min": 45,
  "slots": [
    { "time": "09:00", "available": true },
    { "time": "09:30", "available": true },
    { "time": "10:00", "available": false, "reason": "Optaget" },
    { "time": "12:30", "available": false, "reason": "Buffertid for begivenhed kl 13:30" },
    ...
  ]
}
```

`reason`-feltet matcher mockup'ens "Ikke tilgængelig. Buffertid for begivenheder starter 13:00".

### 4.4 `POST /webhook/booking` — selve bookingen

Public endpoint, samme mønster som `/webhook/bestilling`. Honeypot-felt, altid 200.

Request body:
```json
{
  "purpose": "tasting",
  "date": "2026-04-28",
  "time": "14:30",
  "first_name": "Mette",
  "last_name": "Hansen",
  "email": "mette@tivoli.dk",
  "phone": "+4520304050",
  "company_name": "Tivoli A/S",
  "guest_count": 80,
  "event_type": "company_lunch",
  "message": "Vi tænker på en sommerfrokost til 80 personer.",
  "token": "k7Hx9mQ2",        // valgfrit — overskriver kontaktdata hvis sat
  "honeypot": ""              // skal være tom
}
```

Server-flow:
1. Honeypot tjek (drop hvis udfyldt)
2. Validér påkrævede felter (purpose, date, time, first_name, email)
3. Re-tjek slot er ledigt (race-condition guard)
4. Match/opret kunde:
   - Hvis `token` → brug `customer_id`/`company_id` fra token
   - Ellers email-match: `SELECT id FROM customers WHERE LOWER(email) = LOWER(?)`
   - Ellers opret ny `customer` + evt. ny `company` (hvis `company_name` udfyldt og ikke matchet)
5. Opret `crm_activities`-row:
   ```sql
   INSERT INTO crm_activities (
     customer_id, type, purpose_id, due_at, duration_min,
     guest_count, event_type, text, owner_user_id, outcome, booked_via, created_at
   ) VALUES (
     ?, 'meeting', ?, ?, ?,
     ?, ?, ?, ?, 'planned', ?, datetime('now')
   )
   ```
6. Hvis token: opdatér `booking_tokens.booking_activity_id`, `opened_at` (hvis NULL)
7. Send bekræftelsesmail via `sendFromTemplate({ templateKey: 'booking_confirmation_meeting', to, vars, ... })`
8. SSE broadcast: `crm_activity_created` (eksisterer allerede)
9. Returnér `{ success: true, confirmation_id: <activity_id> }`

### 4.5 `GET /api/booking/token/:token` — pre-fill data

Returnerer:
```json
{
  "valid": true,
  "expires_at": "2026-06-01T00:00:00",
  "customer": { "first_name": "Mette", "last_name": "Hansen", "email": "...", "phone": "..." },
  "company": { "name": "Tivoli A/S" },
  "intent_purpose": "tasting",
  "sales_user": { "name": "Leif", "title": "Salgschef" }
}
```

Bumper `open_count` og sætter `opened_at` ved første kald.

Hvis token udløbet eller ikke fundet: `{ "valid": false }` — frontend viser så det generiske formular uden pre-fill.

### 4.6 `POST /api/booking/tokens` — generér token

Bruges af mail-compose-flow i CRM Kunde 360°. Auth-required.

Request:
```json
{
  "customer_id": 123,
  "intent_purpose": "tasting",   // valgfrit
  "ttl_days": 60                 // valgfrit, default fra settings
}
```

Server:
1. Generér 16-tegn random token (crypto.randomBytes → base62 eller hex)
2. Hent `customer.company_id` automatisk
3. Sæt `sales_user_id = req.session.userId` (mailen sendes af denne person)
4. Insert i `booking_tokens`
5. Returnér: `{ "token": "...", "url": "https://bon.ristetrug.dk/book?t=..." }`

### 4.7 `GET /api/booking/tokens/recent` — daglig briefing

Til briefing-feltet "Klikkede dit link, ikke booket":
```sql
SELECT t.token, t.customer_id, t.opened_at, c.first_name, c.last_name, co.name AS company_name,
       ap.label AS intent_label
FROM booking_tokens t
JOIN customers c  ON c.id = t.customer_id
LEFT JOIN companies co ON co.id = t.company_id
LEFT JOIN activity_purposes ap ON ap.id = t.intent_purpose_id
WHERE t.opened_at IS NOT NULL
  AND t.booking_activity_id IS NULL
  AND t.expires_at > datetime('now')
  AND t.opened_at > datetime('now', '-14 days')
  AND (? IS NULL OR t.sales_user_id = ?)
ORDER BY t.opened_at DESC;
```

---

## 5. Mail-skabelon — `booking_confirmation_meeting`

Tilføjes til `mail_templates`-tabellen via migration. Bruger `kontakt@`-transport (CRM-mail).

```sql
INSERT INTO mail_templates (key, smtp_prefix, subject, body, description) VALUES (
  'booking_confirmation_meeting',
  'smtp_kontakt',
  'Bekræftelse: {{purposeLabel}} — {{datoFormatteret}} kl {{tid}}',
  '<p>Hej {{kundeFornavn}},</p>

<p>Tak for din booking — vi glæder os til at se dig.</p>

<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;background:#f5f4f2;border-radius:6px;margin:16px 0;">
  <tr><td style="color:#666;width:120px;">Mødetype</td><td><strong>{{purposeLabel}}</strong></td></tr>
  <tr><td style="color:#666;">Dato</td><td><strong>{{datoFormatteret}}</strong></td></tr>
  <tr><td style="color:#666;">Tidspunkt</td><td><strong>{{tid}} ({{varighed}} min)</strong></td></tr>
  <tr><td style="color:#666;">Hos</td><td>Ristet Rug, [adresse]</td></tr>
</table>

<p>Skulle der ske noget der gør at du er nødt til at flytte, så svar bare på denne mail eller ring til os på {{firmaTelefon}}.</p>

<p>Vi ses!</p>',
  'Sendes automatisk når kunde booker via offentlig booking-side eller token-link.'
);
```

### Variabler der skal renderes

`mailService.renderTemplate()` skal udvides til at understøtte:
- `{{kundeFornavn}}` → fra customer
- `{{purposeLabel}}` → fra activity_purposes
- `{{datoFormatteret}}` → "tirsdag 28. april 2026"
- `{{tid}}` → "14:30"
- `{{varighed}}` → 45
- `{{firmaTelefon}}` → fra settings (`company_phone`)

### Booking-link i andre mail-skabeloner

Generel variabel `{{booking_link}}` skal kunne renderes i ENHVER mail-skabelon. Implementering:

```javascript
// services/mailService.js — udvid renderTemplate()
async function renderTemplate(body, vars, ctx = {}) {
  // ... eksisterende substitution

  // Booking-link: hvis {{booking_link}} forekommer i body OG ctx.customer_id er sat,
  // generér token automatisk og indsæt knap-HTML
  if (body.includes('{{booking_link}}') && ctx.customer_id) {
    const token = await generateBookingToken(ctx.customer_id, ctx.intent_purpose, ctx.sender_user_id);
    const baseUrl = await getSetting('booking_public_url_base');
    const buttonHtml = renderBookingButton(`${baseUrl}/book?t=${token}`, ctx.intent_label || 'Book et møde');
    body = body.replace(/\{\{booking_link\}\}/g, buttonHtml);
  }

  return body;
}

function renderBookingButton(url, label) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
      <tr>
        <td style="background:#8e631f;border-radius:6px;">
          <a href="${url}" style="display:inline-block;padding:14px 28px;color:#fff;
             text-decoration:none;font-family:'DM Sans',sans-serif;font-weight:600;font-size:15px;">
            ${escapeHtml(label)} →
          </a>
        </td>
      </tr>
    </table>`;
}
```

Bemærk: `#8e631f` er `--brand-primary` fra `tokens.css`. Tabel-baseret button-layout fordi Outlook ikke understøtter `display:inline-block` på `<a>` ordentligt.

### Mail-compose UI i Kunde 360°

I `office/views/crm-kunde360.js` mail-compose-form: tilføj knap "📅 Indsæt booking-link". Klik åbner mini-popover:
- Mødetype-dropdown (de 4 bookable purposes, "Ingen forvalgt" som default)
- "Indsæt"-knap → indsætter `{{booking_link}}` i textarea ved cursor

Variabel-substitution sker server-side når mailen sendes — frontend skriver bare placeholder.

---

## 6. Frontend — `tools/booking.html`

Public side, ingen auth. Følger mønstret fra `tools/bestilling_v2.html`.

### 6.1 Filplacering

```
tools/
  booking.html          ← markup, ren vanilla
  booking.css           ← styling med tokens.css imports
  booking.js            ← logik (intet build-step)
```

`server.js` serverer `tools/` som static. Tilgængelig via `https://bon.ristetrug.dk/tools/booking.html` — eller via reverse proxy på `https://bon.ristetrug.dk/book`.

### 6.2 Stack-noter

- **Vanilla JS** — ikke Vue, ikke React, ingen npm-build
- **Vanilla CSS** — import design-tokens fra `/shared/tokens.css`
- **Google Fonts** — Playfair Display + DM Sans (samme som office)
- **Brand-farver fra tokens** — IKKE den sorte/gulden palette fra mockup'en
- **Ingen native pakker** — fetch er nok

### 6.3 UI-flow (3 trin)

**Trin 1 — Vælg mødetype + dato + tid** (alt på én skærm, samme som mockup):
- 2×2 grid med de 4 mødetyper hentet fra `/api/booking/purposes`
- Kalender — manuelt renderet, ikke library
- Tider hentes fra `/api/booking/slots?date=&purpose=` når dato vælges

**Trin 2 — Oplysninger:**
- Hvis `?t=token` i URL: pre-udfyldte felter, vist som read-only med "Ret"-knap
- Felter: Fornavn, Efternavn, Email, Telefon, Firma (valgfrit), Antal gæster (counter), Eventtype (dropdown), Besked (textarea)

**Trin 3 — Bekræft:**
- Sammenfatning, "Bekræft"-knap → `POST /webhook/booking`
- Spinner → success-skærm med grønt flueben

### 6.4 Designsystem-mapping

Ingen mockup-værdier. Brug tokens:

```css
:root {
  /* Disse er IKKE definerede her — importeres fra tokens.css */
}

.booking-page {
  background: var(--color-background);          /* #f5f4f2 */
  font-family: var(--font-body);                /* DM Sans */
  color: var(--color-text);
}

.booking-page h1, .booking-page h2 {
  font-family: var(--font-heading);             /* Playfair Display */
}

.btn-primary {
  background: var(--brand-primary);             /* #8e631f */
  color: #fff;
}

.type-option.selected,
.day-cell.selected,
.time-slot.selected {
  background: var(--brand-primary);
  color: #fff;
}
```

Mockup'ens mørke tema droppes helt. Lys baggrund, brun accent — som resten af Bon v2.

---

## 7. Lead/customer matching — detaljeret logik

Den vanskelige del. Algoritme i prioriteret rækkefølge:

```javascript
function matchOrCreateCustomer({ token, email, phone, first_name, last_name, company_name }) {
  const db = getDb();

  // 1. Token-baseret: vinder over alt andet
  if (token) {
    const t = db.prepare('SELECT customer_id, company_id FROM booking_tokens WHERE token = ?').get(token);
    if (t?.customer_id) return { customer_id: t.customer_id, company_id: t.company_id, source: 'token' };
  }

  // 2. Exact email match (case-insensitive)
  const emailMatch = db.prepare(
    'SELECT id, company_id FROM customers WHERE LOWER(email) = LOWER(?) AND is_active = 1 LIMIT 1'
  ).get(email);
  if (emailMatch) return { customer_id: emailMatch.id, company_id: emailMatch.company_id, source: 'email' };

  // 3. Phone match (normaliseret)
  if (phone) {
    const normPhone = phone.replace(/\D/g, '').slice(-8);  // sidste 8 cifre
    const phoneMatch = db.prepare(
      "SELECT id, company_id FROM customers WHERE REPLACE(REPLACE(phone, ' ', ''), '+', '') LIKE ? AND is_active = 1 LIMIT 1"
    ).get(`%${normPhone}`);
    if (phoneMatch) return { customer_id: phoneMatch.id, company_id: phoneMatch.company_id, source: 'phone' };
  }

  // 4. Ny kunde — match firma først
  let companyId = null;
  if (company_name) {
    // Eksakt navn match (case-insensitive)
    const compMatch = db.prepare(
      'SELECT id FROM companies WHERE LOWER(name) = LOWER(?) LIMIT 1'
    ).get(company_name);
    if (compMatch) {
      companyId = compMatch.id;
    } else {
      // Opret nyt firma — flag til review
      const result = db.prepare(
        "INSERT INTO companies (name, notes) VALUES (?, ?)"
      ).run(company_name, '[oprettet via booking — verificér CVR]');
      companyId = result.lastInsertRowid;
    }
  }

  // 5. Opret ny kunde
  const result = db.prepare(`
    INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(first_name, last_name, email, phone, companyId);

  // Sæt stage = 'lead' i crm_customer_meta
  db.prepare(`
    INSERT INTO crm_customer_meta (customer_id, stage, lead_source)
    VALUES (?, 'lead', 'booking')
  `).run(result.lastInsertRowid);

  return { customer_id: result.lastInsertRowid, company_id: companyId, source: 'new' };
}
```

**Når matching er ambivalent (flag i daglig briefing):**
- Hvis `source = 'phone'` men firma_name ikke matcher kundens nuværende firma → flag i briefing: *"Booking fra Mette Hansen — telefon matcher kunde hos Tivoli, men hun skrev 'Tivoli Catering'. Verificér."*
- Hvis `source = 'new'` og firma blev oprettet → flag: *"Nyt firma 'Tivoli Catering' oprettet. Verificér CVR."*

Implementeres ved at tilføje en `crm_activities`-row med `type='note'` + `text='[BOOKING_REVIEW] ...'` der dukker op i den relevante briefing-kategori.

---

## 8. Tracking i daglig briefing

Tilføj nye briefing-punkter i `routes/crm.js` daily-briefing-endpoint:

### "Klikkede dit link — ikke booket" (warm leads)
```
🔗 3 åbnede dit booking-link sidste 14 dage uden at booke
   · Mette Hansen (Tivoli A/S) — Smagning — åbnet for 4 dage siden
   · Lars Bro — Gennemgang — åbnet i går
   · Kasper Lund (Cofoco) — Andet — åbnet for 2 dage siden
```

### "Nyt møde booket" (efter siden besøget)
```
📅 2 nye møder booket i dag
   · Mette Hansen — Smagning — onsdag 14:30
   · Søren Skov — Gennemgang — fredag 10:00 (NYT LEAD)
```

NYT LEAD-tag dukker op når `source = 'new'` i matching-algoritmen.

### "Booking kræver review" (matching-tvivl)
```
⚠️  1 booking kræver tjek
   · "Tivoli Catering" — kunne ikke kobles til kendt firma. Tjek CVR.
```

---

## 9. Konfiguration — Settings UI

Tilføj ny sektion i `settings/index.html`: **Booking**.

Felter:
- ☐ Aktivér offentlig booking-side
- Tidligste booking: [2] dage frem
- Seneste booking: [90] dage frem
- Spærrede ugedage: ☐ Mandag ☐ Tirsdag ... ☑ Søndag
- Arbejdstider: [09:00] – [16:30]
- Slot-granularitet: [30] min
- Buffertid før event: [120] min
- Buffertid efter event: [60] min
- Standard-ejer ved anonyme bookings: [Leif H. ▾]
- Token-levetid: [60] dage
- Public booking-URL: [https://bon.ristetrug.dk]

Mødetyper-tabellen redigeres i samme sektion: omdøb labels, ændr varighed, deaktivér purposes (system-purposes kan ikke slettes, kun deaktiveres — analogt til `payment_types` i Settings).

---

## 10. Implementeringsrækkefølge (5 dages plan)

| Dag | Opgave | Verifikation |
|-----|--------|--------------|
| 1 | Migration 050 + `routes/booking.js` med `purposes`/`slots` endpoints | curl returnerer korrekte slots for en testdato |
| 2 | `POST /webhook/booking` + matching-algoritme + `crm_activities` insert | Postman → ny booking dukker op i CRM Kunde 360° timeline |
| 2 | `tools/booking.html` med 3-trins UI (mock data først) | Manuel test af alle states |
| 3 | Token-system: `POST /api/booking/tokens`, `GET /api/booking/token/:token`, pre-fill i frontend | Generér token → åbn link → felter pre-udfyldte |
| 3 | Mail-skabelon `booking_confirmation_meeting` + `{{booking_link}}` substitution i `mailService.js` | Send testmail med skabelon → korrekt knap renderes |
| 4 | "Indsæt booking-link"-knap i CRM Kunde 360° mail-compose | Skriv mail → indsæt link → send → modtagernes mail har klikbar knap |
| 4 | Daily-briefing-tilføjelser (3 nye punkter) | Briefing viser realistisk data |
| 5 | Settings UI for booking-konfiguration + edge-cases (race-condition på slot, dobbelt-booking) | Manuel røgtest |

---

## 11. Bevidste fravalg

| Fravalgt | Hvorfor |
|----------|---------|
| Google Calendar API-integration | Klarer os med interne CRM-meetings + bons-events først. Tilføjes i fase 2 hvis Leif/Anne har private møder der ofte kolliderer. |
| iCal-vedhæftning i bekræftelsesmail | Komplikation. Mailen indeholder dato/tid i klartekst, kunden kan selv tilføje til kalender. Hvis efterspurgt → fase 2. |
| SMS-bekræftelse | Kræver SMS-gateway (eks. Twilio). Mail dækker 95%. |
| CAPTCHA på offentlig formular | Honeypot er nok til at starte. Tilføjes hvis spam bliver et problem. |
| Per-bruger booking-slugs (`/book/leif`) | Token-baseret link gør samme job mere fleksibelt. Den anonyme `/book` lander hos default-ejer. |
| Aflys-link fra bekræftelsesmail | Kunden kan svare på mailen → CRM-indbakken fanger den via `kontakt@`-IMAP. Aflys-knap kan tilføjes i fase 2. |
| Reschedule-flow | Samme — kunden mailer eller ringer i stedet. Hold MVP simpel. |
| Multi-language support | Dansk only. Ristet Rugs kunder er danske. |
| Time zones | Hardcoded `Europe/Copenhagen`. Sommertid håndteres af `Intl.DateTimeFormat`. |

---

## 12. SSE-events

Eksisterende:
- `crm_activity_created` — broadcaster når booking opretter aktivitet (bruges allerede)

Nye:
- `booking_token_opened` — når kunde klikker token-link (sjov-at-have, kan ses i realtid på dashboard)

Format:
```json
{ "type": "booking_token_opened", "customer_id": 123, "token": "k7Hx..." }
```

---

## 13. Eksempel: hele flowet i én historie

> Leif klikker "Send tilbud" på bon #T-2398 til Mette Hansen (Tivoli A/S).
> Tilbudsmodulet sender mailen via `kontakt@`. Mailen indeholder `{{booking_link}}`.
> `mailService` ser variablen, kalder `generateBookingToken(123, 'tasting', 1)` (Leif er user_id=1),
> får `k7Hx9mQ2`, og indsætter knappen i HTML.
>
> Mette modtager mailen, klikker knappen.
> Browser går til `/book?t=k7Hx9mQ2`.
> Frontend kalder `GET /api/booking/token/k7Hx9mQ2`, får hendes data + intent='tasting'.
> Smagning er forvalgt; navn/email/firma er pre-udfyldt.
> Hun vælger onsdag 14:30 og trykker bekræft.
>
> `POST /webhook/booking` opretter `crm_activity` med `type='meeting'`, `purpose_id=1`, `due_at='2026-04-29 14:30'`,
> `customer_id=123`, `booked_via='token_link'`. Mailen `booking_confirmation_meeting` sendes.
> SSE broadcaster `crm_activity_created`. Leifs office-view viser i realtid: nyt møde i CRM-feed.
>
> Næste morgen ser Leif i daglig briefing: *"📅 1 nyt møde booket: Mette Hansen — Smagning — onsdag 14:30."*

---

## 14. Filer der skal oprettes/ændres

```
db/migrations/050_booking.sql              ← NY
routes/booking.js                          ← NY
services/mailService.js                    ← UDVIDES (booking_link variabel)
tools/booking.html + booking.css + .js     ← NY
office/views/crm-kunde360.js               ← UDVIDES (insert booking-link knap)
office/views/crm-dashboard.js              ← UDVIDES (3 nye briefing-punkter)
settings/index.html                        ← UDVIDES (Booking-sektion)
shared/api.js                              ← UDVIDES (5-6 nye wrapper-funktioner)
server.js                                  ← UDVIDES (mount /api/booking + /webhook/booking)
.env.example                               ← UDVIDES (BOOKING_PUBLIC_URL hvis ikke i settings)
```

Ingen nye npm-pakker. Ingen build-step. Pure vanilla.
