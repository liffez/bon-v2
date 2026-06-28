-- ==========================================
-- 110_crm_activity_outcome.sql
-- Outcome-måling på CRM-aktiviteter (CRM-trik A / idé ③).
-- crm_activities.result har en restriktiv CHECK (kun opkalds-udfald), så den
-- passer ikke til "fik anmeldelse". Ny let, genbrugelig outcome-kolonne i stedet
-- — valideres i serveren (POST /activity), ikke via CHECK, så vokabularet kan
-- udvides uden table-recreate. Vokabular: success | partial | declined |
-- no_response | pending. Bruges først af review_ask (anbefaling).
-- Ref: docs/CLAUDE_CRM_TRIKS.md revision idé ③.
-- ==========================================

ALTER TABLE crm_activities ADD COLUMN outcome TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_act_outcome ON crm_activities(outcome)
    WHERE outcome IS NOT NULL;
