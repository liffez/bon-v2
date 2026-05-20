-- Migration 072: bon_menu_groups
--
-- Persisterer de visuelle grupper på køkken-bonens menu-liste.
-- Tidligere var gruppering ren DOM-manipulation uden persistering —
-- grupper forsvandt ved næste SSE-re-render eller sidereload.
--
-- Designnoter:
--   • bon_menu_groups holder titel + note + rækkefølge pr. bon.
--   • bon_lines.menu_group_id peger på gruppen (NULL = løs linje).
--   • PUT /api/bons/:id/menu-groups reconciler hele strukturen:
--     sletter alle grupper for bonen og genskaber dem fra payload.
--     Gruppe-id'er er derfor interne — frontenden refererer dem aldrig.

CREATE TABLE bon_menu_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id      INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'Gruppe',
    note        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bon_menu_groups_bon ON bon_menu_groups(bon_id);

-- NULL = løs linje. ON DELETE SET NULL = en slettet gruppe opløser sine linjer.
ALTER TABLE bon_lines ADD COLUMN menu_group_id INTEGER
    REFERENCES bon_menu_groups(id) ON DELETE SET NULL;
