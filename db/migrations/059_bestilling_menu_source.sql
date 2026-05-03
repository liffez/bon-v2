-- ==========================================
-- 059_bestilling_menu_source.sql
-- Embed-bestillingsformular: vælg menu-kilde
--
-- 'manual' = redigeres i Settings → Bestilling — Menu (gemmes som JSON i settings-tabellen)
-- 'grocy'  = hentes live fra Grocy (sellable=1 recipes, kategori fra 'grupper' userfield)
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('bestilling.menu_source',
     'manual',
     'Kilde til menu på embed-formen: ''manual'' (settings-JSON) eller ''grocy'' (live fra Grocy)');
