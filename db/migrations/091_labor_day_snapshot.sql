-- 091_labor_day_snapshot.sql
-- ════════════════════════════════════════════════════════════
-- Snapshot-frys af driftsregnskab pr. dag (CLAUDE_DRIFTSREGNSKAB §7).
--
-- Afsluttede dage (dato < i dag, realiseret) fryses ved første visning, så
-- tallene ikke skrider bagudrettet når Smartplan-vagtplanen senere ændres.
-- data_json gemmer hele det beregnede /day-resultat. Kun admin kan genberegne
-- (overskrive snapshot fra aktuelle tal) — derfor frozen_by_user_id + frozen_at.
-- ════════════════════════════════════════════════════════════

CREATE TABLE labor_day_snapshot (
    id                 INTEGER PRIMARY KEY,
    location_id        INTEGER,
    snapshot_date      TEXT    NOT NULL,                 -- 'YYYY-MM-DD'
    mode               TEXT    NOT NULL DEFAULT 'realiseret',
    data_json          TEXT    NOT NULL,                 -- frosset /day-resultat
    frozen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    frozen_by_user_id  INTEGER,
    UNIQUE (location_id, snapshot_date, mode)
);

CREATE INDEX idx_labor_snapshot_date ON labor_day_snapshot(snapshot_date);
