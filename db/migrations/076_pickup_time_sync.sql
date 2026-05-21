-- ==========================================
-- 076_pickup_time_sync.sql
-- Afhentnings-bons: pickup_time = kundens tid
--
-- Når en bon bestilles med afhentning (delivery_type='pickup') skriver
-- bestillingsformularen kundens tid i delivery_time — pickup_time står tom.
-- For en afhentnings-bon ER kundens tid afhentningstiden (kunden henter
-- selv på HQ), så pickup_time skal være lig delivery_time.
--
-- Sorteringen bruger allerede COALESCE(pickup_time, delivery_time), så
-- rækkefølgen var korrekt — men pickup_time-feltet (vist prominent på
-- bon-kortet) stod tomt. Triggerne holder invarianten:
--   delivery_type='pickup'  ⟹  pickup_time = delivery_time
--
-- Leverings-bons røres ikke: deres pickup_time ejes af route_planner
-- (afhentning hos HQ beregnes baglæns fra leveringstid). Triggerne
-- fyrer kun WHEN delivery_type='pickup', og kun ved ændring af
-- delivery_type/delivery_time — ikke ved UPDATE af pickup_time selv.
-- ==========================================

-- Backfill: eksisterende afhentnings-bons der har en delivery_time.
-- v1-synkede afhentnings-bons har tiden direkte i pickup_time
-- (delivery_time = NULL) og røres ikke.
UPDATE bons
SET pickup_time = delivery_time
WHERE delivery_type = 'pickup'
  AND delivery_time IS NOT NULL AND delivery_time != ''
  AND COALESCE(pickup_time, '') != delivery_time;

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
