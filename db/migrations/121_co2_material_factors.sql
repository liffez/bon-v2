-- 121_co2_material_factors.sql
-- CO₂ F3 (#108) — materiale-faktortabel for emballage.
-- Spec: docs/CLAUDE_CO2.md §6 + §8 + §12 trin 3.
--
-- CONCITO dækker ~500 FØDEVARER, ikke emballage-materialer. Derfor en lille
-- egen reference i Bon v2: ~8 materialer, hver med én faktor (kg CO₂e/kg).
-- Materialer deles på tværs af mange varer → vedligehold ~8-15 faktorer,
-- ikke 33 varer.
--
-- Flow (§6): en emballagevare får tildelt ÉT materiale (Grocy-userfield
-- `co2e_material` = denne tabels `key`). Ved tildeling/re-resolve slår vi
-- faktoren op her og skriver `co2e_per_kg` + `co2e_source=material` +
-- `co2e_version` tilbage på Grocy-produktet.
--
-- `factor_kg_co2e_per_kg` er NULLABLE med vilje: tabellen seedes med de 8
-- startmaterialer UDEN tal (Katrine/bror udfylder løbende fra Klimakompasset).
-- Et materiale uden faktor kan stadig tildeles en vare — så mangler kun
-- selve tallet, og et enkelt PATCH + re-resolve fylder alle varer på én gang.

CREATE TABLE IF NOT EXISTS co2_material_factors (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    key                    TEXT    NOT NULL UNIQUE,   -- stabil nøgle, gemmes i Grocy co2e_material
    label                  TEXT    NOT NULL,          -- visningsnavn ("Bølgepap")
    factor_kg_co2e_per_kg  REAL,                      -- NULL = placeholder, udfyldes løbende
    version                TEXT,                      -- kildeversion ("Klimakompas 2025")
    typical_items          TEXT,                      -- fri-tekst hint (fra spec §6)
    sort_order             INTEGER NOT NULL DEFAULT 0,
    is_active              INTEGER NOT NULL DEFAULT 1,
    updated_at             TEXT
);

-- Startsæt (§6). Faktorer bevidst NULL — fyldes løbende fra Klimakompasset.
INSERT INTO co2_material_factors (key, label, typical_items, sort_order) VALUES
    ('boelgepap', 'Bølgepap',    'Transportkasser, pomfrit-/pizzabakker',  1),
    ('karton',    'Karton/pap',  'Salatbokse, RR/slider/børneboks',        2),
    ('papir',     'Papir',       'Servietter, bagepapir, etiketter',       3),
    ('ldpe',      'LDPE-film',   'Fryse-/vakuum-/turposer',                4),
    ('pet',       'PET',         'Klare kopper/bægre',                     5),
    ('pla',       'PLA/bagasse', 'Grønne engangsvarer',                    6),
    ('pp',        'PP',          'Gafler, rørepinde, låg',                 7),
    ('aluminium', 'Aluminium',   'Foliebakker',                            8)
ON CONFLICT(key) DO NOTHING;
