-- ==========================================
-- 105_prospect_fit.sql
-- Prospekt-fit konfiguration (CRM Prospekter, Fase 1).
-- Adskilt fra rfm_config: rfm_config styrer staging (VIP/aktiv/sovende/lead),
-- disse styrer hvordan lead-firmaer rangeres som emner.
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('prospect_fit_w_branch',   '50',
   'Prospekt-fit: vægt på branche-match (hvor godt branchen ligner VIP-brancherne).'),
  ('prospect_fit_w_size',     '20',
   'Prospekt-fit: vægt på firmastørrelse (antal ansatte ift. typisk VIP). Holdes lav — VIP er store institutioner.'),
  ('prospect_fit_w_distance', '30',
   'Prospekt-fit: vægt på leveringsafstand (fugleflugt fra HQ). Nær = lettere at levere.'),
  ('prospect_distance_max_km', '',
   'Prospekt-filter: vis kun firmaer inden for så mange km fra HQ (fugleflugt). Tom = intet filter.'),
  ('prospect_branch_blacklist', '[]',
   'Prospekt-filter: JSON-array af branchenavne der aldrig er emner (fjernes fra listen).');
