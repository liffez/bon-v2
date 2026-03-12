-- 007_kitchen_transitions.sql
-- Tilføj direkte transitions fra GODKENDT → KLAR og GODKENDT → LEVERET
-- så køkkenet kan springe trin over.

INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json)
VALUES
    ((SELECT id FROM status_definitions WHERE code='GODKENDT'),
     (SELECT id FROM status_definitions WHERE code='KLAR'), 0, NULL, NULL),

    ((SELECT id FROM status_definitions WHERE code='GODKENDT'),
     (SELECT id FROM status_definitions WHERE code='LEVERET'), 0, NULL, NULL);
