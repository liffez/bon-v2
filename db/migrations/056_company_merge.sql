-- Migration 056: Forberedelser til manuel firma-sammenlægning (Fase 8)
-- - companies.alternate_names: JSON-array af "tidligere firmanavne" så søg
--   stadig kan finde et firma efter merge (fx hvis man søger på det gamle navn).
-- - changelog.rolled_back_at: markering af at en merge er rullet tilbage via
--   scripts/undo-merge.js. Forhindrer at samme rollback køres to gange.

ALTER TABLE companies ADD COLUMN alternate_names TEXT;     -- JSON-array, fx '["Foo I/S","RH HM"]'
ALTER TABLE changelog ADD COLUMN rolled_back_at DATETIME;
