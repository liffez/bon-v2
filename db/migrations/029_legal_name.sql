-- 029: Tilføj legal_name til companies (officielt juridisk navn fra CVR)
ALTER TABLE companies ADD COLUMN legal_name TEXT;
