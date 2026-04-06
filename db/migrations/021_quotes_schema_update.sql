-- ==========================================
-- Opdater quotes/quote_lines til nyt schema
-- Drop + recreate (ingen data at bevare)
-- ==========================================

DROP TABLE IF EXISTS quote_lines;
DROP TABLE IF EXISTS quotes;

CREATE TABLE quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_number TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers(id),
    company_id INTEGER REFERENCES companies(id),
    price_category TEXT NOT NULL DEFAULT 'catering',
    quote_date DATE NOT NULL DEFAULT (DATE('now')),
    valid_until DATE,
    delivery_date DATE,
    delivery_time TEXT,
    pax INTEGER,
    delivery_type TEXT DEFAULT 'delivery',
    delivery_address_id INTEGER REFERENCES addresses(id),
    delivery_price REAL DEFAULT 0,
    delivery_note TEXT,
    template TEXT NOT NULL DEFAULT 'event'
        CHECK (template IN ('event', 'single', 'custom')),
    price_mode TEXT NOT NULL DEFAULT 'total'
        CHECK (price_mode IN ('total', 'block', 'line')),
    discount_percent REAL DEFAULT 0,
    total_price REAL,
    notes TEXT,
    customer_wishes TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
    converted_to_bon_id INTEGER REFERENCES bons(id),
    created_by_user_id INTEGER REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quote_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    block_type TEXT,
    grocy_recipe_id INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'stk',
    unit_price REAL,
    cost_price REAL,
    line_total REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id);
