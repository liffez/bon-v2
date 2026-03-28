-- 017: Receiving log + whiteboard settings
-- Lokal kopi af varemodtagelser for bon-v2 historik

CREATE TABLE IF NOT EXISTS receiving_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id   INTEGER REFERENCES purchase_orders(id),
    supplier            TEXT NOT NULL,
    receiver_name       TEXT NOT NULL,
    temperature         REAL,
    temp_ok             INTEGER DEFAULT 1,
    fvst_checks_json    TEXT,           -- {date_ok, label_ok, packaging_ok, deviation, note}
    items_json          TEXT,           -- [{product_id, qty, status, note}]
    grocy_results_json  TEXT,           -- [{product_id, success, error}]
    whiteboard_event_id INTEGER,        -- ID returneret fra whiteboard
    photo_path          TEXT,
    received_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receiving_log_date ON receiving_log(received_at);
CREATE INDEX IF NOT EXISTS idx_receiving_log_supplier ON receiving_log(supplier);

-- Whiteboard URL setting
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('whiteboard_url', 'http://localhost:3847', 'URL til whiteboard for FVST-logging'),
    ('receiving_auto_fvst', '1', '1 = send automatisk til whiteboard ved varemodtagelse');
