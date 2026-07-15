-- 127_flag_show_in_kitchen.sql
-- Køkken-synlige kunde-/firma-påmindelser.
--
-- Nogle påmindelser er leverings-relevante ("send cookies næste gang",
-- "husk allergi-mærkning") og skal med til pakningen — køkkenet skal se dem.
-- Andre er rent kontor ("fakturaer til Anne, ikke faktura@").
--
-- show_in_kitchen = 1 (default) → vises på køkken-kort + info-modal (read-only).
-- show_in_kitchen = 0 → kun kontor (drawer/CRM).
--
-- ADD COLUMN med DEFAULT 1 udfylder eksisterende rækker automatisk → de bliver
-- køkken-synlige (jf. beslutning: default vis for køkken).

ALTER TABLE entity_flags ADD COLUMN show_in_kitchen INTEGER NOT NULL DEFAULT 1;
