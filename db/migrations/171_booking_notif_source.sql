-- 171_booking_notif_source.sql
-- ---------------------------------------------------------------------------
-- Den interne booking-notifikation fortæller nu HVOR bookingen kom fra.
--
-- Baggrund: indtil september 2026 blev notifikationen sprunget over når kunden
-- bookede via sælgerens eget {{booking_link}} — ud fra at sælgeren jo vidste
-- det. Den antagelse holder ikke i en kampagne, hvor der sendes mange links på
-- få dage. Undtagelsen er væk, og så får sælgeren mail ved ENHVER booking.
--
-- Dermed bliver det til gengæld relevant at kunne se hvilken slags booking det
-- var: et svar på mit link, eller en der selv fandt siden. {{bookingKilde}}
-- siger det.
--
-- Skabelonen er redigerbar i Settings, så den røres KUN hvis den stadig står
-- præcis som den blev seedet i 051. Har nogen skrevet i den, er den deres —
-- variablen er tilgængelig og kan sættes ind i hånden.
-- ---------------------------------------------------------------------------

UPDATE mail_templates
   SET body_text = replace(
           body_text,
           '  Flow:        {{flowType}}',
           '  Flow:        {{flowType}}
  Kom fra:     {{bookingKilde}}'
       )
 WHERE key = 'booking_internal_notification'
   AND body_text = 'Ny booking modtaget:

  Kunde:       {{kundeNavn}}
  Firma:       {{firmaNavn}}
  Email:       {{kundeEmail}}
  Telefon:     {{kundeTelefon}}
  Flow:        {{flowType}}
  Mødetype:    {{moedeTypeLabel}}
  Årsag:       {{kontaktAarsagLabel}}
  Dato:        {{datoFormatteret}} kl {{tid}}
  Antal:       {{antalGaester}}
  Besked:      {{beskedFraKunde}}

Åbn kunden i CRM:
{{crmKundeUrl}}';
