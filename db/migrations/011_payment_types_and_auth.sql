-- ==========================================
-- PAYMENT TYPES (ny tabel)
-- ==========================================

CREATE TABLE IF NOT EXISTS payment_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO payment_types (code, label, sort_order) VALUES
    ('invoice',   'Faktura',    1),
    ('card',      'Kort',       2),
    ('mobilepay', 'MobilePay',  3),
    ('cash',      'Kontant',    4),
    ('pos',       'POS/Zettle', 5);

-- ==========================================
-- SEED: startbrugere
-- Passwords sættes via script — se scripts/set-password.js
-- ==========================================

INSERT OR IGNORE INTO users (name, email, role, is_active)
VALUES ('Admin', 'admin@ristetrug.dk', 'admin', 1);

INSERT OR IGNORE INTO users (name, email, role, pin, is_active)
VALUES ('Køkken', 'kitchen@ristetrug.dk', 'kitchen', '1234', 1);

-- ==========================================
-- SETTINGS: session-varighed per rolle
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('session_days_kitchen',  '365', 'Session-varighed i dage for kitchen-rolle'),
    ('session_days_office',   '30',  'Session-varighed i dage for office-rolle'),
    ('session_days_admin',    '30',  'Session-varighed i dage for admin-rolle'),
    ('session_days_delivery', '30',  'Session-varighed i dage for delivery-rolle');
