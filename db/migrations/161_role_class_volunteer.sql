-- 161_role_class_volunteer.sql
-- ════════════════════════════════════════════════════════════════════════
-- Frivillige som egen rolle (§18.3/§18.4).
--
-- De frivillige står allerede i Smartplan — de blev derfor talt med i
-- eventets MANDETIMER hele tiden, hvilket er rigtigt. Problemet var kronerne:
-- uden en timeløn i wage_rates blev de flagget "mangler timeløn", præcis som
-- en ansat hvis sats ikke er tastet ind. To vidt forskellige ting så ens ud:
--
--   frivillig       → 0 kr ER det rigtige tal
--   manglende sats  → lønnen er for lav, og nogen skal rette det
--
-- Målt på Smartplan juni–september: 18 personer har vagter på event-
-- lokationen, 10 af dem uden timeløn. 8 af de 10 ses ALDRIG på HQ (typiske
-- frivillige), 2 har også HQ-vagter (ansatte der mangler en sats). Advarslen
-- druknede altså de 2 ægte tilfælde i 8 falske.
--
-- Løsningen er en jobtype: Smartplan får en "Frivillig", og den mappes hertil.
-- Det skalerer af sig selv — næste sæsons frivillige kræver ingen oprydning,
-- de skal bare planlægges på den rigtige jobtype.
--
-- Fravalgt: en wage_rates-række med 0 kr. Den ville virke, men
-- getStandardHourlyRate midler ALLE satser, og den middelværdi bruges både
-- til eventets standardtimer og til opskrift-kalkulationen
-- (routes/recipes_overview.js). Ti nuller ville halvere "standard-
-- medarbejderens" timeløn et helt andet sted i systemet — en fjern
-- bivirkning ingen ville koble til frivillige på en festival.
--
-- Tabellen har hverken FK'er, triggers eller views hængende på sig og har
-- 3 rækker i drift, så CHECK-udvidelsen er en almindelig table-rebuild.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE smartplan_role_map_new (
    jobtype_uuid   TEXT    PRIMARY KEY,
    jobtype_title  TEXT,
    role_class     TEXT    NOT NULL DEFAULT 'other'
                            CHECK (role_class IN ('production', 'delivery', 'other', 'volunteer')),
    updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO smartplan_role_map_new (jobtype_uuid, jobtype_title, role_class, updated_at)
    SELECT jobtype_uuid, jobtype_title, role_class, updated_at FROM smartplan_role_map;

DROP TABLE smartplan_role_map;
ALTER TABLE smartplan_role_map_new RENAME TO smartplan_role_map;
