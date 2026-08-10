-- 141_consume_hardening.sql
--
-- Hærder de tre lager-mutationsstier efter at auto-deduct blev tændt i drift
-- (#305, 17. juli 2026). Fra det øjeblik er hver af disse fejl aktiv skade på
-- tal folk træffer indkøbsbeslutninger ud fra.
--
--   #358  Varemodtagelsen skrev indkøbs-enhed som lager-enhed.
--   #359  inventory_deducted blev sat selvom hvert Grocy-træk fejlede.
--   #361  POST /api/grocy/consume havde ingen idempotens — to klik = dobbelt træk.
--
-- Ingen data ændres her; migrationen tilføjer kun de felter fixene har brug for
-- for at kunne FORTÆLLE hvad der skete. Det var netop fraværet af et spor der
-- lod #358 køre uopdaget fra maj til juli.

-- ── #358: hvilken enhed stod det modtagne tal i? ─────────────────────────────
-- `unit` (TEXT) har hele tiden gemt enhedens NAVN, men et navn kan ikke bruges
-- til at konvertere med — og det var netop konverteringen der manglede. Vi gemmer
-- nu både den enhed brugeren tastede i (received_qu_id) og det tal der rent
-- faktisk gik til Grocy (received_quantity_stock), så en fremtidig afvigelse kan
-- afgøres uden at gætte.
ALTER TABLE goods_receipt_items ADD COLUMN received_qu_id INTEGER;
ALTER TABLE goods_receipt_items ADD COLUMN received_quantity_stock REAL;

-- ── #359: gjorde lagertrækket egentlig det den påstår? ───────────────────────
-- inventory_deducted er binært og kan kun sige "trukket/ikke trukket". Den kan
-- ikke skelne "alle 14 produkter trukket" fra "13 trukket, 1 fejlede" — og slet
-- ikke fra "hvert eneste kald fik 500". Statussen bærer den forskel.
--
--   ok                      alle produkter trukket
--   partial                 mindst ét produkt fejlede, mindst ét lykkedes
--                           (flaget SÆTTES — ellers ville en gentagelse
--                            dobbelt-trække dem der lykkedes)
--   failed                  intet blev trukket (flaget sættes IKKE — sikkert at
--                           gentage, og vagthunden fanger det)
--   empty                   der var intet at trække (ingen opskriftslinjer)
--   event_prep_owns_stock   bevidst sprunget over, jf. CLAUDE_EVENT.md §5
--
-- Ingen backfill: eksisterende rækker får NULL, hvilket ærligt betyder "ukendt —
-- trukket før vi begyndte at måle". At gætte 'ok' bagud ville være at opfinde
-- historik af præcis den slags der skjulte #358.
ALTER TABLE bons ADD COLUMN inventory_deduct_status TEXT;

-- ── #361: idempotens-journal for de manuelle consume-endpoints ───────────────
-- Samme mønster som produktionsbatchens batch_nonce (migration 089): klienten
-- genererer en nonce pr. HANDLING (ikke pr. forsøg), så et gentaget kald er en
-- opslagning frem for et nyt træk.
--
-- Rækken indsættes FØR trækket udføres og er dermed også et lock: to samtidige
-- klik kappes om UNIQUE-constrainten, og taberen får svaret fra vinderen i
-- stedet for at trække igen. Derfor er response_json nullable — 'in_progress'
-- er en ægte, observerbar tilstand.
--
-- Journalen er samtidig den kvittering #361 efterlyser: indtil nu var et manuelt
-- træk usynligt bagefter, så et dobbelttræk først blev opdaget ved næste fysiske
-- optælling — og da som en uforklarlig difference.
CREATE TABLE IF NOT EXISTS grocy_consume_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nonce         TEXT    NOT NULL UNIQUE,
    endpoint      TEXT    NOT NULL,          -- 'consume' | 'consume-products'
    user_id       INTEGER REFERENCES users(id),
    state         TEXT    NOT NULL DEFAULT 'in_progress'
                          CHECK (state IN ('in_progress','done','failed')),
    request_json  TEXT,
    response_json TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_grocy_consume_log_created
    ON grocy_consume_log (created_at DESC);
