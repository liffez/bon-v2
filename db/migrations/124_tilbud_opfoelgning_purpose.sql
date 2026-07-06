-- 124_tilbud_opfoelgning_purpose.sql
-- CRM-triks (#232, #228 Fase 5): egen purpose til kold tilbudsopfølgning, så
-- opfølgning på et udløbet tilbud kan dedupes pr. tilbud (bon_id) og rapporteres
-- adskilt. Bruges af GET /api/crm/cold-offers + Ringeliste-fanen "Kolde tilbud".
INSERT OR IGNORE INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('tilbud_opfoelgning', 'Tilbudsopfølgning', '📄', 'Opfølgning på udløbet tilbud uden svar', 1, 46);
