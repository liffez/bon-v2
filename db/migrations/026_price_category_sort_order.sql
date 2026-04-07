-- 026: Tilføj sort_order til price_categories (bruges af rapporter lego-chart)
ALTER TABLE price_categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE price_categories SET sort_order = 1 WHERE code = 'store';
UPDATE price_categories SET sort_order = 2 WHERE code = 'catering';
UPDATE price_categories SET sort_order = 3 WHERE code = 'festival';
UPDATE price_categories SET sort_order = 4 WHERE code = 'produktion';
UPDATE price_categories SET sort_order = 5 WHERE code = 'waiste';
