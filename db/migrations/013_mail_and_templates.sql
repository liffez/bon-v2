-- ==========================================
-- 013_mail_and_templates.sql
-- Mail-skabeloner, kunde-mails, mail-settings
-- ==========================================

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

-- Settings seed: formbuilder field map
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('formbuilder_field_map', '{"f2":"customer_name","f3":"customer_email","f4":"customer_phone","f5":"company_name","f7_date":"delivery_date","f7_time":"delivery_time","f8":"pax","f9":"customer_wishes","f11_navn":"day_contact_name","f11_tlf":"day_contact_phone","f12":"invoice_info"}', 'Mapping fra formular-felter til bon-felter (JSON)');

-- Settings seed: session varighed
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('session_duration_office',  '7',  'Session-varighed for kontor (dage)'),
    ('session_duration_kitchen', '30', 'Session-varighed for køkken (dage)');
