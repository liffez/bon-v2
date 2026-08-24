// scripts/test-event-shift-assign.js
// ============================================================
// To events samme weekend må ikke tælle de samme lønkroner.
//
// Eventets løn hentes på dato + lokation (§18.3, Model A). Kører to events
// samtidig, ser de BEGGE alle vagter på event-lokationen, og begge P&L'er
// tæller det samme. Fejlen er usynlig i tallet: begge ser rigtige ud.
//
// Smartplan kan ikke svare på det. Der er én event-lokation, og noten er
// fritekst til medarbejderen — målt 24. august 2026 var 366 af 417 vagter uden
// note, og de 51 med blandede sted, sygemelding og arbejdsbesked ("der skal
// laves 49 slidere i alt :-)"). To vagter dækkede oven i købet to steder
// ("I HQ 8-11 og Tivoli bagefter"). Feltet bruges rigtigt og skal ikke kapres.
//
// Derfor fordeles vagterne i Bon. Invarianten:
//
//     En fordelt vagt tælles PRÆCIS ét sted.
//
// Kør:  node --experimental-sqlite scripts/test-event-shift-assign.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-shiftassign-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
const near = (a, b, msg, eps = 0.02) => assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`);

// Løn-kilden stubbes: vi tester fordelingen, ikke Smartplan.
const DATO = '2026-08-22';
const SHIFTS = [
    { uuid: 'a1', source: 'shift', employee_id: 'u1', employee_name: 'Anne', role_class: 'production',
      is_open: false, location: 'Festivaler og Events', location_class: 'events',
      timer: 8, sats: 150, kostpris: 1200, rate_missing: false, role_unmapped: false, mode: 'realiseret' },
    { uuid: 'b2', source: 'shift', employee_id: 'u2', employee_name: 'Leif', role_class: 'production',
      is_open: false, location: 'Festivaler og Events', location_class: 'events',
      timer: 10, sats: 145, kostpris: 1450, rate_missing: false, role_unmapped: false, mode: 'realiseret' },
    { uuid: 'c3', source: 'shift', employee_id: 'u3', employee_name: 'Marie', role_class: 'production',
      is_open: false, location: 'Festivaler og Events', location_class: 'events',
      timer: 6, sats: 150, kostpris: 900, rate_missing: false, role_unmapped: false, mode: 'realiseret' },
];
const lPath = require.resolve('../services/laborAdapter');
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor: async () => SHIFTS.map(r => ({ ...r })),
        getLaborMap: async () => ({ [DATO]: SHIFTS.map(r => ({ ...r })) }),
        // Bruges af standardtiderne (transport/opsætning). Fast sats, så
        // testen måler fordelingen og ikke gennemsnitsberegningen.
        getStandardHourlyRate: () => ({ rate: 150, count: 3 }),
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
const req = async (method, u, body) => {
    const r = await fetch(BASE + u, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
};

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

    const mk = (navn) => Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES (?,?, 'light', ?, ?, 'active')
    `).run(navn, locId, DATO, DATO).lastInsertRowid);
    const VIG = mk('Vig Festival');
    const SMUK = mk('Smukfest');

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });
    const labor = async (id) => (await req('GET', `/api/events/${id}/labor`)).data;

    /* ── 1) Uden fordeling: begge tæller alt ─────────────────── */
    console.log('\n— Uden fordeling tælles de samme kroner to steder —');
    const a0 = await labor(VIG), b0 = await labor(SMUK);
    const onsite = (l) => l.sources.find(s => s.kind === 'onsite');
    near(onsite(a0).cost, 3550, 'Vig tæller alle tre vagter');
    near(onsite(b0).cost, 3550, 'Smukfest tæller de samme');
    assert(a0.warnings.some(w => /Smukfest.*samtidig/.test(w)),
        'og der ADVARES om at de kører samtidig');
    assert(a0.warnings.some(w => /BEGGE events/.test(w)), '…og at kronerne tælles begge steder');
    near(a0.overlapping_events.length, 1, 'det overlappende event er navngivet');
    near(onsite(a0).shifts.length, 3, 'vagterne er med i svaret, så de kan fordeles');
    assert(onsite(a0).shifts.every(s => !s.is_assigned), 'ingen er fordelt endnu');

    /* ── 2) Fordeling: hver krone tælles ét sted ─────────────── */
    console.log('\n— Fordelt: præcis ét sted —');
    await req('PUT', `/api/events/${VIG}/labor/shift/a1`,  { source: 'shift', event_id: VIG });
    await req('PUT', `/api/events/${VIG}/labor/shift/b2`,  { source: 'shift', event_id: SMUK });
    await req('PUT', `/api/events/${VIG}/labor/shift/c3`,  { source: 'shift', event_id: VIG });

    const a1 = await labor(VIG), b1 = await labor(SMUK);
    near(onsite(a1).cost, 2100, 'Vig: Anne + Marie');
    near(onsite(b1).cost, 1450, 'Smukfest: Leif');
    near(onsite(a1).cost + onsite(b1).cost, 3550, 'og summen er weekendens rigtige løn — hverken mere eller mindre');
    near(onsite(a1).hours + onsite(b1).hours, 24, 'timerne går også op');
    assert(a1.warnings.some(w => /alle vagter er fordelt/.test(w)), 'advarslen skifter til "alle fordelt"');

    /* ── 3) "Intet event" er et gyldigt svar ─────────────────── */
    // Fx en HQ-vagt der ligger forkert på event-lokationen. Den skal kunne
    // tages helt ud — ikke tvinges over på et event den ikke hører til.
    console.log('\n— En vagt kan høre til ingen af dem —');
    await req('PUT', `/api/events/${VIG}/labor/shift/c3`, { source: 'shift', event_id: null });
    const a2 = await labor(VIG), b2 = await labor(SMUK);
    near(onsite(a2).cost, 1200, 'Vig: kun Anne');
    near(onsite(b2).cost, 1450, 'Smukfest: uændret');
    assert(onsite(a2).shifts.find(s => s.uuid === 'c3').is_assigned === true,
        'og vagten står som fordelt — ikke som "ikke taget stilling"');
    assert(onsite(a2).shifts.find(s => s.uuid === 'c3').counted === false, '…men tæller ikke med');

    /* ── 4) Fortryd ──────────────────────────────────────────── */
    console.log('\n— Fortryd fører tilbage til standarden —');
    await req('PUT', `/api/events/${VIG}/labor/shift/c3`, { source: 'shift', reset: true });
    const a3 = await labor(VIG), b3 = await labor(SMUK);
    near(onsite(a3).cost, 2100, 'Vig tæller Marie igen');
    near(onsite(b3).cost, 2350, '…og det gør Smukfest også — uafklaret betyder begge');
    assert(a3.warnings.some(w => /ikke fordelt/.test(w)), 'og advarslen er tilbage');

    /* ── 5) Et event der IKKE overlapper, kan ikke få vagten ── */
    console.log('\n— Man kan ikke fordele til et event der ikke var i gang —');
    const SENERE = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Efterårsmarked', ?, 'light', '2026-11-01', '2026-11-01', 'active')
    `).run(locId).lastInsertRowid);
    const bad = await req('PUT', `/api/events/${VIG}/labor/shift/a1`, { source: 'shift', event_id: SENERE });
    near(bad.status, 400, 'afvises');
    assert(/overlapper ikke/.test(bad.data?.error || ''), '…med en forklaring man kan handle på');

    /* ── 6) Ét event alene er upåvirket ──────────────────────── */
    // Langt de fleste weekender har ét event. Dér må intet ændre sig.
    console.log('\n— Ét event alene: uændret adfærd —');
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(SMUK);
    db.prepare('DELETE FROM event_shift_assignments').run();
    const solo = await labor(VIG);
    near(onsite(solo).cost, 3550, 'alle vagter tæller med');
    near(solo.overlapping_events.length, 0, 'intet overlap');
    assert(!solo.warnings.some(w => /samtidig/.test(w)), 'og ingen advarsel om samtidighed');
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
