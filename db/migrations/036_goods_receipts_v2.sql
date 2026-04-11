-- Migration 036: Varemodtagelse v3 — nyt skema med to temperaturer, FVST-toggles, afvigelse
-- Erstatter gammelt PO-baseret skema fra migration 005 + 035

-- Drop gamle tabeller
DROP TABLE IF EXISTS goods_receipt_lines;   -- fra 005_purchasing.sql
DROP TABLE IF EXISTS goods_receipt_items;   -- fra 035_indkob_fixes.sql
DROP TABLE IF EXISTS goods_receipts;        -- fra 005_purchasing.sql

-- Nyt goods_receipts skema
CREATE TABLE goods_receipts (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number             TEXT NOT NULL UNIQUE,
  supplier_name              TEXT NOT NULL,

  location_id                INTEGER REFERENCES locations(id),
  received_by                INTEGER REFERENCES users(id),
  received_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Køl-temperatur
  temperature_cool_enabled   INTEGER NOT NULL DEFAULT 1,
  temperature_cool_value     REAL,
  temperature_cool_ok        INTEGER,

  -- Frys-temperatur
  temperature_frozen_enabled INTEGER NOT NULL DEFAULT 1,
  temperature_frozen_value   REAL,
  temperature_frozen_ok      INTEGER,

  -- FVST-tjek
  date_check_ok              INTEGER NOT NULL DEFAULT 1,
  labeling_check_ok          INTEGER NOT NULL DEFAULT 1,
  packaging_check_ok         INTEGER NOT NULL DEFAULT 1,

  -- Afvigelse
  has_deviation              INTEGER NOT NULL DEFAULT 0,
  deviation_type             TEXT CHECK (deviation_type IN
                               ('returned','no_risk','discarded','supplier_contacted','other')),
  deviation_note             TEXT,

  photo_path                 TEXT,
  notes                      TEXT,

  purchase_order_id          INTEGER,
  whiteboard_synced_at       DATETIME,
  status                     TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','approved')),
  created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Nyt goods_receipt_items skema
CREATE TABLE goods_receipt_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id        INTEGER NOT NULL REFERENCES goods_receipts(id),
  grocy_product_id  INTEGER,
  product_name      TEXT NOT NULL,
  expected_quantity REAL,
  unit              TEXT,
  received_quantity REAL,
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','missing','wrong','damaged')),
  notes             TEXT,
  grocy_added       INTEGER NOT NULL DEFAULT 0,
  grocy_error       TEXT
);

-- webhook_log eksisterer allerede fra 035 — rør ikke

-- Settings for receipt-numre (webhook-settings eksisterer allerede fra 035)
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('goods_receipt_number_prefix', 'VR',  'Præfiks for varemodtagelses-numre'),
  ('goods_receipt_number_next',   '1',   'Næste løbenummer');
