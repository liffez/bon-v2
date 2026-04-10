-- 032: Udvid integration_type CHECK med 'intern' for RR Produktion
-- SQLite kan ikke ALTER CHECK constraints, så vi genskaber tabellen

PRAGMA foreign_keys = OFF;

-- 1. Gem eksisterende data
CREATE TABLE _suppliers_backup AS SELECT * FROM suppliers;

-- 2. Drop og genskab med udvidet CHECK
DROP TABLE suppliers;

CREATE TABLE suppliers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    contact_email       TEXT,
    contact_phone       TEXT,
    integration_type    TEXT NOT NULL DEFAULT 'manual'
                        CHECK (integration_type IN ('api', 'form', 'email', 'manual', 'webshop', 'intern')),
    api_config_json     TEXT,
    notes               TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    webshop_url         TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Gendan data
INSERT INTO suppliers SELECT * FROM _suppliers_backup;
DROP TABLE _suppliers_backup;

-- 4. Opret RR Produktion som intern leverandør (hvis ikke allerede eksisterer)
INSERT OR IGNORE INTO suppliers (name, integration_type, notes)
    SELECT 'RR Produktion', 'intern', 'Intern produktion — opskrifter i Grocy'
    WHERE NOT EXISTS (SELECT 1 FROM suppliers WHERE name = 'RR Produktion');

-- 5. Kobl RR Produktion til Grocy shopping_location 6 (RR Produktion)
INSERT OR IGNORE INTO supplier_grocy_locations (supplier_id, grocy_location_id, display_name)
    SELECT s.id, 6, 'RR Produktion'
    FROM suppliers s
    WHERE s.name = 'RR Produktion'
    AND NOT EXISTS (
        SELECT 1 FROM supplier_grocy_locations
        WHERE supplier_id = s.id AND grocy_location_id = 6
    );

PRAGMA foreign_keys = ON;
