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
    // Karantænen efter 429 er en ANDEN mekanisme end cachen. Nulstil den, så
    // dette scenarie måler dét det påstår at måle.
    sp._resetRateLimit();
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

/* ══ Del A2 — vi holder os selv under Smartplans grænse ═════ */

async function partA2() {
    console.log('\n— Vi rammer ikke loftet: 60 kald/min, 2000/dag —');

    // 1) Efter en 429 holder vi HELT op med at spørge til det tidspunkt
    //    Smartplan selv oplyser. Uden det forlænger vores egne forsøg
    //    blokeringen — målt i drift gik availableIn fra 161 til 243 sekunder.
    stubFetch(() => ({ ok: false, status: 429,
        text: async () => JSON.stringify({ availableIn: 120 }) }));
    let sp = freshAdapter();
    try { await sp.getLaborRows('2026-01-01', '2026-01-02'); } catch { /* forventet */ }
    const before = sp.getStats().requests;

    let hitNetwork = false;
    globalThis.fetch = async () => { hitNetwork = true; return OK({ results: [], next: null }); };
    let err = null;
    try { await sp.getLaborRows('2026-02-01', '2026-02-02'); } catch (e) { err = e; }
    assert(err !== null, 'næste opslag afvises lokalt i stedet for at spørge igen');
    assert(hitNetwork === false, '…og der gik IKKE et kald afsted — det er dét der forlænger straffen');
    assert(/vent/i.test(err?.message || ''), 'beskeden siger at vi venter med vilje');
    // KLOKKESLÆT, ikke "om N sekunder": beskeden bliver stående på skærmen, og
    // et relativt tal er forkert to minutter senere — så ville det se ud som om
    // vi hænger fast for evigt.
    assert(/til kl\. \d{2}[.:]\d{2}/.test(err?.message || ''), '…og hvornår vi må spørge igen, som et klokkeslæt');
    const q = sp.getStats();
    assert(/^\d{2}[.:]\d{2}$/.test(q.blocked_until_clock || ''), 'status bærer klokkeslættet i sig selv');
    // Smartplan sagde 120 sek; vi lægger et minuts margin oveni, fordi et
    // prøve-kald præcis ved udløb bliver afvist igen med det samme.
    assert(Math.abs(q.blocked_for_sec - 180) <= 2,
        `Smartplans 120 sek + 60 sek margin (fik ${q.blocked_for_sec}, ventede 180)`);
    assert(!Number.isNaN(Date.parse(q.blocked_until || '')), 'plus et absolut tidspunkt en visning kan tælle ned fra');
    assert(sp.getStats().requests === before, 'karantæne-kald tæller ikke som forbrug');
    assert(sp.getStats().blocked_for_sec > 0, 'status kan se at vi er i karantæne');

    // 1b) Gentagne afvisninger → vi holder os længere væk hver gang.
    //     Når karantænen udløber sender vi ét prøve-kald; får DET også 429,
    //     ville en fast ventetid betyde et evigt drop af prøve-kald der holder
    //     blokeringen åben. (Min egen poll-løkke gjorde præcis det i dag.)
    sp._resetRateLimit();
    stubFetch(() => ({ ok: false, status: 429, text: async () => '{}' }));   // uden availableIn
    const waits = [];
    for (let i = 0; i < 8; i++) {
        const d = String(i + 1).padStart(2, '0');
        try { await sp.getLaborRows('2026-06-' + d, '2026-06-' + d); } catch { /* forventet */ }
        waits.push(sp.getStats().blocked_for_sec);
        sp._expireQuarantine();        // lad som om ventetiden er gået
    }
    // PRÆCIS fordobling, ikke bare "voksende". Et løst krav bestod også når
    // strikes blev talt pr. kald i stedet for pr. karantæne — og så eskalerer
    // to mislykkede visninger til otte minutter.
    // Trappen fordobles — 60,120,240,480 — plus et minuts margin oveni, fordi
    // Smartplans eget availableIn ikke er nok: prøver vi præcis når det udløber,
    // bliver vi afvist igen med det samme.
    assert(waits.slice(0, 4).join(',') === '120,180,300,540',
        `ventetiden fordobles + margin (fik ${waits.slice(0, 4).join(',')})`);
    // Og den flader ud på loftet i stedet for at vokse i det uendelige.
    assert(waits[7] === 960 && waits[6] === 960,
        `loftet holder ved 900+60 sek (fik ${waits[6]},${waits[7]})`);

    // REGRESSION — dette er fejlen der ramte drift 23. august. En DELVIST
    // vellykket paginering må ikke nulstille trappen: side 1 lykkes, side 2
    // giver 429. Lå nulstillingen pr. side, stod backoff'en på 60 sekunder for
    // evigt mens afvisningerne blev ved med at stige — præcis det man så på
    // skærmen ("12 afvist ... 14 afvist", og stadig 1 minut).
    sp._resetRateLimit();
    let pcall = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
        if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'a' }] });
        if (u.includes('_p=1'))       return { ok: false, status: 429, text: async () => '{}' };
        pcall++;
        return OK({ results: [{ uuid: 'r' + pcall, planned_start_dt: '2026-01-01T08:00:00Z',
                                planned_end_dt: '2026-01-01T16:00:00Z' }], next: u + '&_p=1' });
    };
    const partial = [];
    for (let i = 0; i < 3; i++) {
        try { await sp.getLaborRows('2026-08-0' + (i + 1), '2026-08-0' + (i + 1)); } catch { /* forventet */ }
        partial.push(sp.getStats().blocked_for_sec);
        sp._expireQuarantine();
    }
    assert(partial[1] > partial[0] && partial[2] > partial[1],
        `delvis succes nulstiller ikke trappen (${partial.join(' → ')} sek)`);
    assert(pcall >= 3, '…og der lykkedes faktisk sider undervejs — ellers tester scenariet ikke sig selv');

    // Et FULDT vellykket opslag nulstiller straffen — ellers ville en enkelt
    // dårlig dag gøre systemet trægt resten af døgnet.
    sp._resetRateLimit();
    stubFetch(() => ({ ok: false, status: 429, text: async () => '{}' }));
    try { await sp.getLaborRows('2026-07-01', '2026-07-01'); } catch {}
    try { await sp.getLaborRows('2026-07-02', '2026-07-02'); } catch {}
    sp._expireQuarantine();
    stubFetch(() => OK({ results: [], next: null }));
    await sp.getLaborRows('2026-07-03', '2026-07-03');
    assert(sp.getStats().strikes === 0, 'et vellykket kald nulstiller backoff-trappen');

    // 2) Minut-grænsen: vi venter selv frem for at blive afvist.
    sp._resetRateLimit();
    let n = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
        if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'a' }] });
        n++;
        return OK({ results: [], next: null });
    };
    const st0 = sp.getStats();
    assert(st0.per_minute_limit <= 60, `vores egen grænse (${st0.per_minute_limit}) ligger under Smartplans 60`);
    assert(st0.per_day_limit <= 2000, `og dagsgrænsen (${st0.per_day_limit}) under 2000`);

    // Kør helt op til loftet uden at vente — et burst under grænsen skal være
    // gratis, ellers ville hver eneste sideindlæsning føles langsom. Ét
    // getShifts-opslag koster to kald (shifts + worklogs), så vi tæller på
    // forbruget i stedet for på antallet af opslag.
    const t0 = Date.now();
    // Hvert opslag skal have SIT eget datointerval — ellers svarer cachen, og
    // så måler vi cachen i stedet for grænsen. (Første forsøg gjorde præcis
    // det og nåede kun 18 af 48 kald.)
    const uniqueRange = (i) => {
        const mm = String((Math.floor(i / 28) % 12) + 1).padStart(2, '0');
        const dd = String((i % 28) + 1).padStart(2, '0');
        return [`2026-${mm}-${dd}`, `2026-${mm}-28`];
    };
    let guard = 0;
    while (sp.getStats().in_last_minute < st0.per_minute_limit - 2 && guard < 200) {
        const [f, t] = uniqueRange(guard++);
        await sp.getShifts(f, t);
    }
    const used = sp.getStats().in_last_minute;
    const burstMs = Date.now() - t0;
    assert(used >= st0.per_minute_limit - 3, `vi nåede helt op til grænsen (${used} kald) uden at blive afvist`);
    assert(burstMs < 3000, `og uden at vente undervejs (tog ${burstMs} ms)`);

    // Det NÆSTE opslag ville krydse grænsen. Så venter vi — eller siger klart
    // fra hvis ventetiden er urimelig. Det afgørende er at vi ikke bare
    // sender kaldet og lader Smartplan afvise os (og forlænge blokeringen).
    // Prøv videre til grænsen krydses. Antallet af opslag der skal til afhænger
    // af hvor præcist vi landede ovenfor, så vi looper i stedet for at regne
    // det ud — ellers ville testen knække af en harmløs justering af grænsen.
    let over = null, sentOnFailing = -1;
    const prevFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async (url) => { sent++; return prevFetch(url); };
    for (let i = 0; i < 6 && !over; i++) {
        const before = sent;
        try { await sp.getShifts(`2027-0${i + 1}-01`, `2027-0${i + 1}-02`); }
        catch (e) { over = e; sentOnFailing = sent - before; }
    }
    assert(over !== null && /minut/i.test(over.message), 'over grænsen siger vi selv fra, med en forklaring');
    assert(sentOnFailing === 0, '…og det afviste opslag sendte intet til Smartplan');

    // 3) HVILKEN grænse ramte? De to ligner hinanden i Smartplans besked, men
    //    kræver modsatte handlinger: minut-grænsen går over af sig selv om
    //    lidt, dagskvoten først i morgen. Bliver vi afvist efter en håndfuld
    //    kald, kan det ikke være minut-grænsen — og dét er den oplysning der
    //    manglede da driften stod med "8 kald på 5 minutter, stadig afvist".
    sp._resetRateLimit();
    stubFetch(() => ({ ok: false, status: 429, text: async () => '{}' }));
    try { await sp.getLaborRows('2026-09-01', '2026-09-01'); } catch { /* forventet */ }
    const dg = sp.getStats();
    assert(dg.likely_limit === 'daily',
        `få kald + afvist ⇒ dagskvoten, ikke minut-grænsen (fik ${dg.likely_limit})`);
    assert(dg.rate_at_throttle <= 5, `og vi kan se hvor travlt vi havde det (${dg.rate_at_throttle} kald)`);

    // Omvendt: bliver vi afvist mens vi RENT FAKTISK kører på grænsen, er det
    // minut-grænsen. Ellers ville rådet "prøv igen i morgen" være forkert.
    sp._resetRateLimit();
    let phase = 'ok';
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/o/token/'))  return OK({ access_token: 'tok', expires_in: 600 });
        if (u.endsWith('/accounts/')) return OK({ results: [{ uuid: 'a' }] });
        if (phase === 'deny') return { ok: false, status: 429, text: async () => '{}' };
        return OK({ results: [], next: null });
    };
    let g2 = 0;
    while (sp.getStats().in_last_minute < sp.getStats().per_minute_limit - 2 && g2 < 200) {
        const mm = String((Math.floor(g2 / 28) % 12) + 1).padStart(2, '0');
        const dd = String((g2++ % 28) + 1).padStart(2, '0');
        await sp.getShifts(`2028-${mm}-${dd}`, `2028-${mm}-28`);
    }
    phase = 'deny';
    try { await sp.getShifts('2029-01-01', '2029-01-02'); } catch { /* forventet */ }
    assert(sp.getStats().likely_limit === 'minute',
        `afvist mens vi kørte på grænsen ⇒ minut-grænsen (fik ${sp.getStats().likely_limit})`);

    // 4) Dagsgrænsen kan ikke overskrides.
    sp._resetRateLimit();
    const stats = sp.getStats();
    assert(stats.requestsToday === 0, 'dagstælleren nulstilles med resten');

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

/* ══ Del A3 — dags-forbruget overlever en genstart ══════════ */

async function partA3() {
    console.log('\n— Dags-tælleren overlever en genstart —');
    // Uden det er vores dagsgrænse ren dekoration: serveren genstartes ved hver
    // udrulning, og tælleren stod altid på nul. Dagskvoten på 2000 kunne derfor
    // brændes uden at noget sagde fra — hvilket er præcis hvad der skete.
    stubFetch(() => OK({ results: [], next: null }));
    let sp = freshAdapter();
    await sp.getLaborRows('2026-01-01', '2026-01-02');
    const before = sp.getStats().requestsToday;
    assert(before > 0, `der er talt kald op (${before})`);

    sp = freshAdapter();                       // "genstart" af serveren
    stubFetch(() => OK({ results: [], next: null }));
    await sp.getLaborRows('2026-02-01', '2026-02-02');
    const after = sp.getStats().requestsToday;
    assert(after > before, `tælleren fortsætter efter genstart (${before} → ${after})`);

    globalThis.fetch = realFetch;
}

(async () => { await partA(); await partA2(); await partA3(); await partB(); })()
    .catch(err => { console.error(err); fail++; })
    .finally(() => {
        globalThis.fetch = realFetch;
        if (server) server.close();
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
        console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
        process.exit(fail === 0 ? 0 : 1);
    });
