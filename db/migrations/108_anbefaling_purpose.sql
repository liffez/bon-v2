-- ==========================================
-- 108_anbefaling_purpose.sql
-- CRM-trik Fase 1: anbefaling / anmeldelse efter glad kunde.
-- Ingen skemaændring — crm_activities har allerede purpose_id (048)
-- og sentiment (019). Kun en ny purpose-række så "har vi spurgt?"
-- kan dedupes i GET /suggestions §6.
-- Ref: docs/CLAUDE_CRM_TRIKS.md Fase 1.
-- ==========================================

INSERT INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('anbefaling', 'Anbefaling', '⭐', 'Bedt kunde om anmeldelse eller henvisning', 1, 70);
