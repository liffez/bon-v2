-- Migration 035: Indkøb bugfixes + varemodtagelse-forberedelse
-- Fix 2: Varenummer på ordrelinjer (sporbarhed)
ALTER TABLE purchase_order_lines ADD COLUMN barcode_value TEXT;

-- Fix 5: Goods receipts tabeller til varemodtagelse (næste sprint)

CREATE TABLE IF NOT EXISTS goods_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number      TEXT NOT NULL,
    supplier_name       TEXT NOT NULL,
    receiver_name       TEXT NOT NULL,
    location_id         INTEGER REFERENCES locations(id),
    temperature         REAL,
    temp_ok             INTEGER NOT NULL DEFAULT 1,
    date_check          INTEGER NOT NULL DEFAULT 1,
    label_check         INTEGER NOT NULL DEFAULT 1,
    packaging_check     INTEGER NOT NULL DEFAULT 1,
    has_deviation       INTEGER NOT NULL DEFAULT 0,
    deviation_type      TEXT,
    deviation_note      TEXT,
    photo_path          TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved')),
    whiteboard_event_id TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id          INTEGER NOT NULL REFERENCES goods_receipts(id),
    grocy_product_id    INTEGER NOT NULL,
    product_name        TEXT NOT NULL,
    ordered_varenr      TEXT,
    quantity_expected   REAL,
    quantity_received   REAL NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok','missing','wrong','damaged')),
    grocy_added         INTEGER NOT NULL DEFAULT 0,
    grocy_error         TEXT,
    note                TEXT
);

CREATE TABLE IF NOT EXISTS webhook_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status_code INTEGER,
    error       TEXT,
    sent_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retry_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('whiteboard_webhook_url',    '', 'URL til Whiteboard /api/events (tom = ingen sync)'),
  ('whiteboard_webhook_secret', '', 'HMAC-secret til webhook-validering');
