-- 098_event_address.sql
-- ════════════════════════════════════════════════════════════
-- Fysisk adresse på eventet (hvor eventet afholdes).
-- Spec: docs/CLAUDE_EVENT.md (event-redigering).
--
-- events.location_id peger på HQ (hvor prep sker). event_address er det
-- fysiske sted eventet afvikles — fri tekst (festivalplads, gade, pladsnavn),
-- da event-steder er engangs og sjældent i addresses-tabellen. Bruges til
-- visning/overblik; ikke (endnu) til rute-beregning i den lette model.
--
-- Nullable → eksisterende events uberørte.
-- ════════════════════════════════════════════════════════════

ALTER TABLE events ADD COLUMN event_address TEXT;
