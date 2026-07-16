-- ==========================================
-- 001_core.sql
-- Kernetabeller: settings, users, status-system,
-- adresser, lokationer, priskategorier,
-- companies, customers
-- ==========================================

-- ==========================================
-- SETTINGS
-- ==========================================

CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- USERS
-- ==========================================

CREATE TABLE users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    email           TEXT UNIQUE,
    password_hash   TEXT,
    role            TEXT NOT NULL DEFAULT 'kitchen'
                    CHECK (role IN ('admin', 'office', 'kitchen', 'delivery')),
    pin             TEXT,           -- Simpel tablet-login til køkkenet
    smartplan_id    TEXT,           -- Kobling til Smartplan API
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- STATUS-SYSTEM (konfigurérbart)
-- ==========================================

CREATE TABLE status_definitions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT NOT NULL UNIQUE,   -- Fast kode brugt i app-logik
    label           TEXT NOT NULL,          -- Visningsnavn (kan ændres)
    color           TEXT,                   -- Hex farve
    icon            TEXT,                   -- Emoji eller ikon-navn
    sort_order      INTEGER NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    is_terminal     INTEGER NOT NULL DEFAULT 0,
    category        TEXT NOT NULL DEFAULT 'normal'
                    CHECK (category IN ('normal', 'terminal', 'cancel'))
);

CREATE TABLE status_transitions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_status_id          INTEGER NOT NULL REFERENCES status_definitions(id),
    to_status_id            INTEGER NOT NULL REFERENCES status_definitions(id),
    is_active               INTEGER NOT NULL DEFAULT 1,
    requires_confirmation   INTEGER NOT NULL DEFAULT 0,
    confirmation_message    TEXT,
    triggers_json           TEXT,           -- JSON array af trigger-typer
    UNIQUE(from_status_id, to_status_id)
);

-- ==========================================
-- ADRESSER
-- ==========================================
-- Central adressetabel. Bruges af companies og
-- som leveringsadresser på bonner.
-- Geocoding gemmes her så opslag kun sker én gang.

CREATE TABLE addresses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT,               -- "Indgang B", "Kantinen" osv.
    street_name     TEXT,
    street_name2    TEXT,
    street_nr       TEXT,
    postal_code     TEXT,
    city            TEXT,
    lat             REAL,               -- Geocodet breddegrad
    lon             REAL,               -- Geocodet længdegrad
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- LOKATIONER
-- ==========================================
-- HQ, Trailer, Test — hver med sin Grocy-forbindelse

CREATE TABLE locations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    code            TEXT NOT NULL UNIQUE,
    grocy_api_url   TEXT,
    grocy_api_key   TEXT,
    address         TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- PRISKATEGORIER
-- ==========================================
-- Samme ret kan have forskellig pris afhængigt
-- af kontekst (catering vs. festival vs. intern)

CREATE TABLE price_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE item_prices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id             INTEGER NOT NULL,   -- Grocy product_id eller lokal item_id
    price_category_id   INTEGER NOT NULL REFERENCES price_categories(id),
    price               REAL NOT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(item_id, price_category_id)
);

-- ==========================================
-- COMPANIES (firmaer)
-- ==========================================

CREATE TABLE companies (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    cvr                         TEXT,
    ean                         TEXT,
    economic_customer_id        TEXT,       -- e-conomic integration
    address_id                  INTEGER REFERENCES addresses(id),
    phone                       TEXT,
    email                       TEXT,
    invoice_email               TEXT,
    invoice_method              TEXT
                                CHECK (invoice_method IN ('email', 'ean', 'portal')),
    default_payment_type        TEXT
                                CHECK (default_payment_type IN
                                    ('invoice', 'card', 'mobilepay', 'cash', 'pos')),
    discount_percent            REAL,
    default_price_category_id   INTEGER REFERENCES price_categories(id),
    notes                       TEXT,
    is_active                   INTEGER NOT NULL DEFAULT 1,
    created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_companies_cvr ON companies(cvr);
CREATE INDEX idx_companies_ean ON companies(ean);

-- ==========================================
-- CUSTOMERS (kontaktpersoner)
-- ==========================================

CREATE TABLE customers (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id              INTEGER REFERENCES companies(id),
    first_name              TEXT NOT NULL,
    last_name               TEXT,
    phone                   TEXT,
    email                   TEXT,
    economic_contact_id     TEXT,   -- e-conomic kontakt-ID
    economic_customer_id    TEXT,   -- e-conomic kunde-ID (privatkunder)
    is_primary_contact      INTEGER NOT NULL DEFAULT 0,
    notes                   TEXT,
    is_active               INTEGER NOT NULL DEFAULT 1,
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_customers_email ON customers(email);

-- ==========================================
-- SEED: Settings
-- ==========================================

INSERT INTO settings (key, value, description) VALUES
    ('bon_number_prefix',       '',             'Præfiks for bon-numre (tomt = kun tal)'),
    ('bon_number_next',         '3260',         'Næste bon-nummer'),
    ('quote_number_prefix',     'T-',           'Præfiks for tilbudsnumre'),
    ('quote_number_next',       '1',            'Næste tilbudsnummer'),
    ('company_name',            'Ristet Rug',   'Firmanavn'),
    ('default_delivery_type',   'delivery',     'Standard leveringstype'),
    ('default_pax_per_box',     '16',           'Antal pax per transportkasse'),
    ('inventory_auto_deduct',   '0',            '1 = træk automatisk fra lager ved LEVERET'),
    ('kitchen_show_only_today', '1',            '1 = køkken ser kun dagens bonner'),
    ('mail_domain',             'ristetrug.dk', 'Mail-domæne til bon-korrespondance'),
    ('courier_default',         'byekspressen', 'Standard budfirma');

-- ==========================================
-- SEED: Lokationer
-- ==========================================

INSERT INTO locations (name, code, grocy_api_url, grocy_api_key, address, is_active) VALUES
    ('HQ',      'hq',      'https://grocy-hq.ristetrug.dk/api',     '', 'Hovedkontor',     1),
    ('Trailer', 'trailer', 'https://grocytrailer.ristetrug.dk/api', '', 'Festival-trailer',1),
    ('Test',    'test',    'https://grocytest.ristetrug.dk/api',    '', 'Testmiljø',        1);

-- Aktiv lokation for en FRISK database = Test (grocytest, id 3). Bevidst: en ny
-- installation må aldrig som default skrive i produktions-Grocy. Produktion
-- sætter selv HQ som aktiv via Settings → Grocy ("Sæt som aktiv").
INSERT INTO settings (key, value, description) VALUES
    ('default_grocy_location_id', '3', 'Aktiv Grocy-lokation (id i locations). Frisk DB = Test.');

-- ==========================================
-- SEED: Priskategorier
-- ==========================================

INSERT INTO price_categories (code, label, is_default, is_active) VALUES
    ('catering', 'Catering', 1, 1),
    ('festival', 'Festival', 0, 1);

-- ==========================================
-- SEED: Status-definitioner
-- ==========================================

INSERT INTO status_definitions (code, label, color, icon, sort_order, is_active, is_terminal, category) VALUES
    ('NY',          'Ny',           '#7594b3', '🆕', 10, 1, 0, 'normal'),
    ('VENTER',      'Venter info',  '#f1e6b2', '⏳', 20, 1, 0, 'normal'),
    ('GODKENDT',    'Godkendt',     '#7594b3', '✓',  30, 1, 0, 'normal'),
    ('IGANG',       'Igang',        '#e8a832', '🔥', 40, 1, 0, 'normal'),
    ('KLAR',        'Klar',         '#6ab04c', '✅', 50, 1, 0, 'normal'),
    ('LEVERET',     'Leveret',      '#8a8580', '🚚', 60, 1, 0, 'normal'),
    ('FAKTURERET',  'Faktureret',   '#9b59b6', '📄', 70, 1, 1, 'terminal'),
    ('BETALT',      'Betalt',       '#27ae60', '💰', 71, 1, 1, 'terminal'),
    ('AFSLUTTET',   'Afsluttet',    '#8a8580', '📁', 72, 1, 1, 'terminal'),
    ('AFLYST',      'Aflyst',       '#bc181b', '✖',  99, 1, 1, 'cancel');

-- ==========================================
-- SEED: Status-transitions
-- ==========================================

-- Fremad
INSERT INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json) VALUES
    ((SELECT id FROM status_definitions WHERE code='NY'),
     (SELECT id FROM status_definitions WHERE code='VENTER'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='NY'),
     (SELECT id FROM status_definitions WHERE code='GODKENDT'),
     1, 'Send bekræftelse til kunde? Er levering bestilt?',
     '["confirm_customer","check_delivery"]'),

    ((SELECT id FROM status_definitions WHERE code='VENTER'),
     (SELECT id FROM status_definitions WHERE code='GODKENDT'),
     1, 'Send bekræftelse til kunde? Er levering bestilt?',
     '["confirm_customer","check_delivery"]'),

    ((SELECT id FROM status_definitions WHERE code='GODKENDT'),
     (SELECT id FROM status_definitions WHERE code='IGANG'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='IGANG'),
     (SELECT id FROM status_definitions WHERE code='KLAR'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='IGANG'),
     (SELECT id FROM status_definitions WHERE code='LEVERET'),
     1, 'Spring KLAR over og markér som leveret?',
     '["offer_undo","deduct_inventory"]'),

    ((SELECT id FROM status_definitions WHERE code='KLAR'),
     (SELECT id FROM status_definitions WHERE code='LEVERET'),
     1, 'Træk varer fra lager?',
     '["offer_undo","deduct_inventory"]'),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='FAKTURERET'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='BETALT'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='AFSLUTTET'),
     1, 'Markér som afsluttet uden betaling?', NULL);

-- Aflyst (fra alle normale statusser)
INSERT INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json) VALUES
    ((SELECT id FROM status_definitions WHERE code='NY'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Er du sikker? Bonnen aflyses.', NULL),

    ((SELECT id FROM status_definitions WHERE code='VENTER'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Er du sikker? Bonnen aflyses.', NULL),

    ((SELECT id FROM status_definitions WHERE code='GODKENDT'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Bonnen aflyses. Skal levering afbestilles?', '["cancel_delivery"]'),

    ((SELECT id FROM status_definitions WHERE code='IGANG'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Bonnen er igang. Afbestil levering?', '["cancel_delivery"]'),

    ((SELECT id FROM status_definitions WHERE code='KLAR'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Maden er klar. Afbestil levering?', '["cancel_delivery"]'),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='AFLYST'),
     1, 'Maden er leveret. Tilbagefør lagertræk?', '["reverse_inventory"]');

-- Baglæns
INSERT INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json) VALUES
    ((SELECT id FROM status_definitions WHERE code='GODKENDT'),
     (SELECT id FROM status_definitions WHERE code='VENTER'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='IGANG'),
     (SELECT id FROM status_definitions WHERE code='GODKENDT'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='KLAR'),
     (SELECT id FROM status_definitions WHERE code='IGANG'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='KLAR'),
     1, 'Fortryd levering? Tilbagefør lagertræk?', '["reverse_inventory"]'),

    ((SELECT id FROM status_definitions WHERE code='LEVERET'),
     (SELECT id FROM status_definitions WHERE code='IGANG'),
     1, 'Fortryd levering og sæt tilbage til igang?', '["reverse_inventory"]');

-- Terminal → Afsluttet
INSERT INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message) VALUES
    ((SELECT id FROM status_definitions WHERE code='FAKTURERET'),
     (SELECT id FROM status_definitions WHERE code='AFSLUTTET'),
     1, 'Afslut uden betaling?');
