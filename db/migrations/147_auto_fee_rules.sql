-- 147_auto_fee_rules.sql
-- ============================================================
-- Standardgebyrer på fakturaer — miljøbidrag først, men reglen er generel.
--
-- Baggrund: miljøbidraget findes ALLEREDE som Grocy-opskrift 168 "Miljøgebyr"
-- (kategori x-Levering, e-conomic-varenr 98 er reserveret til det i
-- docs/economics/CLAUDE_ECONOMIC_ADAPTER.md). Men det er aldrig blevet brugt:
-- 0 af 20.781 bonlinjer i drift er et miljøgebyr. Det lægges på i hånden ovre
-- i e-conomic, eller slet ikke — og så er det glemt.
--
-- En regel udpeger en Grocy-opskrift + en betingelse. Opskriften er stadig
-- priskilden (som alt andet), reglen siger kun HVORNÅR den skal med. Samme
-- mønster som unit_count_extra_recipes (113) og economic_amount_line_recipes
-- (144): en udpeget liste frem for at gætte ud fra pris eller kategori.
--
-- Felter pr. regel:
--   id         stabil nøgle — bruges i changelog, så en omdøbt regel stadig
--              kan spores. Må ikke genbruges til noget andet.
--   recipe_id  Grocy-opskrift. Pris, navn, kategori og varenr kommer HERFRA.
--   min_pax    gælder når bons.pax >= dette tal. "over 10 pax" ⇒ 11.
--   active     0/1. Se nedenfor hvorfor den seedes slukket.
--
-- ⚠️ SEEDET SLUKKET MED VILJE.
-- Grocy-opskrift 168 står til 29 kr, og Grocy-salgspriser er INCL. moms
-- (BON_V2_PRINCIPPER §6b). Kontoret regner med "29 kr + moms" = 36,25 incl.
-- Tændes reglen før prisen er rettet i Grocy, fakturerer vi 23,20 ex i stedet
-- for 29 ex — stille, på hver eneste faktura. Rækkefølgen er derfor:
--   1) ret SalespriceStore/Catering/Festival på opskrift 168 til 36.25 i Grocy
--   2) tænd reglen i Settings → System → Standardgebyrer
-- Settings-siden viser opskriftens aktuelle pris ved siden af kontakten, så
-- fejlen er synlig i stedet for at skulle huskes.
-- ============================================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('auto_fee_rules',
   '[{"id":"miljobidrag","recipe_id":168,"min_pax":11,"active":0}]',
   'JSON-array af standardgebyrer der lægges automatisk på en bon når den træder ind i faktureringskøen (LEVERET + betales med faktura). Hver regel: {id, recipe_id (Grocy), min_pax (gælder fra og med), active}. Prisen kommer fra Grocy-opskriften. Redigeres i Settings → System → Standardgebyrer.');
