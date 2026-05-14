-- ==========================================
-- 065_reset_new_bons_last_seen.sql
--
-- Engangs-nulstilling af users.new_bons_last_seen_at.
--
-- Mellem migration 064 (14. maj) og fix bfc5b5a (samme dag) blev kolonnen
-- advanceret af IntersectionObserver-feedback fra mobilens Nye-tab. Det
-- viste sig at MAX-update gjorde at scrolling forbi ÉN ny bon filtrerede
-- ALLE ældre bons væk. Beslutning 11 i CLAUDE_MOBIL_NYE_OG_SOEG.md gør
-- nu auto-mark til en ren visuel feedback uden serverstatus-ændring.
--
-- Brugere der nåede at teste den buggy mellemversion har en residual
-- last_seen_at-værdi der filtrerer deres Nye-liste tom. Denne migration
-- nulstiller værdien for alle, så listen falder tilbage på 7-dages-
-- fallback'en og fremover kun rykker via eksplicit "Marker alle læst".
-- ==========================================

UPDATE users SET new_bons_last_seen_at = NULL;
