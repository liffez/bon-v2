-- 153_recipe_cost_source.sql
-- ============================================================
-- `recipe_cost_cache` bar hidtil et tal fra Grocys `/recipes/fulfillment`.
-- Det felt viste sig upålideligt på fire uafhængige måder (#517): skaleret
-- efter `desired_servings`, forældet, forkert for bundter (#455), og med
-- forældre-produkter prissat til 0.
--
-- Cachen fyldes nu af `services/recipeCost.js`. To kolonner gør skiftet
-- ærligt frem for usynligt:
--
--   cost_source          hvor tallet kom fra — 'bon' eller 'grocy'
--   missing_prices_json  råvarer uden kendt pris, så et for lavt tal kan
--                        forklares i stedet for bare at være for lavt
--
-- Uden dem ville en opskrift med manglende priser se ud præcis som en der
-- er billig. Det er den samme stille fejlklasse resten af arbejdet handler om.
-- ============================================================

ALTER TABLE recipe_cost_cache ADD COLUMN cost_source TEXT;
ALTER TABLE recipe_cost_cache ADD COLUMN missing_prices_json TEXT;
