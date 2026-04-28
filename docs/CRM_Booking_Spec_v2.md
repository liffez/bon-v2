# CRM Booking-modul — Spec v2

> Status: udkast — april 2026
> Erstatter v1 fuldstændigt
> Forudsætning: Mail-system, CRM (Fase 7), Tilbudsmodul (Fase 9), `activity_purposes` (migration 048)

---

## Hvad er ændret fra v1

| Område | v1 | v2 |
|--------|----|----|
| **Mail-format** | Antog HTML med `<table>`-knap | Plain text — `{{booking_link}}` er ren URL |
| **Mødetyper** | Genbrugte `activity_purposes` | Egen `meeting_types`-tabel (orthogonal til purpose) |
| **Antal flows** | Ét generelt booking-flow | To separate: Smagsprøve + Kontakt |
| **Takkeside** | Hardcoded HTML | Redigerbar `page_templates`-skabelon |
| **Erindringsmail** | Ingen | Konfigurerbar (variant 2) — N dage før kl HH:MM |
| **`{{booking_link}}`** | I én skabelon | Renderes i ALLE skabeloner (også CRM-mail) |
| **Privatkunder** | Uden firma | `companies.is_personal=1` (matcher 048-skema) |

---

## 1. To separate flows — overblik

### Flow A: Smagsprøve-booking
Kalender-baseret. De konfigurerbare mødetyper (default Smagning / Gennemgang / S+G / Andet) vises som valg. Kunden vælger dato + tid + møde­type. Resulterer i en `crm_activity` med `type='meeting'`.

- URL: `/tools/booking-smagning.html` (kan reverse-proxy'es til `/book/smagning`)
- Webhook: `POST /webhook/booking-smagning`
- Bekræftelsesmail: `booking_smagning_confirmation`
- Erindringsmail: `booking_smagning_reminder`
- Takkeside-skabelon: `thankyou_smagning`

### Flow B: Kontakt-booking
Ingen kalender. Kun et formular: navn, email, telefon, firma, valg af kontaktårsag (`contact_reason`), besked. Resulterer i en `crm_activity` med `type='task'` der lander på "Ring tilbage"-listen.

- URL: `/tools/booking-kontakt.html`
- Webhook: `POST /webhook/booking-kontakt`
- Bekræftelsesmail: `booking_kontakt_confirmation`
- Takkeside-skabelon: `thankyou_kontakt`
- Ingen erindring (ikke et planlagt møde)

**Begge flows** bruger samme token-system når kommer fra mail-link.

---

## 2. Datamodel — migration 051

```sql
-- db/migrations/051_booking.sql

-- ==========================================
-- MEETING TYPES (konfigurerbar opslagstabel)
-- Helt analog til activity_purposes (048).
-- Adskilt fra activity_purposes — purpose er
-- "hvorfor vi mødes", meeting_type er "hvad
-- mødet er rent logistisk + varighed".
-- ==========================================
CREATE TABLE IF NOT EXISTS meeting_types (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    emoji        TEXT,
    description  TEXT,
    duration_min INTEGER NOT NULL DEFAULT 30,
    is_bookable  INTEGER NOT NULL DEFAULT 1,   -- 1 = vises på offentlig booking-side
    is_system    INTEGER NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 100,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO meeting_types (key, label, emoji, description, duration_min, is_bookable, is_system, sort_order) VALUES
    ('smagning',             'Smagning',              '🍽️', 'Smag på vores menuer og bliv inspireret', 45, 1, 1, 10),
    ('gennemgang',           'Gennemgang',            '📋', 'Planlæg dit arrangement i detaljer',       30, 1, 1, 20),
    ('smagning_gennemgang',  'Smagning + Gennemgang', '⭐', 'Det fulde program — smag og planlæg',     75, 1, 1, 30),
    ('andet_moede',          'Andet',                 '💬', 'Uforpligtende snak om jeres event',        30, 1, 1, 40);

-- ==========================================
-- CONTACT REASONS (Flow B — kontakt-formular)
-- Konfigurerbar valgliste på kontakt-formularen
-- ==========================================
CREATE TABLE IF NOT EXISTS contact_reasons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    emoji       TEXT,
    description TEXT,
    is_system   INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO contact_reasons (key, label, emoji, description, is_system, sort_order) VALUES
    ('ring_op',          'Ring mig op',         '📞', 'Specifikt request om opkald',           1, 10),
    ('send_menu',        'Send mig en menu',    '📄', 'Modtag info om vores menuer',           1, 20),
    ('generel_forspg',   'Generel forespørgsel','💬', 'Uforpligtende spørgsmål',                1, 30);

-- ==========================================
-- BOOKING-FELTER på crm_activities
-- (purpose_id eksisterer allerede fra 048)
-- ==========================================
ALTER TABLE crm_activities ADD COLUMN meeting_type_id     INTEGER REFERENCES meeting_types(id);
ALTER TABLE crm_activities ADD COLUMN contact_reason_id   INTEGER REFERENCES contact_reasons(id);
ALTER TABLE crm_activities ADD COLUMN duration_min        INTEGER;
ALTER TABLE crm_activities ADD COLUMN guest_count         INTEGER;
ALTER TABLE crm_activities ADD COLUMN event_type          TEXT;
ALTER TABLE crm_activities ADD COLUMN booked_via          TEXT;  -- 'public_smagning'/'public_kontakt'/'token_link'/'internal'
ALTER TABLE crm_activities ADD COLUMN reminder_sent_at    DATETIME;

-- ==========================================
-- BOOKING TOKENS
-- ==========================================
CREATE TABLE IF NOT EXISTS booking_tokens (
    token              TEXT PRIMARY KEY,
    customer_id        INTEGER REFERENCES customers(id),
    company_id         INTEGER REFERENCES companies(id),
    sales_user_id      INTEGER REFERENCES users(id),
    flow               TEXT NOT NULL DEFAULT 'smagning',  -- 'smagning' eller 'kontakt'
    intent_meeting_type_id INTEGER REFERENCES meeting_types(id),
    intent_purpose_id  INTEGER REFERENCES activity_purposes(id),
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at         DATETIME NOT NULL,
    opened_at          DATETIME,
    open_count         INTEGER NOT NULL DEFAULT 0,
    booking_activity_id INTEGER REFERENCES crm_activities(id),
    notes              TEXT
);

CREATE INDEX idx_booking_tokens_customer ON booking_tokens(customer_id);
CREATE INDEX idx_booking_tokens_expires  ON booking_tokens(expires_at);

-- ==========================================
-- PAGE TEMPLATES (takkeside, intro-tekster)
-- Helt analog til mail_templates, men uden subject
-- ==========================================
CREATE TABLE IF NOT EXISTS page_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    title       TEXT,           -- vises som <h1>
    body_text   TEXT,           -- vises som markdown/plaintext med {{variabel}}
    is_system   INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO page_templates (key, label, title, body_text, is_system) VALUES
    ('thankyou_smagning',
     'Takkeside — Smagning',
     'Tak {{kundeFornavn}}!',
     'Vi glæder os til at se dig {{datoFormatteret}} kl {{tid}}.

Mødetype: {{moedeTypeLabel}} ({{varighed}} min)
Adresse: Prinsesse Charlottesgade 16, 2200 København N

Skulle du være forhindret, så ring til os på {{firmaTelefon}} eller svar på bekræftelsesmailen.

På gensyn!',
     1),
    ('thankyou_kontakt',
     'Takkeside — Kontakt',
     'Tak {{kundeFornavn}}!',
     'Vi har modtaget din henvendelse og kontakter dig hurtigst muligt.

Du hører fra os senest næste arbejdsdag.',
     1),
    ('intro_smagning',
     'Intro-tekst — Smagning',
     'Book en smagning',
     'Vælg tid og dato — vi sørger for en personlig gennemgang af vores catering-muligheder.',
     1),
    ('intro_kontakt',
     'Intro-tekst — Kontakt',
     'Kontakt os',
     'Send os en besked, så vender vi tilbage hurtigst muligt.',
     1);

-- ==========================================
-- BOOKING SETTINGS
-- ==========================================
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    -- Master
    ('booking_smagning_enabled',         '1',     'Aktivér smagsprøve-booking-side'),
    ('booking_kontakt_enabled',          '1',     'Aktivér kontakt-formular'),

    -- Smagning — slot-logik
    ('booking_min_days_ahead',           '2',     'Tidligste booking-dato (dage frem)'),
    ('booking_max_days_ahead',           '90',    'Seneste booking-dato'),
    ('booking_blocked_weekdays',         '[0]',   'JSON: 0=søndag, 6=lørdag'),
    ('booking_workday_start',            '09:00', 'Tidligste mødetid'),
    ('booking_workday_end',              '16:30', 'Seneste mødestart'),
    ('booking_slot_step_min',            '30',    'Slot-granularitet'),
    ('booking_event_buffer_before_min',  '120',   'Buffertid før event-leveringer'),
    ('booking_event_buffer_after_min',   '60',    'Buffertid efter event-leveringer'),

    -- Ejer
    ('booking_default_owner_user_id',    '',      'Bruger der får anonyme bookings'),
    ('booking_token_ttl_days',           '60',    'Token-levetid i dage'),
    ('booking_public_url_base',          '',      'Fx https://bon.ristetrug.dk'),

    -- Erindringsmail (variant 2 — konfigurerbar)
    ('booking_reminder_enabled',         '1',     'Send automatisk erindringsmail før møde'),
    ('booking_reminder_days_before',     '2',     'Antal dage før mødet'),
    ('booking_reminder_send_at_time',    '09:00', 'Klokkeslæt på dagen erindringen sendes'),

    -- Notifikation til sælger
    ('booking_notify_owner_enabled',     '1',     'Send notifikations-mail til sælger ved ny booking'),
    ('booking_notify_owner_template',    'booking_internal_notification', 'Skabelon-key til intern notifikation');
```

---

## 3. Mail-skabeloner — komplet katalog

Plain text (samme som eksisterende skabeloner). Tilføjes i `mail_templates`-tabellen via migration. Alle bruger `kontakt@`-transport.

### Skabelon-format og variabler — udvider TEMPLATE_VARS i settings

I `settings/index.html` (linje 1157-1164) skal `TEMPLATE_VARS`-objektet udvides med booking-skabelonernes variabler:

```javascript
var TEMPLATE_VARS = {
  // Eksisterende
  'booking_confirmation': [...],
  'web_order_confirmation': [...],
  'order_email': [...],

  // Nye — Smagning
  'booking_smagning_confirmation': [
    'kundeFornavn','kundeNavn','firmaNavn','moedeTypeLabel','varighed',
    'datoFormatteret','tid','antalGaester','eventType','beskedFraKunde',
    'firmaTelefon','firmaAdresse','tag'
  ],
  'booking_smagning_reminder': [
    'kundeFornavn','moedeTypeLabel','datoFormatteret','tid','varighed',
    'firmaAdresse','firmaTelefon','tag'
  ],

  // Nye — Kontakt
  'booking_kontakt_confirmation': [
    'kundeFornavn','firmaNavn','kontaktAarsagLabel','beskedFraKunde','tag'
  ],

  // Internt
  'booking_internal_notification': [
    'kundeNavn','firmaNavn','flowType','moedeTypeLabel','kontaktAarsagLabel',
    'datoFormatteret','tid','antalGaester','beskedFraKunde','kundeEmail','kundeTelefon',
    'crmKundeUrl'
  ],

  // Universel — kan bruges i ALLE skabeloner
  '_universal_extras': ['booking_link']
};
```

`booking_link` rendereres af `mailService.renderTemplate()` til en URL — se sektion 4.

### Default-skabelon-indhold (seedes i migration)

```sql
INSERT INTO mail_templates (key, label, subject, body_text) VALUES
('booking_smagning_confirmation',
 'Smagning — Bekræftelse',
 '{{tag}} Bekræftelse af din {{moedeTypeLabel}} {{datoFormatteret}}',
 'Hej {{kundeFornavn}},

Tak for din booking — vi glæder os til at se dig.

  Mødetype:    {{moedeTypeLabel}}
  Dato:        {{datoFormatteret}}
  Tid:         {{tid}} ({{varighed}} min)
  Hos os:      {{firmaAdresse}}

Skulle der ske noget der gør at du er nødt til at flytte, så svar bare på denne mail eller ring til os på {{firmaTelefon}}.

På gensyn!'),

('booking_smagning_reminder',
 'Smagning — Erindring',
 '{{tag}} Påmindelse: {{moedeTypeLabel}} {{datoFormatteret}}',
 'Hej {{kundeFornavn}},

Bare en lille påmindelse om at vi ses {{datoFormatteret}} kl {{tid}}.

  {{moedeTypeLabel}} ({{varighed}} min)
  {{firmaAdresse}}

Vi glæder os.

Hvis du har glemt det og ikke kan komme — ring til os hurtigst muligt på {{firmaTelefon}}.'),

('booking_kontakt_confirmation',
 'Kontakt — Bekræftelse',
 '{{tag}} Vi har modtaget din henvendelse',
 'Hej {{kundeFornavn}},

Tak for din henvendelse om "{{kontaktAarsagLabel}}". Vi vender tilbage hurtigst muligt — senest næste arbejdsdag.

Hvis det haster, kan du ringe til os på {{firmaTelefon}}.'),

('booking_internal_notification',
 'Booking — Intern notifikation',
 '🆕 Ny booking: {{kundeNavn}} ({{flowType}})',
 'Ny booking modtaget:

  Kunde:       {{kundeNavn}}
  Firma:       {{firmaNavn}}
  Email:       {{kundeEmail}}
  Telefon:     {{kundeTelefon}}
  Flow:        {{flowType}}
  Mødetype:    {{moedeTypeLabel}}
  Årsag:       {{kontaktAarsagLabel}}
  Dato:        {{datoFormatteret}} kl {{tid}}
  Antal:       {{antalGaester}}
  Besked:      {{beskedFraKunde}}

Åbn kunden i CRM:
{{crmKundeUrl}}');
```

System-skabeloner — kan ikke slettes, kun redigeres. Tilføjes til SYSTEM_KEYS-listen i `routes/mail.js` og `settings/index.html`:

```javascript
var SYSTEM_KEYS = [
  'booking_confirmation', 'web_order_confirmation', 'order_email',
  'booking_smagning_confirmation', 'booking_smagning_reminder',
  'booking_kontakt_confirmation', 'booking_internal_notification'
];
```

---

## 4. `{{booking_link}}` — universel variabel

Renderes af `mailService.renderTemplate()` i ALLE skabeloner — også eksisterende skabeloner som `booking_confirmation`, custom CRM-mails, osv.

### Implementering — udvidelse af `services/mailService.js`

```javascript
// services/mailService.js — udvid renderTemplate()
async function renderTemplate(body, vars, ctx = {}) {
    let result = body;

    // 1. Standard {{variabel}} substitution
    for (const [key, val] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val ?? '');
    }

    // 2. {{booking_link}} — renderes via token-generering
    // Kun hvis ctx.customer_id eller vars.customer_id er sat
    const customerId = ctx.customerId || vars.customer_id;
    if (result.includes('{{booking_link}}') && customerId) {
        const baseUrl = getSetting('booking_public_url_base') || '';
        const flow = ctx.bookingFlow || 'smagning';
        const intentMeetingTypeKey = ctx.bookingIntent || null;

        const token = await generateBookingToken({
            customer_id: customerId,
            sales_user_id: ctx.userId || null,
            flow,
            intent_meeting_type_key: intentMeetingTypeKey,
            ttl_days: parseInt(getSetting('booking_token_ttl_days') || '60')
        });

        const url = `${baseUrl}/tools/booking-${flow}.html?t=${token}`;
        result = result.replace(/\{\{booking_link\}\}/g, url);
    }

    // 3. Signatur (eksisterende)
    const sig = getSetting('mail_signature');
    if (sig) result += '\n\n--\n' + sig;

    return result;
}

// Ny helper i mailService.js
async function generateBookingToken({ customer_id, sales_user_id, flow, intent_meeting_type_key, ttl_days }) {
    const db = getDb();
    const crypto = require('crypto');
    const token = crypto.randomBytes(8).toString('hex'); // 16 tegn

    let intentId = null;
    if (intent_meeting_type_key) {
        const mt = db.prepare('SELECT id FROM meeting_types WHERE key = ?').get(intent_meeting_type_key);
        intentId = mt?.id || null;
    }

    const customer = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(customer_id);
    const expiresAt = new Date(Date.now() + ttl_days * 86400000).toISOString();

    db.prepare(`
        INSERT INTO booking_tokens (token, customer_id, company_id, sales_user_id, flow,
            intent_meeting_type_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token, customer_id, customer?.company_id, sales_user_id, flow, intentId, expiresAt);

    return token;
}
```

### Note: `sendFromTemplate()` skal videregive context

Eksisterende `sendFromTemplate()` (mailService.js linje 183) skal udvides så `customerId` og evt. `bookingIntent`/`bookingFlow` videregives til `renderTemplate()`:

```javascript
async function sendFromTemplate({ templateKey, to, vars, bonId = null, customerId = null, ..., bookingIntent = null, bookingFlow = 'smagning' }) {
    // ... eksisterende kode
    const ctx = { customerId, userId, bookingIntent, bookingFlow };
    const subject = await renderTemplate(tmpl.subject, enrichedVars, ctx);
    const text    = await renderTemplate(tmpl.body_text, enrichedVars, ctx);
    // ...
}
```

### Brug i UI

I `office/views/crm-kunde360.js` mail-compose: tilføj knap **"📅 Indsæt booking-link"**. Klik åbner mini-popover:
- "Hvilken type?" — dropdown med Smagsprøve / Kontakt
- "Forvalgt mødetype?" — dropdown med aktive `meeting_types` (kun for Smagsprøve), eller "Ingen forvalgt"
- "Indsæt"-knap → indsætter `{{booking_link}}` ved cursor i textarea

Når mailen sendes, kalder UI'et `sendFromTemplate(...)` med `bookingFlow` og `bookingIntent` parametre. Token genereres automatisk på server-siden.

---

## 5. Backend — `routes/booking.js`

### 5.1 Endpoint-overblik

```
# Public — ingen auth
GET    /api/booking/meeting-types                            (Flow A: aktive bookable types)
GET    /api/booking/contact-reasons                          (Flow B: aktive reasons)
GET    /api/booking/intro/:key                               (returnerer page_template)
GET    /api/booking/slots?date=&meeting_type=&token=
GET    /api/booking/token/:token                             (pre-fill data)
POST   /webhook/booking-smagning                             (Flow A submit)
POST   /webhook/booking-kontakt                              (Flow B submit)

# Auth — sælgere/admin
POST   /api/booking/tokens                                   (manuelt generér token)
GET    /api/booking/tokens/recent                            (briefing: åbnet ej booket)
GET    /api/booking/upcoming                                 (kommende bookede møder)

# Admin — settings
GET    /api/booking/meeting-types/admin                      (alle, inkl. inaktive)
POST   /api/booking/meeting-types
PATCH  /api/booking/meeting-types/:id
GET    /api/booking/contact-reasons/admin
POST   /api/booking/contact-reasons
PATCH  /api/booking/contact-reasons/:id
GET    /api/booking/page-templates
PATCH  /api/booking/page-templates/:key
```

### 5.2 Webhook-handler (Flow A — Smagning)

Følger 1:1 mønstret fra `routes/web-orders.js` (honeypot, altid 200, fire-and-forget mail):

```javascript
router.post('/booking-smagning', async (req, res) => {
    try {
        const result = await handleSmagningBooking(req.body);
        res.json({ ok: true, confirmation_id: result?.activityId || null });
    } catch (err) {
        console.error('[booking-smagning] Fejl:', err);
        res.json({ ok: true });  // altid 200
    }
});

async function handleSmagningBooking(data) {
    const db = getDb();

    // 1. Honeypot
    if (data.website) return null;

    // 2. Validér
    if (!data.first_name || !data.email || !data.date || !data.time || !data.meeting_type) {
        console.warn('[booking-smagning] Mangler felter');
        return null;
    }

    // 3. Hent meeting_type (varighed)
    const mt = db.prepare('SELECT id, label, duration_min FROM meeting_types WHERE key = ? AND is_active = 1').get(data.meeting_type);
    if (!mt) { console.warn('[booking-smagning] Ukendt mødetype'); return null; }

    // 4. Re-tjek slot er ledigt (race-condition guard)
    if (!isSlotAvailable(data.date, data.time, mt.duration_min, data.token)) {
        console.warn('[booking-smagning] Slot optaget');
        return null;
    }

    // 5. Match/opret kunde (token > email > opret)
    const { customerId, companyId, source } = matchOrCreateCustomer({
        token: data.token,
        first_name: data.first_name, last_name: data.last_name,
        email: data.email, phone: data.phone,
        company_name: data.company
    });

    // 6. Find ejer (token > anon default)
    const ownerId = resolveSalesOwner(data.token);

    // 7. Opret crm_activity
    const dueAt = `${data.date} ${data.time}:00`;
    const activityRes = db.prepare(`
        INSERT INTO crm_activities (
            customer_id, type, meeting_type_id, due_at, duration_min,
            guest_count, event_type, text, owner_user_id, outcome,
            booked_via, created_at
        ) VALUES (?, 'meeting', ?, ?, ?, ?, ?, ?, ?, 'planned', 'public_smagning', datetime('now'))
    `).run(
        customerId, mt.id, dueAt, mt.duration_min,
        data.guest_count || null, data.event_type || null,
        data.message || null, ownerId
    );
    const activityId = Number(activityRes.lastInsertRowid);

    // 8. Opdatér token (hvis brugt)
    if (data.token) {
        db.prepare(`UPDATE booking_tokens SET booking_activity_id = ? WHERE token = ?`).run(activityId, data.token);
    }

    // 9. SSE broadcast
    broadcast('crm_activity_created', { activity_id: activityId, customer_id: customerId });

    // 10. Send bekræftelsesmail (fire-and-forget)
    const { sendFromTemplate } = require('../services/mailService');
    const vars = buildSmagningMailVars(customerId, companyId, mt, data);
    sendFromTemplate({
        templateKey: 'booking_smagning_confirmation',
        to: data.email,
        customerId,
        vars,
        context: { type: 'customer', number: customerId }
    }).catch(err => console.error('[booking-smagning] Mail fejl:', err.message));

    // 11. Send intern notifikation til ejer (hvis aktiveret)
    if (getSetting('booking_notify_owner_enabled') === '1' && ownerId) {
        sendInternalNotification(ownerId, 'smagning', { customerId, companyId, mt, data, activityId });
    }

    return { activityId, customerId };
}
```

### 5.3 Erindringsmail-cron

Ny fil: `scripts/booking-reminders.js`. Køres hver hverdag kl 09:00 via cron:

```javascript
// scripts/booking-reminders.js
// Køres af cron: 0 * * * *  (hver hele time, alle dage)
// Scriptet exit'er hvis settings siger fra eller hvis time ikke matcher.

const { openDb } = require('../db/compat');
const { sendFromTemplate } = require('../services/mailService');

async function main() {
    const db = openDb('./data/bon.db');

    // Settings læses live ved hver kørsel — UI-ændringer slår igennem næste time
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'booking_reminder_enabled'").get()?.value;
    if (enabled !== '1') {
        console.log('[reminder] Deaktiveret via settings');
        return;
    }

    const sendAtTime = db.prepare("SELECT value FROM settings WHERE key = 'booking_reminder_send_at_time'").get()?.value || '09:00';
    const targetHour = parseInt(sendAtTime.split(':')[0]);
    const nowHour = new Date().getHours();
    if (nowHour !== targetHour) {
        // Forkert time — exit stille (cron kører hver time)
        return;
    }

    const daysBefore = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'booking_reminder_days_before'").get()?.value || '2');

    // Find møder der er N dage frem fra i dag, ikke aflyst, ikke allerede mindet om
    const targetDate = new Date(Date.now() + daysBefore * 86400000).toISOString().slice(0, 10);

    const meetings = db.prepare(`
        SELECT a.id, a.due_at, a.duration_min, a.customer_id,
               c.first_name, c.last_name, c.email,
               mt.label AS meeting_label, mt.key AS meeting_key
        FROM crm_activities a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN meeting_types mt ON mt.id = a.meeting_type_id
        WHERE a.type = 'meeting'
          AND DATE(a.due_at) = ?
          AND a.outcome = 'planned'
          AND a.reminder_sent_at IS NULL
          AND c.email IS NOT NULL AND c.email != ''
    `).all(targetDate);

    console.log(`[reminder] ${meetings.length} møder at minde om for ${targetDate}`);

    for (const m of meetings) {
        try {
            const vars = buildReminderVars(m);
            await sendFromTemplate({
                templateKey: 'booking_smagning_reminder',
                to: m.email,
                customerId: m.customer_id,
                vars,
                context: { type: 'customer', number: m.customer_id }
            });
            db.prepare(`UPDATE crm_activities SET reminder_sent_at = datetime('now') WHERE id = ?`).run(m.id);
            console.log(`[reminder] Sendt til ${m.email} (activity ${m.id})`);
        } catch (err) {
            console.error(`[reminder] Fejl ved activity ${m.id}:`, err.message);
        }
    }

    db.close();
}

if (require.main === module) main();
```

Cron-config (cron eller systemd-timer): `0 * * * * cd /opt/bon-v2 && node scripts/booking-reminders.js >> logs/reminders.log 2>&1`

Bemærk: kører hver hele time, men scriptet exit'er hvis nuværende time ikke matcher `booking_reminder_send_at_time` i settings — det giver UI-fleksibilitet uden cron-redeploy.

---

## 6. Settings UI — to nye sektioner

Tilføjes i `settings/index.html` sidebar (under admin-only):

```html
<button class="st-nav-item st-admin-only" data-section="booking-smagning">Booking — Smagsprøve</button>
<button class="st-nav-item st-admin-only" data-section="booking-kontakt">Booking — Kontakt</button>
```

### 6.1 Sektion: Booking — Smagsprøve

Wireframe (følger eksisterende `st-mail-group`-mønster):

```
┌─ Booking — Smagsprøve ─────────────────────────────────────┐
│                                                             │
│ ☐ Aktivér smagsprøve-booking-side                          │
│   URL: https://bon.ristetrug.dk/tools/booking-smagning.html │
│                                                             │
├─ Mødetyper ────────────────────────────────────────────────┤
│  ┌────┬───────────────┬──────────────┬──────┬──────┬─────┐ │
│  │Ikon│Navn           │Nøgle         │Varigh│Aktiv │     │ │
│  ├────┼───────────────┼──────────────┼──────┼──────┼─────┤ │
│  │🍽️  │Smagning       │smagning      │ 45min│✓ Sys │ Ikon│ │
│  │📋  │Gennemgang     │gennemgang    │ 30min│✓ Sys │ Ikon│ │
│  │⭐  │Smagning + Gen │smagning_gen.. │ 75min│✓ Sys │ Ikon│ │
│  │💬  │Andet          │andet_moede   │ 30min│✓ Sys │ Ikon│ │
│  └────┴───────────────┴──────────────┴──────┴──────┴─────┘ │
│  [+ Ny mødetype]                                           │
│                                                             │
├─ Slot-logik ───────────────────────────────────────────────┤
│  Tidligste booking:           [ 2 ] dage frem               │
│  Seneste booking:             [ 90 ] dage frem              │
│  Spærrede ugedage: ☐Man ☐Tir ☐Ons ☐Tor ☐Fre ☐Lør ☑Søn   │
│  Arbejdstid:                  [ 09:00 ] – [ 16:30 ]        │
│  Slot-granularitet:           [ 30 ] min                   │
│  Buffer før event-levering:   [ 120 ] min                  │
│  Buffer efter event-levering: [ 60 ] min                   │
│                                                             │
├─ Standardejer ─────────────────────────────────────────────┤
│  Anonyme bookings tildeles:   [ Leif Hansen ▾ ]            │
│  Token-levetid:               [ 60 ] dage                  │
│                                                             │
├─ Erindringsmail ───────────────────────────────────────────┤
│  ☑ Send automatisk erindring før mødet                     │
│  Antal dage før mødet:        [ 2 ] dage                   │
│  Sendes på dagen kl:          [ 09:00 ]                    │
│  Skabelon: booking_smagning_reminder    [Redigér i Mail →] │
│                                                             │
├─ Sider og tekster ─────────────────────────────────────────┤
│  Intro-tekst (booking-side):  intro_smagning  [Redigér ▾] │
│  Takkeside efter booking:     thankyou_smagning [Red. ▾]  │
│                                                             │
├─ Mail-skabeloner ──────────────────────────────────────────┤
│  Bekræftelse: booking_smagning_confirmation [Redigér →]    │
│  Erindring:   booking_smagning_reminder [Redigér →]        │
│  Intern notif: booking_internal_notification [Redigér →]   │
│                                                             │
│                                       [Gem indstillinger]   │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Sektion: Booking — Kontakt

Tilsvarende men enklere (ingen kalender-logik):

```
┌─ Booking — Kontakt ────────────────────────────────────────┐
│                                                             │
│ ☐ Aktivér kontakt-formular                                 │
│   URL: https://bon.ristetrug.dk/tools/booking-kontakt.html  │
│                                                             │
├─ Kontaktårsager ───────────────────────────────────────────┤
│  ┌────┬───────────────────┬──────────────┬──────┬──────┐  │
│  │Ikon│Navn               │Nøgle         │Aktiv │      │  │
│  ├────┼───────────────────┼──────────────┼──────┼──────┤  │
│  │📞  │Ring mig op        │ring_op       │✓ Sys │ Ikon │  │
│  │📄  │Send mig en menu   │send_menu     │✓ Sys │ Ikon │  │
│  │💬  │Generel forespørgs.│generel_for...│✓ Sys │ Ikon │  │
│  └────┴───────────────────┴──────────────┴──────┴──────┘  │
│  [+ Ny kontaktårsag]                                       │
│                                                             │
├─ Sider og tekster ─────────────────────────────────────────┤
│  Intro-tekst:                 intro_kontakt   [Redigér ▾] │
│  Takkeside:                   thankyou_kontakt [Red. ▾]   │
│                                                             │
├─ Mail-skabeloner ──────────────────────────────────────────┤
│  Bekræftelse: booking_kontakt_confirmation  [Redigér →]    │
│  Intern notif: booking_internal_notification [Redigér →]   │
│                                                             │
│                                       [Gem indstillinger]   │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Page-template editor — pattern

Inline-expand under "Redigér"-knappen (genbruger `switchTemplate()`-mønstret fra mail-skabelon-editoren):

```
Intro-tekst (booking-side): intro_smagning [Skjul ▴]

  Label:    [ Intro-tekst — Smagning           ]
  Titel:    [ Book en smagning                  ]
  Brødtekst:
  ┌────────────────────────────────────────────────┐
  │ Vælg tid og dato — vi sørger for en personlig │
  │ gennemgang af vores catering-muligheder.       │
  │                                                 │
  │                                                 │
  └────────────────────────────────────────────────┘
  Variabler: {{firmaNavn}} {{firmaTelefon}}

  [Gem]                                  [Send test]
```

### 6.4 JS-implementation — genbrug af mønstre

```javascript
// I settings/index.html scripts:

async function loadBookingSmagning() {
    await loadSettings();
    var c = document.getElementById('booking-smagning-content');
    var html = '';

    // Master-toggle
    html += '<div class="st-mail-group">';
    html += bookingToggle('booking_smagning_enabled', 'Aktivér smagsprøve-booking-side');
    var url = (allSettings.booking_public_url_base || '') + '/tools/booking-smagning.html';
    html += '<div style="font-size:12px;color:var(--color-text-dim);margin-top:6px">URL: <a href="' + url + '" target="_blank">' + url + '</a></div>';
    html += '</div>';

    // Mødetyper-tabel (genbruger activity-purposes-mønstret)
    html += '<div class="st-mail-group"><h3>Mødetyper</h3>';
    html += '<table class="st-table" id="mt-table">';
    html += '<thead><tr><th>Ikon</th><th>Navn</th><th>Nøgle</th><th>Varighed</th><th>Aktiv</th><th></th></tr></thead>';
    html += '<tbody id="mt-body"></tbody></table>';
    html += '<button class="st-btn st-btn-primary" onclick="mtShowNew()" style="margin-top:8px">+ Ny mødetype</button>';
    html += '<div id="mt-new-form" style="display:none;margin-top:12px"></div>';
    html += '</div>';

    // Slot-logik
    html += '<div class="st-mail-group"><h3>Slot-logik</h3>';
    html += '<div class="st-mail-grid">';
    html += bookingNumber('booking_min_days_ahead', 'Tidligste booking', 'dage frem');
    html += bookingNumber('booking_max_days_ahead', 'Seneste booking', 'dage frem');
    html += bookingTime('booking_workday_start', 'Arbejdstid start');
    html += bookingTime('booking_workday_end', 'Arbejdstid slut');
    html += bookingNumber('booking_slot_step_min', 'Slot-granularitet', 'min');
    html += bookingNumber('booking_event_buffer_before_min', 'Buffer før event', 'min');
    html += bookingNumber('booking_event_buffer_after_min', 'Buffer efter event', 'min');
    html += bookingWeekdays('booking_blocked_weekdays', 'Spærrede ugedage');
    html += '</div>';
    html += '<button class="st-btn st-btn-primary st-btn-sm" onclick="saveBookingSmagningSettings()" style="margin-top:8px">Gem</button>';
    html += '</div>';

    // Erindringsmail
    html += '<div class="st-mail-group"><h3>Erindringsmail</h3>';
    html += bookingToggle('booking_reminder_enabled', 'Send automatisk erindring');
    html += '<div class="st-mail-grid" style="margin-top:8px">';
    html += bookingNumber('booking_reminder_days_before', 'Antal dage før', 'dage');
    html += bookingTime('booking_reminder_send_at_time', 'Sendes kl');
    html += '</div>';
    html += '<div style="margin-top:8px;font-size:13px">Skabelon: <code>booking_smagning_reminder</code> ';
    html += '<button class="st-btn st-btn-sm st-btn-secondary" onclick="jumpToTemplate(\'booking_smagning_reminder\')">Redigér i Mail</button></div>';
    html += '</div>';

    // Sider og tekster (page_templates)
    html += '<div class="st-mail-group"><h3>Sider og tekster</h3>';
    html += '<div id="page-tmpl-intro-smagning"></div>';
    html += '<div id="page-tmpl-thankyou-smagning" style="margin-top:12px"></div>';
    html += '</div>';

    c.innerHTML = html;

    loadMeetingTypes();
    loadPageTemplate('intro_smagning', 'page-tmpl-intro-smagning');
    loadPageTemplate('thankyou_smagning', 'page-tmpl-thankyou-smagning');
}

// loadMeetingTypes() — næsten 1:1 kopi af loadActivityPurposes()
// loadPageTemplate() — analog til switchTemplate() men med title+body, ingen subject
// jumpToTemplate(key) — switcher til Mail-fanen og vælger angivet skabelon
```

---

## 7. Offentlige sider — `tools/booking-smagning.html`

Vanilla HTML/CSS/JS. Følger `tools/bestilling__1_.html`-mønstret nøjagtigt.

### 7.1 Header-konstanter (CFG-objekt)

```javascript
const CFG = {
    apiBase:    '/api/booking',
    webhookUrl: '/webhook/booking-smagning',
    company:    'Ristet Rug',
    email:      'kontakt@ristetrug.dk'
};
```

### 7.2 UI-flow (3 trin på én side)

Trin 1 — vis fire mødetype-kort (data fra `GET /api/booking/meeting-types`):

```
┌─ Hvad vil du gerne booke? ───────────────────────────────┐
│  ┌────────────────┐ ┌────────────────┐                    │
│  │      🍽️         │ │      📋         │                    │
│  │   Smagning     │ │  Gennemgang    │                    │
│  │ Smag på vores… │ │ Planlæg dit ev.│                    │
│  │   ca. 45 min   │ │   ca. 30 min   │                    │
│  └────────────────┘ └────────────────┘                    │
│  ┌────────────────┐ ┌────────────────┐                    │
│  │      ⭐         │ │      💬         │                    │
│  │  Smagning +    │ │     Andet      │                    │
│  │  Gennemgang    │ │ Uforpligtende  │                    │
│  │   ca. 75 min   │ │   ca. 30 min   │                    │
│  └────────────────┘ └────────────────┘                    │
└──────────────────────────────────────────────────────────┘

┌─ Vælg dato ──────────────────────────────────────────────┐
│   ◀  april 2026  ▶                                       │
│  Man Tir Ons Tor Fre Lør Søn                             │
│             1   2   3   4   5                            │
│   6   7   8   9  10  11  12                             │
│  13  14  15  16  17  18  19                             │
│  20  21  22  23  24  25  26                             │
│  27 [28] 29  30                                          │
└──────────────────────────────────────────────────────────┘

┌─ Vælg tid ───────────────────────────────────────────────┐
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                  │
│  │  09:00   │ │  09:30   │ │  10:00   │                  │
│  └──────────┘ └──────────┘ └──────────┘                  │
│  ┌──────────────────────────────┐                         │
│  │       12:30 — Optaget         │                         │
│  │ Buffertid før event 13:30     │                         │
│  └──────────────────────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

Trin 2 — formular (vises efter dato+tid valgt):

Hvis `?t=token` i URL og token gyldig → felter pre-udfyldes via `GET /api/booking/token/:token`. Pre-udfyldte felter vises med subtle "Ret"-link øverst.

```
Fornavn:       [_________________]  *
Efternavn:     [_________________]
Email:         [_________________]  *
Telefon:       [_________________]
Firma:         [_________________]  (valgfri — privatkunde tom)
Antal gæster:  [- 0 +]
Eventtype:     [Vælg ▾] (Frokost/Reception/Bryllup/Andet)
Besked:        [____________________________________________]
               [____________________________________________]
               [____________________________________________]
                                        [Bekræft booking →]
```

Trin 3 — takkeside (skift af `<div>`):

Henter `GET /api/booking/page-templates/thankyou_smagning`, renderer titel + body med substitution af `{{kundeFornavn}}`, `{{datoFormatteret}}`, `{{tid}}`, etc.

### 7.3 Vigtigt: design matcher Bon v2 + `bestilling__1_.html`

```css
:root {
    --brand:       #8e631f;
    --brand-light: #f5eddd;
    --brand-dark:  #6b4a16;
    /* ... præcis som bestilling__1_.html */
}
```

Lato + Playfair Display fonts. Lys baggrund. Brun accent. **Ikke** det mørke design fra første mockup.

---

## 8. Offentlig side — `tools/booking-kontakt.html`

Endnu enklere. Ingen kalender. Bare et formular:

```
┌─ Kontakt os ─────────────────────────────────────────────┐
│ Send os en besked, så vender vi tilbage hurtigst muligt.  │
│                                                            │
│ Hvad drejer det sig om?                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │      📞       │ │      📄       │ │      💬       │       │
│  │ Ring mig op  │ │  Send menu   │ │  Generel     │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                            │
│ Fornavn:     [_________________]  *                       │
│ Efternavn:   [_________________]                          │
│ Email:       [_________________]  *                       │
│ Telefon:     [_________________]                          │
│ Firma:       [_________________]                          │
│ Besked:      [____________________________________________]│
│              [____________________________________________]│
│                                                            │
│                                          [Send besked →]   │
└──────────────────────────────────────────────────────────┘
```

Submit til `POST /webhook/booking-kontakt`. Resulterer i `crm_activity` med:
- `type='task'`
- `contact_reason_id=...`
- `outcome='callback'` (hvis "Ring mig op") eller `'planned'` (andre)
- `due_at=NULL` for tasks uden specifik tid → dukker op på dagens "Ring tilbage"-liste

---

## 9. Dataflow når token-mail → booking

```
1. Leif sender CRM-mail fra kunde 360° med {{booking_link}}
   ↓
2. mailService.renderTemplate() ser variablen
   ↓
3. generateBookingToken({customer_id: 123, sales_user_id: 1, flow: 'smagning', intent: 'smagning'})
   → INSERT booking_tokens(token='k7Hx9mQ2', expires_at=+60d)
   ↓
4. URL erstattes: https://bon.ristetrug.dk/tools/booking-smagning.html?t=k7Hx9mQ2
   ↓
5. Kunde Mette modtager mail, klikker link
   ↓
6. Browser → tools/booking-smagning.html?t=k7Hx9mQ2
   ↓
7. JS kalder GET /api/booking/token/k7Hx9mQ2
   → Bumper open_count, sætter opened_at hvis NULL
   → Returnerer { customer:{...}, intent_meeting_type:'smagning', sales_user:{...} }
   ↓
8. Smagning forvalgt; navn/email pre-udfyldt; Mette vælger tid
   ↓
9. POST /webhook/booking-smagning {token: 'k7Hx9mQ2', date, time, ...}
   ↓
10. handleSmagningBooking() opretter crm_activity med owner=Leif (fra token)
    UPDATE booking_tokens SET booking_activity_id = ?
    Sender booking_smagning_confirmation til Mette
    Sender booking_internal_notification til Leif
   ↓
11. SSE broadcaster crm_activity_created → Leifs office-view viser nyt møde live
   ↓
12. To dage før mødet (cron 09:00):
    booking-reminders.js finder Mettes møde, sender booking_smagning_reminder
    UPDATE crm_activities SET reminder_sent_at = ...
```

---

## 10. Filer der skal oprettes/ændres

```
db/migrations/051_booking.sql              ← NY (alt skema, seeds)

routes/booking.js                          ← NY (alle endpoints)
services/mailService.js                    ← UDVIDES ({{booking_link}}, generateBookingToken)
services/bookingMatcher.js                 ← NY (matchOrCreateCustomer, slot-beregning)

tools/booking-smagning.html                ← NY (Flow A frontend)
tools/booking-kontakt.html                 ← NY (Flow B frontend)

scripts/booking-reminders.js               ← NY (cron-job)

settings/index.html                        ← UDVIDES (2 nye sektioner + page_templates UI)
shared/api.js                              ← UDVIDES (~10 nye wrapper-funktioner)

office/views/crm-kunde360.js               ← UDVIDES (Indsæt booking-link knap)
office/views/crm-dashboard.js              ← UDVIDES (3 nye briefing-punkter)

server.js                                  ← UDVIDES (mount /api/booking, /webhook/booking-*)
```

Ingen nye npm-pakker. `crypto` er Node-built-in.

---

## 11. Implementeringsrækkefølge — 6 dages plan

| Dag | Opgave | Verifikation |
|-----|--------|--------------|
| 1 | Migration 051 + `routes/booking.js` med meeting-types/contact-reasons/page-templates endpoints + admin-CRUD | curl tester at typer kan oprettes/redigeres/slettes |
| 1 | Settings UI: Booking — Smagsprøve sektion (mødetyper-CRUD, slot-config) | Manual test via UI |
| 2 | `routes/booking.js` slots-endpoint + `services/bookingMatcher.js` | curl /api/booking/slots returnerer korrekte tider for testdato |
| 2 | `tools/booking-smagning.html` med kalender + slot-visning + form (uden token endnu) | Manual booking opretter crm_activity |
| 3 | Mail-skabeloner seedes; `mailService.js` udvides med `{{booking_link}}` rendering + `generateBookingToken` | Send test-mail med skabelon → URL renderes korrekt |
| 3 | Token-system: `GET /api/booking/token/:token` + pre-fill i tools/booking-smagning.html | Generér token → åbn link → felter pre-udfyldes |
| 4 | `tools/booking-kontakt.html` + `POST /webhook/booking-kontakt` + Settings UI: Booking — Kontakt sektion | Manual test |
| 4 | "Indsæt booking-link"-knap i CRM Kunde 360° mail-compose | Skriv mail → indsæt link → modtagne mail har korrekt URL |
| 5 | `scripts/booking-reminders.js` + cron-konfiguration | Test ved at sætte due_at = i dag + N, kør script manuelt |
| 5 | Daily-briefing-tilføjelser (3 nye punkter: åbnet-ej-booket, nye møder, behøver review) | Briefing viser realistisk data |
| 6 | Page-template editor i Settings (intro + thankyou redigering) + render i offentlige sider | Redigér thankyou_smagning → ny tekst vises |
| 6 | Edge-cases: race-condition slot-tjek, dobbelt-booking, abused tokens | Pen-test |

---

## 12. Bevidste fravalg (forklaret)

| Fravalgt | Hvorfor |
|----------|---------|
| HTML-mails med pæne knapper | `mail_templates.body_text` er plain text. `{{booking_link}}` som ren URL er ærlig og virker i alle klienter. |
| iCal-vedhæftning | Plain-text mail med dato/tid + adresse er nok. Tilføjes hvis efterspurgt. |
| SMS-bekræftelse | Kræver SMS-gateway. Mail dækker. |
| Aflys-link i mail | Kunden kan svare på mailen → kontakt@-IMAP fanger det. Aflys-knap = fase 2. |
| Reschedule-flow | Samme. |
| CAPTCHA | Honeypot er nok. |
| Per-bruger booking-slugs (`/book/leif`) | Token-link gør samme job mere fleksibelt. |
| Multi-language | Dansk only. |
| Google Calendar-integration | Interne CRM-meetings + bons-events er nok som første version. Fase 2 hvis ferier ikke bliver fanget. |
| Per-mødetype erindrings-toggle | Variant 2 valgt: én global indstilling. Hvis behov senere → tilføj `meeting_types.send_reminder`-kolonne. |
| Multipel reminder-regler (1 uge + 1 dag) | Variant 2 valgt: én reminder. |

---

## 13. Eksempel: hele flowet med tre brugerinteraktioner

### Eksempel 1: Cold lead via hjemmesiden
```
Kunde finder bon.ristetrug.dk/book på website → vælger Smagning →
onsdag 14:30 → udfylder formular → klikker bekræft →
crm_activity oprettes med owner=Leif (default), source='public_smagning' →
Mette får booking_smagning_confirmation →
Leif får booking_internal_notification →
2 dage før mødet får Mette booking_smagning_reminder
```

### Eksempel 2: Warm lead via Leifs mail
```
Leif skriver mail i CRM Kunde 360° → klikker "Indsæt booking-link" →
vælger flow=Smagsprøve, intent=Smagning → klikker Indsæt → {{booking_link}} indsat →
sender mail → Mette modtager mail med URL →
klikker URL → siden viser Mettes navn + Smagning forvalgt →
hun vælger tid → bekræfter → activity oprettes med owner=Leif (fra token) →
ingen intern notif (Leif vidste om den) →
samme erindringsflow
```

### Eksempel 3: Hurtig kontakt-anmodning
```
Kunde besøger bon.ristetrug.dk/tools/booking-kontakt.html →
vælger "Ring mig op" → udfylder navn+telefon+besked →
crm_activity oprettes som type='task', outcome='callback', contact_reason='ring_op' →
Kunde får booking_kontakt_confirmation →
Leif får booking_internal_notification →
Tasken dukker op på dagens "Ring tilbage"-liste i CRM
```

---

## 14. Beslutninger (besluttet april 2026)

### 14.1 Cron + UI-styring af erindringsmail

`scripts/booking-reminders.js` køres som cron-job. Selve cron-jobbet kører altid, men erindringerne kan slås fra eller justeres uden kode-ændringer via Settings → Booking — Smagsprøve → Erindringsmail. Når toggle slås fra, exit'er scriptet med det samme:

```javascript
// scripts/booking-reminders.js — første tjek
if (db.prepare("SELECT value FROM settings WHERE key = 'booking_reminder_enabled'").get()?.value !== '1') {
    console.log('[reminder] Deaktiveret via settings');
    return;
}
```

`booking_reminder_days_before` og `booking_reminder_send_at_time` læses live fra settings ved hver kørsel — UI-ændringer slår igennem næste morgen uden deploy.

**Cron-konfiguration** (DevOps-opgave ved deploy):
```
# /etc/crontab
0 * * * * bon-user cd /opt/bon-v2 && node scripts/booking-reminders.js >> /var/log/bon-v2/reminders.log 2>&1
```

Kører hver hele time. Scriptet tjekker selv om `booking_reminder_send_at_time` matcher nuværende time (HH); hvis ikke, exit. Det giver UI-fleksibilitet uden cron-redeploy.

### 14.2 Page-templates seedes i migration 051

Default-værdierne for `thankyou_smagning`, `thankyou_kontakt`, `intro_smagning`, `intro_kontakt` indsættes via `INSERT INTO page_templates ...` i migrationen (som allerede vist i sektion 2). Hvis admin redigerer dem og senere fortryder, kan default'ene gendannes ved at slette rækken (system_key) — men `is_system=1` rækker kan ikke slettes via UI. Til dette formål tilføjes:

```
POST /api/booking/page-templates/:key/reset    (admin) — gendanner default fra migration
```

UI: lille "↻ Gendan default"-knap i page-template editor, kun synlig for `is_system=1` skabeloner.

### 14.3 `{{booking_link}}` understøttes i ALLE skabeloner

Inkluderer `booking_kontakt_confirmation`. Tænkt brug: cross-sell — "Tak for henvendelsen om at få menuen tilsendt. Hvis du vil smage før du beslutter dig, kan du booke en smagning her: {{booking_link}}".

Implementering: `mailService.renderTemplate()` rammer ALLE skabeloner uanset key. Ingen særhåndtering pr. skabelon.

### 14.4 `booking_default_owner_user_id` SKAL være sat

Hvis `booking_default_owner_user_id` er tom i settings:
- Public endpoints `/webhook/booking-smagning` og `/webhook/booking-kontakt` returnerer **503 Service Unavailable** med besked "Booking-modulet er ikke fuldt konfigureret."
- Samme tjek på `GET /api/booking/meeting-types` og `GET /api/booking/contact-reasons` — så sider der renderes uden konfiguration ikke fejler stille.
- Settings UI viser **rød advarsel** øverst i Booking-sektionen hvis ejer ikke er valgt: "⚠️ Vælg en standardejer før modulet kan aktiveres for offentligheden."

Token-baserede bookings (med `?t=...`) bruger `sales_user_id` fra token og er ikke afhængige af default — de virker selv hvis default mangler. Men den offentlige formular uden token kræver det.

### 14.5 Spam-monitoring: log alt, blokér intet

Honeypot-tripper, ugyldige tokens, og rate-limit-overskridelser logges til `logs/booking-spam.log` med struktureret format:

```javascript
function logSpamEvent(type, data) {
    const entry = JSON.stringify({
        ts: new Date().toISOString(),
        type,           // 'honeypot' | 'invalid_token' | 'rate_limit'
        ip: data.ip,
        ua: data.userAgent,
        flow: data.flow,
        detail: data.detail
    });
    fs.appendFileSync('logs/booking-spam.log', entry + '\n');
}
```

Ingen automatisk blokering. Hvis loggen viser et mønster (samme IP > 50 hits/dag, eller honeypot > 100/dag), kan vi tilføje en blokering manuelt. Til at starte med er det rigeligt at vide.

**IP-rate-limit som blød grænse**: Webhook-endpoints får simpel in-memory counter — max 10 submits per IP per time. Overskridelse → log + returnér success (lure spammer) men opret ikke booking. Reset hver time. Brug eksisterende mønster fra evt. andre route-filer hvis det findes.
