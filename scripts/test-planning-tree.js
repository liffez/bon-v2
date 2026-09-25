// scripts/test-planning-tree.js
//
// Planlægning (ny), fase 1 — træet fra services/planningTree.js og ruten
// POST /api/bons/planning/tree. Kører mod en frisk temp-DB bygget af de rigtige
// migrations; Grocy er en attrap (deps.grocy).
//
//   node --experimental-sqlite scripts/test-planning-tree.js
//
// Det vigtigste der låses fast:
//   • enhederne er PRÆCIS dem bons.total_units giver (samme SQL-udtryk)
//   • en boks optræder som sine børn, og summen flytter sig ikke en øre
//   • ønsker grupperes på normaliseret tekst
//   • event-salg tæller ikke
//   • kost/salg er IKKE i svaret når rollen ikke må se dem

require('./helpers/isolated_db');

const http = require('http');
const express = require('express');
const { getDb } = require('../db/database');
const helpers = require('../db/helpers');
const { buildPlanningTree } = require('../services/planningTree');
const PeriodPicker = require('../shared/periodPicker');
const Moms = require('../shared/moms');

const db = getDb();
db.exec('PRAGMA foreign_keys = OFF');

let pass = 0, fail = 0;
function check(label, ok, extra) {
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  ' + (extra ?? '')}`);
    ok ? pass++ : fail++;
}
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `fik ${JSON.stringify(got)}, forventet ${JSON.stringify(want)}`);
const near = (label, got, want) => check(label, Math.abs((got ?? NaN) - want) < 0.005, `fik ${got}, forventet ${want}`);

/* ── Fixture ─────────────────────────────────────────────── */
db.prepare(`INSERT INTO settings (key,value) VALUES ('unit_count_categories', ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('["01 Sandwich","04 Slider"]');
db.prepare(`INSERT INTO settings (key,value) VALUES ('unit_count_extra_recipes', '[]')
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
helpers.invalidateUnitCountCache();

const ruc = db.prepare(`INSERT INTO recipe_unit_counts (grocy_recipe_id, unit_count) VALUES (?,?)`);
ruc.run(10, 1);   // Kartoflen — slider
ruc.run(11, 1);   // Fisken — slider
ruc.run(20, 2);   // Slider-boks: Kartoflen + Fisken
ruc.run(30, 0);   // Transportkasse

const st = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code).id;
const bon = db.prepare(`INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date,
    event_role, payment_type, offer_discount_percent) VALUES (?,?,?,?,?,?,?,?,?)`);
bon.run(1, 'B1', st('GODKENDT'), 1, '2026-09-20', '2026-09-28', null, 'invoice', 10);
bon.run(2, 'B2', st('KLAR'),     1, '2026-09-20', '2026-09-29', null, 'invoice', 0);
bon.run(3, 'B3', st('BETALT'),   1, '2026-09-20', '2026-09-28', 'sales', 'cash', 0);

const line = db.prepare(`INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
    unit_price, line_total, cost_price, co2e, special_request, is_accessory, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
//         bon rec  navn              kategori        qty unit  pris  total  kost  co2  ønske           acc
line.run(1, 10, 'Kartoflen',      '04 Slider',     5, 'stk', 100, 500,   10,  0.5, null,           0, 1);
line.run(1, 20, 'Slider Boks',    '04 Slider',     2, 'stk', 200, 400,   30,  2.0, null,           0, 2);
line.run(1, 30, 'Transportkasse', '06 Emballage',  3, 'stk',  20,  60,    5,  null, null,          0, 3);
line.run(1, 10, 'Kartoflen',      '04 Slider',     2, 'stk', 100, 200,   10,  0.5, 'Uden løg',     0, 4);
line.run(2, 10, 'Kartoflen',      '04 Slider',     3, 'stk', 100, 300,   10,  0.5, '  uden   LØG ', 0, 1);
line.run(2, 11, 'Fisken',         '04 Slider',     1, 'stk', 100, 100, null,  1.0, null,           0, 2);
line.run(3, 10, 'Kartoflen',      '04 Slider',    50, 'stk', 100, 5000,  10,  0.5, null,           0, 1);
helpers.recalcBonTotalUnits(db, 1);
helpers.recalcBonTotalUnits(db, 2);

const recipesRaw = [
    { id: 10, name: 'Kartoflen', userfields: { sellable: '1', grupper: '04 Slider' } },
    { id: 11, name: 'Fisken',    userfields: { sellable: '1', grupper: '04 Slider' } },
    { id: 20, name: 'Slider Boks', userfields: { sellable: '1', grupper: '04 Slider' } },
    { id: 30, name: 'Transportkasse', userfields: { sellable: '1', grupper: '06 Emballage' } },
    { id: 40, name: 'Æggesalat', userfields: { sellable: '0', grupper: 'RR Produktion' } },
];
const nestings = [
    { recipe_id: 20, includes_recipe_id: 10, servings: 1 },
    { recipe_id: 20, includes_recipe_id: 11, servings: 1 },
    { recipe_id: 10, includes_recipe_id: 40, servings: 1 },   // ikke sælgelig → foldes IKKE ud
];
const sellable = [
    { id: 11, name: 'Fisken', category: '04 Slider', unit: 'stk', prices: { catering: 125, festival: 150 }, cost_price: 20, co2e: 1 },
];
const grocyOk = {
    getRecipesRaw: async () => recipesRaw,
    getRecipeNestings: async () => nestings,
    getRecipes: async () => sellable,
};
const grocyDown = {
    getRecipesRaw: async () => { throw new Error('nede'); },
    getRecipeNestings: async () => { throw new Error('nede'); },
    getRecipes: async () => { throw new Error('nede'); },
};

const ALL = { cost: true, sale: true };
const extras = [{ grocy_recipe_id: 11, quantity: 4, price_category: 'catering' }];

(async () => {
    const t = await buildPlanningTree(db, { bonIds: [1, 2, 3], extras, perms: ALL }, { grocy: grocyOk });
    const N = t.nodes;

    // §1 Enhederne er bons.total_units — ingen egen tælling
    const dbUnits = db.prepare(`SELECT SUM(total_units) AS u FROM bons WHERE id IN (1,2)`).get().u;
    eq('enheder: bons B1+B2 i DB', dbUnits, 15);
    eq('træets enheder = bons.total_units + ekstra', t.totals.units, dbUnits + 4);
    eq('unitsForLines = samme regel som recalc', helpers.unitsForLines(db, [
        { quantity: 2, category: '04 Slider', grocy_recipe_id: 20 },
        { quantity: 3, category: '06 Emballage', grocy_recipe_id: 30 },
        { quantity: 1, category: 'lunch', grocy_recipe_id: 10 },
    ]), [4, 0, 1]);

    // §2 Event-salg tæller ikke
    eq('event-salgsbon er udeladt og nævnt', t.meta.excluded_bons, ['B3']);
    eq('bon_count = kun produktion', t.meta.bon_count, 2);

    // §3 Boksen foldes ud i sine sælgelige børn
    check('boksen står ikke som vare', !N['item:r:20']);
    eq('Kartoflen = 5 + 2 + 3 + 2 fra boks', N['item:r:10'].qty, 12);
    eq('Fisken = 2 fra boks + 1 + 4 ekstra', N['item:r:11'].qty, 7);
    check('ikke-sælgeligt barn (Æggesalat) er ikke en vare', !N['item:r:40']);

    // §4 Kategorier
    const slider = N['cat:04 Slider'];
    eq('Slider: enheder', slider.units, 19);
    eq('Slider: sum af varernes antal = kategoriens enheder', slider.children.reduce((s, id) => s + N[id].qty, 0), slider.units);
    check('Slider tæller som enheder', slider.counts_as_unit === true);
    check('Emballage tæller ikke', N['cat:06 Emballage'].counts_as_unit === false);
    eq('tællende kategori står først', t.levels.categories[0], 'cat:04 Slider');
    eq('Varer-fanen = alle varer', t.levels.items.length, 3);
    eq('visningsnavn uden nummer', slider.name, 'Slider');

    // §5 Ønsker — normaliseret, ingen parsing
    const k = N['item:r:10'];
    eq('Kartoflen har ét ønske', k.badge && k.badge.text, '1 ønske');
    eq('Kartoflen: standard + ønske', k.children.length, 2);
    const reqNode = N[k.children[1]];
    eq('"Uden løg" og "  uden   LØG " er samme gruppe', reqNode.qty, 5);
    eq('ønske-gruppen har begge bons som kilde', reqNode.children.map(id => N[id].source.bon_nr).sort(), ['B1', 'B2']);
    eq('niveau 3: kun varer med ønsker', t.levels.requests, ['rq:r:10']);
    eq('niveau 3: "af N"', N['rq:r:10'].of_qty, 12);
    eq('vare uden ønsker går direkte til kilderne', N[N['item:r:11'].children[0]].kind, 'source');

    // §6 Pr. dag
    eq('Kartoflen pr. dag', k.days, { '2026-09-28': 9, '2026-09-29': 3 });
    eq('tabellens dage: kun dage med noget på', t.days, ['2026-09-28', '2026-09-29']);
    eq('enheder pr. dag (bundlinje)', t.totals.units_days, { '2026-09-28': 11, '2026-09-29': 4 });

    // §7 Tal — kost fra snapshot, boksen delt 50/50 (servings), ukendt tælles
    near('kost Kartoflen = 50+20+30 (½ boks)+30', k.values.cost_ex, 130);
    near('kost Fisken = 30 (½ boks) + 80 ekstra', N['item:r:11'].values.cost_ex, 110);
    eq('Fisken: én ukendt kostpris', N['item:r:11'].values.cost_unknown, 1);
    near('kost i alt = summen af kategorierne', t.totals.cost_ex, 130 + 110 + 15);
    // Salg: rabat 10 % på varer, ikke emballage (migration 168); ex via moms.js
    near('salg Transportkasse: ingen rabat på emballage', N['item:r:30'].values.sale_ex, Moms.inclToExcl(60));
    near('salg Kartoflen: B1 700×0,9 + B2 300 + ½ boks 180', k.values.sale_ex, Moms.inclToExcl(700 * 0.9 + 300 + 400 * 0.9 / 2));
    eq('Fisken blander bon- og listepris', N['item:r:11'].values.sale_basis, 'blandet');
    near('boks-split flytter ikke en øre', N['item:r:10'].values.sale_ex + N['item:r:11'].values.sale_ex,
        Moms.inclToExcl(700 * 0.9 + 300 + 400 * 0.9 + 100) + Moms.inclToExcl(4 * 125));

    // §7b Fordelingen følger nestingens servings (samme vægt som e-conomic-udkastet)
    const { unfoldAtom } = require('../services/planningTree');
    const parts = unfoldAtom({ qty: 1, units: 3, cost_ex: 30, sale_ex: 240, co2e_kg: 3, name: 'Boks',
        category: '04 Slider', source: {} },
        [{ recipe_id: 10, servings: 2, name: 'Kartoflen', category: '04 Slider' },
         { recipe_id: 11, servings: 1, name: 'Fisken', category: '04 Slider' }]);
    eq('servings 2:1 → antal', parts.map(x => x.qty), [2, 1]);
    eq('servings 2:1 → enheder', parts.map(x => x.units), [2, 1]);
    eq('servings 2:1 → kost', parts.map(x => x.cost_ex), [20, 10]);
    eq('servings 2:1 → salg', parts.map(x => x.sale_ex), [160, 80]);

    // §8 Rettigheder — et tal man ikke må se, er ikke i svaret
    const noCost = await buildPlanningTree(db, { bonIds: [1, 2], extras: [], perms: { cost: false, sale: true } }, { grocy: grocyOk });
    const json1 = JSON.stringify(noCost);
    check('uden kost: ingen cost_ex nogen steder', !/"cost_ex"/.test(json1));
    check('uden kost: ingen db_ex', !/"db_ex"/.test(json1));
    const noSale = await buildPlanningTree(db, { bonIds: [1, 2], extras: [], perms: { cost: true, sale: false } }, { grocy: grocyOk });
    const json2 = JSON.stringify(noSale);
    check('uden salg: ingen sale_ex nogen steder', !/"sale_ex"/.test(json2));
    check('uden salg: kost er der stadig', /"cost_ex"/.test(json2));

    // §9 Grocy nede: ingen udfoldning, men enhederne står fast
    const down = await buildPlanningTree(db, { bonIds: [1, 2], extras, perms: ALL }, { grocy: grocyDown });
    check('Grocy nede: boksen står som boks', !!down.nodes['item:r:20']);
    eq('Grocy nede: enhederne er de samme', down.totals.units, dbUnits);
    check('Grocy nede: advarsel om boksene', down.meta.warnings.some(w => /bokse/.test(w)));
    check('Grocy nede: advarsel om ekstra-linjerne', down.meta.warnings.some(w => /Ekstra-linjerne/.test(w)));
    check('Grocy nede: niveau 4–5 tomme med advarsel, ikke en fejl', Array.isArray(down.levels.prep) && down.levels.prep.length === 0
        && down.meta.warnings.some(w => /Skal laves og Råvarer/.test(w)));

    // §10 Ruten: rollen afgør hvad der sendes
    db.prepare(`INSERT INTO users (id, name, email, role, is_active) VALUES (901,'K','k@test','kitchen',1),(902,'O','o@test','office',1)`).run();
    require('../shared/auth').invalidatePermCache();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: Number(req.headers['x-user']), userRole: req.headers['x-role'] }; next(); });
    app.use('/api/bons', require('../routes/kitchen'));
    const srv = http.createServer(app);
    await new Promise(r => srv.listen(0, r));
    const port = srv.address().port;
    const post = (user, role) => new Promise((resolve, reject) => {
        const body = JSON.stringify({ bon_ids: [1, 2] });
        const r = http.request({ port, path: '/api/bons/planning/tree', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user': user, 'x-role': role } }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', reject); r.end(body);
    });
    const kit = await post(901, 'kitchen');
    eq('rute: kitchen svarer 200', kit.status, 200);
    check('rute: kitchen får ingen salgspris (migration 190)', !/"sale_ex"/.test(kit.body));
    const off = await post(902, 'office');
    check('rute: office får salgspris', /"sale_ex"/.test(off.body));
    check('rute: office får kostpris', /"cost_ex"/.test(off.body));
    srv.close();

    // §11 Migration 190
    const def = db.prepare(`SELECT value FROM settings WHERE key='planning_default_statuses'`).get();
    eq('standard-statusser: uden LEVERET', JSON.parse(def.value), ['GODKENDT', 'IGANG', 'KLAR']);
    const kp = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='role_permissions_kitchen'`).get().value);
    eq('kitchen: plan_salg fra', kp.plan_salg, false);

    // §12 Periodevælgerens datoregning
    eq('uge 38 + ▶ = uge 39', PeriodPicker._isoWeek(PeriodPicker._step('week', '2026-09-14', 1)), 39);
    eq('uge: mandag–søndag', PeriodPicker._rangeFor('week', '2026-09-17'), { from: '2026-09-14', to: '2026-09-20' });
    eq('3 dage', PeriodPicker._rangeFor('3days', '2026-09-30'), { from: '2026-09-30', to: '2026-10-02' });
    eq('Dag = i morgen', PeriodPicker._startAnchor('day', { day: 1 }, '2026-12-31'), '2027-01-01');
    eq('Uge = næste uge', PeriodPicker._startAnchor('week', { week: 1 }, '2026-09-24'), '2026-09-28');
    eq('3 dage ◀ = tre dage tilbage', PeriodPicker._step('3days', '2026-03-30', -1), '2026-03-27');
    eq('10 dage fra mandag = tir → tor næste uge', PeriodPicker._rangeFor('10days', PeriodPicker._startAnchor('10days', { '10days': 1 }, '2026-09-28')),
        { from: '2026-09-29', to: '2026-10-08' });
    eq('10 dage ▶ = ti dage frem', PeriodPicker._step('10days', '2026-09-29', 1), '2026-10-09');
    eq('10 dage: etiket', PeriodPicker._label('10days', { from: '2026-09-29', to: '2026-10-08' }), '29.09–08.10.2026');

    console.log(`\n${fail === 0 ? '✅ ALLE' : '❌'} — ${pass} pass / ${fail} fail`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
