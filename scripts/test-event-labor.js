// scripts/test-event-labor.js
// ============================================================
// Løn på eventet, "den billige model" (§18.3–§18.5).
//
// To kilder: Smartplan-vagter på event-lokationen (målt) + standard-timer fra
// settings for det vagtplanen ikke dækker (transport, op-/nedtagning, trailer).
// Ingen tabel — alt beregnes live, som top-up-forslaget og event-menuen.
//
// Kører in-process mod isoleret temp-DB. Smartplan og ORS stubbes i
// require-cachen: begge er netværkskald, og de tilfælde der betyder mest —
// en vagt uden timeløn, en adresse der ikke kan geokodes, en vagtplan der er
// nede — kan kun fremprovokeres med en attrap. Route-handleren er ÆGTE.
//
// Kør:  node --experimental-sqlite scripts/test-event-labor.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-eventlabor-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
function near(a, b, msg, eps = 0.02) { assert(Math.abs((a ?? NaN) - b) < eps, `${msg} (fik ${a}, ventede ${b})`); }

/* ── Attrapper ────────────────────────────────────────────── */

let SP_ROWS = {};        // { 'YYYY-MM-DD': [labor-rækker] }
let SP_THROWS = null;
let ORS_RESULT = { distance_m: 30000, duration_s: 1800 };   // 30 km / 0,5 t
let ORS_THROWS = null;

const lPath = require.resolve('../services/laborAdapter');
const realLabor = require(lPath);
require.cache[lPath] = {
    id: lPath, filename: lPath, loaded: true, exports: {
        getLabor: async () => [],
        getLaborMap: async () => { if (SP_THROWS) throw new Error(SP_THROWS); return SP_ROWS; },
        // getStandardHourlyRate er ÆGTE — den læser wage_rates, og fallbacken
        // "tom sats → gennemsnittet" er en af de regler vi vil teste.
        getStandardHourlyRate: realLabor.getStandardHourlyRate,
    },
};

const rPath = require.resolve('../services/routing');
require.cache[rPath] = {
    id: rPath, filename: rPath, loaded: true, exports: {
        getDistance: async () => { if (ORS_THROWS) throw new Error(ORS_THROWS); return ORS_RESULT; },
    },
};

const gPath = require.resolve('../services/grocyAdapter');
require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true, exports: {
        getProducts: async () => [], getQuantityUnits: async () => [], getStock: async () => [],
        getRecipes: async () => [], getProductUnitCosts: async () => new Map(), addToStock: async () => ({}),
    },
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const express = require('express');
const app = express();
app.use(express.json());
let ROLE = 'admin';
app.use((req, _res, next) => { req.session = { userId: 1, userRole: ROLE }; next(); });
app.use('/api/events', require('../routes/events'));

let server, BASE;
const get = async (u, method = 'GET') => {
    const r = await fetch(BASE + u, { method, headers: { 'Content-Type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
};
const http = async (method, u, body) => {
    const r = await fetch(BASE + u, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
};

const DATO = '2026-09-20';
const vagt = (over = {}) => ({
    employee_id: 'emp-1', employee_name: 'Sofie', jobtype_uuid: 'jt', jobtype_title: 'Salg',
    role_class: 'production', location: 'Festivaler og Events', location_class: 'events',
    start: '08:00', slut: '16:00', timer: 8, sats: 150, kostpris: 1200,
    rate_missing: false, role_unmapped: false, used_fallback_hours: false, mode: 'realiseret',
    ...over,
});

async function main() {
    const { getDb } = require('../db/database');
    const db = getDb();
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get().id;

    // Adresse + HQ-koordinater, så køretiden kan udledes
    const addrId = Number(db.prepare(
        `INSERT INTO addresses (street_name, postal_code, city, lat, lon) VALUES ('Testvej 1','4690','Haslev',55.32,11.96)`
    ).run().lastInsertRowid);
    const evId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status, event_address_id)
        VALUES ('Løn-test', ?, 'light', ?, ?, 'active', ?)
    `).run(locId, DATO, DATO, addrId).lastInsertRowid);

    // Standard-satser: 2 t op + 2 t ned + 2×0,5 t trailer, 2 personer, 200 kr/t
    const set = (k, v) => db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(v), k);
    set('event_labor_setup_hours', 2);
    set('event_labor_teardown_hours', 2);
    set('event_labor_trailer_hours', 0.5);
    set('event_labor_default_persons', 2);
    set('event_labor_owner_rate', 200);
    set('labor_overhead_pct', 0);

    await new Promise(r => { server = app.listen(0, () => { BASE = `http://localhost:${server.address().port}`; r(); }); });

    // ── 1) De to kilder lægges sammen ────────────────────────────────────
    console.log('\n— Vagtplan + standard-timer —');
    SP_ROWS = { [DATO]: [vagt(), vagt({ employee_id: 'emp-2', employee_name: 'Jonas' })] };
    let d = (await get(`/api/events/${evId}/labor`)).data;

    const kind = (k) => d.sources.find(s => s.kind === k);
    near(kind('onsite').hours, 16, 'to vagter à 8 t på pladsen');
    near(kind('onsite').cost, 2400, 'og deres løn fra wage_rates via vagt-rækken');
    near(kind('setup').hours, 4, 'opsætning: 2 t × 2 personer');
    near(kind('teardown').hours, 4, 'nedtagning: 2 t × 2 personer');
    near(kind('trailer').hours, 2, 'trailer tælles BEGGE veje: 2 × 0,5 t × 2 personer');
    near(kind('transport').hours, 2, 'transport: 2 × 0,5 t kørsel × 2 personer');
    assert(kind('transport').note.includes('30 km'), 'køretiden er udledt af adressen, og det siges');
    near(d.hours_total, 16 + 4 + 4 + 2 + 2, 'mandetimer i alt');
    near(d.cost_total, 2400 + (12 * 200), 'løn i alt = vagtplan + standard-timer × sats');

    // ── 2) Timer og kroner er to tal ─────────────────────────────────────
    console.log('\n— Timer ≠ kroner —');
    SP_ROWS = { [DATO]: [vagt(), vagt({ employee_id: 'friv', employee_name: 'Frivillig', sats: null, kostpris: null, rate_missing: true })] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').hours, 16, 'en vagt uden timeløn tæller stadig som TIMER på pladsen');
    near(kind('onsite').cost, 1200, 'men bidrager 0 kr — vi gætter ikke på en sats');
    assert(d.warnings.some(w => /mangler en timeløn/.test(w) && /Frivillig/.test(w)),
        'og det siges, med navn — ellers ser lønnen bare lav ud');

    // ── 3) Bud hører ikke til her ────────────────────────────────────────
    console.log('\n— Afgrænsninger —');
    SP_ROWS = { [DATO]: [vagt(), vagt({ employee_id: 'bud', role_class: 'delivery', kostpris: 999 })] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').hours, 8, 'bud-vagter er ude (afregnes separat, som i driften)');

    SP_ROWS = { [DATO]: [vagt(), vagt({ employee_id: 'hq', location: 'Ristet Rug', location_class: 'hq', kostpris: 999 })] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').hours, 8, 'HQ-vagter er ude — de bliver i driftsregnskabet (§18.7)');

    // ── 4) Overhead som i driften ────────────────────────────────────────
    console.log('\n— Overhead —');
    set('labor_overhead_pct', 15);
    SP_ROWS = { [DATO]: [vagt()] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').cost, 1200 * 1.15, 'vagtplanens løn får arbejdsgiver-tillæg');
    near(kind('setup').cost, 4 * 200 * 1.15, 'og standard-timerne får præcis samme faktor');
    set('labor_overhead_pct', 0);

    // ── 5) Tom sats → gennemsnittet af de registrerede ───────────────────
    console.log('\n— Sats-fallback —');
    set('event_labor_owner_rate', '');
    db.prepare(`INSERT INTO wage_rates (smartplan_ref, employee_name, hourly_rate, valid_from) VALUES ('a','A',100,'2020-01-01')`).run();
    db.prepare(`INSERT INTO wage_rates (smartplan_ref, employee_name, hourly_rate, valid_from) VALUES ('b','B',200,'2020-01-01')`).run();
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(d.rate, 150, 'tom sats → snittet af de registrerede timelønninger');
    assert(d.rate_source === 'snit', 'og kilden oplyses, så tallet kan efterprøves');
    set('event_labor_owner_rate', 200);

    // ── 6) Køretid der ikke kan udledes ──────────────────────────────────
    console.log('\n— Køretid —');
    ORS_THROWS = 'ORS nede';
    d = (await get(`/api/events/${evId}/labor`)).data;
    assert(!d.sources.find(s => s.kind === 'transport'), 'ingen transport-linje når køretiden er ukendt');
    assert(d.warnings.some(w => /IKKE talt med/.test(w)), 'og det siges — 0 timer ville se ud som en sandhed');

    set('event_labor_transport_hours', 1.5);
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('transport').hours, 6, 'nødplanen fra Settings bruges: 2 × 1,5 t × 2 personer');
    assert(d.transport_source === 'setting', 'og kilden er mærket som fast tal, ikke beregnet');
    set('event_labor_transport_hours', '');
    ORS_THROWS = null;

    // ── 7) Vagtplanen nede må ikke vælte tallet ──────────────────────────
    console.log('\n— Degradering —');
    SP_THROWS = 'Smartplan timeout';
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').hours, 0, 'ingen vagt-timer når vagtplanen ikke svarer');
    assert(kind('setup').hours > 0, 'men standard-timerne står stadig — de kommer fra vores egen base');
    assert(d.warnings.some(w => /Vagtplanen kunne ikke hentes/.test(w)), 'og fejlen siges');
    SP_THROWS = null;

    // ── 8) Resultatet ────────────────────────────────────────────────────
    console.log('\n— Resultat på pladsen —');
    SP_ROWS = { [DATO]: [vagt()] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(d.result_on_site, d.result_before_labor - d.cost_total,
        'resultat på pladsen = resultat før løn − lønnen');
    assert(d.is_estimate === true, 'svaret siger selv at det er et estimat');

    // ── 9) Løn er rolle-gated ────────────────────────────────────────────
    console.log('\n— Adgang —');
    ROLE = 'kitchen';
    assert((await get(`/api/events/${evId}/labor`)).status === 403,
        'køkkenrollen får 403 — gaten ligger på serveren, ikke i frontenden');
    ROLE = 'office';
    assert((await get(`/api/events/${evId}/labor`)).status === 200, 'office må se lønnen');
    ROLE = 'admin';
    assert((await get(`/api/events/${evId}/labor`)).status === 200, 'det må admin også');
    assert((await get(`/api/events/${evId}/overview`)).status === 200,
        '/overview er urørt — den er åben for alle roller og bærer ikke løn');

    // ── 9b) Vagterne kan efterprøves enkeltvis ───────────────────────────
    // Et samlet timetal kan man ikke se en fejl i. Er der en vagt for meget
    // eller for lidt, opdages det kun ved at kigge på listen — så den skal
    // bære nok til at man kan genkende sin egen dag.
    console.log('\n— Vagtplanen bag tallet —');
    SP_ROWS = { [DATO]: [
        vagt({ employee_name: 'Sofie', start: '12:00' }),
        vagt({ employee_id: 'emp-2', employee_name: 'Jonas', start: '08:00', sats: null, kostpris: null, rate_missing: true }),
    ] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    const sh = kind('onsite').shifts || [];
    assert(sh.length === 2, 'begge vagter kommer med enkeltvis');
    assert(sh[0].employee_name === 'Jonas', 'sorteret på mødetid — 08:00 før 12:00');
    assert(sh[0].start === '08:00' && sh[0].slut === '16:00', 'mødetid og sluttid med');
    assert(sh[0].jobtype_title === 'Salg', 'jobtypen med, så vagten kan genkendes');
    near(sh[1].hours, 8, 'timer pr. vagt');
    near(sh[1].cost, 1200, 'og kroner pr. vagt');
    assert(sh[0].cost === null && sh[0].rate_missing === true,
        'vagten uden timeløn har ingen kroner — og siger hvorfor');

    // Bud og HQ-vagter skal heller ikke dukke op i LISTEN, ikke kun i summen.
    SP_ROWS = { [DATO]: [
        vagt(),
        vagt({ employee_id: 'bud', employee_name: 'Bud', role_class: 'delivery' }),
        vagt({ employee_id: 'hq', employee_name: 'HQ-kok', location_class: 'hq' }),
    ] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    const navne = (kind('onsite').shifts || []).map(x => x.employee_name);
    assert(navne.length === 1 && navne[0] === 'Sofie',
        'listen viser præcis de vagter der tælles — ikke bud, ikke HQ');

    // Planlagt vs. fremmødt skal kunne skelnes: et tal der bygger på en
    // forventning må ikke se ud som en måling.
    SP_ROWS = { [DATO]: [vagt({ used_fallback_hours: true })] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    assert(kind('onsite').shifts[0].planned_only === true,
        'vagt uden registreret fremmøde markeres som planlagt');

    // ── 9c) Frivillige koster 0 — og det er ikke en manglende sats ────────
    // De frivillige står i Smartplan, så deres TIMER blev talt med hele tiden.
    // Det der var galt, var at 0 kr og "vi har glemt at taste satsen" så helt
    // ens ud. Nu er den ene et svar og den anden en advarsel.
    console.log('\n— Frivillige —');
    SP_ROWS = { [DATO]: [
        vagt({ employee_name: 'Sofie' }),
        // Sådan ser rækken ud NÅR den kommer fra laborAdapter: sats 0, ikke null,
        // og rate_missing false. Selve reglen testes i tests/labor_location.test.js.
        vagt({ employee_id: 'friv', employee_name: 'Walter', jobtype_uuid: 'jt-friv',
               jobtype_title: 'Frivillig', role_class: 'volunteer', sats: 0, kostpris: 0 }),
        vagt({ employee_id: 'glemt', employee_name: 'Emilie', sats: null, kostpris: null, rate_missing: true }),
    ] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('onsite').hours, 24, 'den frivilliges timer tæller med — hun stod der jo');
    near(kind('onsite').cost, 1200, 'men koster 0 kr; kun Sofies løn tælles');

    const friv = kind('onsite').shifts.find(x => x.employee_name === 'Walter');
    assert(friv.role_class === 'volunteer', 'vagten er mærket frivillig');
    near(friv.cost, 0, '0 kr er et SVAR, ikke null — vi ved hvad hun koster');
    assert(friv.rate_missing === false, 'og det er ikke en manglende sats');

    // Den ægte advarsel må ikke drukne i de frivillige.
    assert(d.warnings.some(w => /mangler en timeløn/.test(w) && /Emilie/.test(w)),
        'den ansatte uden sats advares der stadig om');
    assert(!d.warnings.some(w => /Walter/.test(w)),
        'men den frivillige nævnes IKKE — ellers er advarslen bare støj');


    // ── 9d) Standard-timerne kan rettes for ét event ─────────────────────
    // Settings er et udgangspunkt, ikke et facit: kranen kan være i stykker,
    // eller pladsen ligge fem minutter væk. Uden en vej til at rette det er
    // tallet enten forkert eller ubrugt.
    console.log('\n— Rettelse af standard-timer —');
    ROLE = 'admin';
    SP_ROWS = { [DATO]: [] };
    d = (await get(`/api/events/${evId}/labor`)).data;
    const opsFør = kind('setup').hours;
    near(opsFør, 4, 'standard: 2 t × 2 pers.');

    let r = await http('PUT', `/api/events/${evId}/labor/setup`, { hours: 5, persons: 3, note: 'kranen var i stykker' });
    assert(r.status === 200, 'rettelsen gemmes');
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('setup').hours, 15, 'rettet: 5 t × 3 pers.');
    assert(kind('setup').overridden === true, 'linjen er mærket som rettet');
    assert(/kranen/.test(kind('setup').note || ''), 'og noten følger med, så tallet kan forsvares');
    near(kind('teardown').hours, 4, 'de andre linjer er urørte');

    // En rettelse ERSTATTER sin linje — den lægges ikke ved siden af.
    assert(d.sources.filter(x => x.kind === 'setup').length === 1, 'kun én opsætnings-linje');

    // Nul timer er et gyldigt svar og skal kunne SES.
    await http('PUT', `/api/events/${evId}/labor/trailer`, { hours: 0, persons: 2 });
    d = (await get(`/api/events/${evId}/labor`)).data;
    assert(kind('trailer') && kind('trailer').hours === 0,
        'rettet til 0 timer vises stadig — ellers ser det ud som om rettelsen forsvandt');

    // Tilbage til standarden er sin EGEN handling, ikke en magisk værdi.
    r = await http('PUT', `/api/events/${evId}/labor/setup`, { reset: true });
    assert(r.status === 200 && r.data.reset === true, 'rettelsen kan fjernes');
    d = (await get(`/api/events/${evId}/labor`)).data;
    near(kind('setup').hours, opsFør, 'og linjen er tilbage på Settings-standarden');
    assert(!kind('setup').overridden, 'mærket er væk');

    // Validering + adgang
    assert((await http('PUT', `/api/events/${evId}/labor/vrøvl`, { hours: 1 })).status === 400,
        'ukendt linje afvises');
    assert((await http('PUT', `/api/events/${evId}/labor/setup`, { hours: -1 })).status === 400,
        'negative timer afvises');
    ROLE = 'kitchen';
    assert((await http('PUT', `/api/events/${evId}/labor/setup`, { hours: 1 })).status === 403,
        'køkkenrollen må ikke rette lønnen');
    ROLE = 'admin';
    await http('PUT', `/api/events/${evId}/labor/trailer`, { reset: true });

    // ── 10) Frys ved 'done' ──────────────────────────────────────────────
    console.log('\n— Frys —');
    ROLE = 'admin';
    SP_ROWS = { [DATO]: [vagt()] };
    let live = (await get(`/api/events/${evId}/labor`)).data;
    assert(live.frozen === false, 'et aktivt event er ikke frosset');
    near(live.hours_total, 8 + 4 + 4 + 2 + 2, 'og viser de aktuelle timer');

    db.prepare("UPDATE events SET status='done' WHERE id=?").run(evId);
    const frozen1 = (await get(`/api/events/${evId}/labor`)).data;
    assert(frozen1.frozen === true, 'et afsluttet event fryses ved første visning');
    assert(!!frozen1.frozen_at, 'og tidspunktet oplyses');
    assert(db.prepare('SELECT COUNT(*) n FROM event_labor_snapshot WHERE event_id=?').get(evId).n === 1,
        'snapshottet er skrevet');

    // Vagtplanen ændrer sig BAGEFTER — det er hele grunden til at fryse.
    SP_ROWS = { [DATO]: [vagt(), vagt({ employee_id: 'ny', timer: 12, kostpris: 1800 })] };
    const frozen2 = (await get(`/api/events/${evId}/labor`)).data;
    near(frozen2.hours_total, frozen1.hours_total, 'en vagt rettet bagefter flytter IKKE det frosne tal');
    near(frozen2.cost_total, frozen1.cost_total, 'heller ikke kronerne');

    // ── 11) Resultatet er live, også når lønnen er frosset ───────────────
    console.log('\n— Resultatet følger med —');
    // Bogføres et retur bagefter (§18.9), ændrer vareforbruget sig. Var
    // resultatet også frosset, ville lønvisningen modsige /overview.
    const before = frozen2.result_before_labor;
    // Flyt P&L'en gennem det ægte endpoint — en udgiftsbon på 500 kr ex moms.
    await fetch(BASE + `/api/events/${evId}/bons`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'expense', delivery_date: DATO, lines: [
            { product_name: 'Stadeleje', quantity: 1, unit: 'stk', unit_price: 500, moms_included: 0 },
        ] }),
    });
    const efter = (await get(`/api/events/${evId}/labor`)).data;
    near(efter.result_before_labor, before - 500, 'resultatet følger en udgift bogført bagefter');
    near(efter.hours_total, frozen1.hours_total, 'mens lønnen står frosset');
    near(efter.result_on_site, efter.result_before_labor - efter.cost_total, 'og de to regnes sammen live');

    // ── 12) Genberegning ─────────────────────────────────────────────────
    console.log('\n— Genberegn —');
    ROLE = 'office';
    assert((await get(`/api/events/${evId}/labor/refreeze`, 'POST')).status === 403,
        'office må ikke genberegne — kun admin');
    ROLE = 'admin';
    const re = (await get(`/api/events/${evId}/labor/refreeze`, 'POST')).data;
    near(re.hours_total, 12 + 8 + 12, 'genberegning tager den NYE vagtplan (8+12 t på pladsen + 12 t standard)');
    assert(re.frozen === true, 'og resultatet er frosset igen');
    near((await get(`/api/events/${evId}/labor`)).data.hours_total, re.hours_total,
        'næste visning giver det genberegnede tal');

    // ── 13) Vi fryser aldrig et tal vi ved er forkert ────────────────────
    console.log('\n— Vagtplanen nede —');
    db.prepare('DELETE FROM event_labor_snapshot WHERE event_id=?').run(evId);
    SP_THROWS = 'Smartplan timeout';
    const nede = (await get(`/api/events/${evId}/labor`)).data;
    assert(nede.frozen === false, 'et afsluttet event fryses IKKE når vagtplanen er nede');
    assert(db.prepare('SELECT COUNT(*) n FROM event_labor_snapshot WHERE event_id=?').get(evId).n === 0,
        'intet snapshot skrevet — "0 timer fordi Smartplan var nede" må aldrig blive permanent');
    assert((await get(`/api/events/${evId}/labor/refreeze`, 'POST')).status === 503,
        'og genberegning afvises af samme grund');
    SP_THROWS = null;

    // ── 14) Genåbnet event viser live tal igen ───────────────────────────
    console.log('\n— Genåbnet —');
    await get(`/api/events/${evId}/labor`);            // fryser igen
    db.prepare("UPDATE events SET status='active' WHERE id=?").run(evId);
    SP_ROWS = { [DATO]: [vagt({ timer: 3, kostpris: 450 })] };
    // NB: `kind()` læser closure-variablen `d`. Her skal vi bruge det friske
    // svar, ellers måler assertionen et tal fra en tidligere sektion.
    d = (await get(`/api/events/${evId}/labor`)).data;
    const genaabnet = d;
    assert(genaabnet.frozen === false, 'et genåbnet event viser live tal igen');
    near(kind('onsite').hours, 3, 'og følger vagtplanen');
    assert(db.prepare('SELECT COUNT(*) n FROM event_labor_snapshot WHERE event_id=?').get(evId).n === 1,
        'snapshottet bliver liggende — det tages i brug igen når eventet lukkes');
}


main()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
