-- ==========================================
-- 012_day_contact.sql
-- Dagskontakt-felter på bons (per-bon override af kundedata)
-- ==========================================

ALTER TABLE bons ADD COLUMN day_contact_name  TEXT;
ALTER TABLE bons ADD COLUMN day_contact_phone TEXT;
