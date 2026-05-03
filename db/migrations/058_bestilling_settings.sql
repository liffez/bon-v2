-- ==========================================
-- 058_bestilling_settings.sql
-- Embed-bestillingsformular (ristetrug.dk/bestil)
--
-- Konfiguration der ellers ville være hardcoded i HTML:
--   - HQ-koordinat for OSRM-routing
--   - Cutoff-logik (global tid + per-ugedag)
--   - Leveringskonfiguration (cykel + taxa-zoner)
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('bestilling.base_lat',
     '55.6961',
     'HQ-koordinat (latitude) til OSRM leverings-estimat'),

    ('bestilling.base_lon',
     '12.5574',
     'HQ-koordinat (longitude) til OSRM leverings-estimat'),

    ('bestilling.cutoff_time',
     '12',
     'Sidste bestillingstime (24h) på en åben dag'),

    ('bestilling.cutoff_lead_days',
     '1',
     'Antal åbne dage før levering der skal være cutoff'),

    ('bestilling.delivery_days',
     'mon,tue,wed,thu,fri,sat',
     'Ugedage hvor vi leverer (CSV: mon,tue,wed,thu,fri,sat,sun)'),

    ('bestilling.cutoff_days',
     'mon,tue,wed,thu,fri,sat',
     'Ugedage der tæller som åbne for cutoff-nedtælling (samme format)'),

    ('bestilling.delivery_config',
     '{"cykel":{"basisPris":154,"ekstraKassePris":50,"gratisKasser":2,"maxKasser":4,"maxAfstand":8,"paxPerKasse":16},"taxa":{"zone3":{"postnumre":["2300","2720","2730","2820"],"pris":425},"zone4":{"postnumre":["2800","2600","2605","2625","2610","2650"],"pris":575},"zone5":{"postnumre":["2620","2760","2770","2750"],"pris":650}}}',
     'Leveringspriser og zoner — JSON. Cykel + taxa-zoner.'),

    ('bestilling.menu_standard',
     '{"menu_id":"standard","name":"Standard menu","version":"2026-05-01","categories":[{"id":"sandwich","name":"Sandwich"},{"id":"salater","name":"Salater"},{"id":"kage_dessert","name":"Kage & Dessert"},{"id":"drikke","name":"Drikke"}],"items":[{"id":"falaflen","name":"Falaflen","category":"sandwich","tags":["vegan"],"allergens":"Gluten, sesam","active":true},{"id":"tunen","name":"Tunen","category":"sandwich","tags":["fisk"],"allergens":"Gluten, fisk, æg","active":true},{"id":"kyllingen","name":"Kyllingen","category":"sandwich","tags":["kød"],"allergens":"Gluten, æg","active":true},{"id":"oliven_feta","name":"Oliven & Feta-salat","category":"salater","tags":["veg","gf"],"allergens":"Mælk","active":true},{"id":"chokoladekage","name":"Chokoladekage","category":"kage_dessert","tags":["veg"],"allergens":"Gluten, æg, mælk","active":true},{"id":"kaffe","name":"Termokande kaffe (1 L)","category":"drikke","tags":[],"allergens":"","active":true}]}',
     'Standard-menu (JSON). Redigeres via Settings → Bestilling → Menu.');
