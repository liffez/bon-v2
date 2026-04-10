-- ==========================================
-- 031_duplicate_candidates.sql
-- Logger produkter der sandsynligvis er
-- duplikater — opdaget ved barcode-kobling
-- i bestillingsflowet.
-- ==========================================

CREATE TABLE IF NOT EXISTS duplicate_candidates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id_a        INTEGER NOT NULL,   -- Produktet brugeren ville koble til
    product_name_a      TEXT,
    product_id_b        INTEGER NOT NULL,   -- Produktet der allerede havde barcoden
    product_name_b      TEXT,
    barcode             TEXT NOT NULL,       -- Hørkram varenummer der afslørede duplikatet
    barcode_name        TEXT,               -- Hørkram produktnavn
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'merged', 'not_duplicate', 'ignored')),
    resolved_at         DATETIME,
    resolved_by_user_id INTEGER REFERENCES users(id),
    notes               TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dup_status ON duplicate_candidates(status);
