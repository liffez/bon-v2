-- ==========================================
-- 106_prospect_distance_min.sql
-- Nedre grænse for prospekt-afstandsfilter, så office kan vælge et
-- km-INTERVAL (fx 5–15 km) i stedet for kun en øvre grænse.
-- Symmetrisk med prospect_distance_max_km (migration 105).
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('prospect_distance_min_km', '',
   'Prospekt-filter: vis kun firmaer mindst så mange km fra HQ (fugleflugt). Tom = ingen nedre grænse.');
