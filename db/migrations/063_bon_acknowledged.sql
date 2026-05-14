-- Migration 063: bons.acknowledged_at + acknowledged_by_user_id (#042)
--
-- Web-bestillinger fra hjemmesidens webhook lander med status='NY' og
-- delivery_date langt i fremtiden (fx august-bestilling modtaget i maj).
-- Sådanne bons falder ud af dashboard-, today- og later-views fordi de
-- filtrerer på delivery_date. Resultat: kunden venter, ingen ser
-- bestillingen, troværdighed daler.
--
-- Løsningen er at adskille "har vi set bestillingen" fra "er den klar
-- til levering". Dashboard-alert (#041) og den nye "Nye bestillinger"-
-- side (#042) tæller `acknowledged_at IS NULL`, uafhængigt af status
-- og delivery_date. Når en operatør klikker "Bekræft modtaget" sættes
-- acknowledged_at + acknowledged_by_user_id, og bonen falder ud af
-- listen (uden at status-flowet røres).
--
-- NULL = ikke bekræftet. Eksisterende bons får NULL ved migration —
-- backfill udføres separat hvis det viser sig nødvendigt.

ALTER TABLE bons ADD COLUMN acknowledged_at DATETIME;
ALTER TABLE bons ADD COLUMN acknowledged_by_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_bons_acknowledged_at ON bons(acknowledged_at) WHERE acknowledged_at IS NULL;
