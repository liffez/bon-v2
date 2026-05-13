-- Migration 061: Patch D — tilføj payload-kolonne til changelog
--
-- Bruges af force-mode i PATCH /api/bons/:id/status til at gemme
-- JSON-metadata om force-overrides (was_forced + by_user_id) så audit-
-- trailen viser hvilke status-skift gik uden om normalt flow.
--
-- Backwards-compatible: payload er nullable, eksisterende rækker får NULL.
-- logChange()-helper'en sender NULL når wasForced ikke er sat.

ALTER TABLE changelog ADD COLUMN payload TEXT;
