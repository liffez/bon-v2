-- Migration 128: Drop CHECK-constraint på bons.payment_type + to nye betalingstyper
--
-- HVORFOR
-- `payment_types` er opslagstabellen med CRUD i Settings, men den var ikke den
-- rigtige sandhed: `bons.payment_type` havde en CHECK der hårdkodede de fem
-- lovlige koder. En ny betalingstype krævede derfor en tabel-genopbygning —
-- præcis dét migration 054 (changelog.action) besluttede at komme væk fra:
--
--   "Bedre at styre det fra application-laget end at re-oprette tabellen for
--    hver ny værdi."
--
-- Vi dropper CHECK'en frem for at udvide den. Så er `payment_types` eneste
-- sandhed, og fremtidige typer koster én række — ikke en migration.
-- Validering hører fra nu af i application-laget (routes/bons.js m.fl.).
--
-- ANLEDNING
-- Byttehandel: en bon der leveres, men afregnes i en modydelse i stedet for
-- penge. Prisen er ægte (kunden ville have betalt den), kun afregningsformen er
-- en anden — så priserne må IKKE nulstilles: det ville slette omsætningen ud af
-- rapporter, margin-analyse og CO2-per-krone. Rette sted er payment_type, fordi
-- al eksisterende logik allerede hænger på `payment_type = 'invoice'`:
-- syncCashflowInvoice sletter cf_invoices-rækken ved skift væk fra 'invoice',
-- så bonnen forsvinder ud af "Forfaldne" af sig selv. Se issue #319.
--
-- SIKKERHED
-- bons er kernetabellen: 9 views, 3 triggers, 11 indexes, 21 tabeller med FK.
-- foreign_keys SKAL være OFF under hele operationen — ellers udfører DROP TABLE
-- et implicit DELETE FROM der fyrer ON DELETE-handlinger på alle 21 børnetabeller.
-- Views droppes FØR rename: ALTER TABLE ... RENAME fejler hvis en view refererer
-- en tabel der ikke findes (samme fælde som migration 041 noterer).
-- Triggers på bons forsvinder automatisk med DROP TABLE og genskabes til sidst.

PRAGMA foreign_keys = OFF;

-- ── 1. Drop views der læser bons (blokerer ellers rename) ────────────────────
DROP VIEW IF EXISTS v_active_notifications;
DROP VIEW IF EXISTS v_callbacks_pending;
DROP VIEW IF EXISTS v_category_totals_today;
DROP VIEW IF EXISTS v_day_totals;
DROP VIEW IF EXISTS v_dormant_customers;
DROP VIEW IF EXISTS v_kitchen_later;
DROP VIEW IF EXISTS v_kitchen_today;
DROP VIEW IF EXISTS v_offer_pipeline;
DROP VIEW IF EXISTS v_service_calls_pending;

-- ── 2. Ny tabel — identisk med den gamle, kun payment_type-CHECK fjernet ─────
CREATE TABLE bons_new (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_number              TEXT NOT NULL UNIQUE,
    status_id               INTEGER NOT NULL REFERENCES status_definitions(id),
    location_id             INTEGER NOT NULL REFERENCES locations(id),
    customer_id             INTEGER REFERENCES customers(id),
    company_id              INTEGER REFERENCES companies(id),
    price_category_id       INTEGER REFERENCES price_categories(id),

    order_date              DATE NOT NULL,
    delivery_date           DATE NOT NULL,
    pickup_time             TEXT,
    delivery_time           TEXT,
    courier_arrival_time    TEXT,

    delivery_type           TEXT NOT NULL DEFAULT 'delivery'
                            CHECK (delivery_type IN ('delivery', 'pickup', 'event')),
    delivery_method         TEXT
                            CHECK (delivery_method IN ('bike', 'taxi', 'volvo', 'pickup')),
    delivery_address_id     INTEGER REFERENCES addresses(id),
    delivery_notes          TEXT,
    delivery_cost           REAL,
    delivery_price          REAL,
    courier_provider        TEXT,

    pax                     INTEGER,
    total_units             INTEGER,
    boxes                   INTEGER,

    total_price             REAL,
    total_with_delivery     REAL,

    -- CHECK bevidst fjernet — payment_types er sandheden (se hovedet)
    payment_type            TEXT,

    kitchen_selects         INTEGER NOT NULL DEFAULT 0,
    customer_collects       INTEGER NOT NULL DEFAULT 0,

    invoice_info            TEXT,

    kitchen_info            TEXT,
    customer_wishes         TEXT,
    internal_notes          TEXT,

    prep_ingredients_ready  INTEGER NOT NULL DEFAULT 0,
    prep_supplies_ready     INTEGER NOT NULL DEFAULT 0,

    inventory_deducted      INTEGER NOT NULL DEFAULT 0,
    inventory_deducted_at   DATETIME,

    created_by_user_id      INTEGER REFERENCES users(id),
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    is_offer                INTEGER NOT NULL DEFAULT 0,
    offer_status            TEXT
                            CHECK (offer_status IN ('draft', 'sent', 'won', 'lost', 'expired')),
    offer_sent_at           DATETIME,
    offer_valid_until       DATE,
    price_category          TEXT NOT NULL DEFAULT 'store',
    day_contact_name        TEXT,
    day_contact_phone       TEXT,
    is_internal             INTEGER NOT NULL DEFAULT 0,
    offer_template          TEXT
                            CHECK (offer_template IN ('event', 'single', 'custom')),
    offer_price_mode        TEXT DEFAULT 'total'
                            CHECK (offer_price_mode IN ('total', 'block', 'line')),
    offer_discount_percent  REAL DEFAULT 0,
    offer_note              TEXT,
    offer_block_metadata    TEXT,
    v1_id                   INTEGER,
    sync_source             TEXT,
    delivery_vehicle_id     INTEGER REFERENCES delivery_vehicles(id),
    delivery_cost_estimated REAL,
    delivery_cost_source    TEXT
                            CHECK (delivery_cost_source IN ('standard', 'manual', 'api') OR delivery_cost_source IS NULL),
    acknowledged_at         DATETIME,
    acknowledged_by_user_id INTEGER REFERENCES users(id),
    event_id                INTEGER REFERENCES events(id),
    event_role              TEXT
                            CHECK (event_role IN ('prep','topup','sales','expense')),
    economic_draft_number   INTEGER,
    economic_draft_at       TEXT,
    total_co2e              REAL
);

-- ── 3. Kopiér data (eksplicit kolonneliste — ikke SELECT *) ──────────────────
INSERT INTO bons_new (
    id, bon_number, status_id, location_id, customer_id, company_id, price_category_id,
    order_date, delivery_date, pickup_time, delivery_time, courier_arrival_time,
    delivery_type, delivery_method, delivery_address_id, delivery_notes,
    delivery_cost, delivery_price, courier_provider,
    pax, total_units, boxes,
    total_price, total_with_delivery,
    payment_type,
    kitchen_selects, customer_collects,
    invoice_info, kitchen_info, customer_wishes, internal_notes,
    prep_ingredients_ready, prep_supplies_ready,
    inventory_deducted, inventory_deducted_at,
    created_by_user_id, created_at, updated_at,
    is_offer, offer_status, offer_sent_at, offer_valid_until, price_category,
    day_contact_name, day_contact_phone, is_internal,
    offer_template, offer_price_mode, offer_discount_percent, offer_note, offer_block_metadata,
    v1_id, sync_source,
    delivery_vehicle_id, delivery_cost_estimated, delivery_cost_source,
    acknowledged_at, acknowledged_by_user_id,
    event_id, event_role,
    economic_draft_number, economic_draft_at, total_co2e
)
SELECT
    id, bon_number, status_id, location_id, customer_id, company_id, price_category_id,
    order_date, delivery_date, pickup_time, delivery_time, courier_arrival_time,
    delivery_type, delivery_method, delivery_address_id, delivery_notes,
    delivery_cost, delivery_price, courier_provider,
    pax, total_units, boxes,
    total_price, total_with_delivery,
    payment_type,
    kitchen_selects, customer_collects,
    invoice_info, kitchen_info, customer_wishes, internal_notes,
    prep_ingredients_ready, prep_supplies_ready,
    inventory_deducted, inventory_deducted_at,
    created_by_user_id, created_at, updated_at,
    is_offer, offer_status, offer_sent_at, offer_valid_until, price_category,
    day_contact_name, day_contact_phone, is_internal,
    offer_template, offer_price_mode, offer_discount_percent, offer_note, offer_block_metadata,
    v1_id, sync_source,
    delivery_vehicle_id, delivery_cost_estimated, delivery_cost_source,
    acknowledged_at, acknowledged_by_user_id,
    event_id, event_role,
    economic_draft_number, economic_draft_at, total_co2e
FROM bons;

DROP TABLE bons;
ALTER TABLE bons_new RENAME TO bons;

-- ── 4. Genskab indexes ──────────────────────────────────────────────────────
CREATE INDEX idx_bons_status           ON bons(status_id);
CREATE INDEX idx_bons_location         ON bons(location_id);
CREATE INDEX idx_bons_delivery_date    ON bons(delivery_date);
CREATE INDEX idx_bons_customer         ON bons(customer_id);
CREATE INDEX idx_bons_company          ON bons(company_id);
CREATE INDEX idx_bons_offer            ON bons(is_offer, offer_status) WHERE is_offer = 1;
CREATE UNIQUE INDEX idx_bons_v1_id     ON bons(v1_id) WHERE v1_id IS NOT NULL;
CREATE INDEX idx_bons_delivery_vehicle ON bons(delivery_vehicle_id);
CREATE INDEX idx_bons_acknowledged_at  ON bons(acknowledged_at) WHERE acknowledged_at IS NULL;
CREATE INDEX idx_bons_created_at       ON bons(created_at);
CREATE INDEX idx_bons_event            ON bons(event_id);

-- ── 5. Genskab triggers (fulgte med DROP TABLE) ─────────────────────────────
CREATE TRIGGER trg_bon_pickup_time_insert
AFTER INSERT ON bons
WHEN NEW.delivery_type = 'pickup'
  AND NEW.delivery_time IS NOT NULL AND NEW.delivery_time != ''
  AND COALESCE(NEW.pickup_time, '') != NEW.delivery_time
BEGIN
    UPDATE bons SET pickup_time = NEW.delivery_time WHERE id = NEW.id;
END;

CREATE TRIGGER trg_bon_pickup_time_update
AFTER UPDATE OF delivery_type, delivery_time ON bons
WHEN NEW.delivery_type = 'pickup'
  AND NEW.delivery_time IS NOT NULL AND NEW.delivery_time != ''
  AND COALESCE(NEW.pickup_time, '') != NEW.delivery_time
BEGIN
    UPDATE bons SET pickup_time = NEW.delivery_time WHERE id = NEW.id;
END;

CREATE TRIGGER bons_seed_standing_discount
AFTER INSERT ON bons
WHEN (NEW.offer_discount_percent IS NULL OR NEW.offer_discount_percent = 0)
BEGIN
    UPDATE bons SET offer_discount_percent = COALESCE(
        (SELECT discount_percent FROM companies WHERE id = NEW.company_id  AND discount_percent > 0),
        (SELECT discount_percent FROM customers WHERE id = NEW.customer_id AND discount_percent > 0),
        0
    ) WHERE id = NEW.id;
END;

-- ── 6. Genskab views (ordret som før — verificeret identiske i drift og frisk DB) ──
CREATE VIEW v_active_notifications AS
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

CREATE VIEW v_callbacks_pending AS
SELECT
    a.id AS activity_id, a.customer_id, a.bon_id, a.text, a.created_at,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    c.phone AS customer_phone,
    co.name AS company_name,
    b.bon_number
FROM crm_activities a
JOIN customers c ON a.customer_id = c.id
LEFT JOIN companies co ON c.company_id = co.id
LEFT JOIN bons b ON a.bon_id = b.id
WHERE a.result = 'callback' AND a.done_at IS NULL
ORDER BY a.created_at ASC;

CREATE VIEW v_category_totals_today AS
SELECT
    bl.category,
    SUM(bl.quantity) AS total_quantity,
    bl.unit
FROM bon_lines bl
JOIN bons b ON bl.bon_id = b.id
JOIN status_definitions s ON b.status_id = s.id
WHERE b.delivery_date = DATE('now')
    AND s.category NOT IN ('terminal', 'cancel')
    AND b.is_offer = 0
    AND bl.category IS NOT NULL
GROUP BY bl.category, bl.unit
ORDER BY total_quantity DESC;

CREATE VIEW v_day_totals AS
SELECT
    delivery_date,
    COUNT(*)                                                AS bon_count,
    SUM(COALESCE(pax, 0))                                   AS total_pax,
    SUM(COALESCE(total_units, 0))                           AS total_units
FROM bons
WHERE is_offer = 0
GROUP BY delivery_date;

CREATE VIEW v_dormant_customers AS
SELECT
    c.id,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
    c.email,
    co.name AS company_name,
    MAX(b.delivery_date) AS last_order_date,
    CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since
FROM customers c
LEFT JOIN companies co ON c.company_id = co.id
LEFT JOIN bons b ON b.customer_id = c.id
WHERE c.is_active = 1
GROUP BY c.id
HAVING days_since > 60 OR last_order_date IS NULL
ORDER BY days_since DESC;

CREATE VIEW v_kitchen_later AS
SELECT
    b.id,
    b.bon_number,
    b.delivery_date,
    b.pickup_time,
    b.pax,
    b.total_units,
    b.prep_ingredients_ready,
    b.prep_supplies_ready,
    s.code   AS status_code,
    s.label  AS status_label,
    s.color  AS status_color,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name  AS company_name
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.delivery_date > DATE('now')
    AND b.delivery_date <= DATE('now', '+7 days')
    AND s.code IN ('GODKENDT', 'IGANG')
    AND b.is_offer = 0
ORDER BY b.delivery_date ASC, b.pickup_time ASC;

CREATE VIEW v_kitchen_today AS
SELECT
    b.id,
    b.bon_number,
    b.pickup_time,
    b.delivery_time,
    b.delivery_type,
    b.pax,
    b.total_units,
    b.kitchen_info,
    b.kitchen_selects,
    b.customer_collects,
    b.prep_ingredients_ready,
    b.prep_supplies_ready,
    s.code   AS status_code,
    s.label  AS status_label,
    s.color  AS status_color,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name  AS company_name
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.delivery_date = DATE('now')
    AND s.category NOT IN ('terminal', 'cancel')
    AND b.is_offer = 0
ORDER BY b.pickup_time ASC;

CREATE VIEW v_offer_pipeline AS
SELECT
    b.id,
    b.bon_number,
    b.offer_status,
    b.offer_sent_at,
    b.offer_valid_until,
    b.total_price,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name AS company_name
FROM bons b
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.is_offer = 1
    AND b.offer_status NOT IN ('won', 'lost', 'expired')
ORDER BY b.offer_valid_until ASC;

CREATE VIEW v_service_calls_pending AS
SELECT
    b.id AS bon_id, b.bon_number, b.delivery_date, b.delivery_time,
    b.pax, b.total_units, b.total_price,
    c.id AS customer_id,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    c.phone AS customer_phone,
    co.name AS company_name,
    CAST(julianday('now') - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery
FROM bons b
JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
JOIN status_definitions sd ON b.status_id = sd.id
WHERE sd.code IN ('LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET')
    AND b.is_internal = 0
    AND julianday('now') - julianday(b.delivery_date) BETWEEN 0 AND 7
    AND NOT EXISTS (
        SELECT 1 FROM crm_activities a
        WHERE a.bon_id = b.id AND a.type = 'service_call'
    );

-- ── 7. De to nye betalingstyper ─────────────────────────────────────────────
-- Modregning: leveret mod en modydelse (byttehandel). Prisen er ægte og bliver
--   stående i omsætningen; kun afregningsformen er en anden.
-- Sponsorat:  givet væk uden modydelse. Samme adfærd i koden.
-- Begge er != 'invoice' → ingen cf_invoices, ingen forfaldsdato, ingen rykker.
INSERT OR IGNORE INTO payment_types (code, label, is_active, sort_order)
VALUES ('barter', 'Modregning', 1, 60),
       ('sponsorship', 'Sponsorat', 1, 70);

PRAGMA foreign_keys = ON;
