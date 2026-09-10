-- 170: Antal gæster og eventtype styres pr. mødetype.
--
-- Begge felter lå hardkodet i booking-formularen og blev vist for enhver
-- mødetype. Men en smagning er altid til to personer, og der er intet event
-- at vælge — kunden blev bedt om at udfylde noget der ikke fandtes.
--
-- Reglen hører til på mødetypen, ikke i siden: næste gang en type skal have
-- andre felter, skal det kunne gøres i Settings uden en commit.
--
--   fixed_guest_count  NULL = spørg kunden. Et tal = spørg ikke, brug tallet.
--   asks_event_type    0 = skjul eventtype-feltet.
--
-- Defaults holder alle eksisterende typer uændrede; kun smagning får den nye
-- adfærd.

ALTER TABLE meeting_types ADD COLUMN fixed_guest_count INTEGER;
ALTER TABLE meeting_types ADD COLUMN asks_event_type   INTEGER NOT NULL DEFAULT 1;

UPDATE meeting_types
   SET fixed_guest_count = 2,
       asks_event_type   = 0
 WHERE key = 'smagning';
