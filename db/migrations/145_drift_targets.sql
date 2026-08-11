-- 145: Måltal for driftsregnskabets løn% og råvare%
--
-- Løn- og vareforbrugsprocenten vises på pillerne og i dag-for-dag-tabellen,
-- men et tal uden et måltal siger ikke om dagen var god. Disse tre settings
-- giver farvekodningen noget at måle imod.
--
-- TOM VÆRDI = INGEN FARVEKODNING. Det er med vilje: et måltal er husets eget
-- (det afhænger af koncept, priser og bemanding), og en default ville være et
-- gæt der lignede en anbefaling. Procenterne vises stadig — de er bare
-- neutrale indtil nogen har taget stilling. Sættes i Settings → Løn.
--
-- Lavere er bedre for begge. Farvetrappen er:
--
--   pct <= mål                    → grøn   (på eller under måltallet)
--   mål < pct <= mål + tolerance  → gul    (lige over — værd at kigge på)
--   pct > mål + tolerance         → rød    (klart over)
--
-- Tolerancen er i PROCENTPOINT og deles af begge måltal, så en dag der ligger
-- 0,3 point over ikke lyser rødt. Default 2,0.
--
-- Måltallene gemmes IKKE i frosne dagsopgørelser (labor_day_snapshot). De
-- lægges på svaret uden om snapshottet, så et ændret måltal slår igennem med
-- det samme — også på historiske dage. Et måltal er en målestok, ikke et
-- regnskabstal: at fryse det ville betyde at man ikke kunne se gamle dage i
-- lyset af det man styrer efter i dag.

INSERT INTO settings (key, value, description)
SELECT 'target_labor_pct', '',
       'Måltal for lønprocent (løn ÷ omsætning, ex moms). Tom = ingen farvekodning i Driftsregnskabet.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'target_labor_pct');

INSERT INTO settings (key, value, description)
SELECT 'target_food_cost_pct', '',
       'Måltal for råvareprocent (vareforbrug ÷ omsætning, ex moms). Tom = ingen farvekodning i Driftsregnskabet.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'target_food_cost_pct');

INSERT INTO settings (key, value, description)
SELECT 'target_pct_tolerance', '2',
       'Hvor mange procentpoint over måltallet der stadig vises gult (ikke rødt). Deles af løn% og råvare%.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'target_pct_tolerance');
