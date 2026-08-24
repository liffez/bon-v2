// scripts/test-smartplan-mirror.js
// ============================================================
// Vagtplanen læses fra et lokalt spejl — læsning må ALDRIG ramme Smartplan.
//
// Baggrund (23.-24. august 2026): seks kaldesteder hentede hver for sig, og
// fire skærme hentede ved HVER SSE-hændelse. Kald-frekvensen var en funktion af
// hvor mange skærme der stod tændt. Cachen opslugte det så længe alt virkede —
// men cachen fyldes kun ved succes, så i det sekund Smartplan fejlede,
// forsvandt vores eneste bremse, og hvert opslag blev til et rigtigt kald igen.
// Throttlingen holdt sig selv i live.
//
// Invarianten der bærer den nye model:
//
//     LÆSNING KOSTER NUL UDGÅENDE KALD. Kun synkroniseringen taler med nettet.
//
// Kør:  node --experimental-sqlite scripts/test-smartplan-mirror.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-spmirror-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
process.env.SMARTPLAN_CLIENT_ID     = 'test-id';
process.env.SMARTPLAN_CLIENT_SECRET = 'test-secret';

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
const near = (a, b, msg) => assert(a === b, `${msg} (fik ${a}, ventede ${b})`);

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { offsetISO, todayISO } = require('../db/helpers');

/* ── Attrap af Smartplan ─────────────────────────────────── */

const OK = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
let netCalls = 0;
let mode = 'ok';                 // 'ok' | 'throttled'

function shiftRec(uuid, date, name, loc, jobtype) {
    return {
        uuid, display_date: date,
        owner: { uuid: 'u-' + name, first_name: name, last_name: 'Test' },
        jobtype: { uuid: jobtype || 'jt-1', title: 'Salgsassistent' },
        location: { title: loc },
        planned_start_dt: `${date}T08:00:00Z`,
        planned_end_dt:   `${date}T16:00:00Z`,
        planned_shift_duration: 8 * 3600,
    };
}

let SHIFTS = [];
let WORKLOGS = [];

globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
    if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'acc' }] });
    netCalls++;
    if (mode === 'throttled') return { ok: false, status: 429, text: async () => '{}' };
    if (u.includes('/shifts/'))   return OK({ results: SHIFTS,   next: null });
    if (u.includes('/worklogs/')) return OK({ results: WORKLOGS, next: null });
    return OK({ results: [], next: null });
};

const smartplan = require('../services/smartplanAdapter');
const sync      = require('../services/smartplanSync');

const D1 = offsetISO(1), D2 = offsetISO(2);

async function main() {
    const db = getDb();

    /* ── 1) Synkronisering fylder spejlet ─────────────────── */
    console.log('\n— Synkroniseringen henter, og kun den —');
    SHIFTS   = [shiftRec('s1', D1, 'Anne', 'Ristet Rug'),
                shiftRec('s2', D1, 'Leif', 'Festivaler og Events')];
    WORKLOGS = [shiftRec('w1', D2, 'Marie', 'Ristet Rug')];

    netCalls = 0;
    const r1 = await sync.syncNow('test');
    assert(r1.ok, 'synkroniseringen lykkedes');
    near(r1.rows, 3, 'tre vagter skrevet til spejlet');
    assert(netCalls > 0, `og den brugte nettet (${netCalls} kald)`);
    near(db.prepare('SELECT COUNT(*) AS n FROM smartplan_shifts').get().n, 3, 'rækker i spejlet');

    /* ── 2) INVARIANTEN: læsning koster nul kald ──────────── */
    console.log('\n— Læsning koster nul udgående kald —');
    netCalls = 0;
    for (let i = 0; i < 25; i++) {          // 25 "SSE-genindlæsninger"
        smartplan.getShifts(D1, D2);
        smartplan.getLaborRows(D1, D1);
    }
    near(netCalls, 0, '50 opslag → nul kald til Smartplan');

    const shifts = smartplan.getShifts(D1, D2);
    near(shifts.length, 3, 'og de leverer stadig data');

    /* ── 3) Lokations-snittet udledes ved LÆSNING ─────────── */
    // Rå records gemmes; klassificeringen sker ved læsning. Derfor slår et
    // skift af HQ-lokation igennem med det samme — uden at synkronisere om.
    console.log('\n— HQ-indstillingen slår igennem uden ny synkronisering —');
    const before = smartplan.getLaborRows(D1, D1).filter(r => r.location_class === 'hq').length;
    near(before, 1, 'Ristet Rug tæller som HQ');
    db.prepare("UPDATE settings SET value = 'Festivaler og Events' WHERE key = 'smartplan_hq_location'").run();
    smartplan.clearCache();
    netCalls = 0;
    const after = smartplan.getLaborRows(D1, D1).filter(r => r.location_class === 'hq').length;
    near(after, 1, 'efter skift er det den ANDEN vagt der er HQ');
    assert(smartplan.getLaborRows(D1, D1).find(r => r.employee_name.startsWith('Leif')).location_class === 'hq',
        '…og det er Leifs festival-vagt');
    near(netCalls, 0, 'skiftet kostede nul kald');
    db.prepare("UPDATE settings SET value = 'Ristet Rug' WHERE key = 'smartplan_hq_location'").run();
    smartplan.clearCache();

    /* ── 3b) De to endpoints navngiver tiden forskelligt ──── */
    // Målt på 423 rigtige vagter (24. august 2026):
    //
    //            start_dt   planned_start_dt
    //   shift      76/76          0/76
    //   worklog     0/347       347/347
    //
    // Timerne var upåvirkede (varigheden ligger i planned_shift_duration begge
    // steder), men klokkeslættene forsvandt på PLANLAGTE vagter — eventets
    // lønpanel viste "8 t" uden at sige hvornår. Et timetal man ikke kan
    // efterprøve er svært at stole på.
    console.log('\n— Planlagt vagt beholder sine klokkeslæt —');
    SHIFTS = [{
        uuid: 'ft1', display_date: D1,
        owner: { uuid: 'u-ft', first_name: 'Planlagt', last_name: 'Vagt' },
        jobtype: { uuid: 'jt-1', title: 'Salgsassistent' },
        location: { title: 'Ristet Rug' },
        start_dt: `${D1}T08:00:00`, end_dt: `${D1}T16:00:00`,   // ingen planned_start_dt
        planned_shift_duration: 8 * 3600,
    }];
    WORKLOGS = [{
        uuid: 'wl1', display_date: D2,
        owner: { uuid: 'u-wl', first_name: 'Arkiveret', last_name: 'Vagt' },
        jobtype: { uuid: 'jt-1', title: 'Salgsassistent' },
        location: { title: 'Ristet Rug' },
        planned_start_dt: `${D2}T09:00:00`, planned_end_dt: `${D2}T17:00:00`,   // ingen start_dt
        planned_shift_duration: 8 * 3600,
    }];
    await sync.syncNow('test-tider');
    const alle = smartplan.getLaborRows(D1, D2);
    const pl = alle.find(r => r.employee_name?.startsWith('Planlagt'));
    const ar = alle.find(r => r.employee_name?.startsWith('Arkiveret'));
    assert(pl?.planned_start === '08:00' && pl?.planned_end === '16:00',
        `planlagt vagt har klokkeslæt fra start_dt (fik ${pl?.planned_start}–${pl?.planned_end})`);
    near(pl?.planned_hours, 8, 'og timerne er uændrede');
    assert(ar?.planned_start === '09:00' && ar?.planned_end === '17:00',
        `arkiveret vagt bruger stadig planned_start_dt (fik ${ar?.planned_start}–${ar?.planned_end})`);

    // Gendan udgangspunktet for de følgende scenarier.
    SHIFTS   = [shiftRec('s1', D1, 'Anne', 'Ristet Rug'),
                shiftRec('s2', D1, 'Leif', 'Festivaler og Events')];
    WORKLOGS = [shiftRec('w1', D2, 'Marie', 'Ristet Rug')];
    await sync.syncNow('test-gendan');

    /* ── 4) En fejlet synkronisering tømmer ikke spejlet ──── */
    // Gamle tal er uendeligt meget bedre end ingen tal. Det var netop dét der
    // gik galt før: en fejl gav "0 vagter" i stedet for "vagtplanen er fra i går".
    console.log('\n— En fejlet synkronisering bevarer det vi har —');
    mode = 'throttled';
    smartplan._resetRateLimit();
    const r2 = await sync.syncNow('test-fejl');
    assert(!r2.ok, 'synkroniseringen fejlede');
    assert(/429|begrænser/i.test(r2.error || ''), '…med Smartplans egen forklaring');
    near(db.prepare('SELECT COUNT(*) AS n FROM smartplan_shifts').get().n, 3, 'spejlet står urørt');
    near(smartplan.getShifts(D1, D2).length, 3, 'og vagtplanen kan stadig læses');
    const st = sync.getSyncState();
    assert(!!st.last_error, 'fejlen står i sync-state');
    assert(!!st.last_success_at, '…ved siden af hvornår det sidst lykkedes');
    mode = 'ok';
    smartplan._resetRateLimit();

    /* ── 5) Aflyste vagter forsvinder ─────────────────────── */
    console.log('\n— En aflyst vagt bliver ikke stående —');
    SHIFTS = [shiftRec('s1', D1, 'Anne', 'Ristet Rug')];   // s2 aflyst
    const r3 = await sync.syncNow('test-prune');
    assert(r3.ok, 'ny synkronisering lykkedes');
    near(r3.pruned, 1, 'én vagt fjernet fra spejlet');
    near(smartplan.getShifts(D1, D2).length, 2, 'og den er væk i læsningen');

    /* ── 6) Afbryderen standser ALT udgående ──────────────── */
    console.log('\n— Afbryderen —');
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'smartplan_enabled'").run();
    smartplan.clearCache();
    netCalls = 0;
    const r4 = await sync.syncNow('test-slukket');
    assert(!r4.ok && /slået fra/i.test(r4.skipped || ''), 'synkronisering springes over');
    near(netCalls, 0, 'og der går intet kald afsted');
    near(smartplan.getShifts(D1, D2).length, 2, 'men vagtplanen kan stadig LÆSES fra spejlet');

    // Afbryderen skal sidde i PORTEN, ikke kun på synk-vejen. Ellers ville en
    // anden indgang — fx løn-importens roster-opslag — stadig kunne kalde ud
    // mens vi tror alt er standset. (Første udgave af testen ramte kun synken,
    // og en mutation der fjernede porten slap derfor igennem.)
    netCalls = 0;
    let blocked = null;
    try { await smartplan.getLaborRoster(offsetISO(-30)); } catch (e) { blocked = e; }
    assert(blocked !== null, 'også løn-importens opslag afvises');
    assert(/slået fra/i.test(blocked?.message || ''), '…med afbryderen som forklaring');
    near(netCalls, 0, 'og der gik intet kald afsted ad DEN vej heller');

    db.prepare("UPDATE settings SET value = '1' WHERE key = 'smartplan_enabled'").run();
    smartplan.clearCache();

    /* ── 7) Hvem ringede? ─────────────────────────────────── */
    console.log('\n— Afsender på hvert kald —');
    netCalls = 0;
    await sync.syncNow('test-afsender');
    const calls = smartplan.getRecentCalls(10);
    assert(calls.length > 0, 'kaldene er registreret');
    assert(calls.every(c => /sync:/.test(c.caller)),
        `og de bærer afsenderen (${calls[0] && calls[0].caller})`);
    assert(calls.some(c => /shifts|worklogs/.test(c.path)), '…og hvilken sti der blev kaldt');

    /* ── 8) Forældelse siges højt ─────────────────────────── */
    console.log('\n— Forældet er en oplysning, ikke en fejl —');
    const fresh = sync.getSyncState();
    assert(fresh.stale === false, 'lige synkroniseret ⇒ ikke forældet');
    db.prepare("UPDATE smartplan_sync_state SET last_success_at = ? WHERE id = 1")
      .run(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());   // utc-ok: test
    const old = sync.getSyncState();
    assert(old.stale === true, 'seks timer gammelt ⇒ forældet');
    assert(old.age_min >= 350, `og alderen kan aflæses (${old.age_min} min)`);
}

main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        sync.stopScheduler();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
