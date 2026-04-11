-- Migration 038: Smartplan-kobling på staff
-- Bruges til at synkronisere medarbejdere fra Smartplan

ALTER TABLE staff ADD COLUMN smartplan_id TEXT;
ALTER TABLE staff ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'smartplan'));
