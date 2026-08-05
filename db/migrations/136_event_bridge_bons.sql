-- 136_event_bridge_bons.sql
-- ════════════════════════════════════════════════════════════
-- Event-broen får sin EGEN bon pr. (event, dag).
--
-- Hvorfor: broen reconciler ved fuld-erstat (slet alle linjer, indsæt
-- aggregatet). Indtil nu fandt den bare den første prep-bon på dagen — og
-- overskrev dermed en prep-bon office havde genereret ud fra forecast.
-- Det skete i drift: en forecast-bon med 133+133+133+20 blev reduceret til
-- "1 × Tunen" af én enkelt forudbestilling.
--
-- Antagelsen bag den gamle adfærd ("forudbestillingerne ER produktionen")
-- holder kun når ALT sælges i forvejen. Et event med både forecast-drevet
-- produktion og forudbestilling har to forskellige tal, og begge skal
-- overleve: planen (hvad vi regner med at sælge) og det konkret bestilte.
--
-- Derfor ejer broen kun bons den selv har oprettet, registreret her. Alt
-- andet rører den aldrig. UNIQUE(event_id, delivery_date) giver samtidig
-- idempotensen: samme dag → samme bon.
--
-- ON DELETE CASCADE begge veje: slettes eventet eller bonnen, forsvinder
-- koblingen med — så broen opretter en frisk bon næste gang.
-- ════════════════════════════════════════════════════════════

CREATE TABLE event_bridge_bons (
    id            INTEGER PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    delivery_date TEXT    NOT NULL,
    bon_id        INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, delivery_date)
);

CREATE INDEX idx_event_bridge_bon ON event_bridge_bons(bon_id);
