-- ==========================================
-- 068_recipe_cost_cache_and_targets.sql
-- Opskrifter & priser (office margin-analyse)
--
-- Tre ændringer:
--   1) Recreate `item_prices` med `item_type`-kolonne (tabellen er tom
--      på tværs af kodebasen — drop+create er sikkert)
--   2) Ny `recipe_cost_cache` (cachet Grocy fulfillment-output)
--   3) Ny `recipe_db_targets` (DB%-mål pr. kategori, ingen seed)
--   4) Setting `recipe_prices_backfilled` til auto-backfill flow
--
-- Spec: docs/CLAUDE_OPSKRIFTER.md
-- Test: tests/specs/T_OPSKRIFTER.md
-- ==========================================

-- ─── 1) item_prices: tilføj item_type ─────────────────────────
-- Tabellen er tom — intet i routes/, services/, shared/, seed.js
-- skriver til den. Drop + recreate er trygt.

DROP TABLE IF EXISTS item_prices;

CREATE TABLE item_prices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type           TEXT NOT NULL
                        CHECK (item_type IN ('recipe', 'product', 'local')),
    item_id             INTEGER NOT NULL,
    price_category_id   INTEGER NOT NULL REFERENCES price_categories(id),
    price               REAL NOT NULL,    -- EX moms (autoritativ — se BON_V2_PRINCIPPER.md §6b)
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id),
    UNIQUE(item_type, item_id, price_category_id)
);

CREATE INDEX idx_item_prices_lookup ON item_prices(item_type, item_id);
CREATE INDEX idx_item_prices_category ON item_prices(price_category_id);

-- ─── 2) recipe_cost_cache ─────────────────────────────────────
-- Cachet output fra Grocy /recipes/fulfillment.
-- Refreshes via nightly cron (scripts/refresh-recipe-costs.js)
-- eller manuelt via POST /api/recipes/refresh-costs.

CREATE TABLE recipe_cost_cache (
    grocy_recipe_id      INTEGER PRIMARY KEY,
    cost_price_excl_moms REAL NOT NULL,
    -- ingredients_json: [{name, qty, unit, cost_excl_moms, pct_of_total}, ...]
    ingredients_json     TEXT NOT NULL DEFAULT '[]',
    co2e                 REAL,
    refreshed_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recipe_cost_cache_refreshed ON recipe_cost_cache(refreshed_at);

-- ─── 3) recipe_db_targets ─────────────────────────────────────
-- DB%-mål pr. Grocy-kategori. Ingen hardcoded seed — admin populerer
-- via ⚙ DB-mål-popoveren. Kategorier hentes dynamisk fra Grocy
-- userfield `grupper` på recipes.

CREATE TABLE recipe_db_targets (
    category            TEXT PRIMARY KEY,    -- Grocy-kategori-navn
    target_pct          REAL NOT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id)
);

-- ─── 4) Setting: backfill-flag ────────────────────────────────
-- '0' (default) → første overview-kald trigger auto-backfill fra Grocy
-- Salesprice*-userfields. '1' → backfill sprunget over.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('recipe_prices_backfilled',
     '0',
     'Sættes til ''1'' første gang Opskrifter & priser viewet har migreret salgspriser fra Grocy Salesprice*-userfields til item_prices. Skift til ''0'' for at trigge re-backfill ved næste overview-kald.');
