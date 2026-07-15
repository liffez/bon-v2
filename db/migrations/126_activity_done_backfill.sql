-- 126_activity_done_backfill.sql
-- CRM Planlagt aktivitet — Fase 1 (se docs/CLAUDE_CRM_PLANLAGT.md).
--
-- Datahul: POST /activity satte historisk aldrig done_at (undtagen for
-- call/service_call med result='reached'). Alle øvrige loggede aktiviteter
-- har derfor done_at = NULL, hvilket nu (efter planlagt-modellen) fejlagtigt
-- ville tolkes som "planlagt".
--
-- Rettelse: en historisk loggede aktivitet uden deadline er per definition
-- udført ved oprettelse → done_at = created_at.
--
-- Friholdt (må BEVARE done_at IS NULL):
--   * Planlagte/møder: har due_at sat.
--   * Service-callbacks: result = 'callback' (eget flow, v_callbacks_pending).
--
-- Go-live-blokker: kør T1.1–T1.3 mod kopi af prod-db og verificér før/efter-
-- rækketal pr. gren FØR denne migration køres i prod.

UPDATE crm_activities
SET done_at = created_at
WHERE done_at IS NULL
  AND due_at IS NULL
  AND (result IS NULL OR result != 'callback');
