-- ==========================================
-- 005_purchasing.sql
-- Indkøb: leverandører, indkøbsliste,
-- bestillinger, varemodtagelse
-- ==========================================
-- NOTE: item_id refererer til Grocy product_id.
-- Grocy ejer lager og produkter — Bon v2 læser
-- via adapter og gemmer ID'er som reference.
-- ==========================================

-- ==========================================
-- LEVERANDØRER
-- ==========================================

CREATE TABLE suppliers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    contact_email       TEXT,
    contact_phone       TEXT,
    integration_type    TEXT NOT NULL DEFAULT 'manual'
                        CHECK (integration_type IN ('api', 'form', 'email', 'manual')),
    api_config_json     TEXT,           -- API-credentials etc. (krypteres i praksis)
    notes               TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hvilke lokationer handler med hvilke leverandører
CREATE TABLE supplier_locations (
    supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
    location_id     INTEGER NOT NULL REFERENCES locations(id),
    account_number  TEXT,               -- Vores kundenr. hos leverandøren
    delivery_days   TEXT,               -- fx "mon,wed,fri"
    lead_time_days  INTEGER,            -- Leveringstid i dage
    PRIMARY KEY (supplier_id, location_id)
);

-- Leverandørens produktkatalog
CREATE TABLE supplier_products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
    item_id             INTEGER NOT NULL,   -- Grocy product_id
    supplier_sku        TEXT,               -- Leverandørens varenummer
    product_name        TEXT,               -- Leverandørens navn for varen
    pack_size           REAL,               -- Antal enheder per pakning
    pack_unit           TEXT,               -- stk, kg, liter
    price_per_pack      REAL,
    price_per_unit      REAL,               -- Beregnet: price_per_pack / pack_size
    is_organic          INTEGER NOT NULL DEFAULT 0,
    is_preferred        INTEGER NOT NULL DEFAULT 0, -- Foretrukken leverandør
    is_available        INTEGER NOT NULL DEFAULT 1,
    last_price_update   DATETIME,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_supplier_products_supplier ON supplier_products(supplier_id);
CREATE INDEX idx_supplier_products_item     ON supplier_products(item_id);

-- ==========================================
-- INDKØBSLISTE
-- ==========================================

CREATE TABLE shopping_list (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id         INTEGER NOT NULL REFERENCES locations(id),
    item_id             INTEGER NOT NULL,   -- Grocy product_id
    quantity_needed     REAL NOT NULL,
    unit                TEXT,
    source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('auto_minimum', 'auto_recipe', 'manual')),
    source_bon_id       INTEGER REFERENCES bons(id),    -- Hvis fra opskrift
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'ordered', 'cancelled')),
    created_by_user_id  INTEGER REFERENCES users(id),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shopping_list_location ON shopping_list(location_id);
CREATE INDEX idx_shopping_list_status   ON shopping_list(status);

-- ==========================================
-- BESTILLINGER (purchase orders)
-- ==========================================

CREATE TABLE purchase_orders (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id             INTEGER NOT NULL REFERENCES locations(id),
    supplier_id             INTEGER NOT NULL REFERENCES suppliers(id),
    order_reference         TEXT,           -- Evt. ordrenr fra leverandøren
    status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN
                                ('draft', 'sent', 'confirmed',
                                 'partially_received', 'received', 'cancelled')),
    expected_delivery_date  DATE,
    total_amount            REAL,
    notes                   TEXT,
    sent_at                 DATETIME,
    sent_via                TEXT
                            CHECK (sent_via IN ('api', 'email', 'manual')),
    created_by_user_id      INTEGER REFERENCES users(id),
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_purchase_orders_location  ON purchase_orders(location_id);
CREATE INDEX idx_purchase_orders_supplier  ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status    ON purchase_orders(status);

CREATE TABLE purchase_order_lines (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id   INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES supplier_products(id),
    item_id             INTEGER NOT NULL,   -- Grocy product_id
    quantity_ordered    REAL NOT NULL,      -- Antal pakker
    unit_quantity       REAL,               -- Antal enheder (pakker × pack_size)
    price_per_pack      REAL,
    line_total          REAL,
    shopping_list_id    INTEGER REFERENCES shopping_list(id)
);

CREATE INDEX idx_po_lines_order ON purchase_order_lines(purchase_order_id);

-- ==========================================
-- VAREMODTAGELSE (goods receipts)
-- ==========================================

CREATE TABLE goods_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id         INTEGER NOT NULL REFERENCES locations(id),
    purchase_order_id   INTEGER REFERENCES purchase_orders(id),
    receipt_number      TEXT,               -- Følgeseddel-nummer
    receipt_date        DATE NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN
                            ('pending', 'verified', 'auto_approved',
                             'approved', 'disputed')),
    has_discrepancies   INTEGER NOT NULL DEFAULT 0,
    notes               TEXT,
    received_by_user_id INTEGER REFERENCES users(id),
    verified_at         DATETIME,
    verified_by_user_id INTEGER REFERENCES users(id),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_goods_receipts_location ON goods_receipts(location_id);
CREATE INDEX idx_goods_receipts_order    ON goods_receipts(purchase_order_id);

CREATE TABLE goods_receipt_lines (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    goods_receipt_id        INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
    purchase_order_line_id  INTEGER REFERENCES purchase_order_lines(id),
    item_id                 INTEGER NOT NULL,   -- Grocy product_id
    quantity_expected       REAL,
    quantity_received       REAL,
    quantity_damaged        REAL NOT NULL DEFAULT 0,
    discrepancy_type        TEXT NOT NULL DEFAULT 'none'
                            CHECK (discrepancy_type IN
                                ('none', 'short', 'over', 'damaged', 'wrong_item', 'missing')),
    discrepancy_note        TEXT,
    added_to_inventory      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_receipt_lines_receipt ON goods_receipt_lines(goods_receipt_id);
