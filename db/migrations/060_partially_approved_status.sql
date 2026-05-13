-- Migration 060: Patch E — tilføj 'partially_approved' som tilladt status
-- på goods_receipts. SQLite kan ikke ALTER CHECK, så hele tabellen genopbygges.
--
-- Bevarer alle eksisterende kolonner (inkl. received_by_name fra migration 039)
-- + den anden CHECK på deviation_type. Foreign key fra goods_receipt_items
-- følger automatisk med rename så længe foreign_keys er OFF under migration.

PRAGMA foreign_keys = OFF;

CREATE TABLE goods_receipts_new (
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

  -- NY: 'partially_approved' tilladt (Patch E, maj 2026)
  status                     TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','approved','partially_approved')),

  created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_by_name           TEXT
);

-- Kopiér alle rækker (inkl. received_by_name fra migration 039)
INSERT INTO goods_receipts_new (
    id, receipt_number, supplier_name,
    location_id, received_by, received_at,
    temperature_cool_enabled, temperature_cool_value, temperature_cool_ok,
    temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok,
    date_check_ok, labeling_check_ok, packaging_check_ok,
    has_deviation, deviation_type, deviation_note,
    photo_path, notes,
    purchase_order_id, whiteboard_synced_at,
    status, created_at, received_by_name
)
SELECT
    id, receipt_number, supplier_name,
    location_id, received_by, received_at,
    temperature_cool_enabled, temperature_cool_value, temperature_cool_ok,
    temperature_frozen_enabled, temperature_frozen_value, temperature_frozen_ok,
    date_check_ok, labeling_check_ok, packaging_check_ok,
    has_deviation, deviation_type, deviation_note,
    photo_path, notes,
    purchase_order_id, whiteboard_synced_at,
    status, created_at, received_by_name
FROM goods_receipts;

DROP TABLE goods_receipts;
ALTER TABLE goods_receipts_new RENAME TO goods_receipts;

PRAGMA foreign_keys = ON;
