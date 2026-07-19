// scripts/test-consume-outcome.js
// ============================================================
// Regressionstest for #359 — siger systemet sandheden om lagertrækket?
//
// `inventory_deducted` blev sat til 1 UBETINGET, også når hvert eneste
// Grocy-kald fejlede. consumeRecipes afviser aldrig: fejl pr. produkt kommer
// tilbage som `success: false` i et resolvet array, så `.catch` ramte dem ikke.
//
// Det værste var ikke fejlen, men at den var immun over for kontrollen:
// scripts/check-inventory-deduct.js (bygget efter #305) leder efter leverede
// bons UDEN flaget. Denne tilstand SATTE flaget → vagthunden meldte alt vel.
//
// Testen dækker begge halvdele: at flaget nu afspejler udfaldet, OG at
// vagthunden kan se en delvist mislykket bon.
//
// Kør:
//   node --experimental-sqlite scripts/test-consume-outcome.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-consume-outcome-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const helpers = require('../db/helpers');
const { getStatusId, getDefaultLocationId, autoConsumeBonInventory } = helpers;
const { findUndeducted } = require('./check-inventory-deduct');
const grocy = require('../services/grocyAdapter');
const db = getDb();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

db.prepare(`INSERT INTO settings (key, value) VALUES ('inventory_auto_deduct','1')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

const today = () => { const d = new Date(); return d.toISOString().slice(0, 10); };  // utc-ok: kun test-fixture

let counter = 9500;
function mkBon() {
    const id = counter++;
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date,
                          inventory_deducted, is_offer, total_price, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'B' + id, getStatusId('LEVERET'), getDefaultLocationId(), today(), today());
    // Én linje med opskriftskobling, så trækket overhovedet forsøges.
    db.prepare(`
        INSERT INTO bon_lines (bon_id, product_name, quantity, unit, unit_price, line_total, grocy_recipe_id)
        VALUES (?, 'Testvare', 1, 'stk', 0, 0, 1)
    `).run(id);
    return id;
}
const readBon = (id) => db.prepare(
    `SELECT inventory_deducted, inventory_deduct_status FROM bons WHERE id = ?`).get(id);

// Trækket er fire-and-forget — vent til DB'en afspejler udfaldet.
async function runConsume(id, results) {
    grocy.consumeRecipes = async () => results;
    autoConsumeBonInventory(id);
    for (let i = 0; i < 60; i++) {
        const r = readBon(id);
        if (r.inventory_deducted === 1 || r.inventory_deduct_status) return r;
        await new Promise(r => setTimeout(r, 25));
    }
    return readBon(id);
}

const OK1   = { product_id: 1, product_name: 'A', success: true };
const OK2   = { product_id: 2, product_name: 'B', success: true };
const FEJL1 = { product_id: 3, product_name: 'C', success: false, error: 'Grocy 500' };
const FEJL2 = { product_id: 4, product_name: 'D', success: false, error: 'Grocy 500' };

(async () => {
    console.log('\nLagertræk: siger flaget sandheden? (#359)\n');

    console.log('S1 · Alt lykkedes → trukket');
    let id = mkBon();
    let r = await runConsume(id, [OK1, OK2]);
    ok(r.inventory_deducted === 1 && r.inventory_deduct_status === 'ok',
        `flag 1, status 'ok' — fik ${r.inventory_deducted}/'${r.inventory_deduct_status}'`);

    console.log('\nS2 · ALT fejlede → flaget må IKKE sættes');
    id = mkBon();
    r = await runConsume(id, [FEJL1, FEJL2]);
    ok(r.inventory_deducted === 0, `flag forbliver 0 (var 1 før rettelsen) — fik ${r.inventory_deducted}`);
    ok(r.inventory_deduct_status === 'failed', `status 'failed' — fik '${r.inventory_deduct_status}'`);

    console.log('\nS3 · Delvist → flaget sættes (mod dobbelt-træk), men tilstanden er synlig');
    id = mkBon();
    const partialId = id;
    r = await runConsume(id, [OK1, FEJL1]);
    ok(r.inventory_deducted === 1, `flag 1 så en gentagelse ikke trækker de lykkedes igen — fik ${r.inventory_deducted}`);
    ok(r.inventory_deduct_status === 'partial', `status 'partial' — fik '${r.inventory_deduct_status}'`);

    console.log('\nS4 · Ingen opskriftslinjer → intet at trække, ikke en fejl');
    id = mkBon();
    r = await runConsume(id, []);
    ok(r.inventory_deducted === 1 && r.inventory_deduct_status === 'nothing',
        `flag 1, status 'nothing' — fik ${r.inventory_deducted}/'${r.inventory_deduct_status}'`);

    // ── Vagthunden ──
    console.log('\nS5 · Vagthunden ser nu begge fejl-tilstande');
    const found = findUndeducted(db, 3);
    const ids = found.map(f => f.id);
    ok(ids.includes(partialId), `den DELVIST trukne bon fanges (var usynlig før) — fandt ${ids.length} bon(s)`);
    const failedBon = db.prepare(`SELECT id FROM bons WHERE inventory_deduct_status = 'failed'`).get();
    ok(ids.includes(failedBon.id), 'den helt mislykkede bon fanges');

    console.log('\nS6 · Vagthunden alarmerer ikke på de sunde');
    const okBon = db.prepare(`SELECT id FROM bons WHERE inventory_deduct_status = 'ok'`).get();
    const nothingBon = db.prepare(`SELECT id FROM bons WHERE inventory_deduct_status = 'nothing'`).get();
    ok(!ids.includes(okBon.id), 'fuldt trukket bon giver ikke alarm');
    ok(!ids.includes(nothingBon.id), 'bon uden opskriftslinjer giver ikke alarm');

    console.log('\nS7 · Idempotens holder — et sat flag forhindrer nyt træk');
    let called = 0;
    grocy.consumeRecipes = async () => { called++; return [OK1]; };
    autoConsumeBonInventory(okBon.id);
    await new Promise(r => setTimeout(r, 150));
    ok(called === 0, `consumeRecipes blev ikke kaldt igen — fik ${called} kald`);

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    try { require('fs').unlinkSync(TEST_DB); } catch { /* ligegyldigt */ }
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
