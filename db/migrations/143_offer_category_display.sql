-- 143_offer_category_display.sql
--
-- Hvordan en varekategori skal vises på kundens tilbud (preview + PDF).
--
-- Baggrund: emballagelinjer — "2× Transportkasse m låg", "15× Receptions Skinner"
-- — stod midt imellem maden på tilbuddet og virkede umotiverede for kunden.
-- På bon-kortet ligger emballagen allerede dæmpet nederst; tilbuddet manglede
-- den samme adskillelse.
--
-- Format: JSON-objekt fra kategorinavn til visningsregel.
--
--   "show"    (eller kategorien mangler i objektet) → som hidtil
--   "last"    → vises stadig, men efter maden
--   "hidden"  → vises slet ikke for kunden
--
-- Reglen er REN VISNING. Priser, moms, totaler og de linjer der gemmes på
-- bonen er upåvirkede — en skjult kategori tæller stadig fuldt med i beløbet.
--
-- Default flytter kun emballagen nederst. At skjule noget kunden betaler for
-- skal være et bevidst valg, så det gøres i Settings → Tilbud — opbygning.
--
-- Kun det kanoniske Grocy-navn. Den historiske variant "Emballage" (uden
-- nummer) er ikke en kategori man skal kunne konfigurere — den mappes til
-- "06 Emballage" af scripts/normalize-bon-line-categories.js, som er den
-- rigtige måde at rydde den slags op på. Grocy er eneste kilde til kategorier.

INSERT INTO settings (key, value, description)
SELECT 'offer_category_display',
       '{"06 Emballage":"last"}',
       'Visning af varekategorier på tilbud: show | last | hidden (kun visning — priser er upåvirkede)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'offer_category_display');

-- Første udgave af denne migration seedede også den historiske stavemåde
-- "Emballage". Den er ikke en Grocy-kategori og hører ikke til i listen.
-- Ryd den KUN hvis værdien stadig er præcis den oprindelige default — så en
-- der allerede har testet branchen ikke sidder med en død række, og uden at
-- røre en indstilling nogen selv har ændret.
UPDATE settings
   SET value = '{"06 Emballage":"last"}'
 WHERE key = 'offer_category_display'
   AND value = '{"06 Emballage":"last","Emballage":"last"}';
