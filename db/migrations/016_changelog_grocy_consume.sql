-- 016: Udvid changelog action CHECK til at inkludere grocy_consume
-- SQLite kan ikke ALTER CHECK constraints, så vi re-opretter tabellen

-- 1. Opret ny tabel med udvidet CHECK
CREATE TABLE changelog_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    action      TEXT NOT NULL
                CHECK (action IN ('create', 'update', 'delete', 'status_change', 'grocy_consume')),
    field_name  TEXT,
    old_value   TEXT,
    new_value   TEXT,
    user_id     INTEGER REFERENCES users(id),
    notes       TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Kopiér alle eksisterende data
INSERT INTO changelog_new SELECT * FROM changelog;

-- 3. Drop gammel tabel og omdøb
DROP TABLE changelog;
ALTER TABLE changelog_new RENAME TO changelog;

-- 4. Genskab index
CREATE INDEX IF NOT EXISTS idx_changelog_entity ON changelog(entity_type, entity_id);
