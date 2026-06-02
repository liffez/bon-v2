-- ==========================================
-- Migration 088 — Driftsregnskab: løn-fundament
-- Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §6a + §9
--
-- Smartplan-payloadet bærer KUN timer (verificeret 2. juni 2026 via
-- scripts/dump-worklog-payload.js) — ingen sats/beløb/løntype, intet
-- løn-endpoint. Derfor lokal sats-tabel + lokal rolle-mapping.
--
-- To tabeller:
--   wage_rates       — timeløn per medarbejder (owner.uuid), tidsversioneret
--   smartplan_role_map — jobtype.uuid → {production|delivery|other}
--
-- Begge er bevidst TOMME efter migration: jobtype/owner-uuid'er er
-- konto-specifikke (test ≠ prod), så seed sker via sync/Settings, ikke i SQL.
-- ==========================================

-- ------------------------------------------
-- wage_rates — timeløn per medarbejder
-- Løn ligger per medarbejder og er samme sats uanset jobtype (salg, assistent,
-- bud), så smartplan_ref = Smartplan owner.uuid — IKKE jobtype.
-- Tidsversioneret: en lønstigning må ikke ændre historiske regnskaber.
-- Opslag for en given dato:
--   valid_from <= dato AND (valid_to IS NULL OR dato < valid_to)
-- ------------------------------------------
CREATE TABLE wage_rates (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    smartplan_ref  TEXT    NOT NULL,            -- Smartplan owner.uuid (medarbejder)
    employee_name  TEXT,                        -- denormaliseret cache til visning/admin
    hourly_rate    REAL    NOT NULL,            -- ex moms, samme sats uanset jobtype
    valid_from     TEXT    NOT NULL,            -- 'YYYY-MM-DD'
    valid_to       TEXT,                        -- NULL = gældende; ellers eksklusiv øvre grænse
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_wage_rates_ref ON wage_rates(smartplan_ref);

-- Én sats per medarbejder per startdato → CSV-import kan upserte rent
-- (INSERT ... ON CONFLICT) og er idempotent ved gen-import.
CREATE UNIQUE INDEX idx_wage_rates_ref_from ON wage_rates(smartplan_ref, valid_from);

-- ------------------------------------------
-- smartplan_role_map — jobtype.uuid → role_class
-- jobtype er rollesignalet (Smartplan har intet rolle-felt). Nøgles på
-- jobtype.uuid fordi titler ikke er unikke (fx tre forskellige "ZOO").
-- role_class:
--   production → tæller i kapacitetsrate + lønandel (kok/salg/assistent)
--   delivery   → ekskluderet fra driften, isoleres i leveringsmodulet (bud)
--   other      → vises, men tæller hverken i rate eller lønandel
-- Ukendte/nye jobtyper findes ikke her → laborAdapter defaulter til 'other'
-- og flagger, så de ikke tavst forsvinder ud af rate-beregningen.
-- ------------------------------------------
CREATE TABLE smartplan_role_map (
    jobtype_uuid   TEXT    PRIMARY KEY,
    jobtype_title  TEXT,                         -- denormaliseret cache til visning
    role_class     TEXT    NOT NULL DEFAULT 'other'
                            CHECK (role_class IN ('production', 'delivery', 'other')),
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
