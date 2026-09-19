-- 179 — Optællingen gemmes som objekt (#673, spec §14.4)
--
-- Indtil nu levede en optælling kun i browseren. Når "Gem og luk" var kørt,
-- var HVAD der blev talt, i HVILKEN enhed og med HVILKEN faktor væk — kun
-- Grocys nye lagertal stod tilbage. Faktordiagnosen (§14.9: "Frikadeller
-- afviger +5 % hver gang i Kasse → faktoren er for lav") kræver historik, og
-- hver optælling uden log er data vi aldrig får igen.
--
-- Tre niveauer:
--   stock_counts        ét tryk på Start i én Grocy-lokation
--   stock_count_lines   én vare talt i én fysisk enhed (KØL-1)
--   stock_count_entries hvert felt der blev tastet ("2 Kasse", "25 stk")
--
-- Afvigelser fra spec §4.2 (godkendt 19.09.2026):
--
--   * physical_unit_id ligger på LINJEN, ikke på optællingen. Én optælling
--     kan dække flere fysiske enheder via chips (KØL-1, KØL-2).
--     current_physical_unit_id på optællingen er kun et HINT om hvor tælleren
--     står lige nu — det driver advarslen ved samtidig optælling (#243).
--
--   * Hver linje har et UDFALD. Også varer hvor tallet passede eller hvor
--     lagerets tal blev beholdt, logges: at vi talte ER sket. Blev kun
--     rettelserne gemt, ville faktordiagnosen kun se de gange tallet var
--     forkert, og så ligner "+5 % hver gang" et mønster.
--
--   * site_location_id = hvilken Grocy (locations-tabellen). product_id er et
--     Grocy-id og betyder noget andet på grocytest end på grocy-hq.
--
-- factor_used er den faktor SERVEREN brugte (resolveToStockAmount), ikke
-- klientens — en browser der har stået åben siden i går kan regne med en
-- forældet omregning. Den skrives altid, også ved tælling i lager-enheden
-- (faktor 1, §15.11).

CREATE TABLE IF NOT EXISTS stock_counts (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    site_location_id         INTEGER REFERENCES locations(id),
    grocy_location_id        INTEGER NOT NULL,
    current_physical_unit_id INTEGER REFERENCES physical_units(id),
    status                   TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'saved', 'discarded')),
    user_id                  INTEGER REFERENCES users(id),
    started_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at              DATETIME
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_open
    ON stock_counts (grocy_location_id, status, started_at);

CREATE TABLE IF NOT EXISTS stock_count_lines (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    count_id           INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    product_id         INTEGER NOT NULL,
    product_name       TEXT,                 -- snapshot til læsning uden Grocy
    physical_unit_id   INTEGER REFERENCES physical_units(id),
    physical_unit_name TEXT NOT NULL,        -- snapshot: enheder kan omdøbes/arkiveres
    stock_qty          REAL NOT NULL,        -- talt, i lager-enhed
    expected_qty       REAL,                 -- Grocys tal da varen blev talt (hele varen)
    deviation_pct      REAL,                 -- kun når varen er talt i ÉN fysisk enhed
    sort_index         INTEGER,              -- rækkefølgen varen blev talt i (§7.3)
    outcome            TEXT NOT NULL
                       CHECK (outcome IN ('corrected', 'unchanged', 'kept_stock', 'failed')),
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Et nyt Gem-forsøg (fx efter en delvis Grocy-fejl) erstatter linjen i stedet
-- for at lægge en til.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_count_lines_unique
    ON stock_count_lines (count_id, product_id, physical_unit_name);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_product
    ON stock_count_lines (product_id);

CREATE TABLE IF NOT EXISTS stock_count_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id     INTEGER NOT NULL REFERENCES stock_count_lines(id) ON DELETE CASCADE,
    qu_id       INTEGER NOT NULL,
    qty         REAL NOT NULL,
    factor_used REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_count_entries_line
    ON stock_count_entries (line_id);
