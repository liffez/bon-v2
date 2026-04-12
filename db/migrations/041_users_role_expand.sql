-- 041_users_role_expand.sql
-- Udvid role-constraint med 'kitchen_personal' + tilføj modules_json

PRAGMA foreign_keys = OFF;

-- Drop views der refererer users (genskabes nedenfor)
DROP VIEW IF EXISTS v_active_notifications;
DROP VIEW IF EXISTS v_my_tasks_today;

CREATE TABLE users_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    email            TEXT UNIQUE,
    password_hash    TEXT,
    role             TEXT NOT NULL DEFAULT 'kitchen'
                         CHECK (role IN ('admin','office','kitchen','kitchen_personal','delivery')),
    pin              TEXT,
    smartplan_id     TEXT,
    modules_json     TEXT DEFAULT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new (id, name, email, password_hash, role, pin, smartplan_id, modules_json, is_active, created_at, updated_at)
    SELECT id, name, email, password_hash, role, pin, smartplan_id, NULL, is_active, created_at, updated_at
    FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Genskab views
CREATE VIEW IF NOT EXISTS v_active_notifications AS
SELECT
    n.id,
    n.bon_id,
    b.bon_number,
    n.type,
    n.message,
    n.priority,
    n.created_at,
    n.sent_by_user_id,
    u.name AS sent_by_name
FROM notifications n
LEFT JOIN bons b ON n.bon_id = b.id
LEFT JOIN users u ON n.sent_by_user_id = u.id
ORDER BY n.created_at DESC;

PRAGMA foreign_keys = ON;

-- Session-varighed for ny rolle
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('session_days_kitchen_personal', '30', 'Session-varighed for personlige køkken-brugere (dage)');

-- Rollerettigheder — én JSON-blob per rolle
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('role_permissions_admin',
     '{"crm":true,"tilbud":true,"okonomi":true,"rapporter":true,"settings":true,"modtag":true}',
     'Moduladgang for admin-rolle'),
    ('role_permissions_office',
     '{"crm":true,"tilbud":true,"okonomi":true,"rapporter":true,"settings":false,"modtag":true}',
     'Moduladgang for office-rolle'),
    ('role_permissions_kitchen',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":true}',
     'Moduladgang for kitchen-rolle'),
    ('role_permissions_kitchen_personal',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":false}',
     'Moduladgang for kitchen_personal-rolle'),
    ('role_permissions_delivery',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":false}',
     'Moduladgang for delivery-rolle');
