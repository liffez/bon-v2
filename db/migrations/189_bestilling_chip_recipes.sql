-- 189: kost-knapper i bestillingsformularen der svarer til en vare
--
-- "🌾 Glutenfri" i formularen skrev kun `Glutenfri: 1` i kundeønskerne. Bollen
-- skulle tastes på bonen i hånden, og det blev glemt (B4314). Nu lægger
-- web-bestillingen selv N stk. af opskriften på bonen, med pris fra Grocy.
--
-- Præfiks → Grocy recipe_id. 75 = "Glutenfri Bolle" i grocy-hq (varenr 25).
-- Kun kost-knapper hvor der findes én vare at lægge på hører hjemme her —
-- "Vegansk: 3" betyder tre veganske retter, ikke en bestemt vare.
-- Tom / {} = slået fra. Findes opskriften ikke, logges det og bonen får intet.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('bestilling.chip_recipes', '{"Glutenfri": 75}',
   'Kost-knapper i bestillingsformularen der lægger en vare på bonen: {"Præfiks": grocy_recipe_id}');
