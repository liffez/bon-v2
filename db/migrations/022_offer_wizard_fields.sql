-- ==========================================
-- Tilbuds-wizard felter på bons
-- (template, price_mode, discount til wizard-gendannelse)
-- ==========================================

ALTER TABLE bons ADD COLUMN offer_template TEXT
    CHECK (offer_template IN ('event', 'single', 'custom'));

ALTER TABLE bons ADD COLUMN offer_price_mode TEXT DEFAULT 'total'
    CHECK (offer_price_mode IN ('total', 'block', 'line'));

ALTER TABLE bons ADD COLUMN offer_discount_percent REAL DEFAULT 0;

-- block_type på bon_lines (til event-skabelon blokke)
ALTER TABLE bon_lines ADD COLUMN block_type TEXT;
