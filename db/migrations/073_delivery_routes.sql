-- ==========================================
-- 073_delivery_routes.sql
-- Delivery Spor 2 — Fundament (S2.0)
--
-- Rute-datamodel der betjener begge workflows:
--   • Workflow B (daglig triage) — typisk 1 stop pr. rute
--   • Workflow A (Volvo-planlægning) — 1-3 stop pr. rute
-- Samme tabeller, kun UI-vægten adskiller dem.
--
-- delivery_route_stops er autoritativ kilde når en bon er på en rute.
-- bons.delivery_vehicle_id + delivery_method forbliver en denormaliseret
-- cache holdt i sync af endpoint-koden (ikke triggers).
--
-- Spec: docs/delivery/CLAUDE_DELIVERY_SPOR2.md sektion 4 + 6.
-- delivery_vehicles findes allerede (migration 057, udvidet i 071).
-- ==========================================

-- ==========================================
-- TURE
-- ==========================================
CREATE TABLE delivery_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_date DATE NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES delivery_vehicles(id),

    courier_user_id INTEGER REFERENCES users(id),   -- intern chauffør, kan være NULL
    external_reference TEXT,                        -- By-expressen/taxa booking-ref

    pickup_time TIME,                               -- fælles afgang fra HQ
    actual_departure DATETIME,
    completed_at DATETIME,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','computed','confirmed','active','completed','cancelled')),

    booking_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (booking_status IN ('pending','in_progress','booked','failed','not_required')),
    booked_at DATETIME,
    booked_by_user_id INTEGER REFERENCES users(id),

    total_km REAL,
    total_minutes INTEGER,
    estimated_cost_dkk INTEGER,
    actual_cost_dkk INTEGER,
    actual_cost_source TEXT
        CHECK (actual_cost_source IN ('api','manual') OR actual_cost_source IS NULL),
    actual_cost_at DATETIME,

    route_geojson TEXT,                             -- ORS-rute-geometri til kort-polyline
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_routes_date ON delivery_routes(route_date);
CREATE INDEX idx_routes_status ON delivery_routes(status);
CREATE INDEX idx_routes_courier ON delivery_routes(courier_user_id);

-- ==========================================
-- STOP PÅ TUR
-- ==========================================
-- 3 states. 'klar' udledes i frontend fra bons.status_code='KLAR' — ikke dobbeltbogført.
CREATE TABLE delivery_route_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    sequence INTEGER NOT NULL,
    eta TIME,
    distance_from_prev_m INTEGER,
    duration_from_prev_s INTEGER,
    status TEXT NOT NULL DEFAULT 'planlagt'
        CHECK (status IN ('planlagt','leveret','problem')),
    completed_at DATETIME,
    UNIQUE(route_id, bon_id),
    UNIQUE(route_id, sequence)
);
CREATE INDEX idx_stops_route ON delivery_route_stops(route_id);
CREATE INDEX idx_stops_bon ON delivery_route_stops(bon_id);

-- ==========================================
-- INCIDENTS (problemer ved levering — bruges fra S2.3)
-- ==========================================
CREATE TABLE delivery_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_stop_id INTEGER REFERENCES delivery_route_stops(id),
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    incident_type TEXT NOT NULL
        CHECK (incident_type IN ('no_answer','wrong_address','left_at_door',
                                 'returned_to_kitchen','damage','other')),
    description TEXT,
    photo_attachment_id INTEGER REFERENCES attachments(id),  -- genbrug attachments-tabel
    location_lat REAL,
    location_lng REAL,
    logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    logged_by_user_id INTEGER REFERENCES users(id),
    resolved_at DATETIME,
    resolved_by_user_id INTEGER REFERENCES users(id),
    resolution_notes TEXT
);
CREATE INDEX idx_incidents_bon ON delivery_incidents(bon_id);
CREATE INDEX idx_incidents_unresolved ON delivery_incidents(resolved_at) WHERE resolved_at IS NULL;

-- ==========================================
-- ROUTING-CACHE — geo_calculations genskabes med nullable bon_id
-- ==========================================
-- geo_calculations (migration 003) er nøglet på bon_id+address_id og røres IKKE
-- af nogen v2-kode. Spor 2 bruger den som afstands-cache nøglet på address_id —
-- HQ er fast, så HQ→adresse-afstanden afhænger kun af leverings-adressen.
-- bon_id gøres nullable så cachen kan skrives uden en bon (geocodeRaw-casen).
-- SQLite kan ikke ALTER COLUMN — tabellen genskabes (mønster fra migration 041/054).
CREATE TABLE geo_calculations_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id           INTEGER REFERENCES bons(id),
    address_id       INTEGER NOT NULL REFERENCES addresses(id),
    distance_meters  REAL,
    duration_seconds REAL,
    route_geojson    TEXT,
    calculated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO geo_calculations_new (id, bon_id, address_id, distance_meters,
                                  duration_seconds, route_geojson, calculated_at)
    SELECT id, bon_id, address_id, distance_meters, duration_seconds,
           route_geojson, calculated_at FROM geo_calculations;
DROP TABLE geo_calculations;
ALTER TABLE geo_calculations_new RENAME TO geo_calculations;
CREATE INDEX idx_geo_bon ON geo_calculations(bon_id);
CREATE INDEX idx_geo_address ON geo_calculations(address_id);

-- ==========================================
-- SETTINGS
-- ==========================================
-- HQ-koordinaterne er DAWA-geokodet 20. maj 2026 (Prinsesse Charlottes Gade 16).
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('delivery_safety_margin_minutes',     '10',
   'Buffer udover ORS-køretid ved beregning af afhentningstid (minutter).'),
  ('delivery_kitchen_capacity_boxes',    '12',
   'Max antal kasser køkkenet kan have klar samtidig ved samme afhentningstid.'),
  ('delivery_default_service_time_min',  '5',
   'Default service-tid pr. stop (losning hos kunde) i minutter.'),
  ('delivery_assumed_delivered_after_min','30',
   'Antag leveret hvis intet er hørt X minutter over deadline.'),
  ('delivery_office_phone',              '+4533218989',
   'Telefonnummer til kontoret — nødløsning vist i courier-mobil.'),
  ('delivery_hq_address',                'Prinsesse Charlottes Gade 16, 2200 København N',
   'HQ-adresse — start/slut for alle ruter.'),
  ('delivery_hq_lat',                    '55.69345859',
   'HQ breddegrad (DAWA-geokodet 20. maj 2026).'),
  ('delivery_hq_lon',                    '12.55234495',
   'HQ længdegrad (DAWA-geokodet 20. maj 2026).');
