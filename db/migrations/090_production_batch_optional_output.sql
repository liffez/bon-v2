-- 090_production_batch_optional_output.sql
-- ════════════════════════════════════════════════════════════
-- Gør grocy_output_product_id NULLABLE.
--
-- RR Produktion-opskrifter uden et produceret produkt ("RR produktion Hurtig":
-- Frisk Grønt, Remoulade, Senneps Mayo …) bruger råvarer når de laves, men
-- resultatet lægges IKKE på lager som et produkt. En consume-only batch
-- trækker råvarerne (med afvigelser) uden self-production add → intet output.
--
-- Tabel-rebuild (samme mønster som 041): SQLite kan ikke droppe NOT NULL
-- in-place. Kolonne-rækkefølge er identisk med 089, så `INSERT ... SELECT *`
-- mapper korrekt.
-- ════════════════════════════════════════════════════════════

PRAGMA foreign_keys = OFF;

CREATE TABLE production_batches_new (
    id                      INTEGER PRIMARY KEY,
    location_id             INTEGER NOT NULL REFERENCES locations(id),
    grocy_recipe_id         INTEGER NOT NULL,
    grocy_output_product_id INTEGER,                   -- NULLABLE: consume-only batches har intet output
    portions                REAL    NOT NULL DEFAULT 1,
    planned_output_qty      REAL    NOT NULL,
    actual_output_qty       REAL,
    output_unit             TEXT    NOT NULL,
    batch_nonce             TEXT    NOT NULL UNIQUE,
    state                   TEXT    NOT NULL DEFAULT 'draft'
                              CHECK (state IN ('draft','produced','failed','partial','reversed')),
    produce_transaction_id  TEXT,
    master_cost             REAL,
    actual_cost             REAL,
    notes                   TEXT,
    produced_at             TEXT,
    produced_by_user_id     INTEGER,
    reversed_at             TEXT,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO production_batches_new SELECT * FROM production_batches;

DROP TABLE production_batches;
ALTER TABLE production_batches_new RENAME TO production_batches;

CREATE INDEX idx_prod_batches_recipe ON production_batches(grocy_recipe_id);
CREATE INDEX idx_prod_batches_date   ON production_batches(produced_at);

PRAGMA foreign_keys = ON;
