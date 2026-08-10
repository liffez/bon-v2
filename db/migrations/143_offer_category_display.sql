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
-- Begge stavemåder tages med: "06 Emballage" (4.415 linjer) er den kanoniske
-- fra Grocy, "Emballage" (210) er en historisk variant.

INSERT INTO settings (key, value, description)
SELECT 'offer_category_display',
       '{"06 Emballage":"last","Emballage":"last"}',
       'Visning af varekategorier på tilbud: show | last | hidden (kun visning — priser er upåvirkede)'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'offer_category_display');
