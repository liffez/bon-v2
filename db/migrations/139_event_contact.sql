-- 139_event_contact.sql
-- ════════════════════════════════════════════════════════════
-- Kontaktperson på eventet.
--
-- Hvorfor: event-genererede bons (prep, top-up, salg, udgift) har hidtil
-- stået uden kunde og uden kontakt på dagen — køkkenet så "Ukendt" på
-- kortet, og kontoret måtte taste den samme person ind manuelt på hver
-- eneste bon. Kontakten hører til EVENTET, ikke til den enkelte bon, så
-- den bør angives ét sted og arves nedad.
--
-- customer_id + company_id spejler bons' egne to felter (og det KundeSoeg
-- leverer), så generatoren kan kopiere dem direkte uden opslag.
-- day_contact_* er kontakten PÅ PLADSEN og er ofte den samme person, men
-- behøver ikke være det (bestilleren sidder på kontoret, én anden står på
-- pladsen) — derfor egne felter frem for at udlede dem af kunden.
--
-- Alt nullable → eksisterende events er uberørte, og et event uden
-- kontaktperson opfører sig præcis som før.
-- ════════════════════════════════════════════════════════════

ALTER TABLE events ADD COLUMN customer_id       INTEGER REFERENCES customers(id);
ALTER TABLE events ADD COLUMN company_id        INTEGER REFERENCES companies(id);
ALTER TABLE events ADD COLUMN day_contact_name  TEXT;
ALTER TABLE events ADD COLUMN day_contact_phone TEXT;
