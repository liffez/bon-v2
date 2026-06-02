-- 089_production_batches.sql
-- ════════════════════════════════════════════════════════════
-- Produktionsbatch (MVP) — log-opskrift / batch record.
-- Spec: docs/CLAUDE_PRODUKTION_MVP.md §9.
--
-- RR Produktion-opskrifter afviger ofte på produktionsdagen. Opskriften er
-- en immutabel skabelon; hver produktion er en kopi med dagens faktiske tal.
-- MVP'en rører ALDRIG Grocys recipe-consume (alt-eller-intet) — hvert
-- lagertræk drives manuelt pr. faktisk mængde + en self-production add.
--
-- Skemaet er identisk med den fulde IMPL-spec (§10), så MVP→fuld er rent
-- additivt. MVP bruger bare ikke alle state-værdier endnu (draft/produced/partial).
--
-- MOMS: master_cost, actual_cost og unit_cost er ALLE ex moms — råvarekost
-- fra Grocy er ex moms, og produktion momses ikke (jf. BON_V2_PRINCIPPER §6b).
-- ════════════════════════════════════════════════════════════

CREATE TABLE production_batches (
    id                      INTEGER PRIMARY KEY,
    location_id             INTEGER NOT NULL REFERENCES locations(id),
    grocy_recipe_id         INTEGER NOT NULL,
    grocy_output_product_id INTEGER NOT NULL,
    portions                REAL    NOT NULL DEFAULT 1,
    planned_output_qty      REAL    NOT NULL,
    actual_output_qty       REAL,
    output_unit             TEXT    NOT NULL,
    batch_nonce             TEXT    NOT NULL UNIQUE,   -- idempotens-vagt (R7)
    state                   TEXT    NOT NULL DEFAULT 'draft'
                              CHECK (state IN ('draft','produced','failed','partial','reversed')),
    produce_transaction_id  TEXT,                      -- Grocy self-production tx-id
    master_cost             REAL,                      -- Σ master×enhedskost, ex moms (svind-reference)
    actual_cost             REAL,                      -- Σ actual×enhedskost, ex moms (= price×yield)
    notes                   TEXT,
    produced_at             TEXT,
    produced_by_user_id     INTEGER,
    reversed_at             TEXT,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE production_batch_consumption (
    id                        INTEGER PRIMARY KEY,
    production_batch_id       INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
    grocy_product_id          INTEGER NOT NULL,
    product_name              TEXT    NOT NULL,        -- snapshot
    planned_qty               REAL    NOT NULL,        -- master × portioner (0 = ikke i opskrift)
    actual_qty                REAL    NOT NULL,        -- reelt brugt, stock-enhed (0 = udeladt)
    unit                      TEXT    NOT NULL,
    deviation_reason          TEXT
                                CHECK (deviation_reason IN ('justeret','udeladt','byttet','tilfoejet','spild') OR deviation_reason IS NULL),
    substitute_for_product_id INTEGER,
    grocy_transaction_id      TEXT,                    -- NULL hvis actual=0 (intet kald)
    unit_cost                 REAL,                    -- ex moms, snapshot fra Grocy fulfillment
    created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pbc_batch          ON production_batch_consumption(production_batch_id);
CREATE INDEX idx_prod_batches_recipe ON production_batches(grocy_recipe_id);
CREATE INDEX idx_prod_batches_date   ON production_batches(produced_at);
