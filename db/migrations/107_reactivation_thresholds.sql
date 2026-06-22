-- ==========================================
-- 107_reactivation_thresholds.sql
-- Gør re-aktiverings-listens tærskler justerbare (var hardcodet i routes/rfm.js):
--   min. antal historiske ordrer + karantæne-dage efter seneste kontakt.
-- (recency_days = hvornår en kunde bliver "sovende" styres separat i rfm_config.)
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('reactivation_min_orders', '2',
   'Re-aktivering: mindste antal historiske ordrer før et sovende firma vises som emne.'),
  ('reactivation_quarantine_days', '30',
   'Re-aktivering: skjul firmaer der er kontaktet inden for så mange dage (undgå at ringe igen for hurtigt).');
