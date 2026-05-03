-- ==========================================
-- 057_delivery_vehicles.sql
-- Spor 1: Manuel bestilling (By-expressen + Taxa)
--
-- Fundament for delivery-modulet (3D.4 simpel udgave).
-- Tilføjer:
--   - delivery_vehicles (master data + booking-template per vehicle)
--   - Udvidelser på delivery_events (vehicle_id, booked_by_user_id)
--   - Udvidelser på bons (vehicle_id, cost_estimated, cost_source)
--
-- Bemærk: bons har allerede delivery_notes, delivery_cost,
-- courier_provider, day_contact_name/_phone. Vi udnytter dem.
--
-- Senere migrations (3D.2) tilføjer delivery_routes / _route_stops /
-- _incidents / _messages og udvider bons.delivery_method CHECK.
-- ==========================================

-- ==========================================
-- KØRETØJER / LEVERINGSMETODER (master data)
-- ==========================================
CREATE TABLE delivery_vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL
        CHECK (type IN ('volvo', 'bike', 'own-bike', 'taxi')),
    is_internal INTEGER NOT NULL DEFAULT 0,

    -- Constraints til senere brug (3D.2 rute-planlægger)
    max_capacity_boxes INTEGER,
    max_distance_km REAL,

    -- Cost-formel (JSON). Bruges til estimat + standard-priser.
    -- Eksempel: {"base":100,"included_boxes":2,"extra_box_cost":50,"standard_inner_city":154}
    cost_formula_json TEXT,

    -- Booking-konfiguration
    booking_method TEXT NOT NULL DEFAULT 'calendar'
        CHECK (booking_method IN ('calendar', 'api', 'manual_clipboard')),
    booking_url TEXT,
    booking_template TEXT,
    booking_api_config_json TEXT,

    -- Knytter vehicle til en supplier (Fase 13) for fri kommunikation via mail
    supplier_id INTEGER REFERENCES suppliers(id),

    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vehicles_active ON delivery_vehicles(is_active);

-- ==========================================
-- UDVIDELSER PÅ delivery_events (eksisterende tabel fra 003_events.sql)
-- ==========================================
ALTER TABLE delivery_events ADD COLUMN vehicle_id INTEGER REFERENCES delivery_vehicles(id);
ALTER TABLE delivery_events ADD COLUMN booked_by_user_id INTEGER REFERENCES users(id);

CREATE INDEX idx_delivery_events_vehicle ON delivery_events(vehicle_id);

-- ==========================================
-- UDVIDELSER PÅ bons
-- delivery_cost (eksisterer) er FAKTISK omkostning vi betaler.
-- delivery_cost_estimated er auto-fyldt standard ved booking.
-- delivery_cost_source markerer hvor prisen kom fra.
-- delivery_vehicle_id er aktuelt valgt vehicle (sidste booking).
-- ==========================================
ALTER TABLE bons ADD COLUMN delivery_vehicle_id INTEGER REFERENCES delivery_vehicles(id);
ALTER TABLE bons ADD COLUMN delivery_cost_estimated REAL;
ALTER TABLE bons ADD COLUMN delivery_cost_source TEXT
    CHECK (delivery_cost_source IN ('standard', 'manual', 'api') OR delivery_cost_source IS NULL);

CREATE INDEX idx_bons_delivery_vehicle ON bons(delivery_vehicle_id);

-- ==========================================
-- SEED — 4 standard-vehicles
-- Templates udfyldes via Settings UI når office har valideret format.
-- URL'er er bekræftet med office.
-- ==========================================
INSERT INTO delivery_vehicles
    (code, label, type, is_internal, max_capacity_boxes, max_distance_km,
     cost_formula_json, booking_method, booking_url, booking_template, sort_order)
VALUES
    ('volvo', 'Volvo Duett', 'volvo', 1, 30, NULL,
     '{"base":0,"per_km":4}',
     'calendar', NULL, NULL, 10),

    ('cykel-egen', 'Egen cykel', 'own-bike', 1, 4, 8,
     '{"base":0}',
     'calendar', NULL, NULL, 20),

    ('byekspressen', 'By-expressen', 'bike', 0, 4, 8,
     '{"base":100,"included_boxes":2,"extra_box_cost":50,"standard_inner_city":154}',
     'manual_clipboard',
     'https://byexpressen.groupnet.at/lobo/#!//coreLogin/',
     NULL,
     30),

    ('taxa-4x35', 'Taxa 4×35', 'taxi', 0, 8, NULL,
     '{"base":136,"per_km":19,"standard_inner_city":250}',
     'manual_clipboard',
     'https://taxa.nu/',
     NULL,
     40);

-- ==========================================
-- SETTINGS — kun de nøgler der bruges af Spor 1
-- ==========================================
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('delivery_office_phone', '+4533218989', 'Tlf. kontoret'),
    ('delivery_hq_address', 'Prinsesse Charlottesgade 16, 2200 København N', 'HQ-adresse'),
    ('delivery_default_pickup_buffer_min', '30', 'Default minutter mellem afgang og leveringstid');
