-- 187: Målvægt — en norm pr. kategori, og en afvigelse pr. opskrift
--
-- «Hvad sigter vi på at en sandwich vejer» er ikke en egenskab ved ÉN
-- opskrift — det er en norm for en slags mad. Grocy har intet felt der kan
-- bære den, og normen hører alligevel ikke hjemme i opskriften (spec §2).
--
-- `recipe_db_targets` bærer allerede præcis den slags norm pr. Grocy-kategori
-- (DB%-målet, migration 068). Målvægten hører samme sted: ét sted at
-- vedligeholde, ét sted at slå op. Men en kategori kan sagtens have en
-- målvægt uden et DB%-mål — og omvendt — så `target_pct` må ikke længere
-- være NOT NULL. SQLite kan ikke lempe en kolonne, så tabellen genskabes.
--
-- Ingen view, trigger eller fremmednøgle peger på tabellen (efterprøvet), så
-- genskabelsen er en ren kopi.

CREATE TABLE recipe_db_targets_ny (
    category            TEXT PRIMARY KEY,   -- Grocy-kategori-navn
    target_pct          REAL,               -- DB%-mål. NULL = kategorien har kun en målvægt
    target_weight_g     REAL,               -- madvægt i gram. NULL = ingen norm
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id)
);

INSERT INTO recipe_db_targets_ny (category, target_pct, updated_at, updated_by_user_id)
    SELECT category, target_pct, updated_at, updated_by_user_id FROM recipe_db_targets;

DROP TABLE recipe_db_targets;
ALTER TABLE recipe_db_targets_ny RENAME TO recipe_db_targets;

-- En enkelt ret må gerne afvige fra sin kategoris norm — en børneportion
-- vejer ikke det samme som en voksen-sandwich. Kun afvigelsen gemmes; er
-- rækken der ikke, gælder kategoriens tal.
CREATE TABLE recipe_target_weights (
    recipe_id           INTEGER PRIMARY KEY,  -- Grocy-opskrift
    target_weight_g     REAL NOT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id)
);
