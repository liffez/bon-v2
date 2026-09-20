-- 183_taxa_tlf_label.sql
-- "tlf" i stedet for "kontakt:" i taxa-bestillingen.
--
-- Beskedfeltet hos taxa.nu tager 120 tegn, og blokken lå på 117-119 efter at
-- kasseantallet fik sit ord (migration 182) — altså 1-3 tegn luft. Et længere
-- kontaktnavn end det sædvanlige sprængte grænsen.
--
-- "kontakt: " er 9 tegn der ikke siger taxaen noget; "tlf " er 4 og siger det
-- samme i den telegramstil resten af blokken allerede har ("start:", "lever
-- til"). Besparelse: 5 tegn, så blokken lander på 112-114 af 120.
--
-- Det giver plads til et kontaktnavn på ca. 29-31 tegn mod 23 i dag. Et
-- virkelig langt navn sprænger stadig grænsen — det er dét popoutets tæller
-- er til for, og så må office forkorte på stedet.
--
-- Vi matcher på hele 'kontakt: {delivery_contact_name}', ikke bare ordet, så
-- vi ved præcis hvad vi rører i kontorets egen tekst. Har nogen skrevet
-- linjen om, sker der ingenting.

UPDATE delivery_vehicles
   SET booking_template = replace(
           booking_template,
           'kontakt: {delivery_contact_name}',
           'tlf {delivery_contact_name}')
 WHERE code = 'taxa-4x35'
   AND booking_template IS NOT NULL
   -- præcis én forekomst ('kontakt: {delivery_contact_name}' = 32 tegn)
   AND (length(booking_template)
        - length(replace(booking_template, 'kontakt: {delivery_contact_name}', ''))) = 32;
