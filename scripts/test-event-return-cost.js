// scripts/test-event-return-cost.js
// ============================================================
// Returen skal ændre eventets VAREFORBRUG, ikke kun lageret (#534).
// Spec: docs/CLAUDE_EVENT.md §18.9.
//
// Lægger sig oven på #537's spor (migration 157): den tabel siger HVAD der kom
// hjem, denne test dækker HVAD DET VAR VÆRD — modposten i computeEventCost —
// plus værnet mod at bogføre varer der aldrig blev trukket fra HQ.
//
// Kører in-process mod en isoleret temp-DB med Grocy stubbet. Grunden er ikke
// hastighed: den ægte sti kalder grocy.addToStock(), og en test der spawner en
// rigtig server ville flytte lager i grocytest. En attrap gør desuden de
// tilfælde testbare der er svære at fremprovokere — at ét produkt fejler hos
// Grocy, og at et andet ingen kendt pris har.
//
// Kør:  node --experimental-sqlite scripts/test-event-return-cost.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-returcost-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
function near(a, b, msg, eps = 0.02) { assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`); }

const PID_LOEG = 501, PID_PERSILLE = 502, PID_FEJL = 503;
const addCalls = [];
let failNext = new Set();

const grocyStub = {
    getProducts: async () => [
        { id: PID_LOEG,     name: 'Rødløg',   qu_id_stock: 1, no_own_stock: '0', active: '1' },
        { id: PID_PERSILLE, name: 'Persille', qu_id_stock: 1, no_own_stock: '0', active: '1' },
        { id: PID_FEJL,     name: 'Kål',      qu_id_stock: 1, no_own_stock: '0', active: '1' },
    ],
    getQuantityUnits: async () => [{ id: 1, name: 'Kilo' }],
    getRecipes: async () => [],
    getStock: async () => [],
    // Rødløg har en pris, persille ikke — den skal på lager men tælle 0 kr.
    getProductUnitCosts: async () => new Map([[String(PID_LOEG), 24], [String(PID_FEJL), 10]]),
    addToStock: async (pid, amt) => {
        if (failNext.has(pid)) throw new Error('Grocy sagde nej');
        addCalls.push({ pid, amt });
        return { ok: true };
    },
};
const gPath = require.resolve('../services/grocyAdapter');
require.cache[gPath] = { id: gPath, filename: gPath, loaded: true, exports: grocyStub };

// BOM-attrap: 1 stk = 0,1 kg rødløg + 0,02 kg persille.
const irPath = require.resolve('../services/ingredientResolver');
require.cache[irPath] = {
    id: irPath, filename: irPath, loaded: true, exports: {
        resolveConsumeItems: async (lines) => {
            let qty = 0;
            for (const l of lines) if (l.grocy_recipe_id) qty += Number(l.quantity) || 0;
            return [
                { product_id: PID_LOEG,     product_name: 'Rødløg',   amount_stock: qty * 0.1 },
                { product_id: PID_PERSILLE, product_name: 'Persille', amount_stock: qty * 0.02 },
            ];
        },
    },
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/events', require('../routes/events'));

let server, BASE;
async function http(method, url, body) {
    const res = await fetch(BASE + url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });

    // Prep 100 stk à 20 kr kost = 2.000. Salg 60 stk.
    const ev = (await http('POST', '/api/events', {
        name: 'Retur-kost', location_id: locId, start_date: '2026-09-10', end_date: '2026-09-11',
    })).data;
    const line = (qty, price) => ({
        grocy_recipe_id: 77, product_name: 'Tunen', category: '01 Sandwich',
        quantity: qty, unit: 'stk', unit_price: price, cost_price: 20,
    });
    await http('POST', `/api/events/${ev.id}/bons`, { role: 'prep',  delivery_date: '2026-09-10', lines: [line(100, 0)] });
    await http('POST', `/api/events/${ev.id}/bons`, { role: 'sales', delivery_date: '2026-09-10', lines: [line(60, 100)] });

    // ── 1) Vareforbrug før retur = hvad vi pakkede ───────────────────────
    console.log('\n— Før retur —');
    let pnl = (await http('GET', `/api/events/${ev.id}/overview`)).data.pnl;
    near(pnl.cost_packed, 2000, 'pakket = 100 × 20 kr');
    near(pnl.cost_estimated, 2000, 'uden retur er faktisk = pakket (uændret adfærd)');
    near(pnl.cost_returned, 0, 'intet returneret endnu');

    const sug = (await http('GET', `/api/events/${ev.id}/return-suggestion`)).data;
    near(sug.items.find(i => i.product_id === PID_LOEG).suggested_rest, 4,
        'forslaget tager udgangspunkt i salget: 10 kg pakket − 6 kg solgt');

    // ── 2) Værnet ────────────────────────────────────────────────────────
    console.log('\n— Værnet —');
    const over = await http('POST', `/api/events/${ev.id}/return`, { items: [{ product_id: PID_LOEG, amount: 8 }] });
    assert(over.status === 409, 'bogføring afvises når der er talt mere end der er tilbage');
    assert(over.data.error === 'return_exceeds_computed', 'fejlen har en maskin-kode');
    assert(over.data.items?.[0]?.product_name === 'Rødløg', 'råvaren navngives, så den kan findes');
    near(over.data.items[0].computed_rest, 4, 'den beregnede rest vises');
    near(over.data.items[0].counted, 8, 'det talte vises ved siden af');
    assert(/top-up/.test(over.data.hint || ''), 'beskeden peger på den manglende top-up-bon');
    assert(addCalls.length === 0, 'INTET blev lagt på lager da værnet slog til');
    assert(db.prepare('SELECT COUNT(*) n FROM event_returns').get().n === 0, 'og intet spor skrevet');

    // ── 3) Tolerance: optælling er upræcis ───────────────────────────────
    console.log('\n— Tolerance —');
    const tol = await http('POST', `/api/events/${ev.id}/return`, { items: [{ product_id: PID_LOEG, amount: 4.3 }] });
    assert(tol.status === 200, '4,3 kg mod beregnet 4,0 (7,5 %) slipper igennem 10 %-tolerancen');
    near(tol.data.cost_returned, 4.3 * 24, 'modposten er talt mængde × snapshottet pris');

    // ── 4) Modposten trækker fra vareforbruget ───────────────────────────
    console.log('\n— Modpost i P&L —');
    pnl = (await http('GET', `/api/events/${ev.id}/overview`)).data.pnl;
    near(pnl.cost_packed, 2000, 'pakket er uændret — vi rører ikke prep-bonnen');
    near(pnl.cost_returned, 103.2, 'retur bogført');
    near(pnl.cost_estimated, 2000 - 103.2, 'faktisk vareforbrug = pakket − retur');
    const row = db.prepare('SELECT unit_cost, cost_total FROM event_returns WHERE product_id=?').get(PID_LOEG);
    near(row.unit_cost, 24, 'prisen er SNAPSHOTTET på rækken, ikke slået op ved visning');

    // ── 5) Værnet fanger også en GENTAGET bogføring ──────────────────────
    // #537's forslag trækker det allerede returnerede fra, så anden gang er
    // resten 0 — og de samme mængder overskrider den. Derfor er der ikke brug
    // for en separat idempotens-nøgle: de to ville dække det samme.
    console.log('\n— Gentagen bogføring —');
    const addsBefore = addCalls.length;
    const igen = await http('POST', `/api/events/${ev.id}/return`, { items: [{ product_id: PID_LOEG, amount: 4.3 }] });
    assert(igen.status === 409, 'samme mængder igen afvises — resten er brugt op');
    assert(addCalls.length === addsBefore, 'lageret blev IKKE tilføjet to gange');
    near((await http('GET', `/api/events/${ev.id}/overview`)).data.pnl.cost_returned, 103.2,
        'og vareforbruget blev ikke trukket ned to gange');

    // ── 6) Force: valget skal kunne træffes, men bevidst og med spor ──────
    console.log('\n— Force —');
    const forced = await http('POST', `/api/events/${ev.id}/return`, {
        force: true, items: [{ product_id: PID_LOEG, amount: 2 }],
    });
    assert(forced.status === 200, 'værnet kan tilsidesættes bevidst');
    assert(Array.isArray(forced.data.forced) && forced.data.forced.length === 1, 'svaret siger hvad der blev tilsidesat');
    assert(db.prepare('SELECT forced FROM event_returns WHERE amount=2').get().forced === 1,
        'rækken er mærket som tilsidesat — sporet skal kunne findes bagefter');
    const note = db.prepare(`SELECT notes FROM changelog WHERE entity_type='event' AND field_name='return' ORDER BY id DESC LIMIT 1`).get();
    assert(/tilsidesat/.test(note?.notes || ''), 'og changelog forklarer hvorfor');

    // ── 7) Manglende pris: lageret rettes, uden at gætte på kroner ────────
    console.log('\n— Råvare uden kendt pris —');
    const np = await http('POST', `/api/events/${ev.id}/return`, {
        items: [{ product_id: PID_PERSILLE, amount: 0.8, product_name: 'Persille' }],
    });
    assert(np.status === 200, 'persille kan returneres selvom prisen er ukendt');
    assert(np.data.missing_price?.includes('Persille'), 'og det SIGES at den ikke tælles i kroner');
    assert(addCalls.some(c => c.pid === PID_PERSILLE), 'lageret blev alligevel rettet — det er den vigtige del');
    near(db.prepare('SELECT cost_total FROM event_returns WHERE product_id=?').get(PID_PERSILLE).cost_total, 0,
        'modposten er 0 kr, ikke et gæt — vareforbruget forbliver hellere for højt');

    // ── 8) Grocy-fejl: kun det der landede bliver bogført ────────────────
    console.log('\n— Grocy fejler på ét produkt —');
    failNext = new Set([PID_FEJL]);
    const costBefore = (await http('GET', `/api/events/${ev.id}/overview`)).data.pnl.cost_returned;
    const partial = await http('POST', `/api/events/${ev.id}/return`, {
        force: true, items: [{ product_id: PID_FEJL, amount: 2 }],
    });
    assert(partial.status === 200, 'et fejlet produkt vælter ikke hele bogføringen');
    assert(partial.data.results.some(r => !r.success), 'fejlen rapporteres pr. produkt');
    assert(db.prepare('SELECT COUNT(*) n FROM event_returns WHERE product_id=?').get(PID_FEJL).n === 0,
        'produktet blev IKKE bogført — regnskabet må ikke påstå at varen kom hjem');
    near((await http('GET', `/api/events/${ev.id}/overview`)).data.pnl.cost_returned, costBefore,
        'og vareforbruget er uændret');
    failNext = new Set();

    // ── 9) Et event uden retur opfører sig præcis som før ────────────────
    console.log('\n— Bagudkompatibilitet —');
    const ev2 = (await http('POST', '/api/events', {
        name: 'Uden retur', location_id: locId, start_date: '2026-10-01',
    })).data;
    await http('POST', `/api/events/${ev2.id}/bons`, { role: 'prep', delivery_date: '2026-10-01', lines: [line(50, 0)] });
    const p2 = (await http('GET', `/api/events/${ev2.id}/overview`)).data.pnl;
    near(p2.cost_estimated, 1000, 'vareforbrug uden retur = pakket, som hidtil');
    near(p2.cost_returned, 0, 'ingen modpost');
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
