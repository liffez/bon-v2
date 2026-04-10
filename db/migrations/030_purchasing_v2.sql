-- ==========================================
-- 030_purchasing_v2.sql
-- Leverandør ↔ Grocy shopping_locations kobling
-- + webshop-integration + grocy-referencer på ordrelinjer
-- ==========================================

-- ══════════════════════════════════════════════════════════════
-- LEVERANDØR ↔ GROCY SHOPPING_LOCATIONS
-- ══════════════════════════════════════════════════════════════
--
-- En leverandør (fx Inco) kan have FLERE handelssteder i Grocy
-- (fx "Inco Valby" og "Inco Frederiksberg").
-- Grocy shopping_locations er autoriteten — Bon v2 tilføjer
-- forretningsinformation ovenpå.
--
-- Brugeren linker Grocy shopping_locations til v2 suppliers
-- via bestillings-tabbens inline setup-bar.

CREATE TABLE IF NOT EXISTS supplier_grocy_locations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id         INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    grocy_location_id   INTEGER NOT NULL,   -- shopping_locations.id i Grocy
    display_name        TEXT,               -- Valgfri override af Grocy-navn
    UNIQUE (grocy_location_id)
);

CREATE INDEX IF NOT EXISTS idx_sgl_supplier ON supplier_grocy_locations(supplier_id);

-- ══════════════════════════════════════════════════════════════
-- SUPPLIERS: tilføj webshop_url
-- ══════════════════════════════════════════════════════════════

ALTER TABLE suppliers ADD COLUMN webshop_url TEXT;

-- ══════════════════════════════════════════════════════════════
-- SUPPLIERS: udvid integration_type CHECK med 'webshop'
-- SQLite kan ikke ALTER CHECK — vi recreater tabellen.
-- ══════════════════════════════════════════════════════════════

-- 1. Gem eksisterende data
CREATE TABLE _suppliers_backup AS SELECT * FROM suppliers;

-- 2. Drop FK-afhængige tabeller midlertidigt (gemmes som backup)
--    supplier_locations og supplier_grocy_locations har FK til suppliers
CREATE TABLE _supplier_locations_backup AS SELECT * FROM supplier_locations;
CREATE TABLE _sgl_backup AS SELECT * FROM supplier_grocy_locations;

-- 3. Drop afhængige tabeller
DROP TABLE IF EXISTS supplier_grocy_locations;
DROP TABLE IF EXISTS supplier_locations;
DROP TABLE IF EXISTS supplier_products;

-- 4. Drop og genskab suppliers med udvidet CHECK
DROP TABLE suppliers;

CREATE TABLE suppliers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    contact_email       TEXT,
    contact_phone       TEXT,
    integration_type    TEXT NOT NULL DEFAULT 'manual'
                        CHECK (integration_type IN ('api', 'form', 'email', 'manual', 'webshop')),
    api_config_json     TEXT,
    notes               TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    webshop_url         TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Gendan data
INSERT INTO suppliers SELECT
    id, name, contact_email, contact_phone, integration_type,
    api_config_json, notes, is_active, webshop_url, created_at
FROM _suppliers_backup;

-- 6. Genskab supplier_locations
CREATE TABLE supplier_locations (
    supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
    location_id     INTEGER NOT NULL REFERENCES locations(id),
    account_number  TEXT,
    delivery_days   TEXT,
    lead_time_days  INTEGER,
    PRIMARY KEY (supplier_id, location_id)
);

INSERT INTO supplier_locations SELECT * FROM _supplier_locations_backup;

-- 7. Genskab supplier_grocy_locations
CREATE TABLE supplier_grocy_locations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id         INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    grocy_location_id   INTEGER NOT NULL,
    display_name        TEXT,
    UNIQUE (grocy_location_id)
);
CREATE INDEX idx_sgl_supplier ON supplier_grocy_locations(supplier_id);

INSERT INTO supplier_grocy_locations SELECT * FROM _sgl_backup;

-- 8. Genskab supplier_products
CREATE TABLE supplier_products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
    item_id             INTEGER NOT NULL,
    supplier_sku        TEXT,
    product_name        TEXT,
    pack_size           REAL,
    pack_unit           TEXT,
    price_per_pack      REAL,
    price_per_unit      REAL,
    is_organic          INTEGER NOT NULL DEFAULT 0,
    is_preferred        INTEGER NOT NULL DEFAULT 0,
    is_available        INTEGER NOT NULL DEFAULT 1,
    last_price_update   DATETIME,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_supplier_products_supplier ON supplier_products(supplier_id);
CREATE INDEX idx_supplier_products_item     ON supplier_products(item_id);

-- 9. Ryd backup-tabeller
DROP TABLE _suppliers_backup;
DROP TABLE _supplier_locations_backup;
DROP TABLE _sgl_backup;

-- ══════════════════════════════════════════════════════════════
-- purchase_orders: handelssted-reference
-- ══════════════════════════════════════════════════════════════

ALTER TABLE purchase_orders ADD COLUMN grocy_location_id INTEGER;

-- ══════════════════════════════════════════════════════════════
-- purchase_order_lines: Grocy-referencer til varemodtagelse
-- ══════════════════════════════════════════════════════════════

ALTER TABLE purchase_order_lines ADD COLUMN grocy_shopping_list_id INTEGER;
ALTER TABLE purchase_order_lines ADD COLUMN grocy_product_id INTEGER;

-- ══════════════════════════════════════════════════════════════
-- SEED — leverandører
-- ══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO suppliers (id, name, integration_type, webshop_url, notes)
VALUES
  (1, 'Hørkram', 'api',     NULL,                                     'Bestilling via hoka.dk API. Kræver HOKA_USERNAME + HOKA_PASSWORD i .env.'),
  (2, 'Metro',   'email',   NULL,                                     'Bestilling via e-mail.'),
  (3, 'Inco',    'webshop', 'https://inco.dk/webshop/sortiment/',     'To handelssteder: Valby og Frederiksberg.');

INSERT OR IGNORE INTO supplier_locations (supplier_id, location_id)
VALUES
  (1, 1),  -- Hørkram → HQ
  (1, 2),  -- Hørkram → Trailer
  (2, 1),  -- Metro → HQ
  (3, 1);  -- Inco → HQ
