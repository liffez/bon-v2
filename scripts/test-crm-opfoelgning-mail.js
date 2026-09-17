// scripts/test-crm-opfoelgning-mail.js
// ============================================================
// Opfølgning på service-kald/ringeliste + mail som rigtig handling.
//
// To kørselsformer, fordi de to halvdele kræver hver sit:
//   HTTP (spawnet server, isoleret temp-DB) — opfølgningens tilstandsmodel,
//     GET /followups, dedupe i /service-calls og /rytme, kampagne-pipelinens
//     kontaktfelter. Rammer de ÆGTE endpoints, ikke query-spejle.
//   IN-PROCESS (ægte routes/customers.js, SMTP stubbet i require-cachen) —
//     POST /api/customers/:id/mail. Uden stub kan afsendelsen ikke prøves,
//     og så ville email_out-logningen aldrig blive kørt af en test.
//
// Kør:
//   node --experimental-sqlite scripts/test-crm-opfoelgning-mail.js
// ============================================================

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-crmfu-${Date.now()}.db`);
const PORT = 4336;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}
// En assert der KASTER er et dårligere signal end en der fejler: mutationstest
// ser en stak-udskrift og tror testen er i stykker. Pak opslag ind.
function check(fn, msg) {
    try { assert(!!fn(), msg); }
    catch (e) { assert(false, msg + ' [kastede: ' + e.message + ']'); }
}

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, {
        method, headers, body: body == null ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

const iso = (offsetDays) => {
    const d = new Date(); d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);
    const userId = (db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get()).id;

    // ── Fixtures ─────────────────────────────────────────────
    const coId = Number(db.prepare(`INSERT INTO companies (name) VALUES ('Novo Test A/S')`).run().lastInsertRowid);
    const cuId = Number(db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone, company_id)
        VALUES ('Dagny','Jensen','dagny@example.invalid','12345678',?)`).run(coId).lastInsertRowid);
    db.prepare(`INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, 'active')`).run(cuId);

    // Kunde nr. 2 til rytme-dedupe (så de to ikke forstyrrer hinanden)
    const cu2 = Number(db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone, company_id)
        VALUES ('Bent','Bentsen','bent@example.invalid','22222222',?)`).run(coId).lastInsertRowid);
    db.prepare(`INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, 'active')`).run(cu2);

    const levId = db.prepare(`SELECT id FROM status_definitions WHERE code='LEVERET'`).get().id;
    const locId = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get().id;
    const bonId = Number(db.prepare(`
        INSERT INTO bons (bon_number, customer_id, company_id, status_id, location_id, order_date, delivery_date, is_internal, total_price)
        VALUES ('T-FU-1', ?, ?, ?, ?, ?, ?, 0, 1000)`).run(cuId, coId, levId, locId, iso(-3), iso(-2)).lastInsertRowid);

    // Rytme-fixture: 6 ordrer med 10 dages mellemrum, sidste for 20 dage siden
    // → snit 10, days_since 20 = 2× → inden for [1.3×, 3×].
    for (let i = 0; i < 6; i++) {
        db.prepare(`
            INSERT INTO bons (bon_number, customer_id, company_id, status_id, location_id, order_date, delivery_date, is_internal, total_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 500)`)
          .run('T-RY-' + i, cu2, coId, levId, locId, iso(-71 + i * 10), iso(-70 + i * 10));
    }

    // Kampagne + medlem (pipeline-felterne)
    const campId = Number(db.prepare(`
        INSERT INTO outreach_campaigns (name, is_active) VALUES ('Gratis frokost til 2', 1)`).run().lastInsertRowid);
    db.prepare(`INSERT INTO campaign_members (campaign_id, company_id, customer_id) VALUES (?,?,?)`)
      .run(campId, coId, cuId);
    db.close();

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc.stdout.on('data', () => {});
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [srv] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        if (login.status !== 200) throw new Error('Login fejlede: ' + login.status);

        /* ══ 1. Opfølgningen er en planlagt række ved siden af opkaldet ══ */
        console.log('\n— Opfølgning: planlagt række, ikke et felt på opkaldet —');

        const call = await http('POST', '/api/crm/activity', {
            customer_id: cuId, bon_id: bonId, type: 'service_call',
            result: 'reached', sentiment: 'positive', text: 'Alt gik godt',
        });
        assert(call.status === 200, 'service-kaldet logges');

        const fuDate = iso(14);
        const fu = await http('POST', '/api/crm/activity', {
            customer_id: cuId, bon_id: bonId, type: 'followup',
            text: 'Ring igen efter ferien', due_at: fuDate,
        });
        assert(fu.status === 200, 'opfølgningen logges som selvstændig aktivitet');

        const planned = await http('GET', `/api/crm/planned?customer_id=${cuId}`);
        const rows = (planned.data && planned.data.planned) || [];
        check(() => rows.length === 1, 'præcis én åben planlagt aktivitet');
        check(() => rows[0].type === 'followup', 'den planlagte er af typen followup');
        check(() => String(rows[0].due_at).startsWith(fuDate), 'due_at er den valgte dato');

        // Opkaldet må IKKE være planlagt — de to tilstande kan ikke bo i samme række.
        const acts = (await http('GET', `/api/crm/customer/${cuId}`)).data.activities || [];
        check(() => {
            const c = acts.find(a => a.type === 'service_call');
            return c && c.done_at && !c.due_at;
        }, 'opkaldet er udført (done_at sat, ingen due_at)');
        check(() => {
            const f = acts.find(a => a.type === 'followup');
            return f && !f.done_at && f.due_at;
        }, 'opfølgningen er planlagt (due_at sat, ingen done_at)');

        // Serveren afviser at være begge dele på én gang
        const both = await http('POST', '/api/crm/activity', {
            customer_id: cuId, type: 'followup', text: 'x', due_at: iso(3), done_at: iso(-3),
        });
        assert(both.status === 400, 'due_at + done_at på samme række afvises');

        /* ══ 2. Opfølgningen lander på dashboardets liste når den forfalder ══ */
        console.log('\n— Opfølgningen serveres på dagen —');

        let f = (await http('GET', '/api/crm/followups')).data.followups || [];
        check(() => !f.some(x => x.id === fu.data.id), 'en opfølgning 14 dage ude vises ikke endnu');

        const dueNow = await http('POST', '/api/crm/activity', {
            customer_id: cuId, type: 'followup', text: 'Forfalden i dag', due_at: iso(0),
        });
        f = (await http('GET', '/api/crm/followups')).data.followups || [];
        check(() => f.some(x => x.id === dueNow.data.id), 'en opfølgning der forfalder i dag vises');
        check(() => (f.find(x => x.id === dueNow.data.id) || {}).kilde === 'planlagt',
            'den mærkes som "planlagt" (ikke service-callback)');

        /* ══ 3. Kampagne-kortet har kontaktdata at handle på ══ */
        console.log('\n— Kampagne-kortet bærer kontaktdata —');
        const pipe = await http('GET', `/api/campaigns/pipeline?campaign_id=${campId}`);
        const member = (pipe.data.columns.lead.members || [])[0];
        check(() => !!member, 'medlemmet er på tavlen');
        check(() => member.customer_phone === '12345678', 'telefonnummeret følger med kortet');
        check(() => member.customer_email === 'dagny@example.invalid', 'mailadressen følger med kortet');
        check(() => 'marketing_consent' in member && 'do_not_contact' in member,
            'samtykke-felterne følger med (så man ikke ringer til en der har frabedt sig det)');

        const campAct = await http('POST', '/api/crm/activity', {
            customer_id: cuId, type: 'call', result: 'reached',
            text: 'Ringet fra kampagnen', campaign_id: campId,
        });
        assert(campAct.status === 200, 'aktivitet fra kampagne-kortet logges');
        const pipe2 = await http('GET', `/api/campaigns/pipeline?campaign_id=${campId}`);
        check(() => !!(pipe2.data.columns.lead.members[0].last_activity_at),
            'kampagne-medlemmets last_activity_at opdateres');

        /* ══ 4. Rytme-listen dedupe'r nu på formål ══ */
        console.log('\n— Rytme-listen glemmer ikke at man har ringet —');
        let rytme = (await http('GET', '/api/crm/rytme')).data || [];
        check(() => rytme.some(r => r.customer_id === cu2), 'den forsinkede kunde står på rytme-listen');
        check(() => {
            const r = rytme.find(x => x.customer_id === cu2);
            return r && r.email === 'bent@example.invalid' && r.first_name === 'Bent';
        }, 'rækken bærer mail + fornavn (mail-knappen og skabelonerne skal bruge dem)');

        const purposes = (await http('GET', '/api/activity-purposes')).data;
        const rytmePurpose = (Array.isArray(purposes) ? purposes : purposes.purposes || [])
            .find(p => p.key === 'fast_rytme');
        check(() => !!rytmePurpose, 'formålet fast_rytme findes (migration 123)');

        await http('POST', '/api/crm/activity', {
            customer_id: cu2, type: 'call', result: 'reached',
            text: 'Talt om fast levering', purpose_id: rytmePurpose.id,
        });
        rytme = (await http('GET', '/api/crm/rytme')).data || [];
        check(() => !rytme.some(r => r.customer_id === cu2),
            'efter et logget rytme-opkald forsvinder kunden fra listen');

        // Kontrolprøve: et opkald med et ANDET formål må ikke skjule rytme-emnet.
        const otherPurpose = (Array.isArray(purposes) ? purposes : purposes.purposes || [])
            .find(p => p.key !== 'fast_rytme');
        const cu3 = (await http('POST', '/api/customers', {
            first_name: 'Carla', last_name: 'Carlsen', company_id: coId, phone: '33333333',
        })).data;
        check(() => !!cu3 && !!cu3.id, 'kontrol-kunde oprettet');

        /* ══ 5. Service-kald: en mail på bonen tæller som håndteret ══ */
        console.log('\n— Service-kald: dedupe dækker også mail —');
        const bon2 = (await http('POST', '/api/bons', {
            customer_id: cu3.id, company_id: coId, delivery_date: iso(-1), pax: 10,
        })).data;
        check(() => !!bon2 && !!bon2.id, 'test-bon oprettet');
        await http('PATCH', `/api/bons/${bon2.id}/status`, { status_code: 'LEVERET', force: true });

        let svc = (await http('GET', '/api/crm/service-calls?days=7')).data || [];
        check(() => svc.some(x => x.bon_id === bon2.id), 'den leverede bon står som ventende service-kald');
        check(() => {
            const r = svc.find(x => x.bon_id === bon2.id);
            return r && r.first_name === 'Carla';
        }, 'rækken bærer fornavnet (skabelon-variabler i mail-knappen)');

        await http('POST', '/api/crm/activity', {
            customer_id: cu3.id, bon_id: bon2.id, type: 'email_out', text: 'Mail sendt: Tak for i går',
        });
        svc = (await http('GET', '/api/crm/service-calls?days=7')).data || [];
        check(() => !svc.some(x => x.bon_id === bon2.id),
            'en email_out på bonen fjerner service-kaldet fra listen');

        // Kontrolprøve: en email_out UDEN bon_id må ikke skjule et andet service-kald.
        const bon3 = (await http('POST', '/api/bons', {
            customer_id: cu3.id, company_id: coId, delivery_date: iso(-1), pax: 4,
        })).data;
        await http('PATCH', `/api/bons/${bon3.id}/status`, { status_code: 'LEVERET', force: true });
        await http('POST', '/api/crm/activity', {
            customer_id: cu3.id, type: 'email_out', text: 'Mail uden bon',
        });
        svc = (await http('GET', '/api/crm/service-calls?days=7')).data || [];
        check(() => svc.some(x => x.bon_id === bon3.id),
            'en mail uden bon_id skjuler IKKE et andet service-kald');

    } finally {
        if (serverProc) serverProc.kill();
        await new Promise(r => setTimeout(r, 400));
    }

    /* ══ 6. Mail-afsendelse logger email_out (in-process, SMTP stubbet) ══ */
    console.log('\n— Mail-afsendelse skriver en aktivitet —');
    await mailSection(TEST_DB, userId, cuId, bonId, campId);

    try { fs.unlinkSync(TEST_DB); } catch {}
    for (const suf of ['-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

// Den ÆGTE routes/customers.js mod en stubbet mailService. Uden stub kræver
// endpointet SMTP, og så ville email_out-logningen aldrig blive prøvet.
async function mailSection(dbPath, userId, customerId, bonId, campaignId) {
    process.env.DB_PATH = dbPath;
    const express = require('express');

    const mailService = require('../services/mailService');
    const sent = [];
    let shouldThrow = false;
    mailService.sendMail = async (args) => {
        if (shouldThrow) throw new Error('SMTP nede');
        sent.push(args);
        return { messageId: 'stub-' + sent.length, threadId: 1 };
    };
    // renderTemplate er ægte, men {{booking_link}} kræver settings vi ikke har i
    // testen; vi sender ikke tokenet, så den er upåvirket.

    delete require.cache[require.resolve('../routes/customers')];
    const customersRouter = require('../routes/customers');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId, userRole: 'admin' }; next(); });
    app.use('/api/customers', customersRouter);

    const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    const base = 'http://localhost:' + server.address().port;
    const post = async (url, body) => {
        const r = await fetch(base + url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        let d = null; try { d = await r.json(); } catch {}
        return { status: r.status, data: d };
    };

    const { openDb } = require('../db/compat');
    const db = openDb(dbPath);
    const countEmailOut = () => db.prepare(
        `SELECT COUNT(*) n FROM crm_activities WHERE customer_id=? AND type='email_out'`).get(customerId).n;
    const before = countEmailOut();

    try {
        const r1 = await post(`/api/customers/${customerId}/mail`, {
            to: 'dagny@example.invalid', subject: 'Gratis frokost til 2', text: 'Hej Dagny',
        });
        assert(r1.status === 200, 'mailen sendes');
        check(() => r1.data.activity_logged === true, 'svaret siger at aktiviteten blev skrevet');
        check(() => countEmailOut() === before + 1, 'en email_out-aktivitet er oprettet');

        const a = db.prepare(
            `SELECT * FROM crm_activities WHERE id=?`).get(r1.data.activity_id);
        check(() => a && a.text === 'Mail sendt: Gratis frokost til 2', 'emnet står i aktivitetens tekst');
        check(() => a && a.done_at, 'en sendt mail er en UDFØRT aktivitet (done_at sat)');
        check(() => a && a.owner_user_id === userId, 'afsenderen kommer fra sessionen');

        // Kontekst: bon, formål, kampagne
        const r2 = await post(`/api/customers/${customerId}/mail`, {
            to: 'dagny@example.invalid', subject: 'Med kontekst', text: 'Hej',
            bon_id: bonId, purpose_key: 'fast_rytme', campaign_id: campaignId,
        });
        const a2 = db.prepare(`SELECT * FROM crm_activities WHERE id=?`).get(r2.data.activity_id);
        check(() => a2 && a2.bon_id === bonId, 'bon_id følger med (så service-kaldet dedupe\'r)');
        check(() => a2 && a2.campaign_id === campaignId, 'campaign_id følger med');
        check(() => a2 && db.prepare(`SELECT key FROM activity_purposes WHERE id=?`)
            .get(a2.purpose_id)?.key === 'fast_rytme', 'purpose_key oversættes til purpose_id');

        // Tomt emne må ikke give en tom linje i tidslinjen
        const r3 = await post(`/api/customers/${customerId}/mail`, {
            to: 'dagny@example.invalid', text: 'Kun brødtekst',
        });
        const a3 = db.prepare(`SELECT * FROM crm_activities WHERE id=?`).get(r3.data.activity_id);
        check(() => a3 && a3.text === 'Mail sendt: (uden emne)', 'mail uden emne får en læselig tekst');

        // Fejler SMTP, skrives der INGEN aktivitet — ellers ville tidslinjen
        // påstå at kunden var kontaktet.
        shouldThrow = true;
        const n = countEmailOut();
        const r4 = await post(`/api/customers/${customerId}/mail`, {
            to: 'dagny@example.invalid', subject: 'Fejler', text: 'x',
        });
        check(() => r4.status >= 400, 'en fejlet afsendelse svarer med fejl');
        check(() => countEmailOut() === n, 'en fejlet afsendelse skriver ingen aktivitet');
    } finally {
        db.close();
        server.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
