-- 181_taxa_address_and_limit.sql
-- Taxa-bestillingen manglede leveringsadressen, og beskedfeltet har en grænse.
--
-- To ting, begge meldt fra drift 20-09-2026:
--
-- 1) ADRESSEN MANGLEDE. Taxas samlede skabelon havde INGEN adresse-variabel
--    overhovedet — kun "lever til {company_name}". Taxaen fik altså firmanavnet
--    og ingen adresse. Variablerne har eksisteret hele tiden ({delivery_address}
--    m.fl.); de var bare aldrig sat ind i denne skabelon.
--
-- 2) BESKEDFELTET TAGER 120 TEGN. Blokken med start/lever/kontakt lander på
--    111 tegn med almindelige data — 9 fra grænsen — og et langt kontaktnavn
--    sprænger den. Markøren {{max:120}} sætter grænsen for blokken under sig;
--    popoutet viser så en tæller og markerer overskridelsen. Vi afkorter aldrig:
--    hvad der skal ud er kontorets valg, og et telefonnummer klippet væk i
--    stilhed er værre end en tekst man selv forkorter.
--
-- Adressen kunne IKKE komme ind i den blok (111 + 36 = 147, altså 27 over), så
-- den får sin egen blok mellem kontakt-blokken og datoen.
--
-- Skabelonen er skrevet i hånden af kontoret, så vi overskriver den ikke —
-- vi sætter kun de to ting ind, og kun når de mangler OG ankeret optræder
-- præcis én gang. Har nogen skrevet skabelonen om, sker der ingenting.

-- ── 1) Tegngrænse på besked-blokken ──────────────────────
UPDATE delivery_vehicles
   SET booking_template = replace(
           booking_template,
           'start: {bon_number}',
           '{{max:120}}' || char(10) || 'start: {bon_number}')
 WHERE code = 'taxa-4x35'
   AND booking_template IS NOT NULL
   AND booking_template NOT LIKE '%{{max:%'
   -- ankeret skal optræde præcis én gang ('start: {bon_number}' = 19 tegn)
   AND (length(booking_template)
        - length(replace(booking_template, 'start: {bon_number}', ''))) = 19;

-- ── 2) Adressen som egen blok før datoen ─────────────────
UPDATE delivery_vehicles
   SET booking_template = replace(
           booking_template,
           '{delivery_date}',
           '{delivery_address}' || char(10) || char(10) || '{delivery_date}')
 WHERE code = 'taxa-4x35'
   AND booking_template IS NOT NULL
   AND booking_template NOT LIKE '%delivery_address%'
   -- ankeret skal optræde præcis én gang ('{delivery_date}' = 15 tegn)
   AND (length(booking_template)
        - length(replace(booking_template, '{delivery_date}', ''))) = 15;

-- ── 3) Samme to ting i felt-for-felt-visningen ───────────
-- Felterne er seedet i 071 og har adressen delt op (Adresse/Postnr/By), så dér
-- mangler den ikke. Men "Bemærkn." er den blok der svarer til besked-feltet,
-- og den skal have samme grænse. maxlen er additivt — felter uden det
-- opfører sig præcis som før.
-- Vi indsætter maxlen lige efter template-VÆRDIEN, ikke i et helt felt-objekt:
-- seed'en (071) er formateret med mellemrum mens Settings gemmer kompakt JSON
-- (JSON.stringify), så en match på hele objektet ville kun ramme det ene format.
-- Næste tegn er '}' eller ' }' i begge, så resultatet er gyldig JSON.
UPDATE delivery_vehicles
   SET booking_fields_json = replace(
           booking_fields_json,
           '"{packaging_lines}. {delivery_notes}"',
           '"{packaging_lines}. {delivery_notes}","maxlen":120')
 WHERE code = 'taxa-4x35'
   AND booking_fields_json IS NOT NULL
   AND booking_fields_json NOT LIKE '%maxlen%'
   -- præcis én forekomst ('"{packaging_lines}. {delivery_notes}"' = 37 tegn)
   AND (length(booking_fields_json)
        - length(replace(booking_fields_json, '"{packaging_lines}. {delivery_notes}"', ''))) = 37;
