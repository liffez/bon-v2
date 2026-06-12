-- 102_prep_packing_extras.sql
-- ════════════════════════════════════════════════════════════
-- Ekstra buffer-varer på event-prep-bons.
-- Spec: docs/CLAUDE_EVENT.md §6 (buffer-pakning) — udvidelse.
--
-- Pakkelisten viser nu produktions-niveau: færdige varer som de læsses
-- (brød, sylt, dressinger blandet hjemmefra), IKKE de BOM-eksploderede
-- råvarer. Køkkenet tager ofte lidt EKSTRA med ud over opskrifterne —
-- fx 1 kg ekstra mayonnaise — som sin egen vare ved siden af.
--
-- Forskellen fra prep_packing_overrides:
--   override (097): ERSTATTER den beregnede mængde for en vare der ER i
--                   opskriften (buffer-in-place på en direkte vare).
--   extra (denne):  LÆGGER en vare OVENI opskrifts-forbruget. Varen behøver
--                   ikke være i nogen opskrift — fx mayonnaise der ellers kun
--                   findes inde i en dressing-underopskrift.
--
-- VIGTIGT — extra er forretnings-sand: når prep-bonnen sættes til LEVERET,
-- trækker Grocy ekstra-mængden fra HQ OVENI det opskrifterne forbruger.
-- Se db/helpers.js autoConsumeBonInventory + grocyAdapter.consumeRecipes.
--
-- amount er i STOCK-units (samme enhed som consume bruger og som pakkelisten
-- viser). product_name + unit gemmes som snapshot til visning uden re-resolve.
--
-- UNIQUE(bon_id, product_id) → idempotent PUT-reconcile. Adderer man samme
-- vare to gange, summeres den i én linje i UI'et inden gem.
-- Separat tabel fra overrides så (bon, produkt) kan optræde begge steder
-- (fx ekstra brød oveni et brød-override) uden UNIQUE-kollision.
-- ════════════════════════════════════════════════════════════

CREATE TABLE prep_packing_extras (
    id              INTEGER PRIMARY KEY,
    bon_id          INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL,
    product_name    TEXT,
    amount          REAL    NOT NULL,
    unit            TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bon_id, product_id)
);

CREATE INDEX idx_prep_packing_extras_bon ON prep_packing_extras(bon_id);
