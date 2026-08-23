// scripts/test-drift-location.js
// ============================================================
// Lokations-snit i driftsregnskabet (§18.7).
//
// Driften er ÉN motor med to visninger: HQ og Events er to disjunkte snit af
// den samme dag. Invarianten der bærer det hele — og som er hele grunden til at
// snittene overhovedet må findes — er:
//
//        hq + events = alt,  krone for krone, på HVER metrik
//
// Holder den ikke, er et snit ikke et snit men et selvstændigt regnskab, og så
// kan et tal falde ud mellem de to visninger uden at nogen opdager det.
//
// To kilder svarer på "hvor foregik arbejdet", og BEGGE skal respektere valget:
//   bon-siden  → bons.event_role  ('sales'/'expense' = event, resten = HQ)
//   løn-siden  → labor.location_class fra Smartplans lokation (migration 122)
// Snittes kun den ene, ville HQ-visningen vise festival-lønnen sammen med
// HQ's omsætning — et tal der ser rigtigt ud og er forkert.
//
// Kører in-process mod isoleret temp-DB. Smartplan stubbes, men laborAdapter
// leverer ÆGTE rækker med location_class — ellers ville løn-halvdelen af snittet
// være stubbet væk, og testen ville måle ingenting.
//
// Kør:  node --experimental-sqlite scripts/test-drift-location.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-driftloc-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
function near(a, b, msg, eps = 0.02) { assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`); }

// Frysning gælder KUN afsluttede dage i realiseret-mode. Datoerne er derfor
// udledt af dagen i dag, ikke skrevet i hånden: en fast dato ville stille og
// roligt glide fra "fortid" til "fremtid" og degradere frysnings-testene til
// noget der bare ikke fyrer. (todayISO er dansk tid, ikke UTC — jf. #133.)
const { todayISO, offsetISO } = require('../db/helpers');
const DATO   = offsetISO(-40);   // afsluttet dag → fryses ved første visning
const FUTURE = offsetISO(200);   // fremtid → altid live

// ── Løn-stub: ægte rækkeform, to lokationer ──────────────────
// Formen matcher laborAdapter._transformRow (kostpris = timer × sats, is_open,
// location_class). Vi stubber KILDEN, ikke logikken der snitter.
const LABOR = [
    { employee_id: 'u-hq',  employee_name: 'HQ-kok',   role_class: 'production', is_open: false,
      location: 'Ristet Rug',          location_class: 'hq',     timer: 8, sats: 150, kostpris: 1200,
      rate_missing: false, role_unmapped: false, mode: 'realiseret' },
    { employee_id: 'u-ev',  employee_name: 'Event-sælger', role_class: 'production', is_open: false,
      location: 'Festivaler og Events', location_class: 'events', timer: 10, sats: 145, kostpris: 1450,
      rate_missing: false, role_unmapped: false, mode: 'realiseret' },
    { employee_id: 'u-vol', employee_name: 'Frivillig',  role_class: 'volunteer', is_open: false,
      location: 'Festivaler og Events', location_class: 'events', timer: 6, sats: 0, kostpris: 0,
      rate_missing: false, role_unmapped: false, mode: 'realiseret' },
];
const lPath = require.resolve('../services/laborAdapter');
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor:    async (d) => (d === DATO || d === FUTURE ? LABOR.map(r => ({ ...r })) : []),
        getLaborMap: async ()  => ({ [DATO]: LABOR.map(r => ({ ...r })), [FUTURE]: LABOR.map(r => ({ ...r })) }),
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
    const r = await fetch(BASE + u);
    return { status: r.status, data: await r.json().catch(() => null) };
};

/* ── Seed ────────────────────────────────────────────────── */

function seed(db, dato) {
    const pc = (code) => db.prepare('SELECT id FROM price_categories WHERE code=?').get(code)?.id;
    const st = (code) => db.prepare('SELECT id FROM status_definitions WHERE code=?').get(code).id;
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

    const evId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, status)
        VALUES ('Loc-test', ?, 'light', ?, 'active')
    `).run(locId, dato).lastInsertRowid);

    let n = 0;
    function bon({ statusCode, priceCode, role, total, delivery, lines }) {
        const id = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                              price_category_id, event_id, event_role, total_price, delivery_cost, pax)
            VALUES (?,?,?,?,?,?,?,?,?,?,10)
        `).run(`T_LOC_${dato}_${++n}`, st(statusCode), locId, dato, dato, pc(priceCode) ?? null,
               role ? evId : null, role ?? null, total, delivery ?? 0).lastInsertRowid);
        for (const l of lines) {
            db.prepare(`
                INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit,
                                       unit_price, line_total, cost_price)
                VALUES (?,?,?,?,'stk',?,?,?)
            `).run(id, l.name, l.cat ?? '01 Sandwich', l.qty, l.price, l.qty * l.price, l.cost);
        }
        return id;
    }

    // HQ: almindelig catering-bon (omsætning + vareforbrug + levering)
    bon({ statusCode: 'BETALT', priceCode: 'catering', total: 1000, delivery: 120,
          lines: [{ name: 'Tunen', qty: 10, price: 100, cost: 25 }] });
    // HQ: event-PREP. Bevidst HQ — den laves i HQ-køkkenet og trækker HQ-lager.
    bon({ statusCode: 'LEVERET', priceCode: 'produktion', role: 'prep', total: 0,
          lines: [{ name: 'Tunen', qty: 100, price: 0, cost: 20 }] });
    // Event: salg (omsætning, rører ikke lageret)
    bon({ statusCode: 'BETALT', priceCode: 'festival', role: 'sales', total: 6900,
          lines: [{ name: 'Tunen', qty: 60, price: 115, cost: 20 }] });
    // Event: udgift (stadeleje)
    bon({ statusCode: 'BETALT', priceCode: 'festival', role: 'expense', total: 500,
          lines: [{ name: 'Stadeleje', cat: 'x- Service', qty: 1, price: 500, cost: 0 }] });
    return evId;
}

/* ── Test ────────────────────────────────────────────────── */

const METRICS = ['revenue_ex_moms', 'cost_ex_moms', 'delivery_ex_moms', 'labor_ex_moms',
                 'labor_raw_ex_moms', 'driftsresultat_ex_moms', 'units', 'bon_count',
                 'cost_excluded_ex_moms', 'hours_production'];

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    seed(db, DATO);
    seed(db, FUTURE);

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });

    const day = (l) => get(`/api/drift/day?date=${FUTURE}&mode=realiseret${l ? '&location=' + l : ''}`).then(r => r.data);

    // ── 1) Invarianten: hq + events = alt ────────────────────────────────
    console.log('\n— hq + events = alt —');
    const all = await day(), hq = await day('hq'), ev = await day('events');
    for (const k of METRICS) {
        near((hq[k] || 0) + (ev[k] || 0), all[k] || 0, `${k}: snittene summerer til hele driften`);
    }

    // ── 2) Bon-siden snittes på event_role ───────────────────────────────
    console.log('\n— Bon-siden —');
    const { inclToExcl } = require('../shared/moms');
    near(hq.revenue_ex_moms, inclToExcl(1000), 'HQ: kun catering-bonnen (prep er 0 kr)');
    near(ev.revenue_ex_moms, inclToExcl(6900 + 500), 'Event: salg + udgift');
    near(hq.bon_count, 2, 'HQ: catering + prep');
    near(ev.bon_count, 2, 'Event: salg + udgift');
    near(hq.cost_ex_moms, 250 + 2000, 'HQ bærer prep-bonnens vareforbrug (§18.7: prep bliver i driften)');
    near(ev.cost_ex_moms, 0, 'Event: salgsbonnens spøgelses-kostpris tælles ikke (#533)');
    near(ev.cost_excluded_ex_moms, 1200, 'og det udeladte rapporteres i event-snittet');
    near(hq.delivery_ex_moms, 120, 'levering følger bonnen ind i HQ');
    near(ev.delivery_ex_moms, 0, 'event-bonnerne har ingen levering');

    // ── 3) Løn-siden snittes på Smartplans lokation ──────────────────────
    // Dette er den halvdel der er nem at glemme: uden den ville HQ-visningen
    // vise festivalens løn sammen med HQ's omsætning.
    console.log('\n— Løn-siden —');
    near(hq.labor_raw_ex_moms, 1200, 'HQ: kun vagten på HQ-lokationen');
    near(ev.labor_raw_ex_moms, 1450, 'Event: kun vagten på event-lokationen (frivillig = 0 kr)');
    near(all.labor_raw_ex_moms, 2650, 'Alt: begge vagter');
    assert((hq.labor_rows || []).every(l => l.location_class === 'hq'), 'HQ-snittet har ingen event-vagter i rækkerne');
    assert((ev.labor_rows || []).every(l => l.location_class === 'events'), 'Event-snittet har ingen HQ-vagter i rækkerne');
    near(hq.hours_production, 8, 'HQ: 8 timer');
    near(ev.hours_production, 10, 'Event: kun den lønnede vagt tæller som produktionstimer');
    // Værd at vide, og derfor pinnet: en frivillig har role_class 'volunteer',
    // ikke 'production'. Timerne tæller altså IKKE i kapacitetsraten, selvom
    // personen står og arbejder. Det gør raten på en festivaldag for høj —
    // men det er en egenskab ved role_class, ikke ved snittet, og det gælder
    // uændret med og uden lokations-valg (invarianten 8 + 10 = 18 holder).
    assert(LABOR.filter(l => l.role_class === 'volunteer').length === 1,
        'frivillig-timer er bevidst uden for produktionstimerne (role_class er ét felt)');

    // ── 4) Svaret mærker sig selv ────────────────────────────────────────
    console.log('\n— Svaret siger hvilket snit det er —');
    assert(all.location === 'all',    'uden parameter: location = all');
    assert(hq.location === 'hq',      'hq: location = hq');
    assert(ev.location === 'events',  'events: location = events');
    const junk = (await get(`/api/drift/day?date=${FUTURE}&mode=realiseret&location=peberholm`)).data;
    assert(junk.location === 'all', 'ukendt lokation falder tilbage til hele driften');
    near(junk.revenue_ex_moms, all.revenue_ex_moms, '…med de samme tal — aldrig et tomt regnskab');

    // ── 5) Drill-down følger snittet ─────────────────────────────────────
    console.log('\n— Drill-down —');
    const evBons = (await get(`/api/drift/day/bons?date=${FUTURE}&mode=realiseret&location=events`)).data.bons || [];
    assert(evBons.length === 2, 'event-snittets drill-down har kun event-bonnerne');
    near(evBons.reduce((s, b) => s + b.revenue_ex_moms, 0), ev.revenue_ex_moms,
        'rækkerne summerer til snittets pille, krone for krone');
    assert((ev.bons || []).length === 2, '/day bærer den samme liste');

    // ── 6) Produktions-sammentælling ─────────────────────────────────────
    console.log('\n— Sammentælling —');
    const itAll = (await get(`/api/drift/items?from=${FUTURE}&to=${FUTURE}`)).data;
    const itHq  = (await get(`/api/drift/items?from=${FUTURE}&to=${FUTURE}&location=hq`)).data;
    const itEv  = (await get(`/api/drift/items?from=${FUTURE}&to=${FUTURE}&location=events`)).data;
    assert(itAll.location === 'all' && itHq.location === 'hq', 'sammentællingen mærker også sit snit');
    // Tallene skal være FORSKELLIGE fra hinanden — ellers beviser en sum-test
    // ingenting (0 + 0 = 0 består også). Seeden: 10 stk HQ + 100 stk prep (HQ)
    // + 60 stk event-salg + 1 stk stadeleje.
    near(itAll.totals.quantity, 171, 'alt: alle linjer talt op');
    near(itHq.totals.quantity,  110, 'HQ: catering 10 + prep 100');
    near(itEv.totals.quantity,   61, 'Event: salg 60 + stadeleje 1');
    near(itHq.totals.quantity + itEv.totals.quantity, itAll.totals.quantity, 'talte varer: hq + events = alt');
    near(itHq.totals.units + itEv.totals.units, itAll.totals.units, 'talte enheder: hq + events = alt');
    assert(itEv.categories.every(c => c.products.every(p => p.name !== 'Tunen' || p.quantity === 60)),
        'event-snittet tæller kun sine egne 60 stk Tunen, ikke prep-bonnens 100');

    // ── 7) Periode ───────────────────────────────────────────────────────
    console.log('\n— Periode —');
    const per = (l) => get(`/api/drift/period?from=${FUTURE}&to=${FUTURE}&mode=realiseret${l ? '&location=' + l : ''}`).then(r => r.data);
    const pAll = await per(), pHq = await per('hq'), pEv = await per('events');
    assert(pAll.totals.location === 'all' && pEv.totals.location === 'events', 'periode-totalen mærker sit snit');
    for (const k of ['revenue_ex_moms', 'cost_ex_moms', 'labor_ex_moms', 'driftsresultat_ex_moms']) {
        near(pHq.totals[k] + pEv.totals[k], pAll.totals[k], `periode ${k}: snittene summerer`);
    }
    near(pAll.totals.revenue_ex_moms, all.revenue_ex_moms, 'én-dags periode = dagsvisningen');
    near(pEv.totals.revenue_ex_moms, ev.revenue_ex_moms, '…også i et snit');

    // ── 8) Frysning: et snit må aldrig fryse en halv dag ─────────────────
    // Første kald på en afsluttet dag fryser den. Sker det gennem et snit, SKAL
    // det frosne stadig være hele dagen — ellers ville "alt" bagefter vise
    // halvdelen, permanent, uden at nogen kunne se hvorfor.
    console.log('\n— Frysning —');
    const frozenSlice = (await get(`/api/drift/day?date=${DATO}&mode=realiseret&location=events`)).data;
    assert(frozenSlice.frozen === true, 'et snit på en afsluttet dag fryser dagen');
    assert(frozenSlice.bons_live === true, '…og siger at bon-siden er regnet live');
    near(frozenSlice.revenue_ex_moms, inclToExcl(7400), 'snittet viser event-tallene');

    const snap = JSON.parse(db.prepare(
        'SELECT data_json FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(DATO, 'realiseret').data_json);
    assert(snap.location === 'all', 'det FROSNE er hele dagen, ikke snittet');
    near(snap.revenue_ex_moms, inclToExcl(8400), '…med begge halvdele i omsætningen');
    assert((snap.labor_rows || []).length === 3, '…og alle vagter, så snit kan udledes bagefter');

    const frozenAll = (await get(`/api/drift/day?date=${DATO}&mode=realiseret`)).data;
    assert(frozenAll.frozen === true && !frozenAll.bons_live, 'hele driften serveres fra snapshottet');
    near(frozenAll.revenue_ex_moms, inclToExcl(8400), '…uændret af at et snit blev vist først');

    // Invarianten holder også på en frosset dag.
    const fHq = (await get(`/api/drift/day?date=${DATO}&mode=realiseret&location=hq`)).data;
    for (const k of ['revenue_ex_moms', 'cost_ex_moms', 'labor_raw_ex_moms']) {
        near((fHq[k] || 0) + (frozenSlice[k] || 0), frozenAll[k] || 0, `frosset dag, ${k}: snittene summerer stadig`);
    }
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
