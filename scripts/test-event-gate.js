// scripts/test-event-gate.js
// ============================================================
// Unit-test for autoConsumeBonInventory event-gate (CLAUDE_EVENT.md §5 + §11 Vej B).
//
// Verificerer ét punkt: BESLUTNINGEN om at trække lager (eller ej) for hver
// kombination af event-medlemskab, model og priskategori. Mocker
// services/grocyAdapter.consumeRecipes så Grocy ikke kaldes.
//
// Isoleret temp-DB. Rører intet i prod.
//
// Kør:
//   node --experimental-sqlite scripts/test-event-gate.js
// ============================================================

'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-event-gate-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

// 1) Apply alle migrations (inkl. 095_events.sql).
const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// 2) Mock consumeRecipes FØR helpers.js requirer det indirekte.
//    autoConsumeBonInventory laver `require('../services/grocyAdapter')` INDE
//    i funktionen, så vi kan stadig patche exports efter første load.
const grocyAdapter = require('../services/grocyAdapter');
const consumeCalls = [];          // hver entry: { bonId, lines }
grocyAdapter.consumeRecipes = (lines) => {
    consumeCalls.push({ lines: lines.map(l => ({ product_name: l.product_name, quantity: l.quantity })) });
    return Promise.resolve(lines.map(() => ({ success: true })));
};

const { getDb } = require('../db/database');
const { autoConsumeBonInventory, getStatusId, getDefaultLocationId } = require('../db/helpers');
const db = getDb();

// ── test-harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(msg)  { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
function bad(msg) { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
function check(cond, msg) { (cond ? ok : bad)(msg); }
function section(t) { console.log(`\n${t}`); }

// ── DB setup ───────────────────────────────────────────────────
function setFlag(value) {
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'inventory_auto_deduct'`).run(value);
}
function pcId(code) {
    return db.prepare(`SELECT id FROM price_categories WHERE code = ?`).get(code).id;
}
function createEvent(name, model) {
    const locId = getDefaultLocationId();
    return db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, status)
        VALUES (?, ?, ?, '2026-07-01', 'active')
    `).run(name, locId, model).lastInsertRowid;
}
let bonCounter = 9000;
function createBon({ eventId = null, priceCategory = 'catering' } = {}) {
    const id = bonCounter++;
    const locId = getDefaultLocationId();
    const statusId = getStatusId('KLAR');
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, price_category_id, event_id,
                          order_date, delivery_date, total_price, inventory_deducted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '2026-07-01', '2026-07-02', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'TEST-' + id, statusId, locId, pcId(priceCategory), eventId);
    // En enkelt linje så consumeRecipes har noget at modtage
    db.prepare(`
        INSERT INTO bon_lines (bon_id, product_name, quantity, unit, unit_price, line_total, sort_order)
        VALUES (?, 'Falafel test', 10, 'stk', 0, 0, 1)
    `).run(id);
    return id;
}
function bonState(id) {
    return db.prepare(`SELECT inventory_deducted FROM bons WHERE id = ?`).get(id);
}
function lastConsumeAction(id) {
    return db.prepare(`
        SELECT new_value FROM changelog
        WHERE entity_type = 'bon' AND entity_id = ? AND action = 'grocy_consume'
        ORDER BY id DESC LIMIT 1
    `).get(id);
}
function resetCalls() { consumeCalls.length = 0; }

// consumeRecipes er fire-and-forget i autoConsumeBonInventory — vi venter
// kort efter hvert kald så .then-handleren får sat inventory_deducted.
function tick(ms = 50) { return new Promise(r => setTimeout(r, ms)); }

// ── SCENARIER ──────────────────────────────────────────────────
console.log(`\nEvent-gate unit-test (DB: ${TEST_DB})`);

async function run() {
    const lightEv    = createEvent('Roskilde-let', 'light');
    const festivalEv = createEvent('Roskilde-festival', 'festival');

    // S1 — Let-event prep (Vej B): flag='0', alligevel skal den trække.
    section('S1 · Let-event PREP-bon — Vej B: trækker uanset flag=0');
    {
        setFlag('0'); resetCalls();
        const bonId = createBon({ eventId: lightEv, priceCategory: 'produktion' });
        autoConsumeBonInventory(bonId);
        await tick();
        check(consumeCalls.length === 1, 'consumeRecipes kaldt 1 gang (Vej B override aktiv)');
        check(bonState(bonId).inventory_deducted === 1, 'inventory_deducted = 1 efter consume');
        const log = lastConsumeAction(bonId);
        check(log && log.new_value !== 'event_prep_owns_stock', 'changelog viser faktisk consume-result (ikke no-deduct-skip)');
    }

    // S2 — Let-event SALG (kontant/faktura → LEVERET): MÅ IKKE trække.
    section('S2 · Let-event SALG-bon — §5-gaten: trækker IKKE (selv med flag=1)');
    {
        setFlag('1'); resetCalls();
        const bonId = createBon({ eventId: lightEv, priceCategory: 'catering' });
        autoConsumeBonInventory(bonId);
        await tick();
        check(consumeCalls.length === 0, 'consumeRecipes IKKE kaldt');
        check(bonState(bonId).inventory_deducted === 1, 'inventory_deducted = 1 (markeret som "ejet af prep")');
        const log = lastConsumeAction(bonId);
        check(log && log.new_value === 'event_prep_owns_stock', "changelog viser grund 'event_prep_owns_stock'");
    }

    // S3 — Festival-event SALG: SKAL trække (festival har sit eget lager).
    section('S3 · Festival-event SALG-bon — gates IKKE: trækker normalt');
    {
        setFlag('1'); resetCalls();
        const bonId = createBon({ eventId: festivalEv, priceCategory: 'catering' });
        autoConsumeBonInventory(bonId);
        await tick();
        check(consumeCalls.length === 1, 'consumeRecipes kaldt 1 gang (festival gates ikke)');
        check(bonState(bonId).inventory_deducted === 1, 'inventory_deducted = 1 efter consume');
    }

    // S4 — Butikssalg uden event: trækker som hidtil.
    section('S4 · Butikssalg uden event_id — uændret adfærd');
    {
        setFlag('1'); resetCalls();
        const bonId = createBon({ eventId: null, priceCategory: 'catering' });
        autoConsumeBonInventory(bonId);
        await tick();
        check(consumeCalls.length === 1, 'consumeRecipes kaldt 1 gang');
        check(bonState(bonId).inventory_deducted === 1, 'inventory_deducted = 1');
    }

    // S5 — Butikssalg + flag='0': trækker IKKE (forhindrer regression af eksisterende adfærd).
    section('S5 · Butikssalg + flag=0 — uændret adfærd: trækker IKKE');
    {
        setFlag('0'); resetCalls();
        const bonId = createBon({ eventId: null, priceCategory: 'catering' });
        autoConsumeBonInventory(bonId);
        await tick();
        check(consumeCalls.length === 0, 'consumeRecipes IKKE kaldt (flag styrer)');
        check(bonState(bonId).inventory_deducted === 0, 'inventory_deducted forbliver 0');
    }

    // S6 — Idempotens: andet kald trækker ikke igen (Vej A-fremtidssikring).
    section('S6 · Idempotens — to kald på samme prep-bon trækker kun én gang');
    {
        setFlag('0'); resetCalls();
        const bonId = createBon({ eventId: lightEv, priceCategory: 'produktion' });
        autoConsumeBonInventory(bonId); await tick();
        autoConsumeBonInventory(bonId); await tick();
        check(consumeCalls.length === 1, 'consumeRecipes kaldt PRÆCIS 1 gang (idempotens-vagt fanger andet kald)');
    }

    // S7 — Idempotens på no-deduct-skippet salgsbon (samme vagt).
    section('S7 · Idempotens — to kald på let-event salgsbon skipper begge gange');
    {
        setFlag('1'); resetCalls();
        const bonId = createBon({ eventId: lightEv, priceCategory: 'catering' });
        autoConsumeBonInventory(bonId); await tick();
        autoConsumeBonInventory(bonId); await tick();
        check(consumeCalls.length === 0, 'consumeRecipes aldrig kaldt');
        const count = db.prepare(`
            SELECT COUNT(*) AS n FROM changelog
            WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'
        `).get(bonId).n;
        check(count === 1, 'changelog skrevet PRÆCIS 1 gang (andet kald fanges af idempotens før log)');
    }

    section('─────────────────────────────────────────────────────────');
    if (fail === 0) console.log(`\x1b[32m${pass} PASS\x1b[0m · 0 FAIL`);
    else            console.log(`\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('test runner crashed:', err); process.exit(2); });
