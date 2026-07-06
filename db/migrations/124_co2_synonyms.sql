-- 124_co2_synonyms.sql
-- CO₂ — synonym-par flyttet fra hardcodet kode til data (synlig + redigerbar).
-- Spec: docs/CLAUDE_CO2.md §6/§8 (dublet-varer deler faktor).
--
-- Baggrund: synonymerne (kål↔Hvidkål osv.) lå i services/co2Concito.js som en
-- SKJULT liste — man kunne ikke se/verificere dem i appen ("usynlig fælde").
-- Nu er de data: importen læser dem herfra, og CO₂-rapporten viser + redigerer
-- dem. Angives som produkt-DISPLAY-navne; normaliseres ved match.
--
-- Kanonisk = varen der HAR faktoren (fra Katrines ark). Synonym = dublet-varen
-- der skal arve samme faktor.

CREATE TABLE IF NOT EXISTS co2_synonyms (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT    NOT NULL,   -- varen med faktoren (fx "BurgerLommer - alm")
    synonym_name   TEXT    NOT NULL,   -- dublet der arver den (fx "Små Burgerlommer")
    note           TEXT,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (canonical_name, synonym_name)
);

-- Seed med de par der hidtil lå hardcodet (Leif-bekræftet).
INSERT INTO co2_synonyms (canonical_name, synonym_name, note) VALUES
    ('Hvidkål',           'kål',              'Grocy parent_product_id: Hvidkål er barn af kål'),
    ('Rødløg - Rå',       'Rødløg - Sylt',    'Samme rødløg, rå vs syltet'),
    ('Løvstikke - Frisk', 'Løvstikke pakke',  'Samme løvstikke'),
    ('BurgerLommer - alm','Små Burgerlommer', 'Samme brød, forskellig størrelse (låser sliderne op)'),
    ('Rødkål - Rå',       'Rødkål - Sylt',    'Samme rødkål, rå vs syltet')
ON CONFLICT (canonical_name, synonym_name) DO NOTHING;
