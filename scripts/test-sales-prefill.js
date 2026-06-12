// scripts/test-sales-prefill.js
// ============================================================
// Test for computeSalesPrefill (GET /api/events/:id/sales-prefill).
// Spec: docs/CLAUDE_EVENT.md §14 — salgs-bon pre-fill.
//
// Rammer den ÆGTE helper i routes/events.js (ingen SQL-replikering) og
// MOCKER grocy.getRecipes — så festival-prisopslaget testes deterministisk
// uden netværk/Grocy-flakiness (samme mønster som test-event-gate.js der
// mocker consumeRecipes). Isoleret temp-DB. Rører intet i prod.
//
// Verificerer:
//   • KUN prep-rollen tæller (top-up ekskluderet).
//   • Union på tværs af flere prep-bonner, summeret pr. produkt.
//   • Antal = summen af preppet pr. produkt.
//   • Pris = FESTIVAL-salgspris fra Grocy (prices.festival), 0 ved ukendt/fri-tekst.
//   • price_category_code = 'festival'.
//
//   node --experimental-sqlite scripts/test-sales-prefill.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-sales-prefill-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

// 1) Migrér frisk temp-DB.
const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// 2) Mock grocy.getRecipes FØR helperen kaldes (samme modul-objekt som
//    routes/events.js holder via sin require — patch slår igennem).
const grocy = require('../services/grocyAdapter');
grocy.getRecipes = async () => ([
    { id: 101, name: 'Falaflen', category: '01 Sandwich', unit: 'antal',
      prices: { catering: 104, festival: 115 }, cost_price: 20, co2e: 0.4 },
    { id: 102, name: 'Tunen',    category: '01 Sandwich', unit: 'antal',
      prices: { catering: 99,  festival: 109 }, cost_price: 18, co2e: 0.5 },
    { id: 201, name: 'Græsk salat', category: '02 Salat', unit: 'antal',
      prices: { catering: 75,  festival: 85 },  cost_price: 15, co2e: 0.3 },
    // rec 999 har bevidst INGEN festival-pris → unit_price skal falde til 0.
    { id: 999, name: 'Uden festivalpris', category: '03 Andet', unit: 'antal',
      prices: { catering: 50 }, cost_price: 10 },
]);

// 3) Importér den ægte helper (efter mock).
const { computeSalesPrefill } = require('../routes/events');
const { getDb } = require('../db/database');
const { getStatusId, getDefaultLocationId } = require('../db/helpers');
const db = getDb();

let pass = 0, fail = 0;
const ok  = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);

const pcId = code => db.prepare(`SELECT id FROM price_categories WHERE code = ?`).get(code).id;

const event = {
    id: db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Test-event', ?, 'light', '2026-07-01', '2026-07-02', 'active')
    `).run(getDefaultLocationId()).lastInsertRowid,
    start_date: '2026-07-01',
};

let bonCounter = 9000;
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

// Prep dag 1: Falaflen 50 + Tunen 30 + fri-tekst-vare (ingen recipe) 5
const prep1 = createBon('prep', '2026-07-01', 'produktion');
addLine(prep1, 101, 'Falaflen', '01 Sandwich', 50);
addLine(prep1, 102, 'Tunen',    '01 Sandwich', 30);
addLine(prep1, null, 'Hjemmelavet dip', '03 Andet', 5);
// Prep dag 2: Falaflen 20 (→ sum 70) + Græsk salat 15 + rec uden festivalpris 8
const prep2 = createBon('prep', '2026-07-02', 'produktion');
addLine(prep2, 101, 'Falaflen', '01 Sandwich', 20);
addLine(prep2, 201, 'Græsk salat', '02 Salat', 15);
addLine(prep2, 999, 'Uden festivalpris', '03 Andet', 8);
// Top-up: Falaflen 99 — SKAL IKKE tælle med
const topup = createBon('topup', '2026-07-02', 'produktion');
addLine(topup, 101, 'Falaflen', '01 Sandwich', 99);

(async () => {
    const result = await computeSalesPrefill(event);
    const by = Object.fromEntries(result.lines.map(l => [l.product_name, l]));

    console.log('\nPrefill-linjer:');
    for (const l of result.lines)
        console.log(`  ${l.product_name} | qty=${l.quantity} | unit_price=${l.unit_price} | cat=${l.category} | rec=${l.grocy_recipe_id}`);

    console.log('\nAsserts:');
    check(result.price_category_code === 'festival', 'price_category_code = festival');
    check(by['Falaflen'] && by['Falaflen'].quantity === 70, `Falaflen summet 50+20 = 70 (fik ${by['Falaflen']?.quantity})`);
    check(by['Falaflen'] && by['Falaflen'].unit_price === 115, `Falaflen unit_price = FESTIVAL 115 (fik ${by['Falaflen']?.unit_price})`);
    check(by['Tunen'] && by['Tunen'].quantity === 30 && by['Tunen'].unit_price === 109, 'Tunen 30 @ festival 109');
    check(by['Græsk salat'] && by['Græsk salat'].unit_price === 85, `Græsk salat @ festival 85 (fik ${by['Græsk salat']?.unit_price})`);
    check(by['Hjemmelavet dip'] && by['Hjemmelavet dip'].unit_price === 0, 'fri-tekst-vare (ingen recipe) → unit_price 0');
    check(by['Uden festivalpris'] && by['Uden festivalpris'].unit_price === 0, 'recipe uden festival-pris → unit_price 0');
    check(!result.lines.some(l => l.quantity === 99 || l.quantity === 119), 'top-ups 99 IKKE talt med');
    check(result.lines.length === 5, `5 distinkte produkter (fik ${result.lines.length})`);
    // Tom-event-case: et event uden prep-bonner giver tom liste.
    const empty = await computeSalesPrefill({ id: 999999, start_date: '2026-07-01' });
    check(empty.lines.length === 0 && empty.price_category_code === 'festival', 'event uden prep-bonner → tom liste, festival');

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})();
