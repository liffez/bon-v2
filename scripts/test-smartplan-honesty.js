// scripts/test-smartplan-honesty.js
// ============================================================
// "Vi kunne ikke spørge" må aldrig blive til "svaret er nul".
//
// Baggrund (august 2026): Settings viste "✓ Forbundet — 0 vagter og 0 jobtyper
// det seneste år", og det så ud som om alle timer i Smartplan var forsvundet.
// De var der. Smartplan throttlede os (HTTP 429), og fem `.catch(() => [])` i
// adapteren lavede fejlen om til en tom liste.
//
// Konsekvensen var ikke kun kosmetisk. BEGGE frys-værn — driftens dagsopgørelse
// og eventets løn — hænger på at der er sat en fejl. Når adapteren aldrig kunne
// sætte en, kunne et enkelt throttlet øjeblik fryse "0 kr løn" permanent ind i
// labor_day_snapshot, hvor ingen bagefter kunne se hvorfor.
//
// Samme fejlklasse som #305/#319: handlingen påstår at være sket, bivirkningen
// fyrede aldrig, og de to steder mødes aldrig.
//
// Del A stubber global fetch (adapterens eneste udgang) og kigger på hvad
// adapteren gør ved en fejl. Del B kører driftens ÆGTE route-handler mod en
// laborAdapter der kaster, og kigger i DATABASEN efter et snapshot.
//
// Kør:  node --experimental-sqlite scripts/test-smartplan-honesty.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-sphonest-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
process.env.SMARTPLAN_CLIENT_ID     = 'test-id';
process.env.SMARTPLAN_CLIENT_SECRET = 'test-secret';

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
const near = (a, b, msg, eps = 0.02) => assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`);

/* ══ Del A — adapteren sluger ikke ══════════════════════════ */

const realFetch = globalThis.fetch;
const OK = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

// Token + konto lykkes altid; kun data-endpointet varieres. Så er det entydigt
// hvad testen måler: fejl PÅ DATAEN, ikke en manglende opsætning.
function stubFetch(dataResponse) {
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
        if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'acc-1', name: 'Ristet Rug' }] });
        return dataResponse(u);
    };
}

function freshAdapter() {
    delete require.cache[require.resolve('../services/smartplanAdapter')];
    return require('../services/smartplanAdapter');
}

async function partA() {
    console.log('\n— Adapteren siger fra i stedet for at svare nul —');

    // 1) 429: den fejl der faktisk ramte, og den eneste der går over af sig selv.
    stubFetch(() => ({ ok: false, status: 429,
        text: async () => JSON.stringify({ message: 'request limit exceeded', availableIn: 161.5 }) }));
    let sp = freshAdapter();
    let err = null;
    try { await sp.getLaborRows('2026-01-01', '2026-01-02'); } catch (e) { err = e; }
    assert(err !== null, 'en throttlet forespørgsel kaster (og bliver ikke til en tom liste)');
    assert(/429/.test(err?.message || ''), 'beskeden nævner 429');
    // Præcis formulering, ikke bare tallet: "161" står også i Smartplans rå
    // JSON-svar, så en løs test ville bestå selvom beskeden var uændret rå.
    assert(/prøv igen om ca\. 162 sekunder/.test(err?.message || ''),
        '…og hvor længe man skal vente, formuleret så det er til at handle på');
    assert(/[Tt]imerne er der stadig/.test(err?.message || ''),
        '…og at data ikke er tabt — ellers leder nogen efter en fejl i Smartplan');

    // 2) Andre HTTP-fejl skal også frem.
    stubFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
    sp = freshAdapter(); err = null;
    try { await sp.getLaborRows('2026-01-01', '2026-01-02'); } catch (e) { err = e; }
    assert(/500/.test(err?.message || ''), 'en 500 kaster også');

    // 3) Netværksfejl (ingen HTTP-svar overhovedet).
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    sp = freshAdapter(); err = null;
    try { await sp.getLaborRows('2026-01-01', '2026-01-02'); } catch (e) { err = e; }
    assert(/ECONNREFUSED/.test(err?.message || ''), 'en netværksfejl kaster');

    // 4) De øvrige indgange til Smartplan har samme regel.
    for (const fn of ['getShifts', 'getLaborRoster', 'getMembers']) {
        stubFetch(() => ({ ok: false, status: 429, text: async () => '{}' }));
        sp = freshAdapter(); err = null;
        try { await sp[fn]('2026-01-01', '2026-01-02'); } catch (e) { err = e; }
        assert(err !== null, `${fn} sluger heller ikke fejlen`);
    }

    // 5) En ægte tom periode er IKKE en fejl. Uden det her ville rettelsen bare
    //    have byttet én løgn ud med en anden.
    stubFetch(() => OK({ results: [], next: null }));
    sp = freshAdapter();
    const empty = await sp.getLaborRows('2026-01-01', '2026-01-02');
    assert(Array.isArray(empty) && empty.length === 0, 'en tom uge er stadig et gyldigt svar, ikke en fejl');

    // 6) En fejl må ikke lande i cachen. Gjorde den det, ville ét throttlet
    //    øjeblik holde vagtplanen tom i hele cache-vinduet bagefter.
    stubFetch(() => ({ ok: false, status: 429, text: async () => '{}' }));
    sp = freshAdapter();
    try { await sp.getLaborRows('2026-03-01', '2026-03-02'); } catch { /* forventet */ }
    let calls = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
        if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'acc-1' }] });
        calls++;
        return OK({ results: [], next: null });
    };
    await sp.getLaborRows('2026-03-01', '2026-03-02');
    assert(calls > 0, 'den fejlede forespørgsel blev ikke cachet — næste forsøg spørger igen');

    globalThis.fetch = realFetch;
}

/* ══ Del B — driften fryser ikke et tal den ikke kender ═════ */

const LABOR_ERROR = 'Smartplan begrænser antallet af kald (429)';
let laborShouldFail = true;
const lPath = require.resolve('../services/laborAdapter');
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor: async () => {
            if (laborShouldFail) throw new Error(LABOR_ERROR);
            return [{ employee_id: 'u1', employee_name: 'Kok', role_class: 'production', is_open: false,
                      location: 'Ristet Rug', location_class: 'hq', timer: 8, sats: 150, kostpris: 1200,
                      rate_missing: false, role_unmapped: false, mode: 'realiseret' }];
        },
        getLaborMap: async () => {
            if (laborShouldFail) throw new Error(LABOR_ERROR);
            return {};
        },
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
const req = async (method, u, body) => {
    const r = await fetch(BASE + u, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
};

const { todayISO, offsetISO } = require('../db/helpers');
const PAST = offsetISO(-30);   // afsluttet dag → kandidat til frysning

function seedDay(db, dato) {
    const st = (c) => db.prepare('SELECT id FROM status_definitions WHERE code=?').get(c).id;
    const pc = (c) => db.prepare('SELECT id FROM price_categories WHERE code=?').get(c)?.id;
    const id = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                          price_category_id, total_price, pax)
        VALUES (?,?,1,?,?,?,1000,10)
    `).run(`T_SPH_${dato}`, st('BETALT'), dato, dato, pc('catering') ?? null).lastInsertRowid);
    db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, cost_price)
                VALUES (?,'Tunen','01 Sandwich',10,'stk',100,1000,25)`).run(id);
}

async function partB() {
    const { getDb } = require('../db/database');
    const db = getDb();
    seedDay(db, PAST);
    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });

    const snapCount = () => db.prepare(
        'SELECT COUNT(*) AS n FROM labor_day_snapshot WHERE snapshot_date=?').get(PAST).n;

    console.log('\n— En afsluttet dag fryses ikke uden vagtplanen —');
    assert(snapCount() === 0, 'ingen snapshot til at begynde med');

    const d = (await req('GET', `/api/drift/day?date=${PAST}&mode=realiseret`)).data;
    assert(d.labor_error === LABOR_ERROR, 'fejlen står på svaret i stedet for at være væk');
    near(d.labor_ex_moms, 0, 'lønnen er 0 — men det er netop derfor den ikke må fryses');
    assert(d.frozen === false, 'dagen vises live, ikke som frosset');
    assert(snapCount() === 0, 'og INTET blev skrevet til labor_day_snapshot');

    console.log('\n— Snittet respekteres stadig på fejl-stien —');
    const ev = (await req('GET', `/api/drift/day?date=${PAST}&mode=realiseret&location=events`)).data;
    assert(ev.location === 'events', 'man får det snit man bad om, ikke hele huset');
    assert(ev.labor_error === LABOR_ERROR, '…med fejlen intakt');
    near(ev.bon_count, 0, '…og kun event-bonner (her: ingen)');
    assert(snapCount() === 0, 'et snit på fejl-stien fryser heller ikke');

    console.log('\n— En hel uge må ikke tie om manglende løn —');
    // Perioden henter løn i ÉT kald for hele intervallet. Fejler det, er lønnen
    // 0 kr på hver eneste dag — og en uge med "Løn 0 kr · 0 %" ser ud som om
    // ingen har arbejdet. Det var samme løgn som adapterens, én visning længere ude.
    const per = (await req('GET', `/api/drift/period?from=${PAST}&to=${PAST}&mode=realiseret`)).data;
    assert(per.labor_error === LABOR_ERROR, 'periode-svaret bærer fejlen');
    near(per.labor_missing_days, 1, 'og siger HVOR MANGE dage der mangler løn');
    assert((per.days || []).every(d => d.labor_error === LABOR_ERROR),
        'hver enkelt dag er mærket, så tabellen kan pege på de rigtige rækker');
    near(per.totals.labor_ex_moms, 0, 'lønnen er 0 i totalen — derfor advarslen');

    console.log('\n— Genberegning kan heller ikke fryse nullerne —');
    const rf = await req('POST', '/api/drift/refreeze', { date: PAST });
    assert(rf.status === 503, 'refreeze afvises med 503');
    assert(rf.data?.code === 'labor_unavailable', '…med en kode kalderen kan skelne på');
    assert(snapCount() === 0, 'stadig intet snapshot');

    console.log('\n— Og når Smartplan svarer igen, fryses dagen ═══════');
    laborShouldFail = false;
    const perOk = (await req('GET', `/api/drift/period?from=${PAST}&to=${PAST}&mode=realiseret`)).data;
    assert(!perOk.labor_error, 'perioden er ren igen når kilden svarer');
    near(perOk.labor_missing_days, 0, 'ingen dage mangler løn');

    const ok2 = (await req('GET', `/api/drift/day?date=${PAST}&mode=realiseret`)).data;
    assert(!ok2.labor_error, 'ingen fejl længere');
    near(ok2.labor_raw_ex_moms, 1200, 'lønnen er med');
    assert(ok2.frozen === true, 'dagen fryses nu');
    assert(snapCount() === 1, 'og snapshottet er skrevet');
    const stored = JSON.parse(db.prepare(
        'SELECT data_json FROM labor_day_snapshot WHERE snapshot_date=?').get(PAST).data_json);
    near(stored.labor_raw_ex_moms, 1200, 'det frosne bærer den rigtige løn, ikke et nul');
}

(async () => { await partA(); await partB(); })()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        globalThis.fetch = realFetch;
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
