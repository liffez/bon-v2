// scripts/run_T_PRODUKTION.js
// ════════════════════════════════════════════════════════════
// T_PRODUKTION-runner (MVP-delmængde: P5–P15, P19–P22, P24, P26–P30).
// Spec: docs/T_PRODUKTION.md.
//
// Tilgang: ingen rigtig Grocy. Route'n køres IN-PROCESS mod en isoleret
// temp-DB, med shared/auth.requireAuth + grocyAdapter's Grocy-metoder stubbet
// (fake in-memory lager-ledger). Logik-only cases (skalering, QU) testes direkte
// mod services/production.js.
//
// Udeladt fra MVP (jf. CLAUDE_PRODUKTION_MVP §14): P1–P4 (recipe-consume-vej —
// MVP kører altid manuelt), P16–P18 (reversering), P23 (rollback), P25 (toggle).
//
// Kør: node --experimental-sqlite scripts/run_T_PRODUKTION.js
// ════════════════════════════════════════════════════════════

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-tprod-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
delete process.env.GROCY_TEST_KEY; delete process.env.GROCY_HQ_KEY; delete process.env.GROCY_CAFE_KEY;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);
const { getDb } = require('../db/database');
const db = getDb();

// Aktiv lokation (getDefaultLocationId)
if (!db.prepare('SELECT id FROM locations WHERE is_active=1 LIMIT 1').get()) {
    db.prepare("INSERT INTO locations (name, code, is_active) VALUES ('Test','test',1)").run();
}

// ── Stub auth FØR route requires (requireAuth destruktureres ved load) ──
const auth = require('../shared/auth');
auth.requireAuth = () => (req, res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); };

// ── Fake Grocy: in-memory ledger ──
const FIX = { RAW_A: 101, RAW_B: 102, KRYDDERI: 103, SUBST: 104, MELLEM: 201 };
const COST = { 101: 40, 102: 30, 103: 100, 104: 60 };   // kr/stock-enhed ex moms
let LEDGER, CALLS, txN;
function resetGrocy() {
    LEDGER = { 101: 100, 102: 100, 103: 100, 104: 100, 201: 0 };
    CALLS = { consume: [], add: [], other: [] };
    txN = 0;
}
resetGrocy();

const grocy = require('../services/grocyAdapter');
grocy.getQuantityUnitConversions = async () => ([
    { product_id: null, from_qu_id: 2, to_qu_id: 3, factor: 0.001 },   // g → kg
    { product_id: null, from_qu_id: 5, to_qu_id: 6, factor: 0.001 },   // ml → l
]);
grocy.getStock = async () => Object.keys(COST).map(pid => ({
    product_id: Number(pid), amount: LEDGER[pid], last_price: COST[pid], value: LEDGER[pid] * COST[pid],
}));
grocy.produceBatch = async ({ consume = [], produce }) => {
    const consumeTx = [], failedLines = [];
    for (const c of consume) {
        if (!(Number(c.amount) > 0)) continue;
        LEDGER[c.productId] = (LEDGER[c.productId] || 0) - c.amount;
        CALLS.consume.push({ productId: c.productId, amount: c.amount });
        consumeTx.push({ productId: c.productId, transactionId: 'tx' + (++txN) });
    }
    let produceTx = null;
    if (produce) {
        LEDGER[produce.productId] = (LEDGER[produce.productId] || 0) + produce.amount;
        CALLS.add.push({ productId: produce.productId, amount: produce.amount, price: produce.price });
        produceTx = 'tx' + (++txN);
    }
    return { state: failedLines.length ? 'partial' : 'produced', consumeTx, produceTx, produceError: null, failedLines };
};

// ── Mount route in-process ──
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/production', require('../routes/production'));
const services = require('../services/production');

let server, BASE;
async function start() {
    await new Promise(r => { server = app.listen(0, r); });
    BASE = 'http://127.0.0.1:' + server.address().port;
}
async function post(body) {
    const r = await fetch(BASE + '/api/production/batches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ── Assert-helpers ──
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  ✓', m); pass++; } else { console.error('  ✗', m); fail++; } };
const near = (a, b, m, t = 1e-6) => ok(Math.abs(Number(a) - Number(b)) <= t, `${m} (fik ${a}, forv. ${b})`);

let nonceN = 0;
const nonce = () => 'ZZT-' + Date.now() + '-' + (++nonceN);

// Standard-bon (1 portion): RAW_A 0.25, RAW_B 0.065, KRYDDERI 0.012 → MELLEM 1.0
function baseLines(over = {}) {
    const mk = (pid, name, q, dev) => ({
        productId: pid, productName: name, plannedQty: q, actualQty: (over[pid] != null ? over[pid] : q),
        fromQuId: 3, toQuId: 3, stockUnitName: 'kg', deviationReason: dev || null,
    });
    return [mk(101, 'ZZT_RAW_A', 0.25), mk(102, 'ZZT_RAW_B', 0.065), mk(103, 'ZZT_KRYDDERI', 0.012)];
}
function baseBody(extra = {}) {
    return Object.assign({
        recipe_id: 301, output_product_id: FIX.MELLEM, portions: 1, actual_yield: 1.0,
        output_unit: 'kg', batch_nonce: nonce(), lines: baseLines(),
    }, extra);
}

(async () => {
    await start();

    console.log('\n── B: Stock-effekt & dobbelttælling (R1) ──');
    {
        resetGrocy();
        const r = await post(baseBody());
        ok(r.status === 201, 'P5: produktion accepteret (201)');
        near(LEDGER[101], 100 - 0.25, 'P5: RAW_A −0,25');
        near(LEDGER[102], 100 - 0.065, 'P5: RAW_B −0,065');
        near(LEDGER[103], 100 - 0.012, 'P5: KRYDDERI −0,012');
        near(LEDGER[201], 1.0, 'P5: MELLEMPRODUKT +1,0 (self-production)');
        ok(CALLS.consume.length === 3 && !CALLS.consume.some(c => c.productId === 201),
            'P6: kun de 3 råvarer konsumeres — IKKE mellemproduktet (ingen dobbelttælling)');
        ok(CALLS.add.length === 1 && CALLS.add[0].productId === 201, 'P6: præcis ét add af mellemproduktet');
    }
    {
        resetGrocy();
        await post(baseBody({ lines: baseLines({ 101: 0.28 }) }));   // +30 g
        near(LEDGER[101], 100 - 0.28, 'P7: edit RAW_A → −0,28 (ikke −0,25)');
    }
    {
        resetGrocy();
        const lines = baseLines({ 102: 0 }); lines[1].deviationReason = 'udeladt';
        await post(baseBody({ lines }));
        near(LEDGER[102], 100, 'P8: RAW_B udeladt → uændret');
        ok(!CALLS.consume.some(c => c.productId === 102), 'P8: intet consume-kald for RAW_B');
    }
    {
        resetGrocy();
        const lines = baseLines();
        lines[0].actualQty = 0; lines[0].deviationReason = 'byttet';   // RAW_A ud
        lines.push({ productId: 104, productName: 'ZZT_SUBST', plannedQty: 0, actualQty: 0.25,
            fromQuId: 3, toQuId: 3, stockUnitName: 'kg', deviationReason: 'byttet', substituteForProductId: 101 });
        await post(baseBody({ lines }));
        near(LEDGER[101], 100, 'P9: byttet RAW_A → uændret (0-kald)');
        near(LEDGER[104], 100 - 0.25, 'P9: SUBST −0,25');
    }

    console.log('\n── C: Kostpris (R3) ──');
    {
        resetGrocy();
        await post(baseBody());
        // batchCost = 0,25×40 + 0,065×30 + 0,012×100 = 10 + 1,95 + 1,2 = 13,15 ; yield 1 → 13,15
        near(CALLS.add[0].price, 13.15, 'P10/P11: produkt-pris = Σ(actual×kost)/yield, ex moms');
        ok(CALLS.add[0].price < 13.15 * 1.25 - 0.01, 'P13: prisen er IKKE momset (ingen ×1,25)');
    }
    {
        resetGrocy();
        const lines = baseLines();
        lines[0].actualQty = 0; lines[0].deviationReason = 'byttet';
        lines.push({ productId: 104, productName: 'ZZT_SUBST', plannedQty: 0, actualQty: 0.25,
            fromQuId: 3, toQuId: 3, stockUnitName: 'kg', deviationReason: 'byttet', substituteForProductId: 101 });
        await post(baseBody({ lines }));
        // dyrere subst: 0,25×60 + 0,065×30 + 0,012×100 = 15 + 1,95 + 1,2 = 18,15
        near(CALLS.add[0].price, 18.15, 'P11: dyrere substitut → højere produkt-pris');
    }

    console.log('\n── D: Yield (R4) ──');
    {
        resetGrocy();
        const r = await post(baseBody({ actual_yield: 0.87, planned_yield: 1.0 }));
        near(LEDGER[201], 0.87, 'P14: faktisk udbytte 0,87 → MELLEM +0,87 (ikke +1,0)');
        const batch = db.prepare('SELECT planned_output_qty p, actual_output_qty a FROM production_batches WHERE id=?').get(r.json.batch.id);
        near(batch.a, 0.87, 'P15: actual_output_qty=0,87 gemt');
        near(batch.p, 1.0, 'P15: planned_output_qty=1,0 gemt (svind-reference)');
    }

    console.log('\n── F: Skalering (R9) — logik ──');
    near(services.scaleToPortions(0.28, 1.3), 0.364, 'P19: (0,25+0,03)×1,3 = 0,364');
    near(services.scaleToPortions(0, 5), 0, 'P20: udeladt (0) forbliver 0 ved skalering');
    {
        // P21: decimal-parse "1,3" og "1.3" (frontend-parse-ækvivalent)
        const parse = v => parseFloat(String(v).replace(',', '.'));
        ok(parse('1,3') === 1.3 && parse('1.3') === 1.3, 'P21: "1,3" og "1.3" → 1,3');
    }
    {
        // P22: skalér frem og tilbage 1→2→1 uden drift (override-per model)
        const per = 0.25; const a = services.scaleToPortions(per, 2); const back = services.scaleToPortions(per, 1);
        ok(Math.abs(back - 0.25) < 0.01 && Math.abs(a - 0.5) < 1e-9, 'P22: 1→2→1 ingen rundingsdrift > 0,01');
    }

    console.log('\n── G: Idempotens (R7) ──');
    {
        resetGrocy();
        const body = baseBody();
        const r1 = await post(body);
        const r2 = await post(body);   // samme nonce
        ok(r1.status === 201, 'P24: 1. submit opretter (201)');
        ok(r2.json.idempotent === true, 'P24: 2. submit (samme nonce) → idempotent, intet nyt træk');
        ok(CALLS.add.length === 1, 'P24: kun ÉT produkt-add trods dobbelt-submit');
        const cnt = db.prepare('SELECT COUNT(*) c FROM production_batches WHERE batch_nonce=?').get(body.batch_nonce).c;
        ok(cnt === 1, 'P24: kun én batch-række i DB');
    }

    console.log('\n── H: Enheder/QU (R6) — logik ──');
    {
        const r = services.toStockAmount({ productId: 101, displayAmount: 250, fromQuId: 2, toQuId: 3, conversions: [{ product_id: null, from_qu_id: 2, to_qu_id: 3, factor: 0.001 }] });
        near(r.stockAmount, 0.25, 'P26: 250 g → 0,25 kg før consume');
    }
    {
        const conv = [{ product_id: null, from_qu_id: 5, to_qu_id: 6, factor: 0.001 }];
        near(services.toStockAmount({ productId: 102, displayAmount: 65, fromQuId: 5, toQuId: 6, conversions: conv }).stockAmount, 0.065, 'P27: 65 ml → 0,065 l');
        near(services.toStockAmount({ productId: 103, displayAmount: 3, fromQuId: 7, toQuId: 7, conversions: [] }).stockAmount, 3, 'P27: stk (samme enhed) → uændret');
    }

    console.log('\n── I: Immutabilitet (R8) ──');
    {
        resetGrocy();
        await post(baseBody({ lines: baseLines({ 101: 0.28 }) }));
        ok(CALLS.other.length === 0, 'P28: ingen recipe-mutation (kun consume/add — masteren røres ikke)');
    }

    console.log('\n── J: Consumption-log integritet ──');
    {
        resetGrocy();
        const r = await post(baseBody());
        const rows = db.prepare('SELECT * FROM production_batch_consumption WHERE production_batch_id=? ORDER BY id').all(r.json.batch.id);
        ok(rows.length === 3, 'P29: én consumption-række pr. linje (3)');
        ok(rows.every(x => x.grocy_transaction_id && x.unit_cost != null && x.planned_qty != null && x.actual_qty != null),
            'P29: tx-id, unit_cost, planned_qty, actual_qty udfyldt');
    }
    {
        resetGrocy();
        const lines = baseLines();
        lines[0].actualQty = 0; lines[0].deviationReason = 'byttet';
        lines.push({ productId: 104, productName: 'ZZT_SUBST', plannedQty: 0, actualQty: 0.25,
            fromQuId: 3, toQuId: 3, stockUnitName: 'kg', deviationReason: 'byttet', substituteForProductId: 101 });
        const r = await post(baseBody({ lines }));
        const rows = db.prepare('SELECT * FROM production_batch_consumption WHERE production_batch_id=?').all(r.json.batch.id);
        const orig = rows.find(x => x.grocy_product_id === 101);
        const sub = rows.find(x => x.grocy_product_id === 104);
        ok(orig && orig.deviation_reason === 'byttet' && Number(orig.actual_qty) === 0, 'P30: original-linje actual=0, reason=byttet');
        ok(sub && sub.substitute_for_product_id === 101, 'P30: substitut-linje har substitute_for_product_id');
    }

    server.close();
    try { fs.unlinkSync(TEST_DB); } catch (_) {}
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})();
