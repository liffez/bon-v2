-- 182_taxa_boxes_text.sql
-- "1 kasse" i stedet for et bart "1".
--
-- Meldt fra drift 20-09-2026: taxa-bestillingen sagde
--
--   start: B4296, 1 hos Ristet Rug
--
-- Tallet er nu rigtigt (migration 180), men et bart "1" siger ingenting til den
-- der skal køre. {total_boxes_text} er det samme tal med ordet på, bøjet:
-- "1 kasse" / "4 kasser". Bøjningen hører i koden — "{total_boxes} kasser" i
-- skabelonen ville give "1 kasser".
--
-- Det RENE tal bevares som {total_boxes} og bruges uændret af By-expressens
-- felt "Antal kolli": et formularfelt der spørger om et antal skal have 4,
-- ikke "4 kasser".
--
-- ⚠️ Tegnbudgettet bliver strammere: besked-blokken går fra 111 til 117 af de
-- 120 (migration 181). Popoutets tæller viser det, og et langt kontaktnavn
-- sprænger grænsen — det er netop dét tælleren er til for.
--
-- Skabelonen er kontorets egen tekst, så vi bytter kun variablen ud og rører
-- intet andet. Har nogen allerede skiftet til _text, sker der ingenting.

UPDATE delivery_vehicles
   SET booking_template = replace(booking_template, '{total_boxes}', '{total_boxes_text}')
 WHERE code = 'taxa-4x35'
   AND booking_template IS NOT NULL
   AND booking_template LIKE '%{total_boxes}%';
