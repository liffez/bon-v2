-- Migration 083: tillad KLAR → GODKENDT som direkte reverse transition
-- ════════════════════════════════════════════════════════════
-- KLAR → IGANG og IGANG → GODKENDT findes allerede som no-confirm
-- reverse-transitions, og GODKENDT → KLAR findes som no-confirm
-- skip-forward (migration 007). KLAR → GODKENDT manglede som det
-- spejlede skip-baglæns. Køkkenet kan nu klikke direkte tilbage til
-- GODKENDT hvis KLAR er trykket ved en fejl, uden at gå via IGANG.
-- ════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json)
VALUES
    ((SELECT id FROM status_definitions WHERE code='KLAR'),
     (SELECT id FROM status_definitions WHERE code='GODKENDT'), 0, NULL, NULL);
