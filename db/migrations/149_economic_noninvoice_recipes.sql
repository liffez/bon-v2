-- 149_economic_noninvoice_recipes.sql
-- "Faktureres ikke" flyttes fra kategori til vare (#454).
--
-- NONINVOICE_CATEGORIES i services/economicInvoice.js udelod pr. KATEGORI, men to
-- af de fem kategorier er blandede:
--
--   'Tilbehør & Bokse'  19 opskrifter, INGEN har varenr — men flere er ægte varer
--                       med omsætning (Glutenfri Bolle, Børne Bokse, HåndDelle,
--                       Morgenboller, Toast, side dish). De forsvandt stille.
--   '06 Emballage'      47/96/157 HAR varenr. 45/46/48/82/121 er aldrig faktureret.
--                       Men Receptions Skinner (50) er faktureret 210 gange mod 55
--                       gratis, og Slider Boks 2 stk (49) 6 mod 4.
--   'lunch'             er slet ikke en Grocy-kategori — det er block_type lækket
--                       fra tilbudsmodulet og kan dække hvad som helst.
--
-- Kategorien kan altså ikke afgøre spørgsmålet. Kriteriet er varen.
--
-- Listen her udpeger det utvetydige: emballage der aldrig faktureres, og prep.
-- Samme mønster som economic_amount_line_recipes (144) og unit_count_extra_recipes
-- (113) — en udpeget liste frem for et gæt ud fra kategori.
--
-- VIGTIGT om hvad listen KAN og IKKE kan:
--   Listen kan kun ophæve en blokering — den kan ALDRIG fjerne omsætning. En linje
--   der bærer penge blokerer selv om opskriften står her (så er det en selvmodsigelse
--   i stamdata, og den skal ses, ikke skjules). Den værste fejl en forkert indtastning
--   kan lave, er derfor at en 0-kr-linje ikke kommer med — hvilket ikke ændrer fakturaen.
--
-- IKKE på listen med vilje: 49 + 50 (fakturerede varer — 50 har et forslag, varenr 57,
-- i juni-CSV'en der aldrig blev anvendt) og intet fra 'Tilbehør & Bokse'. De skal
-- blokere synligt, indtil de kobles i Grocy.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('economic_noninvoice_recipes',
   '[9,10,11,12,13,14,15,16,18,22,28,29,45,46,48,65,80,82,83,84,85,86,87,97,98,110,112,115,116,117,118,119,121,130,137,144,160]',
   'JSON-array af Grocy recipe-id der bevidst IKKE faktureres: emballage der aldrig faktureres (45,46,48,82,121) + prep (RR Produktion + RR produktion Hurtig). Kan kun ophæve en blokering — en linje med beløb blokerer stadig, også når opskriften står her.');
