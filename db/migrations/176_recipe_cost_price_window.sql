-- 176_recipe_cost_price_window.sql
-- ════════════════════════════════════════════════════════════
-- Vinduet kostprisen vægtes over (#557).
--
-- #557 er et FORSØG: 90 dage er valgt fordi alle de forkerte posteringer i
-- Grocy er fra 2024, men det rigtige tal kendes først når man har set hvor
-- mange varer vinduet faktisk fanger (målt 17. sep: 16 af 156 rammer snittet,
-- 127 falder tilbage på seneste køb — og 56 af dem ville et 180-dages vindue
-- fange). Derfor en indstilling og ikke en konstant i koden.
--
-- Den redigeres i ⚙-popoveren inde i Opskrifter & priser — dér den bruges —
-- og optræder bevidst IKKE i den globale settings-liste.
INSERT INTO settings (key, value)
VALUES ('recipe_cost_price_window_days', '90')
ON CONFLICT(key) DO NOTHING;
