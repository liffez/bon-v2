// scripts/test-crm-planlagt.js
// ==========================================
// Integration- + migrations-test for CRM Planlagt aktivitet (Fase 1-4)
// + køkken-synlige påmindelser (migration 127).
//
// Spawner en frisk server mod en isoleret test-DB i /tmp så
// produktions-data forbliver urørt.
//
// Del A (in-process): migration 126 backfill-logik + migration 127-kolonne.
// Del B (HTTP):        POST /activity, PATCH /done, GET /planned, /followups,
//                      /flags show_in_kitchen, kitchen /today-filtrering.
//
// Kør:
//   node --experimental-sqlite scripts/test-crm-planlagt.js
//   (eller: npm run test:crm-planlagt hvis wired)
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-crmplan-${Date.now()}.db`);
const PORT = 4331;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      faktisk:  ', actual); fail++; }
}

// Lokal ISO-dato (undgår UTC-forskydning — matcher todayISO()).
function localISO(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function waitForServer(maxMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
function getCookieHeader() { return _cookies.join('; '); }
function captureCookies(res) { const s = res.headers.get('set-cookie'); if (s) _cookies = [s.split(';')[0]]; }
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const cookie = getCookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    captureCookies(res);
    let data = null; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    // ─── Seed: admin, kunder, firma, bons ─────────────────
    const TEST_PIN = '9999';
    const existing = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (existing) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, existing.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','ta@local','admin',?,1)`).run(TEST_PIN);
    const adminId = db.prepare(`SELECT id FROM users WHERE pin=? AND role='admin'`).get(TEST_PIN).id;

    const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code=? LIMIT 1`).get(code)?.id;
    const godkendt = statusId('GODKENDT') || db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get()?.id;

    const companyId = Number(db.prepare(`INSERT INTO companies (name) VALUES ('Testfirma A/S')`).run().lastInsertRowid);
    const custId = Number(db.prepare(`INSERT INTO customers (first_name,last_name,email,phone,company_id) VALUES ('Test','Kunde','tk@test.dk','+4512121212',?)`).run(companyId).lastInsertRowid);
    const custPrivat = Number(db.prepare(`INSERT INTO customers (first_name,last_name,phone) VALUES ('Privat','Person','+4534343434')`).run().lastInsertRowid);

    const mkBon = (num, date, sId) => Number(db.prepare(`
        INSERT INTO bons (bon_number,status_id,location_id,customer_id,company_id,order_date,delivery_date,delivery_type,pax)
        VALUES (?,?,?,?,?,?,?, 'delivery', 10)`).run(num, sId, locId, custId, companyId, localISO(-5), date).lastInsertRowid);
    const bonToday = mkBon('T-TODAY', localISO(0), godkendt);   // i køkken /today-vinduet
    const bonLater = mkBon('T-LATER', localISO(3), godkendt);   // i /later-vinduet

    // ════════════ DEL A — Migrations (in-process) ════════════
    console.log('\n═══ DEL A — Migrations ═══');

    // A1: migration 127 — show_in_kitchen kolonne + default 1
    console.log('\n=== Migration 127: entity_flags.show_in_kitchen ===');
    const cols = db.prepare(`PRAGMA table_info(entity_flags)`).all().map(c => c.name);
    assert(cols.includes('show_in_kitchen'), 'kolonnen show_in_kitchen findes');
    const fId = Number(db.prepare(`INSERT INTO entity_flags (entity_type,entity_id,title,created_by_user_id) VALUES ('customer',?,'A1-default',?)`).run(custId, adminId).lastInsertRowid);
    const fRow = db.prepare(`SELECT show_in_kitchen FROM entity_flags WHERE id=?`).get(fId);
    assertEqual(fRow.show_in_kitchen, 1, 'show_in_kitchen defaulter til 1');
    db.prepare(`DELETE FROM entity_flags WHERE id=?`).run(fId);

    // A2: migration 126 — backfill-logik (seed pre-migration state, kør UPDATE)
    console.log('\n=== Migration 126: done_at backfill ===');
    // Simulér rækker som FØR migrationen (done_at NULL). created_at sættes eksplicit i fortiden.
    const past = '2020-03-15 10:00:00';
    const mk = (fields) => Number(db.prepare(`INSERT INTO crm_activities (customer_id,type,text,due_at,done_at,result,created_at,owner_user_id) VALUES (?,?,?,?,?,?,?,?)`)
        .run(custId, fields.type || 'note', fields.text, fields.due_at || null, null, fields.result || null, past, adminId).lastInsertRowid);
    const aLogged   = mk({ text: 'A2-logget-note' });                         // due NULL, result NULL → skal backfilles
    const aCallback = mk({ text: 'A2-callback', result: 'callback' });        // callback → friholdes
    const aMeeting  = mk({ type: 'meeting', text: 'A2-møde', due_at: '2099-01-01 09:00' }); // due sat → friholdes

    const MIG126 = `UPDATE crm_activities SET done_at = created_at WHERE done_at IS NULL AND due_at IS NULL AND (result IS NULL OR result != 'callback')`;
    db.exec(MIG126);

    const get = (id) => db.prepare(`SELECT done_at, created_at FROM crm_activities WHERE id=?`).get(id);
    assert(get(aLogged).done_at === get(aLogged).created_at, 'T126.1 logget note → done_at = created_at');
    assertEqual(get(aCallback).done_at, null, 'T126.2 callback → done_at forbliver NULL');
    assertEqual(get(aMeeting).done_at, null, 'T126.3 møde (due_at sat) → done_at forbliver NULL');
    assert(db.prepare(`SELECT COUNT(*) c FROM crm_activities WHERE done_at IS NOT NULL`).get().c === 1, 'kun 1 række blev backfillet');

    // Ryd op så DEL B starter med tom crm_activities
    db.exec(`DELETE FROM crm_activities`);
    db.close();

    // ════════════ DEL B — HTTP endpoints ════════════
    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}…`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server-err] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke inden timeout');

        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        assert(login.status === 200 && login.data.role === 'admin', 'Login som admin');

        // ─── POST /activity — tilstands-grene (Fase 1) ───
        console.log('\n═══ DEL B — POST /activity ═══');
        const bNow = await http('POST', '/api/crm/activity', { customer_id: custId, type: 'note', text: 'B-lognu' });
        assert(bNow.status === 200, 'B1 log-nu → 200');
        const rNow = await http('GET', `/api/crm/planned?customer_id=${custId}`);
        // log-nu er IKKE planlagt (done_at sat) → ikke i /planned
        assert(!(rNow.data.planned || []).some(p => p.text === 'B-lognu'), 'B1 log-nu er ikke planlagt');

        const bPlan = await http('POST', '/api/crm/activity', { customer_id: custId, bon_id: bonToday, type: 'call', text: 'B-planlagt', due_at: localISO(1) + ' 09:00' });
        assert(bPlan.status === 200, 'B2 planlæg (fremtidig due_at) → 200');

        const bBack = await http('POST', '/api/crm/activity', { customer_id: custId, type: 'note', text: 'B-bagud', done_at: '2020-01-02' });
        assert(bBack.status === 200, 'B3 bagudrettet (done_at) → 200');

        const bBoth = await http('POST', '/api/crm/activity', { customer_id: custId, type: 'note', text: 'B-begge', due_at: '2099-01-01', done_at: '2020-01-01' });
        assertEqual(bBoth.status, 400, 'B4 både due_at OG done_at → 400');

        const bCb = await http('POST', '/api/crm/activity', { customer_id: custPrivat, type: 'service_call', result: 'callback', text: 'B-callback' });
        assert(bCb.status === 200, 'B5 callback → 200');

        // ─── GET /planned ───
        console.log('\n═══ GET /planned ═══');
        const planned = (await http('GET', `/api/crm/planned?customer_id=${custId}`)).data.planned || [];
        assert(planned.some(p => p.text === 'B-planlagt'), 'B-planlagt er i /planned');
        assert(!planned.some(p => p.text === 'B-bagud' || p.text === 'B-lognu'), 'bagudrettet + log-nu er IKKE i /planned');
        const plannedBon = (await http('GET', `/api/crm/planned?bon_id=${bonToday}`)).data.planned || [];
        assert(plannedBon.some(p => p.text === 'B-planlagt'), '/planned?bon_id filtrerer på bon');
        const plannedNoParam = await http('GET', '/api/crm/planned');
        assertEqual(plannedNoParam.status, 400, '/planned uden param → 400');

        // ─── PATCH /done — struktureret resultat (Fase 1) ───
        console.log('\n═══ PATCH /activity/:id/done ═══');
        const plannedId = planned.find(p => p.text === 'B-planlagt').id;
        const done = await http('PATCH', `/api/crm/activity/${plannedId}/done`, { result: 'reached', sentiment: 'positive', outcome: 'success', note: 'aftalt' });
        assert(done.status === 200, 'B6 complete → 200');
        const afterDone = (await http('GET', `/api/crm/planned?customer_id=${custId}`)).data.planned || [];
        assert(!afterDone.some(p => p.id === plannedId), 'udført forsvinder fra /planned');
        const badOutcome = await http('PATCH', `/api/crm/activity/${plannedId}/done`, { outcome: 'BOGUS' });
        assertEqual(badOutcome.status, 400, 'B7 ugyldig outcome → 400');

        // ─── GET /followups (Fase 4) ───
        console.log('\n═══ GET /followups ═══');
        // seed: en forfalden planlagt + en fremtidig planlagt + et møde
        await http('POST', '/api/crm/activity', { customer_id: custId, type: 'task', text: 'FU-forfalden', due_at: '2020-05-05 08:00' });
        await http('POST', '/api/crm/activity', { customer_id: custId, type: 'task', text: 'FU-fremtidig', due_at: localISO(30) + ' 09:00' });
        await http('POST', '/api/crm/activity', { customer_id: custId, type: 'meeting', text: 'FU-møde', due_at: '2020-06-01 09:00' });
        const fu = (await http('GET', '/api/crm/followups')).data.followups || [];
        assert(fu.some(f => f.text === 'FU-forfalden'), 'forfalden planlagt er i /followups');
        assert(fu.some(f => f.text === 'B-callback' && f.kilde === 'service'), 'callback er i /followups (kilde=service)');
        assert(!fu.some(f => f.text === 'FU-fremtidig'), 'fremtidig planlagt er IKKE i /followups');
        assert(!fu.some(f => f.text === 'FU-møde'), 'møde er IKKE i /followups');
        // sortering: forfaldne først
        const firstDue = fu[0];
        assert(firstDue && firstDue.due_at && firstDue.due_at < localISO(0), 'forfaldne først i /followups');

        // ─── Alder på callbacks (de har ingen due_at) ───
        console.log('\n═══ Alder + luk af gamle callbacks ═══');
        const db2 = openDb(TEST_DB);   // eget handle — det første blev lukket før server-spawn
        const cbRow = fu.find(f => f.kilde === 'service');
        assert(cbRow && cbRow.age_days !== undefined && cbRow.age_days !== null,
            'callbacks har age_days (uden det ser en 87 dage gammel ud som ny)');
        assert(cbRow && cbRow.created_at, '/followups returnerer created_at');
        // Gammel callback → skal markeres stale
        const oldCb = db2.prepare(`SELECT id FROM crm_activities WHERE result='callback' AND done_at IS NULL LIMIT 1`).get();
        db2.prepare(`UPDATE crm_activities SET created_at = date('now','-90 days') WHERE id = ?`).run(oldCb.id);
        const fuOld = (await http('GET', '/api/crm/followups')).data.followups || [];
        const aged = fuOld.find(f => f.id === oldCb.id);
        assert(aged && aged.age_days >= 89, `90 dage gammel callback rapporterer age_days (fik ${aged && aged.age_days})`);

        // Luk uden opfølgning: forsvinder fra listen MEN bevares i historikken
        const closeMe = fuOld.find(f => f.kilde === 'service');
        const closed = await http('PATCH', `/api/crm/activity/${closeMe.id}/done`, { note: 'Lukket uden opfølgning' });
        assert(closed.status === 200, 'luk uden opfølgning → 200');
        const fuAfter = (await http('GET', '/api/crm/followups')).data.followups || [];
        assert(!fuAfter.some(f => f.id === closeMe.id), 'lukket callback forsvinder fra /followups');
        const hist = db2.prepare(`SELECT done_at, text FROM crm_activities WHERE id = ?`).get(closeMe.id);
        assert(!!hist.done_at, 'lukket callback bevares med done_at (ikke slettet)');
        assert(/Lukket uden opfølgning/.test(hist.text), 'luk-noten er sporbar i historikken');

        // ─── /flags show_in_kitchen (Fase B) ───
        console.log('\n═══ /flags show_in_kitchen ═══');
        const fKitchen = await http('POST', '/api/flags', { entity_type: 'customer', entity_id: custId, title: 'KØKKEN-synlig', show_in_kitchen: 1 });
        const fOffice  = await http('POST', '/api/flags', { entity_type: 'customer', entity_id: custId, title: 'KONTOR-kun', show_in_kitchen: 0 });
        assert(fKitchen.status === 200 && fOffice.status === 200, 'flags oprettet');
        const flagsList = await http('GET', `/api/flags?entity_type=customer&entity_id=${custId}`);
        const kf = flagsList.data.find(f => f.title === 'KØKKEN-synlig');
        const of = flagsList.data.find(f => f.title === 'KONTOR-kun');
        assertEqual(kf.show_in_kitchen, 1, 'køkken-flag show_in_kitchen=1');
        assertEqual(of.show_in_kitchen, 0, 'kontor-flag show_in_kitchen=0');
        // PATCH kan ændre show_in_kitchen
        await http('PATCH', `/api/flags/${of.id}`, { show_in_kitchen: 1 });
        const ofAfter = (await http('GET', `/api/flags?entity_type=customer&entity_id=${custId}`)).data.find(f => f.id === of.id);
        assertEqual(ofAfter.show_in_kitchen, 1, 'PATCH ændrer show_in_kitchen → 1');
        await http('PATCH', `/api/flags/${of.id}`, { show_in_kitchen: 0 }); // tilbage til kontor-kun

        // ─── kitchen /today + /bons/:id flag-levering ───
        console.log('\n═══ kitchen /today filtrering ═══');
        const today = (await http('GET', '/api/bons/today')).data;
        const kbon = today.find(b => b.id === bonToday);
        assert(!!kbon, 'test-bon er i /today');
        const kflags = (kbon.kitchen_flags || []).map(f => f.title);
        assert(kflags.includes('KØKKEN-synlig'), '/today kitchen_flags indeholder køkken-synlig');
        assert(!kflags.includes('KONTOR-kun'), '/today kitchen_flags udelader kontor-kun');
        // office /bons/:id får BEGGE med show_in_kitchen
        const detail = (await http('GET', `/api/bons/${bonToday}`)).data;
        const dflags = (detail.flags || []);
        assert(dflags.some(f => f.title === 'KØKKEN-synlig') && dflags.some(f => f.title === 'KONTOR-kun'), 'office /bons/:id har begge flags');
        assert(dflags.every(f => f.show_in_kitchen === 0 || f.show_in_kitchen === 1), 'office flags har show_in_kitchen-felt');

        // ─── briefing-tæller (Fase 4 §4.4) ───
        console.log('\n═══ briefing "opfølgninger i dag" ═══');
        const briefing = (await http('GET', '/api/crm/briefing')).data;
        assert(Array.isArray(briefing) && briefing.some(b => /opfølgning/.test(b.text)), 'briefing har "opfølgninger i dag"-punkt');
        // aktivitets-opsummerings-punktet linker til Ringelisten (nav)
        const wkItem = briefing.find(b => /Denne uge|Ingen aktiviteter/.test(b.text));
        assert(wkItem && wkItem.nav === 'ringeliste', 'briefing aktivitets-punkt har nav=ringeliste');

        // ─── Firma 360° — aktivitet aggregeret via firmaets kunder ───
        console.log('\n═══ GET /company/:id aktivitet (firma-aggregering) ═══');
        // Aktivitet på firmaets kontaktperson (custId har company_id = companyId)
        await http('POST', '/api/crm/activity', { customer_id: custId, type: 'note', text: 'FIRMA-A' });
        const co = (await http('GET', `/api/crm/company/${companyId}`)).data;
        const coActs = co.activities || [];
        assert(Array.isArray(coActs) && coActs.length > 0, 'firma-endpoint returnerer aktiviteter');
        assert(coActs.some(a => a.text === 'FIRMA-A'), 'aktivitet fra firmaets kunde er med');
        assert(coActs.every(a => a.type === 'dismissed_flag' || a.customer_name), 'hver aktivitet har customer_name (hvem den lå på)');
        // privatkundens aktivitet (uden company_id) må IKKE lække ind
        assert(!coActs.some(a => a.text === 'B-callback'), 'aktivitet fra kunde UDEN firma lækker ikke ind');

        // dismissed firma-flag → syntetisk læse-only række (fase 7-paritet)
        const cf = await http('POST', '/api/flags', { entity_type: 'company', entity_id: companyId, title: 'FIRMAFLAG-test' });
        await http('POST', `/api/flags/${cf.data.id}/dismiss`, { note: 'ordnet' });
        const co2 = (await http('GET', `/api/crm/company/${companyId}`)).data;
        const flagRow = (co2.activities || []).find(a => a.type === 'dismissed_flag');
        assert(!!flagRow, 'dismissed firma-flag vises som syntetisk række');
        assert(flagRow && flagRow.note === 'ordnet', 'dismiss-note følger med');
        assert(flagRow && flagRow.customer_name === null, 'firma-flag har ingen customer_name (hører til firmaet)');

        // ─── To typer påmindelser: firma-flag OG kunde-flag ───
        console.log('\n═══ Begge påmindelses-typer (firma + kunde) ═══');
        // Aktivt firma-flag skal ses på kontaktpersonens kundekort (den hejses
        // på hendes bons — uden dette viste vi historikken men ikke det aktuelle)
        await http('POST', '/api/flags', { entity_type: 'company', entity_id: companyId, title: 'FIRMAFLAG-aktiv' });
        const kFlags = (await http('GET', `/api/crm/customer/${custId}`)).data.flags || [];
        assert(kFlags.some(f => f.title === 'FIRMAFLAG-aktiv' && f.entity_type === 'company'),
            'aktivt FIRMA-flag vises på kontaktpersonens kundekort');
        assert(kFlags.every(f => f.entity_type === 'customer' || f.entity_type === 'company'),
            'flags på kundekort har entity_type så UI kan markere "på firmaet"');
        // Privatkunde (uden firma) må ikke få firmaets flag
        const pFlags = (await http('GET', `/api/crm/customer/${custPrivat}`)).data.flags || [];
        assert(!pFlags.some(f => f.entity_type === 'company'), 'kunde uden firma får ikke firma-flag');

        // Dismissed KUNDE-flag skal med i FIRMAETS tidslinje (begge typer)
        const kf2 = await http('POST', '/api/flags', { entity_type: 'customer', entity_id: custId, title: 'KUNDEFLAG-test' });
        await http('POST', `/api/flags/${kf2.data.id}/dismiss`, { note: 'klaret' });
        const co3 = (await http('GET', `/api/crm/company/${companyId}`)).data;
        const rows = (co3.activities || []).filter(a => a.type === 'dismissed_flag');
        const kundeFlagRow = rows.find(a => /KUNDEFLAG-test/.test(a.text));
        assert(!!kundeFlagRow, 'dismissed KUNDE-flag vises i firmaets tidslinje');
        assert(kundeFlagRow && !!kundeFlagRow.customer_name, 'kunde-flag i firma-tidslinje har customer_name (hvem)');
        assert(rows.some(a => a.customer_name === null), 'firma-flag i samme tidslinje har customer_name = null');

    } finally {
        if (serverProc) serverProc.kill('SIGTERM');
    }

    // ─── Oprydning ───
    try { fs.rmSync(TEST_DB, { force: true }); fs.rmSync(TEST_DB + '-journal', { force: true }); fs.rmSync(TEST_DB + '-wal', { force: true }); fs.rmSync(TEST_DB + '-shm', { force: true }); } catch {}

    console.log(`\n═══════════════════════════════════`);
    console.log(`  ${pass} PASS · ${fail} FAIL`);
    console.log(`═══════════════════════════════════`);
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
