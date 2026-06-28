-- 113_recipe_unit_counts.sql
-- Boks-aware enheds-tælling.
--
-- Problem: bons.total_units talte hver linje som SUM(quantity) pr. tællende
-- kategori. En "slider boks" (Grocy recipe 77/78) er ét styk i bon_lines, men
-- INDEHOLDER 3 sliders — så 15 bokse blev talt som 15 i stedet for 45.
--
-- Løsning: en cachet tabel der pr. Grocy-recipe gemmer hvor mange tællelige
-- enheder ÉT styk svarer til (3 for kombo-bokse, 1 for almindelige
-- sandwich/salat/slider + Børne Bokse, 0 for emballage/levering/drikke osv.).
-- Tabellen genopbygges fra Grocy (recipes_nestings + grupper-userfield) af
-- services/recipeUnits.js. recalcBonTotalUnits joiner mod den og forbliver
-- synkron (ingen Grocy i hot-path). Samme mønster som recipe_cost_cache.

CREATE TABLE IF NOT EXISTS recipe_unit_counts (
    grocy_recipe_id INTEGER PRIMARY KEY,
    unit_count      REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hvilke Grocy-recipes der tæller som 1 enhed selvom deres kategori ikke er i
-- unit_count_categories. Børne Bokse (recipe 71 = Delle, 72 = Fisk) ligger i
-- den blandede kategori "Tilbehør & Bokse" (sammen med brød/boller/suppe/snacks
-- der IKKE skal tælle), så de udpeges eksplicit her. Redigeres i Settings.
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('unit_count_extra_recipes',
   '[71,72]',
   'JSON-array af Grocy recipe-id der tæller som 1 enhed selvom kategorien ikke er i unit_count_categories (fx Børne Bokse i den blandede kategori "Tilbehør & Bokse"). Redigeres i Settings → System → Enheds-kategorier.');
