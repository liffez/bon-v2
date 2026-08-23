// scripts/test-drift-event-cost.js
// ============================================================
// Driftsregnskabet må ikke tælle event-vareforbrug to gange (#533).
// Spec: docs/CLAUDE_EVENT.md §18.8.
//
// computeDay summerede bl.quantity * bl.cost_price over ALLE bons på datoen.
// VarePicker snapshotter en cost_price på hver eneste linje — også på en
// event-salgsbon, som pr. konstruktion ikke rører lageret (prep-bonnen ejer
// trækket). Eventets varer blev derfor talt to gange: én gang på prep-dagen og
// én gang på salgsdagen. Omsætningen var derimod korrekt hele tiden.
//
// Kører in-process mod isoleret temp-DB. Smartplan stubbes — driftens løn-del
// er ikke det der testes her, og et netværkskald ville gøre testen upålidelig.
// Route-handleren er ÆGTE: det er dens SQL der bærer reglen.
//
// Kør:  node --experimental-sqlite scripts/test-drift-event-cost.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-driftcost-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
function near(a, b, msg, eps = 0.02) { assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`); }

// Smartplan-fri løn: driften kalder laborAdapter, ikke Smartplan direkte.
const lPath = require.resolve('../services/laborAdapter');
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor: async () => [], getLaborMap: async () => ({}),
    },
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/drift', require('../routes/drift'));

let server, BASE;
const get = async (u) => {
    const r = await fetch(BASE + u, { headers: { 'Content-Type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
};

const DATO = '2026-09-20';

function seed(db) {
    const pc = (code) => db.prepare('SELECT id FROM price_categories WHERE code=?').get(code)?.id;
    const st = (code) => db.prepare('SELECT id FROM status_definitions WHERE code=?').get(code).id;
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

    const evId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, status)
        VALUES ('Drift-test', ?, 'light', ?, 'active')
    `).run(locId, DATO).lastInsertRowid);

    let n = 0;
    function bon({ number, statusCode, priceCode, eventId, role, total, lines }) {
        const id = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                              price_category_id, event_id, event_role, total_price, pax)
            VALUES (?,?,?,?,?,?,?,?,?,10)
        `).run(`T_DRIFT_${++n}`, st(statusCode), locId, DATO, DATO, pc(priceCode) ?? null,
               eventId ?? null, role ?? null, total).lastInsertRowid);
        for (const l of lines) {
            db.prepare(`
                INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                                       unit_price, line_total, cost_price)
                VALUES (?,?,?,?,'stk',?,?,?)
            `).run(id, l.name, l.cat ?? '01 Sandwich', l.qty, l.price, l.qty * l.price, l.cost);
        }
        return id;
    }

    // Almindelig HQ-bon: trækker lager OG har omsætning → dens kostpris ER vareforbrug.
    bon({ statusCode: 'BETALT', priceCode: 'catering', total: 1000,
          lines: [{ name: 'Tunen', qty: 10, price: 100, cost: 25 }] });                 // kost 250

    // Event-prep: 0 kr omsætning, ejer lagertrækket → dens kostpris tæller.
    bon({ statusCode: 'LEVERET', priceCode: 'produktion', eventId: evId, role: 'prep', total: 0,
          lines: [{ name: 'Tunen', qty: 100, price: 0, cost: 20 }] });                  // kost 2000

    // Event-salg: omsætning, men rører IKKE lageret. Kostprisen er et spøgelse.
    bon({ statusCode: 'BETALT', priceCode: 'festival', eventId: evId, role: 'sales', total: 6900,
          lines: [{ name: 'Tunen', qty: 60, price: 115, cost: 20 }] });                 // kost 1200 ← må ikke tælle

    return evId;
}

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    const evId = seed(db);

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });

    // ── 1) Aggregatet ────────────────────────────────────────────────────
    console.log('\n— Dagens vareforbrug —');
    const day = (await get(`/api/drift/day?date=${DATO}&mode=realiseret`)).data;
    near(day.cost_ex_moms, 250 + 2000, 'vareforbrug = HQ-bon + prep — salgsbonnens 1.200 kr er ude');
    near(day.cost_excluded_ex_moms, 1200, 'det udeladte rapporteres i stedet for at forsvinde tavst');

    // ── 2) Omsætningen var korrekt hele tiden ────────────────────────────
    console.log('\n— Omsætningen er urørt —');
    const { inclToExcl } = require('../shared/moms');
    near(day.revenue_ex_moms, inclToExcl(1000 + 6900), 'både HQ-bon og event-salg tæller i omsætningen');
    near(day.bon_count, 3, 'alle tre bons er stadig med i dagen');

    // ── 3) Bundlinjen følger med ─────────────────────────────────────────
    console.log('\n— Resultatet —');
    near(day.driftsresultat_ex_moms, inclToExcl(7900) - 2250, 'resultat = omsætning − vareforbrug (ingen levering/løn)');

    // ── 4) Per-bon nedbrydningen skal stemme med aggregatet ──────────────
    // De to queries er skrevet hver for sig; divergerer de, summerer drill-down
    // ikke længere til pillen ovenover, og så leder man efter en fejl der ikke findes.
    console.log('\n— Drill-down stemmer med pillen —');
    const bons = (await get(`/api/drift/day/bons?date=${DATO}&mode=realiseret`)).data.bons || [];
    assert(bons.length === 3, 'alle tre bons i drill-down');
    near(bons.reduce((s, b) => s + b.cost_ex_moms, 0), day.cost_ex_moms,
        'summen af rækkerne = aggregatet, krone for krone');
    const salgsbon = bons.find(b => b.revenue_ex_moms > 5000);
    near(salgsbon.cost_ex_moms, 0, 'event-salgsbonnen står med 0 kr vareforbrug');

    // ── 5) Festival-modellen gates IKKE ──────────────────────────────────
    // Dér trækker salgsbonnen fra sin egen lokation og ejer altså sin omkostning.
    console.log('\n— Festival-model —');
    db.prepare("UPDATE events SET model='festival' WHERE id=?").run(evId);
    const fest = (await get(`/api/drift/day?date=${DATO}&mode=realiseret`)).data;
    near(fest.cost_ex_moms, 250 + 2000 + 1200, 'festival-salgsbonnen tæller sin egen kostpris med');
    near(fest.cost_excluded_ex_moms, 0, 'og intet udelades');
    db.prepare("UPDATE events SET model='light' WHERE id=?").run(evId);

    // ── 6) En dag uden events er fuldstændig uændret ─────────────────────
    console.log('\n— Bagudkompatibilitet —');
    db.prepare("UPDATE bons SET delivery_date='2026-09-21' WHERE event_id IS NOT NULL").run();
    const solo = (await get(`/api/drift/day?date=${DATO}&mode=realiseret`)).data;
    near(solo.cost_ex_moms, 250, 'almindelig HQ-dag: vareforbrug som hidtil');
    near(solo.cost_excluded_ex_moms, 0, 'intet udeladt når der ingen event-bons er');
    near(solo.bon_count, 1, 'kun HQ-bonnen tilbage på datoen');
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
