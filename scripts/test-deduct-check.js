// scripts/test-deduct-check.js
// ============================================================
// Test for vagthunden check-inventory-deduct.js (#305 trin 4).
//
// Rammer den ÆGTE findUndeducted-helper (ingen SQL-replikering) + kører hele
// scriptet som barn-proces for at verificere exit-koderne, som er selve
// alarm-mekanismen: cron fanger non-zero.
//
// Verificerer:
//   • findUndeducted finder KUN leverede bons uden træk i vinduet
//   • ekskluderer: ikke-leverede, allerede-trukne, tilbud, ældre end vinduet
//   • flag SLUKKET      → exit 0 (stille — den tilstand er kendt, ikke en alarm)
//   • flag TÆNDT, alt ok → exit 0
//   • flag TÆNDT, drift  → exit 1 (så cron-mail fanger det) + bon nævnt i output
//
//   node --experimental-sqlite scripts/test-deduct-check.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-deduct-check-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { getStatusId, getDefaultLocationId } = require('../db/helpers');
const { findUndeducted } = require('./check-inventory-deduct');
const db = getDb();

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);

// ── Datoer relativt til i dag, så vindues-testen er robust ──
const dOffset = n => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
};

let counter = 8800;
function mkBon({ status, date, deducted = 0, offer = 0 }) {
    const id = counter++;
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date,
                          inventory_deducted, is_offer, total_price, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'B' + id, getStatusId(status), getDefaultLocationId(),
           dOffset(-1), date, deducted, offer);
    return id;
}
const setFlag = v => db.prepare(
    `INSERT INTO settings (key, value) VALUES ('inventory_auto_deduct', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);

// ── Scenarie ────────────────────────────────────────────────────────────────
const target   = mkBon({ status: 'LEVERET', date: dOffset(-1), deducted: 0 }); // ← skal fanges
mkBon({ status: 'LEVERET',   date: dOffset(-1), deducted: 1 });                 // trukket → ikke
mkBon({ status: 'GODKENDT',  date: dOffset(-1), deducted: 0 });                 // ikke leveret → ikke
mkBon({ status: 'LEVERET',   date: dOffset(-30), deducted: 0 });                // uden for vindue → ikke
mkBon({ status: 'LEVERET',   date: dOffset(-1), deducted: 0, offer: 1 });       // tilbud → ikke
const betalt   = mkBon({ status: 'BETALT', date: dOffset(-2), deducted: 0 });   // ← skal også fanges

console.log('\n— findUndeducted: kun leverede-uden-træk i vinduet —');
const found = findUndeducted(db, 3);
const ids = found.map(r => r.id).sort();
check(ids.includes(target) && ids.includes(betalt), 'fanger LEVERET + BETALT uden træk');
check(!found.some(r => r.id !== target && r.id !== betalt), 'ekskluderer trukne, ikke-leverede, gamle og tilbud');
check(found.length === 2, `præcis 2 fundet (fik ${found.length})`);

// ── Exit-koder via barn-proces (den ægte alarm-mekanisme) ──
function run() {
    const r = spawnSync('node', ['--experimental-sqlite', path.join(__dirname, 'check-inventory-deduct.js')], {
        env: { ...process.env, DB_PATH: TEST_DB, INVENTORY_CHECK_DAYS: '3', INVENTORY_ALERT_EMAIL: '' },
        encoding: 'utf8',
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('\n— Flag SLUKKET: stille exit 0 —');
setFlag('0');
let r = run();
check(r.code === 0, `exit 0 (fik ${r.code})`);
check(/slukket/.test(r.out), 'logger at trækket er slukket');

console.log('\n— Flag TÆNDT + drift: exit 1 + bons nævnt —');
setFlag('1');
r = run();
check(r.code === 1, `exit 1 så cron-mail fanger det (fik ${r.code})`);
check(r.out.includes('B' + target) && r.out.includes('B' + betalt), 'begge drift-bons nævnt i output');
check(/ingen alarm-modtager/.test(r.out), 'noterer at mail springes over uden modtager');

console.log('\n— Flag TÆNDT + alt trukket: exit 0 —');
db.prepare(`UPDATE bons SET inventory_deducted = 1 WHERE inventory_deducted = 0`).run();
r = run();
check(r.code === 0, `exit 0 (fik ${r.code})`);
check(/OK/.test(r.out), 'logger OK');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
