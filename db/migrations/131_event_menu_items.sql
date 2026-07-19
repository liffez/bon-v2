-- 131_event_menu_items.sql
-- ════════════════════════════════════════════════════════════
-- Eventets prisliste — hvad vi sælger på pladsen, og til hvilken pris.
-- Spec: docs/CLAUDE_EVENT.md §16.
--
-- Hvorfor tabellen findes: menuen fandtes før kun IMPLICIT som unionen af
-- prep-bonnens linjer, og prisen var hvad salgs-prefillen tilfældigvis hentede
-- fra Grocys festivalpris den dag den første salgsbon blev oprettet. Det gav
-- tre driftsproblemer:
--   1. Prisen fandtes ikke før første salg — skiltet på vognen kunne ikke laves.
--   2. En pris justeret på pladsen levede kun i den ene salgsbons linjer. Næste
--      dags salgsbon faldt lydløst tilbage til Grocys pris.
--   3. En ret fundet på pladsen havde intet hjem og skulle tastes hver dag.
--
-- ⚠️  unit_price er INCL MOMS.
-- Det er hvad gæsten betaler, og det matcher bon_lines.unit_price
-- (moms-doktrin §6b), så salgs-prefill ikke skal konvertere.
-- Den eksisterende item_prices-tabel (migration 068) gemmer derimod EX MOMS.
-- "Retter" nogen senere denne kolonne til at matche den, går ALLE eventpriser
-- 25 % galt. De to tabeller har bevidst hver sit momsgrundlag — læs §6b før
-- du rører ved nogen af dem.
--
-- grocy_recipe_id er NULL for fritekst-linjer ("ret fundet på pladsen").
-- Uden opskrift er der ingen BOM ⇒ ingen kostpris, ingen CO₂, ingen påvirkning
-- af rest-/retur-beregningen. Omsætningen tæller. Id'et bæres med hvor det kan,
-- fordi prissammenligning på tværs af events er en aktiv arbejdsgang, og navne
-- driver over tid mens id'er ikke gør. Fritekst-linjer kan kun matches på navn
-- — accepteret begrænsning.
--
-- Ingen prisversionering: prisen ligger normalt fast når vi først er i gang, og
-- salgsbonnerne har allerede snapshottet prisen pr. dag. I stedet markeres en
-- menurække diskret i UI'et hvis en salgsbons linjepris afviger fra den —
-- billigt sikkerhedsnet frem for et versioneringslag.
--
-- UNIQUE(event_id, grocy_recipe_id) WHERE grocy_recipe_id IS NOT NULL:
-- partielt indeks, fordi SQLite ellers ville lade NULL-rækker kollidere frit —
-- men vi vil netop tillade FLERE fritekst-linjer pr. event. Navne-unikhed for
-- dem håndhæves i generate-stien i routes/events.js.
-- ON DELETE CASCADE: slettes eventet, forsvinder menuen med det (som forecast).
-- ════════════════════════════════════════════════════════════

CREATE TABLE event_menu_items (
    id              INTEGER PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    grocy_recipe_id INTEGER,
    product_name    TEXT    NOT NULL,
    category        TEXT,
    unit            TEXT    NOT NULL DEFAULT 'stk',
    unit_price      REAL    NOT NULL DEFAULT 0,   -- INCL moms (se hovedkommentar)
    sort_order      INTEGER NOT NULL DEFAULT 0,
    note            TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_event_menu_recipe
    ON event_menu_items(event_id, grocy_recipe_id)
    WHERE grocy_recipe_id IS NOT NULL;

CREATE INDEX idx_event_menu_event ON event_menu_items(event_id, sort_order);
