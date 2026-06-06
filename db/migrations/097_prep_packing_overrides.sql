-- 097_prep_packing_overrides.sql
-- ════════════════════════════════════════════════════════════
-- Manuelle pakke-justeringer på event-prep-bons.
-- Spec: docs/CLAUDE_EVENT.md §6 (buffer-pakning).
--
-- Pakkelisten viser BOM-eksploderede råvarer beregnet fra opskrifterne.
-- Køkkenet vil ofte tage MERE med end opskriften kræver ("vi tager hele
-- brødposen med" / lidt buffer). En override pr. (bon, produkt) erstatter
-- den beregnede mængde med den faktisk pakkede mængde.
--
-- VIGTIGT — overriden er forretnings-sand: når prep-bonnen sættes til
-- LEVERET, trækker Grocy den OVERRIDEDE mængde fra HQ (ikke den beregnede),
-- fordi det er det der fysisk forlod huset. Det ekstra (buffer) kommer hjem
-- i returen. Se db/helpers.js autoConsumeBonInventory + grocyAdapter.consumeRecipes.
--
-- packed_amount er i STOCK-units (samme enhed som consume bruger og som
-- pakkelisten viser). product_name + unit gemmes som snapshot til visning
-- uden at re-resolve BOM'en.
--
-- UNIQUE(bon_id, product_id) → idempotent PUT-reconcile.
-- ON DELETE CASCADE: sletter eventet/bonen → forsvinder med.
-- ════════════════════════════════════════════════════════════

CREATE TABLE prep_packing_overrides (
    id              INTEGER PRIMARY KEY,
    bon_id          INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL,
    product_name    TEXT,
    packed_amount   REAL    NOT NULL,
    unit            TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bon_id, product_id)
);

CREATE INDEX idx_prep_packing_bon ON prep_packing_overrides(bon_id);
