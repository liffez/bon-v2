-- Migration 055: companies.last_enriched_at + last_enriched_source
-- Sættes når et firma beriges via /api/companies/:id/enrich.
-- Bruges af batch-enrichment (Fase 7) til at finde firmaer der ikke
-- er beriget de sidste 90 dage.

ALTER TABLE companies ADD COLUMN last_enriched_at DATETIME;
ALTER TABLE companies ADD COLUMN last_enriched_source TEXT;
