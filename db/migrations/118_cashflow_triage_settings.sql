-- 118_cashflow_triage_settings.sql
-- ════════════════════════════════════════════════════════════════════════
-- Pengestrøm §2.F.6: kategori-triage af "kan ikke matches"-listen (Leifs model).
--
-- 1) Hæv leverings-tolerancen 350 → 400 (bankbeløb må være op til 400 kr over
--    fakturaen: variabel levering + miljøgebyr). Kun hvis stadig på default 350.
-- 2) cf_check_large_threshold: stort beløb UDEN fakturareference løftes som
--    "muligt event uden bon" (🔍). Default 3000 kr.
-- 3) cf_accounts_closed_year: regnskabsår der er afleveret/godkendt. Faktura-
--    betalinger fra/før det år foldes som afregnet; senere år tjekkes mod e-conomic.
--    Default 2025. Rykkes når 2026 lukkes.
-- ════════════════════════════════════════════════════════════════════════

UPDATE settings SET value = '400' WHERE key = 'cf_match_extra_tolerance_max' AND value = '350';

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('cf_check_large_threshold', '10000',
   'Pengestrøm: beløbsgrænse for "store ukoblede beløb" — indbetalinger uden fakturareference over denne grænse løftes til tjek (muligt event uden bon / overførsel der bør verificeres), alle år'),
  ('cf_accounts_closed_year', '2025',
   'Pengestrøm: seneste afleverede/godkendte regnskabsår. Fakturabetalinger fra/før foldes som afregnet; senere tjekkes mod e-conomic');
