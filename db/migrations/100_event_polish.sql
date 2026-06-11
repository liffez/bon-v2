-- 100_event_polish.sql
-- Event-modul polish (CLAUDE_EVENT.md):
--
-- 1) Åbningstider pr. event-dag. JSON-objekt { "YYYY-MM-DD": "10-18", ... }
--    redigeres i forecast-tabellen og vises som kontekst for pakke/prep.
--
-- 2) NY → LEVERET transition. Event-prep-bons starter på NY, og pakkelisten
--    får en "Marker som LEVERET"-knap (lagertrækket sker ved LEVERET, §5).
--    Uden denne transition ville knappen kræve et mellem-hop via GODKENDT.
--    requires_confirmation=1 så alle frontends ved at springet skal bekræftes.

ALTER TABLE events ADD COLUMN open_hours_json TEXT;

-- 3) DAWA-valideret event-adresse. Vælges adressen via DAWA-autocomplete i
--    event-modalen, oprettes en struktureret addresses-række (med koordinater)
--    med det samme, og event_address_id peger på den. Genererede bons arver
--    den direkte. event_address (fritekst) beholdes som visnings-/fallback-felt.
ALTER TABLE events ADD COLUMN event_address_id INTEGER REFERENCES addresses(id);

INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json)
VALUES
    ((SELECT id FROM status_definitions WHERE code='NY'),
     (SELECT id FROM status_definitions WHERE code='LEVERET'),
     1, 'Markér som leveret uden godkendelse? Lageret trækkes.', NULL);
