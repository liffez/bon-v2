// scripts/test-event-bridge-prep.js
// ============================================================
// Fase 3-test: event-bro prep-endpoint (routes/event-bridge.js).
// Se docs/CLAUDE_EVENT_BON_BRIDGE.md.
//
// Kører mod en isoleret temp-DB in-process (migrations → getDb-singleton), så
// prod aldrig røres. Rammer den ÆGTE kerne applyPrepPush(db, …) — samme funktion
// route-handleren bruger — så find/opret/reconcile/frys testes rigtigt.
// resolvePrepLines testes separat med injicerede Grocy-mocks (ingen Grocy).
//
// Kør:  node --experimental-sqlite scripts/test-event-bridge-prep.js
// ============================================================

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-bridge-prep-${Date.now()}.db`);

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (fik ${JSON.stringify(a)}, ventede ${JSON.stringify(b)})`); }

// Grocy-mock til resolvePrepLines
const mockGrocy = {
    getRecipes: async () => [
        { id: 91, name: 'Grisen på Rug', category: '01 Sandwich', unit: 'stk', prices: { produktion: 0, festival: 115 }, cost_price: 23.5, co2e: 0.4 },
        { id: 92, name: 'Salaten',        category: '02 Salat',    unit: 'stk', prices: { produktion: 0, festival: 98 },  cost_price: 20 }
    ]
};

async function main() {
    process.env.DB_PATH = TEST_DB;
    process.env.NODE_ENV = 'test';
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    // Brug getDb-singleton som fælles handle — de interne helpers (nextBonNumber,
    // getStatusId, logChange) bruger også getDb(), så alt deler én forbindelse.
    const { getDb } = require('../db/database');
    const db = getDb();

    const { resolvePrepLines, applyPrepPush, findPrepBon } = require('../routes/event-bridge');

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const eventId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Bro-test', ?, 'light', '2026-07-30', '2026-07-31', 'planning')
    `).run(locId).lastInsertRowid);
    const event = db.prepare(`SELECT id, name, location_id, event_address_id FROM events WHERE id = ?`).get(eventId);

    const DAY1 = '2026-07-30';
    const DAY2 = '2026-07-31';

    // ── resolvePrepLines: aggregat → linjer (mocket Grocy) ──────────────────
    const { lines: r1, unmatched: u1 } = await resolvePrepLines(
        [{ grocy_recipe_id: 91, antal: 12 }, { grocy_recipe_id: 92, antal: 5 }, { grocy_recipe_id: 999, antal: 3 }],
        mockGrocy
    );
    eq(r1.length, 2, 'resolvePrepLines: 2 linjer matchet');
    eq(u1.length, 1, 'resolvePrepLines: 1 unmatched (999)');
    const l91 = r1.find(l => l.grocy_recipe_id === 91);
    eq(l91.quantity, 12, 'resolvePrepLines: antal→quantity');
    eq(l91.product_name, 'Grisen på Rug', 'resolvePrepLines: navn snapshottet');
    eq(Number(l91.cost_price), 23.5, 'resolvePrepLines: kostpris snapshottet');
    ok(l91.unit_price === null || Number(l91.unit_price) === 0, 'resolvePrepLines: produktion-pris 0/null');

    // ── applyPrepPush: OPRET (dag 1) ────────────────────────────────────────
    const c1 = applyPrepPush(db, { event, date: DAY1, resolved: r1 });
    eq(c1.action, 'created', 'push dag1 → created');
    ok(c1.bonId > 0 && typeof c1.bonNumber === 'string', 'push dag1 → bonId + bonNumber');

    const bon1 = db.prepare(`SELECT b.*, sd.code AS status_code, pc.code AS pc_code FROM bons b JOIN status_definitions sd ON b.status_id=sd.id JOIN price_categories pc ON b.price_category_id=pc.id WHERE b.id=?`).get(c1.bonId);
    eq(bon1.event_id, eventId, 'bon dag1: event_id');
    eq(bon1.event_role, 'prep', 'bon dag1: event_role=prep');
    eq(bon1.delivery_date, DAY1, 'bon dag1: delivery_date');
    eq(bon1.pc_code, 'produktion', 'bon dag1: priskategori=produktion');
    eq(bon1.status_code, 'GODKENDT', 'bon dag1: status=GODKENDT');
    eq(Number(bon1.total_units), 17, 'bon dag1: total_units=17 (sandwich 12 + salat 5)');
    eq(db.prepare(`SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?`).get(c1.bonId).n, 2, 'bon dag1: 2 linjer');

    // ── applyPrepPush: RECONCILE (samme dag, nye tal) ───────────────────────
    const { lines: r1b } = await resolvePrepLines([{ grocy_recipe_id: 91, antal: 20 }], mockGrocy);
    const c2 = applyPrepPush(db, { event, date: DAY1, resolved: r1b });
    eq(c2.action, 'updated', 'push dag1 igen → updated');
    eq(c2.bonId, c1.bonId, 'push dag1 igen → SAMME bon (ingen dublet)');
    eq(db.prepare(`SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?`).get(c1.bonId).n, 1, 'reconcile: gamle linjer slettet, 1 tilbage');
    eq(Number(db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity), 20, 'reconcile: ny mængde 20');
    eq(Number(db.prepare(`SELECT total_units FROM bons WHERE id=?`).get(c1.bonId).total_units), 20, 'reconcile: total_units genberegnet');
    eq(db.prepare(`SELECT COUNT(*) n FROM bons WHERE event_id=? AND event_role='prep'`).get(eventId).n, 1, 'stadig kun 1 prep-bon efter reconcile');

    // ── applyPrepPush: DAG 2 → ny prep-bon under samme event ────────────────
    const { lines: r2 } = await resolvePrepLines([{ grocy_recipe_id: 92, antal: 8 }], mockGrocy);
    const c3 = applyPrepPush(db, { event, date: DAY2, resolved: r2 });
    eq(c3.action, 'created', 'push dag2 → created');
    ok(c3.bonId !== c1.bonId, 'push dag2 → ny bon (≠ dag1)');
    eq(db.prepare(`SELECT COUNT(*) n FROM bons WHERE event_id=? AND event_role='prep'`).get(eventId).n, 2, '2 prep-bons (én pr. dag) under samme event');

    // ── FRYS: status IGANG → mutér ikke ─────────────────────────────────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='IGANG') WHERE id=?`).run(c1.bonId);
    const beforeLines = db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity;
    const { lines: r1c } = await resolvePrepLines([{ grocy_recipe_id: 91, antal: 99 }], mockGrocy);
    const c4 = applyPrepPush(db, { event, date: DAY1, resolved: r1c });
    eq(c4.action, 'frozen', 'IGANG → frozen');
    eq(c4.bonId, c1.bonId, 'frozen → returnerer den låste bon');
    eq(Number(db.prepare(`SELECT quantity FROM bon_lines WHERE bon_id=?`).get(c1.bonId).quantity), Number(beforeLines), 'frozen: linjer IKKE muteret');

    // ── FRYS: inventory_deducted=1 (selv i GODKENDT) → mutér ikke ───────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='GODKENDT'), inventory_deducted=1 WHERE id=?`).run(c1.bonId);
    const c5 = applyPrepPush(db, { event, date: DAY1, resolved: r1c });
    eq(c5.action, 'frozen', 'inventory_deducted=1 → frozen (lager allerede trukket)');

    // ── AFLYST prep-bon ignoreres (ny oprettes) ─────────────────────────────
    db.prepare(`UPDATE bons SET status_id=(SELECT id FROM status_definitions WHERE code='AFLYST') WHERE id=?`).run(c3.bonId);
    ok(!findPrepBon(db, eventId, DAY2), 'AFLYST prep-bon findes ikke som aktiv');
    const c6 = applyPrepPush(db, { event, date: DAY2, resolved: r2 });
    eq(c6.action, 'created', 'AFLYST dag2 → ny prep-bon oprettes');

    console.log(`\nFase 3 (event-bro prep): ${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
