-- 095_events.sql
-- ════════════════════════════════════════════════════════════
-- Event-modul (let event: alt fra HQ).
-- Spec: docs/CLAUDE_EVENT.md §8.
--
-- Flerdags-event hvor ALT hentes fra HQ og INTET købes ind på pladsen.
-- "Magien" er en foreign key + en query: bons bindes til et event via
-- bons.event_id, og event-viewet orkestrerer fire roller (prep, top-up,
-- salg, udgift) + retur — alle som ganske almindelige bons.
--
-- model-kolonnen er per-event-gaten mod festival-modellen (lokalt indkøb →
-- sporet event-lager i egen Grocy). 'light' = denne spec; 'festival' =
-- den separat-specede multi-lokation-model. Kun 'light' implementeres her.
--
-- LAGERTRÆK: event-salgsbons (kontant/faktura → LEVERET) må IKKE trække
-- HQ-lager — prep-/top-up-bonnerne (price_category='produktion') ejer
-- trækket. Den regel håndhæves i kode (db/helpers.js autoConsumeBonInventory),
-- ikke i skemaet, og er stramt scoped til event_id.
--
-- event_id er nullable → alle eksisterende bons er uberørte.
-- ════════════════════════════════════════════════════════════

CREATE TABLE events (
    id                  INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL,
    location_id         INTEGER NOT NULL REFERENCES locations(id),   -- HQ for let event
    model               TEXT    NOT NULL DEFAULT 'light'
                          CHECK (model IN ('light','festival')),     -- per-event-gaten
    start_date          DATE    NOT NULL,
    end_date            DATE,
    status              TEXT    NOT NULL DEFAULT 'planning'
                          CHECK (status IN ('planning','active','done','cancelled')),
    notes               TEXT,
    created_by_user_id  INTEGER REFERENCES users(id),
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE bons ADD COLUMN event_id INTEGER REFERENCES events(id);
CREATE INDEX idx_bons_event ON bons(event_id);
