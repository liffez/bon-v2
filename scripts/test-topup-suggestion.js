// scripts/test-topup-suggestion.js
// ============================================================
// Test for computeTopupSuggestion (GET /api/events/:id/topup-suggestion).
// Spec: docs/CLAUDE_EVENT.md §6 — top-up-forslag.
//
//   rest = (prep + top-ups, delivery_date ≤ dato) − solgt (delivery_date < dato)
//   forslag = forecast_dag_N − rest   (clamp ≥ 0)
//
// Rammer den ÆGTE helper i routes/events.js (ingen SQL-replikering) og
// MOCKER grocy.getProducts/getQuantityUnits + ingredientResolver's
// resolveConsumeItems — så BOM-eksplosionen testes deterministisk uden
// netværk/Grocy-flakiness (samme mønster som test-sales-prefill.js).
// Isoleret temp-DB. Rører intet i prod.
//
// Verificerer:
//   • Kategori-niveau: rest = prepped − solgt, forslag = forecast − rest, clamp 0.
//   • Datofiltre: produktion ≤ dato tæller; salg KUN < dato (dagens salg er ikke sket).
//   • Produkt-allokering: pro-rata på prep-mix, heltal der summer korrekt.
//   • Råvare-niveau: fetch = behov − rest (clamp 0), surplus = rest − behov (clamp 0).
//   • Forecast-kategori uden prep-mix → warning, ingen allokering.
//   • Eksisterende topup-bon på dagen reducerer forslaget (idempotent-agtigt).
//   • allocateInteger: largest remainder, kanter (0-vægte, 0-total).
//
//   node --experimental-sqlite scripts/test-topup-suggestion.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-topup-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

// 1) Migrér frisk temp-DB.
const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// 2) Mock FØR helperen kaldes (samme modul-objekter som routes/events.js
//    holder via require — patch slår igennem).
const grocy = require('../services/grocyAdapter');
grocy.getProducts = async () => ([
    { id: 11, name: 'Falafelmasse', qu_id_stock: 1 },
    { id: 12, name: 'Bolle',        qu_id_stock: 2 },
    { id: 13, name: 'Tun',          qu_id_stock: 1 },
    { id: 14, name: 'Grønt-mix',    qu_id_stock: 1 },
]);
grocy.getQuantityUnits = async () => ([
    { id: 1, name: 'kg' },
    { id: 2, name: 'stk' },
]);

// Deterministisk BOM: opskrift → råvarer pr. enhed (i stock-units).
const BOM = {
    101: [ { pid: 11, name: 'Falafelmasse', per: 0.1  }, { pid: 12, name: 'Bolle', per: 1 } ],  // Falaflen
    102: [ { pid: 13, name: 'Tun',          per: 0.08 }, { pid: 12, name: 'Bolle', per: 1 } ],  // Tunen
    201: [ { pid: 14, name: 'Grønt-mix',    per: 0.2  } ],                                       // Græsk salat
};
const ir = require('../services/ingredientResolver');
ir.resolveConsumeItems = async (lines) => {
    const agg = new Map();
    for (const l of lines) {
        const bom = BOM[l.grocy_recipe_id];
        if (!bom) continue;
        for (const ing of bom) {
            const cur = agg.get(ing.pid) || { product_id: ing.pid, product_name: ing.name, amount_stock: 0 };
            cur.amount_stock += ing.per * (Number(l.quantity) || 0);
            agg.set(ing.pid, cur);
        }
    }
    return Array.from(agg.values());
};

// 3) Importér de ægte helpers (efter mock).
const { computeTopupSuggestion, allocateInteger } = require('../routes/events');
const { getDb } = require('../db/database');
const { getStatusId, getDefaultLocationId } = require('../db/helpers');
const db = getDb();

let pass = 0, fail = 0;
const ok  = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const near  = (a, b, m) => check(Math.abs((a ?? NaN) - b) < 0.005, `${m} (fik ${a}, ventede ${b})`);

const pcId = code => db.prepare(`SELECT id FROM price_categories WHERE code = ?`).get(code).id;

const eventId = db.prepare(`
    INSERT INTO events (name, location_id, model, start_date, end_date, status)
    VALUES ('Topup-test', ?, 'light', '2026-07-01', '2026-07-02', 'active')
`).run(getDefaultLocationId()).lastInsertRowid;
const event = { id: eventId, start_date: '2026-07-01' };

let bonCounter = 9100;
function createBon(role, deliveryDate, priceCategory) {
    const id = bonCounter++;
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, price_category_id, price_category,
                          event_id, event_role, order_date, delivery_date, total_price,
                          inventory_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-07-01', ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'T-' + id, getStatusId('GODKENDT'), getDefaultLocationId(),
           pcId(priceCategory), priceCategory, event.id, role, deliveryDate);
    return id;
}
function addLine(bonId, recipeId, name, category, qty) {
    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                               unit_price, line_total, sort_order)
        VALUES (?, ?, ?, ?, ?, 'antal', 0, 0, 0)
    `).run(bonId, recipeId, name, category, qty);
}
function setForecast(date, category, qty) {
    db.prepare(`
        INSERT INTO event_forecast (event_id, forecast_date, category, expected_qty, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(event.id, date, category, qty);
}

// ── Scenario ────────────────────────────────────────────────────────────────
// Prep dag 1: Falaflen 50 + Tunen 30 (01 Sandwich), Græsk salat 20 (02 Salat).
const prep1 = createBon('prep', '2026-07-01', 'produktion');
addLine(prep1, 101, 'Falaflen',    '01 Sandwich', 50);
addLine(prep1, 102, 'Tunen',       '01 Sandwich', 30);
addLine(prep1, 201, 'Græsk salat', '02 Salat',    20);
// Salg dag 1: Falaflen 40 + Tunen 10 (= 50 sandwich), Græsk salat 5.
const sales1 = createBon('sales', '2026-07-01', 'festival');
addLine(sales1, 101, 'Falaflen',    '01 Sandwich', 40);
addLine(sales1, 102, 'Tunen',       '01 Sandwich', 10);
addLine(sales1, 201, 'Græsk salat', '02 Salat',    5);
// Forecast dag 1 + dag 2. Dag 2 har også en kategori UDEN prep-mix (Kager).
setForecast('2026-07-01', '01 Sandwich', 70);
setForecast('2026-07-02', '01 Sandwich', 60);
setForecast('2026-07-02', '02 Salat',    10);
setForecast('2026-07-02', '03 Kager',    12);

(async () => {
    console.log('\n— allocateInteger —');
    check(JSON.stringify(allocateInteger(30, [50, 30])) === '[19,11]',
        'allocateInteger(30, [50,30]) = [19,11] (largest remainder)');
    check(allocateInteger(10, [1, 1, 1]).reduce((a, b) => a + b, 0) === 10,
        'allocateInteger(10, [1,1,1]) summer til 10');
    check(JSON.stringify(allocateInteger(5, [0, 0])) === '[0,0]',
        '0-vægte → [0,0] (ingen division by zero)');
    check(JSON.stringify(allocateInteger(0, [3, 7])) === '[0,0]',
        'total 0 → [0,0]');

    console.log('\n— Dag 2 morgen (hovedscenario) —');
    const s2 = await computeTopupSuggestion(event, '2026-07-02');
    const cat = Object.fromEntries(s2.categories.map(c => [c.category, c]));

    console.log('  kategorier:', s2.categories.map(c =>
        `${c.category}: fc=${c.forecast} prepped=${c.prepped} sold=${c.sold} rest=${c.rest} → ${c.suggestion}`).join(' · '));

    check(s2.sales_bon_count === 1, `sales_bon_count = 1 (fik ${s2.sales_bon_count})`);
    check(cat['01 Sandwich']?.rest === 30, `sandwich rest = 80−50 = 30 (fik ${cat['01 Sandwich']?.rest})`);
    check(cat['01 Sandwich']?.suggestion === 30, `sandwich forslag = 60−30 = 30 (fik ${cat['01 Sandwich']?.suggestion})`);
    check(cat['02 Salat']?.rest === 15, `salat rest = 20−5 = 15 (fik ${cat['02 Salat']?.rest})`);
    check(cat['02 Salat']?.suggestion === 0, `salat forslag clampet til 0 (forecast 10 < rest 15) (fik ${cat['02 Salat']?.suggestion})`);
    check(cat['03 Kager']?.suggestion === 12, `kager forslag = 12 (intet prepped) (fik ${cat['03 Kager']?.suggestion})`);
    check(s2.warnings.length === 1 && /03 Kager/.test(s2.warnings[0]),
        `warning for 03 Kager uden prep-mix (fik: ${JSON.stringify(s2.warnings)})`);

    // Produkt-allokering: 30 sandwich fordelt 50/30 → Falaflen 19, Tunen 11.
    const prod = Object.fromEntries(s2.products.map(p => [p.product_name, p]));
    check(prod['Falaflen']?.quantity === 19, `Falaflen allokeret 19 (fik ${prod['Falaflen']?.quantity})`);
    check(prod['Tunen']?.quantity === 11, `Tunen allokeret 11 (fik ${prod['Tunen']?.quantity})`);
    check(!prod['Græsk salat'], 'Græsk salat IKKE allokeret (forslag 0)');
    check(s2.products.reduce((a, p) => a + p.quantity, 0) === 30, 'allokering summer til 30');

    // Råvarer: prepped(5; 2.4; 80; 4) − sold(4; 0.8; 50; 1) = rest(1; 1.6; 30; 3).
    // Behov (19 Falaflen + 11 Tunen): masse 1.9, tun 0.88, bolle 30.
    const raw = Object.fromEntries(s2.raw.map(r => [r.product_name, r]));
    near(raw['Falafelmasse']?.rest, 1.0,  'falafelmasse rest');
    near(raw['Falafelmasse']?.needed, 1.9, 'falafelmasse behov');
    near(raw['Falafelmasse']?.fetch, 0.9, 'falafelmasse HENT MERE = 1.9−1.0');
    near(raw['Tun']?.fetch, 0, 'tun hent = 0 (rest 1.6 > behov 0.88)');
    near(raw['Tun']?.surplus, 0.72, 'tun RIGELIGT = 1.6−0.88');
    near(raw['Bolle']?.fetch, 0, 'boller hent = 0 (rest 30 = behov 30)');
    near(raw['Bolle']?.surplus, 0, 'boller surplus = 0');
    near(raw['Grønt-mix']?.surplus, 3.0, 'grønt rigeligt = 3.0 (intet behov)');
    check(raw['Falafelmasse']?.unit === 'kg', `råvare-enhed fra Grocy (fik '${raw['Falafelmasse']?.unit}')`);
    check(s2.raw[0]?.product_name === 'Falafelmasse', 'sorteret med størst hent-behov øverst');

    console.log('\n— Dag 1 morgen (dagens salg tæller IKKE) —');
    const s1 = await computeTopupSuggestion(event, '2026-07-01');
    const cat1 = Object.fromEntries(s1.categories.map(c => [c.category, c]));
    check(s1.sales_bon_count === 0, `dag 1: 0 salgs-bons talt (salg dag 1 er ikke sket endnu) (fik ${s1.sales_bon_count})`);
    check(cat1['01 Sandwich']?.sold === 0, `dag 1: solgt = 0 (fik ${cat1['01 Sandwich']?.sold})`);
    check(cat1['01 Sandwich']?.suggestion === 0, `dag 1: forslag = max(0, 70−80) = 0 (fik ${cat1['01 Sandwich']?.suggestion})`);

    console.log('\n— Eksisterende top-up på dagen reducerer forslaget —');
    const topup2 = createBon('topup', '2026-07-02', 'produktion');
    addLine(topup2, 101, 'Falaflen', '01 Sandwich', 10);
    const s2b = await computeTopupSuggestion(event, '2026-07-02');
    const cat2b = Object.fromEntries(s2b.categories.map(c => [c.category, c]));
    check(cat2b['01 Sandwich']?.rest === 40, `rest = 90−50 = 40 efter topup-bon (fik ${cat2b['01 Sandwich']?.rest})`);
    check(cat2b['01 Sandwich']?.suggestion === 20, `forslag = 60−40 = 20 (fik ${cat2b['01 Sandwich']?.suggestion})`);

    console.log('\n— Grocy nede → gracefully degraderet (kun kategori-niveau) —');
    const realResolve = ir.resolveConsumeItems;
    ir.resolveConsumeItems = async () => { throw new Error('Grocy timeout (simuleret)'); };
    const sDeg = await computeTopupSuggestion(event, '2026-07-02');
    ir.resolveConsumeItems = realResolve;
    const catDeg = Object.fromEntries(sDeg.categories.map(c => [c.category, c]));
    check(catDeg['01 Sandwich']?.suggestion === 20, 'kategori-forslag virker stadig uden Grocy');
    check(sDeg.raw.length === 0, 'råvare-liste tom ved Grocy-fejl (ikke crash)');
    check(sDeg.warnings.some(w => /Råvare-tjek utilgængeligt/.test(w)),
        `degraderings-warning sendt med (fik: ${JSON.stringify(sDeg.warnings)})`);
    check(sDeg.products.length > 0, 'produkt-allokering (ren SQL) overlever Grocy-fejl');

    console.log('\n— Event uden forecast/bons —');
    const emptyId = db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, status)
        VALUES ('Tomt', ?, 'light', '2026-08-01', 'planning')
    `).run(getDefaultLocationId()).lastInsertRowid;
    const se = await computeTopupSuggestion({ id: emptyId, start_date: '2026-08-01' }, '2026-08-01');
    check(se.categories.length === 0 && se.products.length === 0 && se.raw.length === 0,
        'tomt event → tomme lister, ingen crash');

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})();
