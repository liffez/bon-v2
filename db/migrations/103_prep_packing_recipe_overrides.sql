-- 103_prep_packing_recipe_overrides.sql
-- ════════════════════════════════════════════════════════════
-- Skalering af underopskrifter på event-prep-bons.
-- Spec: docs/CLAUDE_EVENT.md §6 (buffer-pakning) — udvidelse.
--
-- En underopskrift (Frisk Grønt, Senneps Mayo, dressinger) vises på
-- pakkelisten som ét færdigt item — men den har INGEN lagervare i Grocy;
-- den er sat sammen af flere råvarer (kål, spinat, mayo-base, sennep …).
--
-- Vil køkkenet tage MERE Frisk Grønt med, kan man ikke bare overrider ét
-- produkt (som med Brød Rug) — der skal trækkes proportionalt mere af ALLE
-- dens råvarer. Derfor gemmer vi en SKALERINGSFAKTOR pr. (bon, underopskrift):
--   factor = ønsket mængde / standard-beregnet mængde
-- fx 1,17 = "tag 17 % mere Frisk Grønt med".
--
-- Ved LEVERET ganges faktoren på underopskriftens råvare-multiplier i
-- ingredientResolver.resolveConsumeItems → råvarerne (og evt. dybere
-- underopskrifter) skaleres tilsvarende. Forhåndsvisningen viser det samme.
--
-- Forskellen fra de to andre buffer-mekanismer:
--   override (097): ERSTATTER mængden for ÉN lagervare (direkte vare).
--   extra (102):    LÆGGER en konkret lagervare OVENI.
--   recipe (denne): SKALERER en underopskrifts råvarer proportionalt.
--
-- factor lagres som ratio (enhedsuafhængig). UNIQUE(bon_id, recipe_id) →
-- idempotent PUT-reconcile. ON DELETE CASCADE med bonen.
-- ════════════════════════════════════════════════════════════

CREATE TABLE prep_packing_recipe_overrides (
    id          INTEGER PRIMARY KEY,
    bon_id      INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    recipe_id   INTEGER NOT NULL,
    factor      REAL    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bon_id, recipe_id)
);

CREATE INDEX idx_prep_packing_recipe_ov_bon ON prep_packing_recipe_overrides(bon_id);
