-- Migration 081: tillad FAKTURERET → BETALT som direkte transition
-- ════════════════════════════════════════════════════════════
-- Indtil nu var der ingen eksplicit transition fra FAKTURERET til BETALT.
-- Fakturering-viewet kunne flytte en bon til FAKTURERET, men næste skridt
-- (kunden har betalt) krævede force-mode. Det blokerede cashflow-modulets
-- "Bekræft betalt"-handling i at flytte bon-status synkront med faktura-
-- status, så fakturering, dashboard og rapporter altid kom bagud.
--
-- Transition er uden bekræftelse — det er en naturlig progression i flowet.
-- ════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO status_transitions (from_status_id, to_status_id, requires_confirmation, confirmation_message, triggers_json)
VALUES
    ((SELECT id FROM status_definitions WHERE code='FAKTURERET'),
     (SELECT id FROM status_definitions WHERE code='BETALT'), 0, NULL, NULL);
