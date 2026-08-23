-- 157_event_returns.sql
-- ════════════════════════════════════════════════════════════
-- Spor på hvad der er bogført retur til HQ efter et event.
-- Issue #536. Spec: docs/CLAUDE_EVENT.md §5 (retur & afstemning).
--
-- `POST /api/events/:id/return` lagde de talte rester på HQ-lageret og skrev
-- en changelog-linje — men linjen blev ikke vist nogen steder, og kvitteringen
-- i UI'et var en flygtig statuslinje der forsvandt ved næste render. Efter en
-- genindlæsning så eventet ud som om der aldrig var bogført retur.
--
-- Det var ikke kun kosmetik. `computeReturnSuggestion` regner
-- `rest = preppet − solgt` og vidste intet om tidligere retur, så et tryk mere
-- på "Bogfør retur" foreslog de SAMME mængder og lagde dem på lageret IGEN.
-- Lageret blev for højt, og fejlen dukkede først op ved næste optælling som en
-- uforklarlig difference. Samme fejlklasse som #305 og #319: handlingen påstod
-- at være sket, bivirkningen efterlod intet spor, og de to mødtes aldrig.
--
-- Hver række er en HÆNDELSE, ikke en tilstand — derfor ingen UNIQUE på
-- (event_id, product_id). Man kan legitimt bogføre retur ad flere omgange:
-- første kørsel fejler delvist hos Grocy, eller der dukker mere op i traileren
-- dagen efter. Forslaget trækker summen af det allerede returnerede fra, så en
-- gentagelse foreslår resten frem for det hele.
--
-- `amount` er i STOCK-units, som resten af retur- og consume-stien.
-- `added_to_product_id` afviger fra `product_id` når returen blev omdirigeret
-- fra et parent-produkt uden eget lager (fx "kål") til det barn der faktisk
-- har varer — ellers ville sporet pege på et produkt Grocy aldrig rørte.
-- ════════════════════════════════════════════════════════════

CREATE TABLE event_returns (
    id                  INTEGER PRIMARY KEY,
    event_id            INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    product_id          INTEGER NOT NULL,
    product_name        TEXT,
    amount              REAL    NOT NULL,
    unit                TEXT,
    added_to_product_id INTEGER,
    booked_by_user_id   INTEGER REFERENCES users(id),
    booked_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    -- Én værdi pr. bogføring, så historikken kan grupperes entydigt. At
    -- gruppere på booked_at alene er utæt: tidsstemplet har sekund-opløsning
    -- (samme format som datetime('now')), så to bogføringer i samme sekund
    -- ville smelte sammen til én linje.
    booking_ref         TEXT
);

CREATE INDEX idx_event_returns_event ON event_returns(event_id);
CREATE INDEX idx_event_returns_ref ON event_returns(event_id, booking_ref);
