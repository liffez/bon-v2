-- 139_delivery_price_tiers.sql
-- ============================================================
-- By-expressens kundepris som TRAPPE i stedet for én bypris.
--
-- Baggrund: cost_formula sagde 154 kr uanset afstand, fordi den kun
-- beskrev Food (bynær levering). Uden for byen gav den derfor et tal
-- der ikke gælder — og en "margin" målt mod det så ud som et tab.
--
-- Trappen er IKKE opfundet: office har historisk brugt tre takster,
-- som stadig ligger i driftsdataene (bon_lines.category = 'x-Levering'):
--
--   By-ekspressen leverer            180 kr   1067 linjer, i brug
--   By-ekspressen - Langt væk        300 kr     47 linjer, sidst apr. 2024
--   By-ekspressen - Meget Langt væk  500 kr      9 linjer, sidst apr. 2024
--
-- De to sidste holdt op med at blive brugt i april 2024 — derfor hullet.
-- Bekræftet mod en faktura fra 11. juni 2025 til 2630 Taastrup:
-- "Transport Taastrup 400,00" = 500 kr incl = 400 kr ex → meget-langt-taksten.
--
-- bon_lines.unit_price er INCL moms; cost_formula er EX moms (§6b), så
-- takstene er omregnet med Moms.inclToExcl: 180 → 144 · 300 → 240 · 500 → 400.
--
-- Km-grænserne er et skøn, ikke udledt: de historiske takster blev valgt
-- i hånden og er ikke konsistente (2800 Lyngby fik både 300 og 500, og
-- 300-taksten blev også brugt på inderby-adresser). 8 km matcher Food's
-- forsyningsområde (max_distance_km); 15 km skiller Lyngby/Ballerup fra
-- Vallensbæk/Taastrup. Justér i Settings → Leveringsmetoder.
-- ============================================================

UPDATE delivery_vehicles
SET cost_formula_json = json_object(
        'tiers', json_array(
            json_object('max_km', 8,  'price', 144, 'label', 'Bytakst'),
            json_object('max_km', 15, 'price', 240, 'label', 'Langt væk'),
            json_object(             'price', 400, 'label', 'Meget langt væk')
        ),
        'included_boxes', 2,
        'extra_box_cost', 50
    )
WHERE code = 'byekspressen';
