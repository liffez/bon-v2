-- ==========================================
-- 002_bons.sql
-- Bonner, bon-linjer, tilbud
-- ==========================================

-- ==========================================
-- BONNER
-- ==========================================

CREATE TABLE bons (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_number              TEXT NOT NULL UNIQUE,
    status_id               INTEGER NOT NULL REFERENCES status_definitions(id),
    location_id             INTEGER NOT NULL REFERENCES locations(id),
    customer_id             INTEGER REFERENCES customers(id),
    company_id              INTEGER REFERENCES companies(id),
    price_category_id       INTEGER REFERENCES price_categories(id),

    -- Datoer & tider
    order_date              DATE NOT NULL,
    delivery_date           DATE NOT NULL,
    pickup_time             TEXT,               -- "12:00"
    delivery_time           TEXT,               -- "12:30"
    courier_arrival_time    TEXT,               -- Hvornår bud ankommer

    -- Levering
    delivery_type           TEXT NOT NULL DEFAULT 'delivery'
                            CHECK (delivery_type IN ('delivery', 'pickup', 'event')),
    delivery_method         TEXT
                            CHECK (delivery_method IN ('bike', 'taxi', 'volvo', 'pickup')),
    delivery_address_id     INTEGER REFERENCES addresses(id),
    delivery_notes          TEXT,
    delivery_cost           REAL,               -- Hvad vi betaler budfirmaet
    delivery_price          REAL,               -- Hvad vi opkræver kunden
    courier_provider        TEXT,               -- byekspressen | taxa | intern

    -- Mængder
    pax                     INTEGER,
    total_units             INTEGER,
    boxes                   INTEGER,

    -- Priser
    total_price             REAL,
    total_with_delivery     REAL,

    -- Betalingstype
    payment_type            TEXT
                            CHECK (payment_type IN ('invoice', 'card', 'mobilepay', 'cash', 'pos')),

    -- Flags
    kitchen_selects         INTEGER NOT NULL DEFAULT 0, -- Køkkenet vælger menu
    customer_collects       INTEGER NOT NULL DEFAULT 0, -- Kunden henter selv

    -- Ekstra faktureringsinfo (EAN-ordre m.v.)
    invoice_info            TEXT,

    -- Fritekst-noter
    kitchen_info            TEXT,               -- Note til køkkenet
    customer_wishes         TEXT,               -- Kundens ønsker
    internal_notes          TEXT,               -- Intern note

    -- Prep-tjek
    prep_ingredients_ready  INTEGER NOT NULL DEFAULT 0,
    prep_supplies_ready     INTEGER NOT NULL DEFAULT 0,

    -- Lagertræk
    inventory_deducted      INTEGER NOT NULL DEFAULT 0,
    inventory_deducted_at   DATETIME,

    -- Meta
    created_by_user_id      INTEGER REFERENCES users(id),
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bons_status        ON bons(status_id);
CREATE INDEX idx_bons_location      ON bons(location_id);
CREATE INDEX idx_bons_delivery_date ON bons(delivery_date);
CREATE INDEX idx_bons_customer      ON bons(customer_id);
CREATE INDEX idx_bons_company       ON bons(company_id);

-- ==========================================
-- BON-LINJER
-- ==========================================

CREATE TABLE bon_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id          INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    grocy_recipe_id INTEGER,            -- Link til Grocy opskrift
    product_name    TEXT NOT NULL,      -- Snapshot af navn (Grocy kan ændre sig)
    category        TEXT,               -- Varekategori til dagsoverblik
    quantity        INTEGER NOT NULL,
    unit            TEXT NOT NULL DEFAULT 'stk',
    cost_price      REAL,               -- Kostpris (fra Grocy)
    unit_price      REAL,               -- Salgspris
    line_total      REAL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_accessory    INTEGER NOT NULL DEFAULT 0, -- Tilbehør (bestik, servietter...)
    special_request TEXT,               -- Kundes særønsker til denne linje
    co2e            REAL,               -- CO₂-aftryk per linje
    pos_product_id  INTEGER,            -- iZettle/POS reference
    notes           TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bon_lines_bon ON bon_lines(bon_id);

-- ==========================================
-- TILBUD
-- ==========================================

CREATE TABLE quotes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_number        TEXT NOT NULL UNIQUE,
    customer_id         INTEGER REFERENCES customers(id),
    company_id          INTEGER REFERENCES companies(id),
    price_category_id   INTEGER REFERENCES price_categories(id),
    quote_date          DATE NOT NULL,
    valid_until         DATE,
    delivery_date       DATE,
    pax                 INTEGER,
    delivery_type       TEXT DEFAULT 'delivery',
    delivery_address_id INTEGER REFERENCES addresses(id),
    total_price         REAL,
    notes               TEXT,
    customer_message    TEXT,
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
    converted_to_bon_id INTEGER REFERENCES bons(id),
    created_by_user_id  INTEGER REFERENCES users(id),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quote_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id        INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    grocy_recipe_id INTEGER,
    product_name    TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    unit            TEXT NOT NULL DEFAULT 'stk',
    unit_price      REAL,
    line_total      REAL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    notes           TEXT
);

CREATE INDEX idx_quote_lines_quote ON quote_lines(quote_id);
