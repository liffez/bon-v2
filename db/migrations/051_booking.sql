-- ==========================================
-- 051_booking.sql
-- Booking-modul (Fase 14):
--   - meeting_types (Flow A: smagsprøve)
--   - contact_reasons (Flow B: kontakt)
--   - booking_tokens (mail-link tokens)
--   - page_templates (takkesider, intro-tekster)
--   - kolonner på crm_activities
--   - mail-skabeloner (booking_smagning_*, booking_kontakt_*, booking_internal_*)
--   - booking-settings
--
-- VIGTIGT: bruger crm_activities.done_at IS NULL som "planlagt"
-- og result='callback' for ring-tilbage-tasks (matcher 019-skema og
-- v_callbacks_pending). Tilføjer IKKE en outcome-kolonne.
-- ==========================================

-- ==========================================
-- MEETING TYPES (Flow A — konfigurerbar)
-- Mønster: kopi af activity_purposes (048).
-- Adskilt fra activity_purposes — purpose er "hvorfor",
-- meeting_type er "hvad/varighed".
-- ==========================================
CREATE TABLE IF NOT EXISTS meeting_types (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    emoji        TEXT,
    description  TEXT,
    duration_min INTEGER NOT NULL DEFAULT 30,
    is_bookable  INTEGER NOT NULL DEFAULT 1,
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
-- CONTACT REASONS (Flow B — konfigurerbar)
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
    ('ring_op',        'Ring mig op',          '📞', 'Specifikt request om opkald',  1, 10),
    ('send_menu',      'Send mig en menu',     '📄', 'Modtag info om vores menuer',  1, 20),
    ('generel_forspg', 'Generel forespørgsel', '💬', 'Uforpligtende spørgsmål',      1, 30);

-- ==========================================
-- BOOKING-FELTER på crm_activities
-- (purpose_id eksisterer allerede fra 048)
-- ==========================================
ALTER TABLE crm_activities ADD COLUMN meeting_type_id     INTEGER REFERENCES meeting_types(id);
ALTER TABLE crm_activities ADD COLUMN contact_reason_id   INTEGER REFERENCES contact_reasons(id);
ALTER TABLE crm_activities ADD COLUMN duration_min        INTEGER;
ALTER TABLE crm_activities ADD COLUMN guest_count         INTEGER;
ALTER TABLE crm_activities ADD COLUMN event_type          TEXT;
ALTER TABLE crm_activities ADD COLUMN booked_via          TEXT;  -- 'public_smagning'|'public_kontakt'|'token_link'|'internal'
ALTER TABLE crm_activities ADD COLUMN reminder_sent_at    DATETIME;

CREATE INDEX IF NOT EXISTS idx_crm_act_meeting_type ON crm_activities(meeting_type_id);
CREATE INDEX IF NOT EXISTS idx_crm_act_due_planned  ON crm_activities(due_at)
    WHERE type = 'meeting' AND done_at IS NULL;

-- ==========================================
-- BOOKING TOKENS
-- ==========================================
CREATE TABLE IF NOT EXISTS booking_tokens (
    token                  TEXT PRIMARY KEY,
    customer_id            INTEGER REFERENCES customers(id),
    company_id             INTEGER REFERENCES companies(id),
    sales_user_id          INTEGER REFERENCES users(id),
    flow                   TEXT NOT NULL DEFAULT 'smagning',  -- 'smagning' eller 'kontakt'
    intent_meeting_type_id INTEGER REFERENCES meeting_types(id),
    intent_purpose_id      INTEGER REFERENCES activity_purposes(id),
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at             DATETIME NOT NULL,
    opened_at              DATETIME,
    open_count             INTEGER NOT NULL DEFAULT 0,
    booking_activity_id    INTEGER REFERENCES crm_activities(id),
    notes                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_booking_tokens_customer ON booking_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_booking_tokens_expires  ON booking_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_booking_tokens_idem
    ON booking_tokens(customer_id, sales_user_id, flow, intent_meeting_type_id)
    WHERE booking_activity_id IS NULL;

-- ==========================================
-- PAGE TEMPLATES (takkesider, intro-tekster)
-- Analog til mail_templates, men uden subject — title + body_text.
-- ==========================================
CREATE TABLE IF NOT EXISTS page_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    title       TEXT,
    body_text   TEXT,
    is_system   INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO page_templates (key, label, title, body_text, is_system) VALUES
    ('thankyou_smagning',
     'Takkeside — Smagning',
     'Tak {{kundeFornavn}}!',
     'Vi glæder os til at se dig {{datoFormatteret}} kl {{tid}}.

Mødetype: {{moedeTypeLabel}} ({{varighed}} min)
Adresse: {{firmaAdresse}}

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
    -- Master-toggles
    ('booking_smagning_enabled',         '0',     'Aktivér smagsprøve-booking-side'),
    ('booking_kontakt_enabled',          '0',     'Aktivér kontakt-formular'),

    -- Slot-logik
    ('booking_min_days_ahead',           '2',     'Tidligste booking-dato (dage frem)'),
    ('booking_max_days_ahead',           '90',    'Seneste booking-dato (dage frem)'),
    ('booking_blocked_weekdays',         '[0]',   'JSON-array: 0=søndag, 6=lørdag'),
    ('booking_workday_start',            '09:00', 'Tidligste mødetid'),
    ('booking_workday_end',              '16:30', 'Seneste mødestart'),
    ('booking_slot_step_min',            '30',    'Slot-granularitet (min)'),
    ('booking_event_buffer_before_min',  '120',   'Buffertid før event-leveringer (min)'),
    ('booking_event_buffer_after_min',   '60',    'Buffertid efter event-leveringer (min)'),

    -- Ejer + tokens
    ('booking_default_owner_user_id',    '',      'Bruger der får anonyme bookings (krævet før public-flow virker)'),
    ('booking_token_ttl_days',           '60',    'Token-levetid i dage'),
    ('booking_token_reuse_min_days',     '7',     'Genbrug eksisterende token hvis udløb > N dage'),
    ('booking_public_url_base',          '',      'Fx https://bon.ristetrug.dk — bruges i {{booking_link}}'),

    -- Erindringsmail
    ('booking_reminder_enabled',         '1',     'Send automatisk erindringsmail før møde'),
    ('booking_reminder_days_before',     '2',     'Antal dage før mødet'),
    ('booking_reminder_send_at_time',    '09:00', 'Klokkeslæt på dagen erindringen sendes (cron matcher mod denne time)'),

    -- Notifikation til sælger
    ('booking_notify_owner_enabled',     '1',     'Send intern notifikations-mail til sælger ved ny booking');

-- ==========================================
-- MAIL-SKABELONER
-- ==========================================
INSERT OR IGNORE INTO mail_templates (key, label, subject, body_text) VALUES
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
