-- ============================================================
-- seed_planning.sql — Testdata for T_PLAN
-- ============================================================
-- 8 bonner over 5 dage (uge 20 / 2026, ma 11/5 – fr 15/5)
-- Bon 4008 er et TILBUD (is_offer=1) — tester at tilbud inkluderes uanset status.
-- Anvendes af tests/scripts/run.js til T_PLAN-tracken.
--
-- Bon-numre 4001-4007 er valgt så de adskiller sig fra prod (3000-tal).
-- Kører mod data/test.db — IKKE prod.
--
-- Forudsætninger:
--   - migrations har kørt (tabeller findes)
--   - status_definitions, locations, price_categories er seedet via 001_core.sql
--
-- Reference: tests/specs/T_PLAN.md
--
-- Vigtigt om priskategori (Leif maj 2026):
--   • Bons har BÅDE 'price_category_id' (FK til price_categories) OG
--     'price_category' (TEXT med CHECK constraint, jf. migration 007)
--   • Begge sættes eksplicit til 'catering' i alle 7 test-bonner
--   • Salgspriser i bon_lines.unit_price er allerede snapshot fra Grocy ved oprettelse
--     → planlægning læser dem direkte fra DB, ikke live fra Grocy
-- ============================================================

BEGIN TRANSACTION;

-- ============================================================
-- 1. ADRESSE (én adresse, bruges som leveringsadresse for alle test-bonner)
-- ============================================================

INSERT INTO addresses (id, street_name, street_nr, postal_code, city, lat, lon)
VALUES (9001, 'Testvej', '1', '2920', 'Charlottenlund', 55.7531, 12.5803);

-- ============================================================
-- 2. FIRMA + KUNDE (én af hver — kunde-håndtering testes i T_INPUT)
-- ============================================================

INSERT INTO companies (id, name, cvr, address_id, phone, email,
                       default_payment_type, is_active)
VALUES (9001, 'Testfirma A/S', '12345678', 9001,
        '+45 20 12 34 56', 'kontakt@testfirma.dk',
        'invoice', 1);

INSERT INTO customers (id, company_id, first_name, last_name,
                       phone, email, is_primary_contact, is_active)
VALUES (9001, 9001, 'Test', 'Testesen',
        '+45 20 12 34 56', 'test@testfirma.dk', 1, 1);

-- ============================================================
-- 3. BONNER
-- ============================================================
-- Bemærk:
--  • status_id slås op via subquery (robust mod ID-skift)
--  • location_id antages 'hq' (default)
--  • price_category_id antages 'standard' eller 'catering' — bruger første aktive
--  • total_units og total_price er sat til facit-værdierne fra T_PLAN.md §6
--    så testen kan verificere at bons-rækken stemmer med summen af bon_lines
--  • Alle priser er INCL moms (jf. moms-doktrin §6b i BON_V2_PRINCIPPER.md)
-- ============================================================

-- Hjælpe-CTE (køres ikke direkte — viser bare værdierne der bruges nedenfor)
-- location_id := (SELECT id FROM locations WHERE code='hq')
-- price_cat   := (SELECT id FROM price_categories WHERE is_default=1 LIMIT 1)

-- BON 4001 — Ma 11/5, LEVERET, 50 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4001, '4001',
        (SELECT id FROM status_definitions WHERE code='LEVERET'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-08', '2026-05-11', '11:30', '12:00',
        'delivery', 9001, 50, 103, 5237.50,
        'invoice', 1, 1);

-- BON 4002 — Ma 11/5, FAKTURERET, 30 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4002, '4002',
        (SELECT id FROM status_definitions WHERE code='FAKTURERET'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-08', '2026-05-11', '11:30', '12:00',
        'delivery', 9001, 30, 62, 2485.00,
        'invoice', 1, 1);

-- BON 4003 — Ti 12/5, KLAR, 50 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4003, '4003',
        (SELECT id FROM status_definitions WHERE code='KLAR'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-08', '2026-05-12', '11:30', '12:00',
        'delivery', 9001, 50, 103, 5237.50,
        'invoice', 1, 0);

-- BON 4004 — Ti 12/5, AFLYST, 25 pax (skal IKKE indgå i facit)
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4004, '4004',
        (SELECT id FROM status_definitions WHERE code='AFLYST'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-08', '2026-05-12', '12:00', '12:30',
        'delivery', 9001, 25, 50, 2475.00,
        'invoice', 0, 0);

-- BON 4005 — On 13/5, IGANG, 70 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4005, '4005',
        (SELECT id FROM status_definitions WHERE code='IGANG'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-09', '2026-05-13', '11:30', '12:00',
        'delivery', 9001, 70, 134, 7090.00,
        'invoice', 1, 1);

-- BON 4006 — To 14/5, GODKENDT, 25 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4006, '4006',
        (SELECT id FROM status_definitions WHERE code='GODKENDT'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-09', '2026-05-14', '11:30', '12:00',
        'delivery', 9001, 25, 47, 2655.00,
        'invoice', 0, 0);

-- BON 4007 — Fr 15/5, VENTER, 40 pax
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready)
VALUES (4007, '4007',
        (SELECT id FROM status_definitions WHERE code='VENTER'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-09', '2026-05-15', '11:30', '12:00',
        'delivery', 9001, 40, 83, 3807.50,
        'invoice', 0, 0);


-- BON 4008 — To 14/5, VENTER, is_offer=1, 40 pax
-- Tester at tilbud (is_offer=1) inkluderes i backend uanset status,
-- men kan ekskluderes client-side via _plShowOffers toggle.
INSERT INTO bons (id, bon_number, status_id, location_id, customer_id, company_id,
                  price_category_id, price_category, order_date, delivery_date, pickup_time, delivery_time,
                  delivery_type, delivery_address_id, pax, total_units, total_price,
                  payment_type, prep_ingredients_ready, prep_supplies_ready, is_offer)
VALUES (4008, '4008',
        (SELECT id FROM status_definitions WHERE code='VENTER'),
        (SELECT id FROM locations WHERE code='hq'),
        9001, 9001,
        (SELECT id FROM price_categories WHERE code='catering' LIMIT 1),
        'catering',
        '2026-05-09', '2026-05-14', '12:00', '12:30',
        'delivery', 9001, 40, 83, 4287.50,
        'invoice', 0, 0, 1);

-- ============================================================
-- 4. BON_LINES
-- ============================================================
-- Felter:
--   product_name      — match-key mod Grocy via name (snapshot)
--   category          — kategori-tekst, brugt i niveau A grupperinger
--   quantity          — antal stk
--   unit              — 'stk' for alle her
--   unit_price        — INCL moms (snapshot fra Grocy salgspris)
--   cost_price        — EX moms (placeholder; reel værdi fra Grocy)
--   line_total        — quantity × unit_price (INCL moms)
--   sort_order        — visningsrækkefølge
--   is_accessory      — 1 for emballage (RR Boks, Sliderbox, Transportkasse)
--                       MEN: tæller stadig med i planlægning jf. Leif maj 2026
--   grocy_recipe_id   — sættes til 0 (placeholder; opdateres af snapshot-script)
-- ============================================================

-- BON 4001 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4001, 'Falaflen',          '01 Sandwich',  30, 'stk', 104.00, 25.00, 3120.00, 1, 0, 91),
  (4001, 'Kyllingen',          '01 Sandwich',  20, 'stk', 104.00, 25.00, 2080.00, 2, 0, 88),
  (4001, 'RR Boks',            '06 Emballage', 50, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4001, 'Transportkasse',     '06 Emballage',  3, 'stk',  12.50,  3.00,   37.50, 4, 1, 47);

-- BON 4002 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4002, 'Frikadellen-Slider', '04 Slider',    15, 'stk',  65.00, 15.60,  975.00, 1, 0, 53),
  (4002, 'Tunen',              '01 Sandwich',  15, 'stk',  99.00, 23.76, 1485.00, 2, 0, 63),
  (4002, 'RR Boks',            '06 Emballage', 30, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4002, 'Transportkasse',     '06 Emballage',  2, 'stk',  12.50,  3.00,   25.00, 4, 1, 47);

-- BON 4003 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4003, 'Kyllingen',          '01 Sandwich',  40, 'stk', 104.00, 25.00, 4160.00, 1, 0, 88),
  (4003, 'Falaflen',           '01 Sandwich',  10, 'stk', 104.00, 25.00, 1040.00, 2, 0, 91),
  (4003, 'RR Boks',            '06 Emballage', 50, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4003, 'Transportkasse',     '06 Emballage',  3, 'stk',  12.50,  3.00,   37.50, 4, 1, 47);

-- BON 4004 linjer (AFLYST — skal IKKE indgå i planlægnings-facit)
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4004, 'Tunen',              '01 Sandwich',  25, 'stk',  99.00, 23.76, 2475.00, 1, 0, 63),
  (4004, 'RR Boks',            '06 Emballage', 25, 'stk',   0.00,  1.50,    0.00, 2, 1, 45);

-- BON 4005 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4005, 'Tunen',              '01 Sandwich',  60, 'stk',  99.00, 23.76, 5940.00, 1, 0, 63),
  (4005, 'Kålen',              '02 Salat',     10, 'stk', 110.00, 26.40, 1100.00, 2, 0, 66),
  (4005, 'RR Boks',            '06 Emballage', 60, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4005, 'Transportkasse',     '06 Emballage',  4, 'stk',  12.50,  3.00,   50.00, 4, 1, 47);

-- BON 4006 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4006, 'Falaflen',           '01 Sandwich',  20, 'stk', 104.00, 25.00, 2080.00, 1, 0, 91),
  (4006, 'Kålen',              '02 Salat',      5, 'stk', 110.00, 26.40,  550.00, 2, 0, 66),
  (4006, 'RR Boks',            '06 Emballage', 20, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4006, 'Transportkasse',     '06 Emballage',  2, 'stk',  12.50,  3.00,   25.00, 4, 1, 47);

-- BON 4007 linjer
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4007, 'Kyllingen',          '01 Sandwich',  30, 'stk', 104.00, 25.00, 3120.00, 1, 0, 88),
  (4007, 'Frikadellen-Slider', '04 Slider',    10, 'stk',  65.00, 15.60,  650.00, 2, 0, 53),
  (4007, 'RR Boks',            '06 Emballage', 40, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4007, 'Transportkasse',     '06 Emballage',  3, 'stk',  12.50,  3.00,   37.50, 4, 1, 47);

-- BON 4008 linjer (tilbud — Falaflen, Tunen, RR Boks, Transportkasse)
INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, is_accessory, grocy_recipe_id) VALUES
  (4008, 'Falaflen',           '01 Sandwich',  25, 'stk', 104.00, 25.00, 2600.00, 1, 0, 91),
  (4008, 'Tunen',              '01 Sandwich',  15, 'stk',  99.00, 23.76, 1485.00, 2, 0, 63),
  (4008, 'RR Boks',            '06 Emballage', 40, 'stk',   0.00,  1.50,    0.00, 3, 1, 45),
  (4008, 'Transportkasse',     '06 Emballage',  3, 'stk',  12.50,  3.00,   37.50, 4, 1, 47);
-- ============================================================
-- 6. SETTINGS
-- ============================================================
-- KRITISK: default_grocy_location_id = 3 (Test) — så grocyAdapter rammer
-- grocytest.ristetrug.dk og ikke grocycafe (PROD!). Uden denne linje falder
-- adapteren tilbage til første aktive lokation, som er HQ (PROD).
-- Adapteren læser URL fra locations-tabellen, IKKE fra GROCY_API_URL env-var,
-- så safety_check.js's env-tjek alene er ikke nok.
--
-- inventory_auto_deduct styrer om consumeRecipes køres ved LEVERET-status.
-- Default på en frisk Bon v2-installation er '0'. Skal være '1' for at
-- T_INVENTORY-testene kan teste lagertræk.
--
-- VIGTIGT: inventory_auto_deduct skal også sættes manuelt i prod-DB inden
-- go-live — ellers virker LEVERET ikke som forventet i forhold til Grocy-lager.
-- ============================================================

INSERT OR REPLACE INTO settings (key, value) VALUES
    ('default_grocy_location_id', '3'),
    ('inventory_auto_deduct',     '1');

COMMIT;

-- ============================================================
-- 5. SANITY-CHECK QUERIES (kør manuelt efter import)
-- ============================================================
-- Verificér at seed er konsistent inden T_PLAN-tests starter.
--
-- A) Total antal bonner skal være 8
--    SELECT COUNT(*) FROM bons WHERE id BETWEEN 4001 AND 4008;
--    Forventet: 8
--
-- B) Total antal bon-linjer
--    SELECT COUNT(*) FROM bon_lines WHERE bon_id BETWEEN 4001 AND 4008;
--    Forventet: 30 (4+4+4+2+4+4+4+4)
--
-- B2) Antal tilbud (is_offer=1)
--     SELECT COUNT(*) FROM bons WHERE is_offer=1 AND id BETWEEN 4001 AND 4008;
--     Forventet: 1 (kun bon 4008)
--
-- C) Sum af enheder pr. dag (ekskl. AFLYST) — match T_PLAN §6.1 sidste række
--    SELECT b.delivery_date, SUM(bl.quantity) AS units
--    FROM bons b JOIN bon_lines bl ON bl.bon_id = b.id
--    WHERE b.id BETWEEN 4001 AND 4008
--      AND b.status_id != (SELECT id FROM status_definitions WHERE code='AFLYST')
--    GROUP BY b.delivery_date ORDER BY b.delivery_date;
--    Forventet: 11/5: 165, 12/5: 103, 13/5: 134, 14/5: 47, 15/5: 83
--
-- D) total_price på bons skal matche SUM(line_total) for samme bon
--    SELECT b.bon_number, b.total_price,
--           (SELECT ROUND(SUM(line_total), 2) FROM bon_lines WHERE bon_id = b.id) AS sum_lines,
--           b.total_price - (SELECT SUM(line_total) FROM bon_lines WHERE bon_id = b.id) AS diff
--    FROM bons b WHERE b.id BETWEEN 4001 AND 4008;
--    Forventet: alle diff = 0
--
-- E) total_units på bons skal matche SUM(quantity)
--    SELECT b.bon_number, b.total_units,
--           (SELECT SUM(quantity) FROM bon_lines WHERE bon_id = b.id) AS sum_qty
--    FROM bons b WHERE b.id BETWEEN 4001 AND 4008;
--    Forventet: alle ens
-- ============================================================
