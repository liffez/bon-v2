// scripts/test-event-cancelled.js
// ============================================================
// Aflyste bons må ALDRIG tælle med i event-tal.
// Spec: docs/CLAUDE_EVENT.md §3/§6/§7.
//
// Baggrund: et event kan sagtens have flere prep-bons hvor nogle er aflyst
// undervejs (planen laves om). Ingen af event-beregningerne filtrerede på
// status, så aflyste bons talte fuldt med: salgs-prefill foreslog at sælge
// varer fra en aflyst prep-bon, og vareforbrug/CO₂/P&L talte deres tal med.
//
// En aflyst bon er historik: den skal blive stående i overblikkets bon-liste
// (så man kan se at der VAR en plan), men den forlod aldrig huset og blev
// aldrig solgt. Derfor: synlig i listen, usynlig i tallene.
//
// Rammer de ÆGTE helpers i routes/events.js (ingen SQL-replikering) og mocker
// grocy + resolveConsumeItems deterministisk — samme mønster som
// test-topup-suggestion.js. Isoleret temp-DB. Rører intet i prod.
//
// Verificerer, for hver beregning, at et aflyst modstykke ikke rykker tallet:
//   • computeSalesPrefill   — aflyst prep tæller ikke med i foreslået antal
//   • computeSalesPrefill   — aflyst prep stjæler ikke 'prep'-rollen (fallback-heuristik)
//   • computeEventCost      — vareforbrug ekskl. aflyst prep
//   • computeEventCO2       — CO₂ ekskl. aflyst salg
//   • computeEventPnL       — aflyst salg er ikke omsætning; aflyst udgift er ikke udgift
//   • computeEventExpenses  — do., pr. linje
//   • computeTopupSuggestion— aflyst prep tæller ikke som "på pladsen"
//   • computeReturnSuggestion — aflyst prep skal ikke køres hjem
//   • getEventBons          — returnerer STADIG de aflyste (bon-listen skal vise dem)
//
//   node --experimental-sqlite scripts/test-event-cancelled.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-event-cancelled-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// Mock FØR helperne kaldes (samme modul-objekter som routes/events.js holder).
const grocy = require('../services/grocyAdapter');
grocy.getProducts = async () => ([
    { id: 11, name: 'Falafelmasse', qu_id_stock: 1 },
    { id: 12, name: 'Bolle',        qu_id_stock: 2 },
]);
grocy.getQuantityUnits = async () => ([{ id: 1, name: 'kg' }, { id: 2, name: 'stk' }]);
// Festival-pris + kostpris + CO₂ pr. opskrift (driver prefill/cost/CO₂).
grocy.getRecipes = async () => ([
    { id: 101, name: 'Falaflen', prices: { festival: 115 }, cost_price: 20, co2e: 0.5 },
]);

const BOM = { 101: [{ pid: 11, name: 'Falafelmasse', per: 0.1 }, { pid: 12, name: 'Bolle', per: 1 }] };
const ir = require('../services/ingredientResolver');
ir.resolveConsumeItems = async (lines) => {
    const agg = new Map();
    for (const l of lines) {
        for (const ing of (BOM[l.grocy_recipe_id] || [])) {
            const cur = agg.get(ing.pid) || { product_id: ing.pid, product_name: ing.name, amount_stock: 0 };
            cur.amount_stock += ing.per * (Number(l.quantity) || 0);
            agg.set(ing.pid, cur);
        }
    }
    return Array.from(agg.values());
};

const ev = require('../routes/events');
const { getDb } = require('../db/database');
const { getStatusId, getDefaultLocationId } = require('../db/helpers');
const db = getDb();

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const near  = (a, b, m) => check(Math.abs((a ?? NaN) - b) < 0.005, `${m} (fik ${a}, ventede ${b})`);

const pcId = code => db.prepare(`SELECT id FROM price_categories WHERE code = ?`).get(code).id;

const eventId = db.prepare(`
    INSERT INTO events (name, location_id, model, start_date, end_date, status)
    VALUES ('Aflyst-test', ?, 'light', '2026-07-01', '2026-07-02', 'active')
`).run(getDefaultLocationId()).lastInsertRowid;
const event = { id: eventId, start_date: '2026-07-01' };

let bonCounter = 9500;
function createBon(role, deliveryDate, priceCategory, statusCode, totalPrice = 0) {
    const id = bonCounter++;
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, price_category_id, price_category,
                          event_id, event_role, order_date, delivery_date, total_price,
                          inventory_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-07-01', ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'T-' + id, getStatusId(statusCode), getDefaultLocationId(),
           pcId(priceCategory), priceCategory, event.id, role, deliveryDate, totalPrice);
    return id;
}
function addLine(bonId, recipeId, name, category, qty, unitPrice = 0, costPrice = 0, co2e = 0, momsIncl = 1) {
    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                               unit_price, line_total, cost_price, co2e, moms_included, sort_order)
        VALUES (?, ?, ?, ?, ?, 'antal', ?, ?, ?, ?, ?, 0)
    `).run(bonId, recipeId, name, category, qty, unitPrice, unitPrice * qty, costPrice, co2e, momsIncl);
}

// ── Scenario (aflyst prep side om side med den levende) ─────────────────────────────────────
// AFLYST prep FØRST (lavest id) — så fangen vi tester er reel: uden filter
// ville den lægge beslag på 'prep'-rollen i fallback-heuristikken.
const prepCancelled = createBon(null, '2026-07-01', 'produktion', 'AFLYST');
addLine(prepCancelled, 101, 'Falaflen', '01 Sandwich', 10, 0, 20, 0.5);

// Den rigtige prep-bon: 300 Falaflen.
const prepLive = createBon(null, '2026-07-01', 'produktion', 'GODKENDT');
addLine(prepLive, 101, 'Falaflen', '01 Sandwich', 300, 0, 20, 0.5);

// Salg dag 1: 50 solgt (aktivt) + 25 på en aflyst salgsbon.
const salesLive = createBon('sales', '2026-07-01', 'festival', 'BETALT', 5750);
addLine(salesLive, 101, 'Falaflen', '01 Sandwich', 50, 115, 20, 0.5);
const salesCancelled = createBon('sales', '2026-07-01', 'festival', 'AFLYST', 2875);
addLine(salesCancelled, 101, 'Falaflen', '01 Sandwich', 25, 115, 20, 0.5);

// Udgift: aktiv 500 kr + aflyst 300 kr (begge incl moms).
const expLive = createBon('expense', '2026-07-01', 'festival', 'GODKENDT', -500);
addLine(expLive, null, 'Stadeleje', null, 1, -500, 0, 0);
const expCancelled = createBon('expense', '2026-07-01', 'festival', 'AFLYST', -300);
addLine(expCancelled, null, 'Aflyst leje', null, 1, -300, 0, 0);

db.prepare(`INSERT INTO event_forecast (event_id, forecast_date, category, expected_qty, updated_at)
            VALUES (?, '2026-07-02', '01 Sandwich', 400, CURRENT_TIMESTAMP)`).run(event.id);

(async () => {
    console.log('\n— getEventBons: aflyste bons er STADIG synlige i listen —');
    const allBons = ev.getEventBons(event.id);
    check(allBons.length === 6, `bon-listen rummer alle 6 bons (fik ${allBons.length})`);
    check(allBons.filter(b => b.status_code === 'AFLYST').length === 3,
        'de 3 aflyste bons vises stadig (historik, ikke regnskab)');

    console.log('\n— computeSalesPrefill: aflyst prep tælles ikke med —');
    const prefill = await ev.computeSalesPrefill(event);
    const fal = prefill.lines.find(l => l.grocy_recipe_id === 101);
    near(fal?.quantity, 300, 'foreslår 300 Falaflen (ikke 310 — den aflyste prep tæller ikke)');
    near(fal?.unit_price, 115, 'festival-pris fra Grocy');

    console.log('\n— computeSalesPrefill: aflyst prep stjæler ikke prep-rollen —');
    // Begge produktionsbons har event_role = NULL → fallback-heuristikken kører.
    // Den aflyste er oprettet først; uden filter ville DEN blive 'prep' og den
    // rigtige degraderes til 'topup' → prefill = 10 stk (eller tom).
    check((fal?.quantity ?? 0) > 0, 'den levende prep-bon beholder prep-rollen');

    console.log('\n— computeEventCost: vareforbrug ekskl. aflyst prep —');
    near(ev.computeEventCost(event.id), 300 * 20, 'vareforbrug = 6000 kr (300 × 20), ikke 6200');

    console.log('\n— computeEventCO2: ekskl. aflyst salg —');
    near(ev.computeEventCO2(event.id), 50 * 0.5, 'CO₂ = 25 kg (kun de 50 faktisk solgte)');

    console.log('\n— computeEventPnL: aflyst salg er ikke omsætning —');
    const pnl = ev.computeEventPnL(allBons);
    near(pnl.revenue_incl, 5750, 'omsætning = 5750 kr incl (aflyst salgsbon tæller ikke)');
    near(pnl.expenses, 500, 'udgift = 500 kr (aflyst udgiftsbon tæller ikke)');

    console.log('\n— computeEventExpenses: pr. linje, ekskl. aflyst —');
    const exp = ev.computeEventExpenses(event.id);
    near(exp.incl, 500, 'udgift incl moms = 500 kr');
    near(exp.excl, 400, 'udgift ex moms = 400 kr (500 / 1,25)');

    console.log('\n— computeTopupSuggestion: aflyst prep er ikke "på pladsen" —');
    const sug = await ev.computeTopupSuggestion(event, '2026-07-02');
    const cat = sug.categories.find(c => c.category === '01 Sandwich');
    near(cat?.prepped, 300, 'preppet = 300 (ikke 310)');
    near(cat?.sold, 50, 'solgt = 50 (aflyst salg tæller ikke)');
    near(cat?.rest, 250, 'rest = 300 − 50 = 250');
    near(cat?.suggestion, 150, 'forslag = forecast 400 − rest 250 = 150');

    console.log('\n— computeReturnSuggestion: aflyst prep skal ikke køres hjem —');
    const ret = await ev.computeReturnSuggestion(event);
    const bolle = ret.items.find(i => i.product_id === 12);
    near(bolle?.prepped, 300, 'preppet 300 boller (ikke 310)');
    near(bolle?.sold, 50, 'solgt 50 boller (aflyst salg tæller ikke)');
    near(bolle?.suggested_rest, 250, 'retur-forslag = 250 boller');

    // ── Rute-niveau: tallene skal også flyde rigtigt gennem HTTP ────────────
    // Helperne er dækket ovenfor; her verificeres at /overview og /sales-prefill
    // stadig svarer 200 og leverer de filtrerede tal — med de aflyste bons
    // STADIG med i bon-listen (det er hele pointen: synlig, men ikke talt).
    console.log('\n— GET /:id/overview + /:id/sales-prefill (in-process HTTP) —');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
    app.use('/api/events', ev);
    const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const ovRes = await fetch(`${base}/api/events/${event.id}/overview`);
    const ov = await ovRes.json();
    check(ovRes.status === 200, `/overview svarer 200 (fik ${ovRes.status})`);
    near(ov?.pnl?.cost_estimated, 6000, 'overview: vareforbrug = 6000 kr');
    near(ov?.pnl?.revenue_incl, 5750, 'overview: omsætning = 5750 kr incl');
    near(ov?.pnl?.co2e_total, 25, 'overview: CO₂ = 25 kg');
    // Resultat = omsætning ex (4600) − vareforbrug (6000) − udgift ex (400) = −1800
    near(ov?.pnl?.result, -1800, 'overview: resultat = −1800 kr');
    check((ov?.bons ?? []).length === 6, `overview: alle 6 bons i listen (fik ${(ov?.bons ?? []).length})`);

    const pfRes = await fetch(`${base}/api/events/${event.id}/sales-prefill`);
    const pf = await pfRes.json();
    check(pfRes.status === 200, `/sales-prefill svarer 200 (fik ${pfRes.status})`);
    near(pf?.lines?.find(l => l.grocy_recipe_id === 101)?.quantity, 300,
        'sales-prefill over HTTP: 300 Falaflen');

    server.close();

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
