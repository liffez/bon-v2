-- ==========================================
-- 075_delivery_pickup_model.sql
-- Fælles afhentnings-model for alle vogne.
--
-- afhentningstid = leveringstid − lead, hvor lead enten er:
--   • et fast tal (pickup_lead_min) — fx By-expressen 45 min, de ruter selv
--   • køretidsbaseret (pickup_lead_min IS NULL) — ORS-køretid + handover-margin
--
-- Office kan altid sætte afhentningstiden manuelt. Så markeres ruten
-- 'manual', og en genberegning overskriver den ikke.
-- ==========================================

ALTER TABLE delivery_vehicles ADD COLUMN pickup_lead_min INTEGER;

-- By-expressen henter standardmæssigt 45 min før leveringstid.
UPDATE delivery_vehicles SET pickup_lead_min = 45 WHERE code = 'byekspressen';

ALTER TABLE delivery_routes ADD COLUMN pickup_time_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (pickup_time_source IN ('auto', 'manual'));
