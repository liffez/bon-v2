// scripts/test-planning-production.js
//
// Planlægning (ny), fase 2 — niveau 4 (Skal laves) og 5 (Råvarer) fra
// services/planningProduction.js. Den ÆGTE resolver, kostpris- og CO₂-motor
// kører; kun Grocy-adapterens hentefunktioner er erstattet med en fixtur
// (samme mønster som test-consume-policy.js).
//
//   node --experimental-sqlite scripts/test-planning-production.js
//
// Det vigtigste der låses fast:
//   • niveau 4 er de varer resolveren kalder producerbare (produktionspolitikken)
//   • en produceret vare står IKKE i råvarelisten — men råvarerne til de batches
//     der skal laves, gør
//   • status og 🛒-mængde er resolverens egne
//   • kost på niveau 4 kommer fra opskriften (#558), og er skjult uden rettighed

require('./helpers/isolated_db');

const grocy = require('../services/grocyAdapter');
const { buildProductionLevels } = require('../services/planningProduction');

let pass = 0, fail = 0;
function check(label, ok, extra) {
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  ' + (extra ?? '')}`);
    ok ? pass++ : fail++;
}
const safe = (label, fn) => { try { check(label, !!fn()); } catch (e) { check(label, false, 'kastede: ' + e.message); } };
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `fik ${JSON.stringify(got)}, forventet ${JSON.stringify(want)}`);
const near = (label, got, want) => check(label, Math.abs((got ?? NaN) - want) < 0.005, `fik ${got}, forventet ${want}`);

/* ── Fixtur ───────────────────────────────────────────────── */
// Menu 1 "Grisen på Rug": brød + 0,25 kg langtidsstegt gris (produkt 125, RR Produktion)
// Menu 2 "Falaflen":      falafel-råvare + 0,05 kg tahin (produkt 300, RR produktion Hurtig)
//                         + en æske (emballage)
// Menu 3 "Suppe":         0,2 kg bouillon (produkt 400, RR Produktion UDEN udbytte)
const P = { BROED: 205, GRIS_RAA: 200, SALT: 201, TAHINI: 204, FALAFEL_RAA: 206, AESKE: 207,
            GRIS: 125, TAHIN: 300, BOUILLON: 400, BEN: 208, MEL: 209, PICKLES: 500, AGURK: 210 };
const G = { BROED: 30, KOED: 31, KRYDDERI: 40, EMBALLAGE: 10 };

const RAW = new Map([
    [1,  { id: 1,  name: 'Grisen på Rug', base_servings: 1, userfields: { sellable: '1' } }],
    [2,  { id: 2,  name: 'Falaflen',      base_servings: 1, userfields: { sellable: '1' } }],
    [3,  { id: 3,  name: 'Suppe',         base_servings: 1, userfields: { sellable: '1' } }],
    [4,  { id: 4,  name: 'Boller',        base_servings: 1, userfields: { sellable: '1' } }],
    [28, { id: 28, name: 'Langtids stegt Gris', base_servings: 1, product_id: P.GRIS,
           userfields: { grupper: 'RR Produktion', recipeunit: 'Kilo', recipeunitnumber: '1' } }],
    [98, { id: 98, name: 'Tahin dressing', base_servings: 1, product_id: P.TAHIN,
           userfields: { grupper: 'RR produktion Hurtig', recipeunit: 'Kilo', recipeunitnumber: '1' } }],
    [60, { id: 60, name: 'Pickles', base_servings: 1, product_id: P.PICKLES,
           userfields: { grupper: 'RR Produktion', recipeunit: 'Kilo', recipeunitnumber: '1' } }],
    [50, { id: 50, name: 'Bouillon', base_servings: 1, product_id: P.BOUILLON,
           userfields: { grupper: 'RR Produktion' } }],   // intet udbytte → kan ikke regnes
]);
const POS = [
    { recipe_id: 1,  product_id: P.BROED,       amount: 0.12, qu_id: 4 },
    { recipe_id: 1,  product_id: P.GRIS,        amount: 0.25, qu_id: 4 },
    { recipe_id: 2,  product_id: P.FALAFEL_RAA, amount: 0.10, qu_id: 4 },
    { recipe_id: 2,  product_id: P.TAHIN,       amount: 0.05, qu_id: 4 },
    { recipe_id: 2,  product_id: P.AESKE,       amount: 1,    qu_id: 5, ingredient_group: 'Emballage' },
    { recipe_id: 3,  product_id: P.BOUILLON,    amount: 0.20, qu_id: 4 },
    { recipe_id: 4,  product_id: P.MEL,         amount: 0.20, qu_id: 4 },
    { recipe_id: 4,  product_id: P.PICKLES,     amount: 0.05, qu_id: 4 },
    { recipe_id: 60, product_id: P.AGURK,       amount: 1,    qu_id: 4 },
    { recipe_id: 28, product_id: P.GRIS_RAA,    amount: 1.12, qu_id: 4 },
    { recipe_id: 28, product_id: P.SALT,        amount: 0.01, qu_id: 4 },
    { recipe_id: 98, product_id: P.TAHINI,      amount: 0.50, qu_id: 4 },
    { recipe_id: 50, product_id: P.BEN,         amount: 2,    qu_id: 4 },
];
const PRODUCTS = [
    [P.BROED, 'Rugbrød', G.BROED, 4], [P.GRIS_RAA, 'Svinekam', G.KOED, 4], [P.SALT, 'Salt', G.KRYDDERI, 4],
    [P.TAHINI, 'Tahini', G.KRYDDERI, 4], [P.FALAFEL_RAA, 'Kikærter', null, 4], [P.AESKE, 'Æske', G.EMBALLAGE, 5],
    [P.GRIS, 'Langtids stegt Gris', G.KOED, 4], [P.TAHIN, 'Tahin dressing', G.KRYDDERI, 4],
    [P.BOUILLON, 'Bouillon', null, 4], [P.BEN, 'Suppeben', G.KOED, 4], [P.MEL, 'Hvedemel', G.BROED, 4, 6],
    [P.PICKLES, 'Pickles', null, 4], [P.AGURK, 'Agurk', null, 4],
].map(([id, name, grp, qu, pu]) => ({ id, name, product_group_id: grp, qu_id_stock: qu, qu_id_purchase: pu || qu,
    userfields: id === P.GRIS_RAA ? { co2e_per_kg: '5' } : id === P.SALT ? { co2e_per_kg: '1' } : {} }));
const STOCK = [
    { product_id: P.BROED, amount: 1 }, { product_id: P.GRIS, amount: 0.3 }, { product_id: P.SALT, amount: 5 },
    { product_id: P.AESKE, amount: 3 }, { product_id: P.MEL, amount: 0.1 }, { product_id: P.PICKLES, amount: 5 },
];
const COSTS = new Map([[P.GRIS_RAA, { cost: 50 }], [P.SALT, { cost: 10 }], [P.BROED, { cost: 20 }],
    [P.TAHINI, { cost: 40 }], [P.AESKE, { cost: 2 }]]);

grocy.getRecipes = async () => [
    { id: 1, name: 'Grisen på Rug', unit_number: 1 }, { id: 2, name: 'Falaflen', unit_number: 1 },
    { id: 3, name: 'Suppe', unit_number: 1 }, { id: 4, name: 'Boller', unit_number: 1 }];
grocy.getRecipesRawMap = async () => RAW;
grocy.getRecipesRaw = async () => [...RAW.values()];
grocy.getAllRecipesPos = async () => POS;
grocy.getRecipeNestings = async () => [];
grocy.getProducts = async () => PRODUCTS;
grocy.getStock = async () => STOCK;
grocy.getProductGroups = async () => [
    { id: G.BROED, name: '30 Brød' }, { id: G.KOED, name: '31 Kød' },
    { id: G.KRYDDERI, name: '40 Krydderier' }, { id: G.EMBALLAGE, name: '10 Emballage' }];
grocy.getQuantityUnits = async () => [{ id: 4, name: 'Kilo', name_short: 'kg' }, { id: 5, name: 'Stk', name_short: 'stk' },
    { id: 6, name: 'Sæk', name_short: 'sæk' }];
// 1 sæk mel = 0,35 kg
grocy.getQuantityUnitConversions = async () => [{ product_id: P.MEL, from_qu_id: 6, to_qu_id: 4, factor: 0.35 }];
grocy.getProductUnitCostDetails = async () => COSTS;

const lines = [{ grocy_recipe_id: 1, quantity: 4 }, { grocy_recipe_id: 2, quantity: 10 }, { grocy_recipe_id: 3, quantity: 1 },
    { grocy_recipe_id: 4, quantity: 4 }];
const itemRecipes = new Map([[1, 'Grisen på Rug'], [2, 'Falaflen'], [3, 'Suppe'], [4, 'Boller']]);

(async () => {
    const r = await buildProductionLevels({ lines, itemRecipes, perms: { cost: true, sale: true } });
    const N = r.nodes;

    // §1 Niveau 4 = de producerbare varer
    eq('niveau 4: gris, bouillon, tahin, pickles', r.levels.prep.slice().sort(), ['prep:125', 'prep:300', 'prep:400', 'prep:500']);
    // Tre afsnit (afgjort 25.09)
    eq('afsnit', r.sections.prep.map(x => x.key), ['to_stock', 'on_demand', 'covered']);
    eq('i forvejen: gris (mangler) før bouillon (udbytte ukendt)', r.sections.prep[0].ids, ['prep:125', 'prep:400']);
    eq('ved levering: tahin', r.sections.prep[1].ids, ['prep:300']);
    eq('dækket: pickles, foldet sammen', [r.sections.prep[2].ids, r.sections.prep[2].collapsed], [['prep:500'], true]);
    eq('gris: mangler 0,7 kg (behov 1 − lager 0,3), samme enhed', [N['prep:125'].short_display, N['prep:125'].need_display, N['prep:125'].stock_display],
        ['0,7 kg', '1 kg', '0,3 kg']);
    check('dækket vare får ingen batch-råvarer i niveau 5', !r.levels.raw.flatMap(g => N[g].children).includes('raw:210'));
    eq('dækket vare kender stadig sin opskrift (til linket)', [N['prep:500'].make.recipe_id, N['prep:500'].make.batches], [60, null]);
    eq('niveau-listen følger afsnittene', r.levels.prep, r.sections.prep.flatMap(x => x.ids));
    eq('gris er to_stock', N['prep:125'].production_type, 'to_stock');
    eq('tahin er on_demand', N['prep:300'].production_type, 'on_demand');
    near('gris: behov 4 × 0,25 kg', N['prep:125'].qty, 1);
    eq('gris: 1 batch skal laves (1 − 0,3 på lager)', N['prep:125'].make.batches, 1);
    eq('gris: kan ikke laves — svinekammen mangler', N['prep:125'].status, 'mangler');
    eq('gris: mangelliste', N['prep:125'].make.missing, ['Svinekam']);
    // Tahin mangler også sin råvare — men står stadig sidst, fordi Bon selv laver den ved levering.
    eq('tahin: mangler tahini', N['prep:300'].status, 'mangler');
    eq('bruges i', N['prep:125'].used_in, ['Grisen på Rug']);

    // §2 Børn: råvarerne i det batch der skal laves
    eq('gris: børn = svinekam + salt', N['prep:125'].children.map(id => N[id].name).sort(), ['Salt', 'Svinekam']);
    near('gris-batch: 1,12 kg svinekam', N['prepraw:125:200'] && N['prepraw:125:200'].qty, 1.12);

    // §3 Niveau 5: ingen producerede varer, men batch-råvarerne er med
    const rawIds = r.levels.raw.flatMap(g => N[g].children);
    const rawNames = rawIds.map(id => N[id].name).sort();
    check('producerede varer står ikke i råvarelisten', !rawNames.includes('Langtids stegt Gris') && !rawNames.includes('Tahin dressing'));
    check('svinekam (til gris-batchen) er med', rawNames.includes('Svinekam'));
    check('tahini (til tahin-batchen) er med', rawNames.includes('Tahini'));
    check('bouillonens råvarer er IKKE med (udbytte ukendt)', !rawNames.includes('Suppeben'));
    check('advarsel om bouillon', r.warnings.some(w => /Bouillon/.test(w)));
    near('svinekam: 1,12 kg (1 batch)', N['raw:200'].qty, 1.12);
    eq('svinekam: mangler', N['raw:200'].status, 'mangler');
    eq('svinekam: 🛒 = resolverens mængde', N['raw:200'].cart && N['raw:200'].cart.amount, 1.12);
    eq('rugbrød dækket: ingen 🛒', N['raw:205'].cart, null);
    // 4 × 0,2 − 0,1 = 0,7 kg = 2 sække à 0,35 — i flydende tal 2,0000000000000004
    eq('mel: 2 hele sække, ikke 3', N['raw:209'].cart && N['raw:209'].cart.amount, 2);

    // §4 Grupper efter varegruppe; emballage sidst trods lavt nummer
    eq('grupper i rækkefølge', r.levels.raw.map(id => N[id].name), ['Brød', 'Kød', 'Krydderier', 'Uden varegruppe', 'Emballage']);
    eq('kød-gruppen: 1 mangler', N['pgrp:31'].badge && N['pgrp:31'].badge.text, '1 mangler');

    // §5 Tal — aktuelle priser
    near('gris: kost fra opskriften (1,12×50 + 0,01×10) × 1 kg', N['prep:125'].values.cost_ex, 56.1);
    near('gris: CO₂ via opskriften 1,12×5 + 0,01×1', N['prep:125'].values.co2e_kg, 5.61);
    eq('tahin: CO₂ ukendt (tahini har ingen faktor) — ikke 0', N['prep:300'].values.co2e_unknown, 1);
    near('svinekam: kost 1,12 × 50', N['raw:200'].values.cost_ex, 56);
    eq('kikærter: ukendt kost', N['raw:206'].values.cost_unknown, 1);
    eq('grundlag: aktuelle priser', N['raw:200'].values.basis, 'aktuel');
    near('kød-gruppens kost = summen af dens rækker', N['pgrp:31'].values.cost_ex, 56);
    check('ingen salgspris på niveau 4–5', !/"sale_ex"/.test(JSON.stringify(r)));

    // §6 Rettighed
    const noCost = await buildProductionLevels({ lines, itemRecipes, perms: { cost: false } });
    check('uden kost-rettighed: ingen cost_ex', !/"cost_ex"/.test(JSON.stringify(noCost)));

    // §6b Visning: samme enhed og skala for behov, lager og mangel
    const { _amounts, _shortUnit } = require('../services/planningProduction');
    const a1 = _amounts({ needed_stock: 0.04, stock_amount: 2.01, display_factor: 1000, unit: 'Gram' });
    eq('lager over 1000 g → alt i kg', [a1.need_display, a1.stock_display, a1.short_display], ['0,04 kg', '2,01 kg', '0 kg']);
    const a2 = _amounts({ needed_stock: 0.04, stock_amount: 0.01, display_factor: 1000, unit: 'Gram' });
    eq('små mængder bliver i g', [a2.need_display, a2.stock_display, a2.short_display], ['40 g', '10 g', '30 g']);
    eq('Gram/Kilo → g/kg', [_shortUnit('Gram'), _shortUnit('Kilo'), _shortUnit('Antal'), _shortUnit('pose')], ['g', 'kg', 'stk', 'pose']);

    // §7 Tomt grundlag
    const empty = await buildProductionLevels({ lines: [], itemRecipes, perms: { cost: true } });
    eq('tomt: ingen rækker', empty.levels, { prep: [], raw: [] });

    console.log(`\n${fail === 0 ? '✅ ALLE' : '❌'} — ${pass} pass / ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
