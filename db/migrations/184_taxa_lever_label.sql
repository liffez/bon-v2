-- 184_taxa_lever_label.sql
-- "lever:" i stedet for "lever til" i taxa-bestillingen.
--
-- Fortsættelse af 183: beskedfeltet hos taxa.nu tager 120 tegn, og hvert
-- sparet tegn er plads til et længere kontakt- eller firmanavn.
--
-- "lever til " er 10 tegn, "lever: " er 7 — og kolon matcher den stil blokken
-- allerede har ("start:", og "tlf" fra 183). Blokken går fra 112-114 til
-- 109-111 af de 120.
--
-- Samlet plads til firmanavn + kontaktnavn efter 183 + 184: 11 tegn mere end
-- før. Et virkelig langt navn sprænger stadig grænsen — det er dét popoutets
-- tæller er til for.
--
-- Vi matcher på hele 'lever til {company_name}', ikke bare ordene, så vi ved
-- præcis hvad vi rører i kontorets egen tekst. Har nogen skrevet linjen om,
-- sker der ingenting.

UPDATE delivery_vehicles
   SET booking_template = replace(
           booking_template,
           'lever til {company_name}',
           'lever: {company_name}')
 WHERE code = 'taxa-4x35'
   AND booking_template IS NOT NULL
   -- præcis én forekomst ('lever til {company_name}' = 24 tegn)
   AND (length(booking_template)
        - length(replace(booking_template, 'lever til {company_name}', ''))) = 24;
