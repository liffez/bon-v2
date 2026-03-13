-- 008_price_category.sql
-- Tilføj price_category TEXT direkte på bons-tabellen.
-- Simpel TEXT-kolonne i stedet for FK — matcher Grocy userfield-kategorier.

-- Tilføj manglende priskategorier til reference-tabellen
INSERT OR IGNORE INTO price_categories (code, label, is_default, is_active) VALUES
    ('store',      'Butik',      0, 1),
    ('produktion', 'Produktion', 0, 1),
    ('waiste',     'Waiste',     0, 1);

-- Tilføj price_category kolonne (SQLite understøtter ikke CHECK i ALTER TABLE)
ALTER TABLE bons ADD COLUMN price_category TEXT NOT NULL DEFAULT 'store';

-- Sæt eksisterende bons baseret på deres price_category_id
UPDATE bons SET price_category = (
    SELECT pc.code FROM price_categories pc WHERE pc.id = bons.price_category_id
) WHERE price_category_id IS NOT NULL;
