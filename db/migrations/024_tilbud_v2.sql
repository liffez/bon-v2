-- ==========================================
-- Tilbud v2: kundenote, per-blok pax, konfigurerbare bloktyper
-- ==========================================

-- Kundenote der vises på PDF (adskilt fra interne noter)
ALTER TABLE bons ADD COLUMN offer_note TEXT;

-- Per-blok metadata (JSON): { "lunch": { "pax": 80 } }
-- Kun blokke der afviger fra globalt pax gemmes
ALTER TABLE bons ADD COLUMN offer_block_metadata TEXT;

-- Konfigurerbare blok-typer til event-tilbud
INSERT OR IGNORE INTO settings (key, value, description) VALUES (
  'offer_block_types',
  '[{"key":"morning","label":"Morgenmad","sort_order":1},{"key":"amsnack","label":"Formiddagssnack","sort_order":2},{"key":"lunch","label":"Frokost","sort_order":3},{"key":"pmsnack","label":"Eftermiddagssnack","sort_order":4}]',
  'Blok-typer til event-tilbud (JSON-array med key, label, sort_order)'
);
