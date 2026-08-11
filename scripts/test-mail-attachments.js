// scripts/test-mail-attachments.js
// ============================================================
// Regressionstest for vedhæftninger på udgående mail.
//
// Baggrund: CRM Kunde 360°'s mail-compose uploadede filen korrekt, men
// POST /api/customers/:id/mail læste aldrig `attachments` fra body'en —
// mailen gik af sted uden filerne, uden fejlbesked. Bon-mailen
// (POST /api/bons/:id/mail) havde koblingen; kunde-mailen manglede den.
//
// Rammer de ÆGTE endpoints over HTTP mod en isoleret test-DB i /tmp.
// SMTP auto-mockes af NODE_ENV=test, og den afsendte mail hentes via
// GET /api/test/sent-mails — så vi verificerer hvad nodemailer FIK,
// ikke blot hvad databasen gemte.
//
// Kør:
//   node --experimental-sqlite scripts/test-mail-attachments.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-mailatt-${Date.now()}.db`);
const PORT = 4337;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
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

// Upload via det rigtige multipart-endpoint — så filen på disk og
// attachments-rækken bliver til på præcis samme måde som i browseren.
async function upload(filename, content, entityType, entityId) {
    const fd = new FormData();
    fd.append('entity_type', entityType);
    fd.append('entity_id', String(entityId));
    fd.append('file', new Blob([content], { type: 'application/pdf' }), filename);
    const headers = {};
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + '/api/attachments/upload', { method: 'POST', headers, body: fd });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const existingAdmin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (existingAdmin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, existingAdmin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','test-admin@local','admin',?,1)`).run(TEST_PIN);

    // SMTP skal være "aktiveret" — transporten selv er auto-mocket af NODE_ENV=test.
    for (const k of ['smtp_enabled', 'smtp_kontakt_enabled']) {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, '1')
                    ON CONFLICT(key) DO UPDATE SET value='1'`).run(k);
    }

    const customerId = Number(db.prepare(`
        INSERT INTO customers (first_name, last_name, email, is_active)
        VALUES ('Test', 'Kunde', 'test-kunde@local', 1)
    `).run().lastInsertRowid);

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const statusNy = db.prepare(`SELECT id FROM status_definitions WHERE code='NY'`).get().id;
    const bonId = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, customer_id,
                          order_date, delivery_date, created_at, updated_at)
        VALUES ('B-9901', ?, ?, ?, '2026-08-01', '2026-08-10', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(statusNy, locId, customerId).lastInsertRowid);
    db.close();

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc.stdout.on('data', () => {});
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (/Error|error/.test(s)) process.stderr.write('  [server] ' + s);
        });

        if (!await waitForServer()) throw new Error('Server startede ikke');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        if (login.status !== 200) throw new Error('Login fejlede: ' + login.status);

        // ── 1. Upload ────────────────────────────────────────
        console.log('\n1. Upload af vedhæftning');
        const up = await upload('tilbud.pdf', '%PDF-1.4 testfil', 'customer', customerId);
        assert(up.status === 200, 'upload returnerer 200');
        assert(up.data && up.data.attachment_id > 0, 'upload giver attachment_id');
        const attId = up.data && up.data.attachment_id;

        // ── 2. Kunde-mail MED vedhæftning ────────────────────
        console.log('\n2. Kunde-mail (CRM Kunde 360°) med vedhæftning');
        await http('POST', '/api/test/clear-mails');
        const send = await http('POST', `/api/customers/${customerId}/mail`, {
            to: 'modtager@local',
            subject: 'Tilbud',
            text: 'Se vedhæftede.',
            attachments: [{ attachment_id: attId }],
        });
        assert(send.status === 200, 'send returnerer 200');

        const sent = await http('GET', '/api/test/sent-mails');
        const mail = (sent.data.mails || [])[0];
        assert(!!mail, 'mailen blev afsendt');
        assert(Array.isArray(mail && mail.attachments) && mail.attachments.length === 1,
               'nodemailer fik præcis 1 vedhæftning');
        assert(mail && mail.attachments && mail.attachments[0].filename === 'tilbud.pdf',
               'vedhæftningen har det rigtige filnavn');
        assert(mail && mail.attachments && fs.existsSync(mail.attachments[0].path),
               'vedhæftningens fil findes på disk');

        // Historikken skal også vise den, ellers kan man ikke se bagefter hvad kunden fik.
        const hist = await http('GET', `/api/customers/${customerId}/mail`);
        const msgs = (hist.data.threads || []).flatMap(t => t.messages || []);
        const withAtt = msgs.find(m => (m.attachments || []).length > 0);
        assert(!!withAtt, 'mail-historikken viser vedhæftningen');

        // ── 3. Bon-mail (må ikke være brudt af den delte helper) ──
        console.log('\n3. Bon-mail med vedhæftning (regression)');
        await http('POST', '/api/test/clear-mails');
        const upBon = await upload('bon.pdf', '%PDF-1.4 bon', 'bon', bonId);
        const sendBon = await http('POST', `/api/bons/${bonId}/mail`, {
            to: 'modtager@local',
            subject: 'Ordrebekræftelse',
            text: 'Se vedhæftede.',
            attachments: [{ attachment_id: upBon.data.attachment_id }],
        });
        assert(sendBon.status === 200, 'bon-mail returnerer 200');
        const sentBon = await http('GET', '/api/test/sent-mails');
        const bonMail = (sentBon.data.mails || [])[0];
        assert(bonMail && (bonMail.attachments || []).length === 1, 'bon-mail har vedhæftningen med');

        // ── 4. Validering ────────────────────────────────────
        console.log('\n4. Validering af attachments-feltet');
        const bad1 = await http('POST', `/api/customers/${customerId}/mail`,
            { to: 'x@local', subject: 's', text: 't', attachments: 'ikke-array' });
        assert(bad1.status === 400, 'ikke-array afvises med 400');

        const bad2 = await http('POST', `/api/customers/${customerId}/mail`,
            { to: 'x@local', subject: 's', text: 't', attachments: [{ attachment_id: 0 }] });
        assert(bad2.status === 400, 'ugyldigt attachment_id afvises med 400');

        const bad3 = await http('POST', `/api/customers/${customerId}/mail`, {
            to: 'x@local', subject: 's', text: 't',
            attachments: Array.from({ length: 6 }, () => ({ attachment_id: attId })),
        });
        assert(bad3.status === 400, 'mere end 5 vedhæftninger afvises med 400');

        // Uden attachments skal mailen stadig sendes (bagudkompatibelt).
        await http('POST', '/api/test/clear-mails');
        const plain = await http('POST', `/api/customers/${customerId}/mail`,
            { to: 'x@local', subject: 's', text: 't' });
        assert(plain.status === 200, 'mail uden vedhæftninger sendes stadig');
        const sentPlain = await http('GET', '/api/test/sent-mails');
        const plainMail = (sentPlain.data.mails || [])[0];
        assert(plainMail && !plainMail.attachments, 'mail uden vedhæftninger sætter ikke attachments');

    } finally {
        if (serverProc) serverProc.kill();
        try { fs.unlinkSync(TEST_DB); } catch {}
        try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
        try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    }

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
