-- 180_delivery_box_recipes.sql
-- Hvilke bon-linjer der er transportkasser — altså kolli buddet skal bære.
--
-- Problem: {total_boxes} i bud-popoutet læste kolonnen `bons.boxes` råt, og
-- den er tom på ALLE 3.288 bons i drift (målt 20-09-2026). Feltet meldte
-- derfor "[mangler]" på hver eneste bon, uanset hvad der stod på den — mens
-- bonnen udmærket bar tallet som emballage-linjer: 444 af 509 leverings-bons
-- i 2026 har en transportkasse-linje, gennemsnitligt 3,3 stk.
--
-- Samme døde kolonne fik By-expressens kasse-tillæg (included_boxes 2,
-- extra_box_cost 50) til aldrig at fyre: popoutet viste 154 kr hvor
-- logistik-rækkens /calculate — som ALLEREDE udleder kasse-antallet —
-- viste 254. To priser for samme bon.
--
-- Opskrifterne UDPEGES, de gættes ikke ud fra navnet: et match på
-- "%transportkasse%" ville ramme enhver ny vare nogen kalder noget i den
-- retning. Samme mønster som unit_count_extra_recipes (113) og
-- economic_amount_line_recipes (144).
--
-- 47 = Transportkasse, 96 = Transportkasse m låg. Målt i drift: de to bruges
-- på bons helt frem til 2026-11-14. Den tredje variant ("transportkasse",
-- uden opskrift-id) er v1-import og sidst brugt 13-05-2023.
--
-- Receptionsskinner og RR-bokse tæller IKKE med — beslutning 20-09-2026:
-- de ligger i kassen, og buddet bærer kasser. RR Boks står desuden med
-- 47.485 stk i drift og ville gøre kolli-tallet meningsløst.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('delivery_box_recipes',
   '[47,96]',
   'JSON-array af Grocy recipe-id der tæller som transportkasser (kolli) på en levering. Summen af linjernes antal bliver {total_boxes} i bud-popoutet og driver kasse-tillægget i leverandørernes prisformler. Tom liste = ingen linjer tæller.');
