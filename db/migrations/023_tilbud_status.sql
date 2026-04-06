-- ==========================================
-- TILBUD status i status_definitions
-- Tilbud = bon med is_offer=1 og status TILBUD
-- ==========================================

INSERT OR IGNORE INTO status_definitions (code, label, color, icon, sort_order, is_terminal)
VALUES ('TILBUD', 'Tilbud', '#c2722e', '📋', 0, 0);

-- Transitions fra TILBUD
-- TILBUD → GODKENDT (tilbud accepteret, bliver til aktiv bon)
-- TILBUD → AFLYST (tilbud afvist/udløbet)
INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id)
SELECT f.id, t.id FROM status_definitions f, status_definitions t
WHERE f.code = 'TILBUD' AND t.code = 'GODKENDT';

INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id)
SELECT f.id, t.id FROM status_definitions f, status_definitions t
WHERE f.code = 'TILBUD' AND t.code = 'AFLYST';

-- Også TILBUD → NY (hvis man vil gøre det til en aktiv ordre uden at godkende)
INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id)
SELECT f.id, t.id FROM status_definitions f, status_definitions t
WHERE f.code = 'TILBUD' AND t.code = 'NY';
