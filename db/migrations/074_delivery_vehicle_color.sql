-- ==========================================
-- 074_delivery_vehicle_color.sql
-- Farve pr. vogn — til kort-markører, rute-polylinjer og legende.
--
-- Farve sættes pr. VOGN, ikke pr. type: By-expressen og egen cykel er
-- begge cykler men skal kunne skelnes på kortet (jf. Bon v1's legende).
-- Redigerbar senere via Settings → Leveringsmetoder.
-- ==========================================

ALTER TABLE delivery_vehicles ADD COLUMN color TEXT;

UPDATE delivery_vehicles SET color = '#2d6da3' WHERE code = 'byekspressen';  -- blå
UPDATE delivery_vehicles SET color = '#d98a2b' WHERE code = 'cykel-egen';    -- orange
UPDATE delivery_vehicles SET color = '#8e631f' WHERE code = 'volvo';         -- brun
UPDATE delivery_vehicles SET color = '#4a8a3a' WHERE code = 'taxa-4x35';     -- grøn
