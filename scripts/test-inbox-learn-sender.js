// scripts/test-inbox-learn-sender.js
// ============================================================
// #478 — en kobling skal lære afsenderens adresse på kunden.
//
// Sagen der gav issuet: kunde 4520 blev oprettet uden email, en videresendt
// mail blev koblet til hende, og hendes to egne svar dagen efter (det ene med
// hele bestillingen) faldt ud i den ufordelte indbakke igen. Koblingen fik
// adressen serveret og kastede den væk.
//
// Testen rammer de ÆGTE endpoints over HTTP, fordi læringen sker i
// route-handlerne — ikke i et lag man kan kalde direkte:
//   PATCH /api/mail/unmatched/:id            (Link til Kunde / Link til Bon)
//   POST  /api/mail/unmatched/:id/create-lead (opret lead)
//
// Den sidste gruppe lukker cirklen: efter koblingen skal mailService's
// afsender-opslag faktisk finde kunden — ellers er læringen ligegyldig.
//
// Kør:
//   node --experimental-sqlite scripts/test-inbox-learn-sender.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-learnsender-${Date.now()}.db`);
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

let db;
let umSeq = 0;

// Én ufordelt mail som IMAP ville have lagt den.
function seedUnmatched({ from, parsedEmail = null, parsedName = null, subject = 'Catering d. 18-20 august' }) {
    umSeq++;
    return Number(db.prepare(`
        INSERT INTO mail_unmatched (mailbox, message_id, imap_uid, from_email, from_name, subject,
                                    body_text, received_at, parsed_email, parsed_name, status)
        VALUES ('kontakt@ristetrug.dk', ?, ?, ?, 'Lærke Haumann Andersen', ?,
                'Kunden siger go for at bestille ved jer', datetime('now'), ?, ?, 'open')
    `).run(`<test-${umSeq}@example.invalid>`, 900 + umSeq, from, subject, parsedEmail, parsedName).lastInsertRowid);
}

const emailsOn = (cid) => db.prepare(
    `SELECT value, is_primary, source, is_active, is_public FROM contact_points
      WHERE entity_type='customer' AND entity_id=? AND kind='email' ORDER BY id`
).all(cid);

async function main() {
    process.env.DB_PATH = TEST_DB;
    require('../db/migrate').runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','test-admin@local','admin',?,1)`).run(TEST_PIN);

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, MAIL_POLL_DISABLED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc.stdout.on('data', () => {});
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server-err] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        if ((await http('POST', '/api/auth/pin', { pin: TEST_PIN })).status !== 200) throw new Error('Login fejlede');

        // ── 1) Drifts-sagen: kunde uden email ─────────────────────────────
        console.log('\n— Kunde uden email (sagen fra #478) —');
        const laerke = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name, phone) VALUES ('Lærke','Haumann Andersen','+45 38 42 95 99')`
        ).run().lastInsertRowid);
        assert(emailsOn(laerke).length === 0, 'kunden starter uden email — som i drift');

        const um1 = seedUnmatched({ from: 'LHA@cap-partner.eu' });
        const r1 = await http('PATCH', `/api/mail/unmatched/${um1}`, { status: 'linked', linked_customer_id: laerke });
        assert(r1.status === 200, 'mailen kobles til kunden');

        const e1 = emailsOn(laerke);
        assert(e1.length === 1, 'koblingen lærte adressen (1 kontaktpunkt)');
        assert(e1[0]?.value === 'lha@cap-partner.eu', `adressen normaliseres til lowercase (${e1[0]?.value})`);
        assert(e1[0]?.is_primary === 1, 'bliver primær fordi kunden ingen havde');
        assert(e1[0]?.source === 'mail', "source='mail' viser hvor den kom fra");
        assert(e1[0]?.is_public === 0, 'is_public=0 — juridisk sikker default (CLAUDE_KONTAKTER.md)');
        assert(db.prepare('SELECT email FROM customers WHERE id=?').get(laerke).email === 'lha@cap-partner.eu',
            'cachen på customers.email synkes med');
        assert(db.prepare(
            `SELECT COUNT(*) n FROM changelog WHERE entity_type='customer' AND entity_id=? AND action='contact_point_create'`
        ).get(laerke).n === 1, 'changelog viser hvor adressen kom fra');

        // ── 2) Cirklen lukkes: næste mail rammer nu kunden ────────────────
        console.log('\n— Næste mail fra samme afsender —');
        const mailSvc = require('../services/mailService');
        const found = mailSvc.findCustomerByEmail(db, 'LHA@cap-partner.eu');
        assert(found && found.id === laerke, 'afsender-opslaget finder nu kunden (var dét der fejlede 11/8)');

        // ── 3) Vi flytter aldrig en adresse nogen har valgt ───────────────
        console.log('\n— Eksisterende primær bevares —');
        const morten = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name, email) VALUES ('Morten','W','m@mortenw.dk')`
        ).run().lastInsertRowid);
        db.prepare(`INSERT INTO contact_points (entity_type,entity_id,kind,value,is_primary,is_public,source)
                    VALUES ('customer',?,'email','m@mortenw.dk',1,0,'manual')`).run(morten);

        const um2 = seedUnmatched({ from: 'morten.privat@example.invalid' });
        await http('PATCH', `/api/mail/unmatched/${um2}`, { status: 'linked', linked_customer_id: morten });
        const e2 = emailsOn(morten);
        assert(e2.length === 2, 'den nye adresse tilføjes');
        assert(e2.find(r => r.value === 'm@mortenw.dk')?.is_primary === 1, 'den valgte primær bevares');
        assert(e2.find(r => r.value === 'morten.privat@example.invalid')?.is_primary === 0,
            'den lærte adresse bliver IKKE primær');
        assert(db.prepare('SELECT email FROM customers WHERE id=?').get(morten).email === 'm@mortenw.dk',
            'cachen peger stadig på den valgte primær');

        // ── 4) Vores egne adresser bliver aldrig kundekontakt ─────────────
        console.log('\n— Intern afsender —');
        const kollega = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name) VALUES ('Uden','Email')`
        ).run().lastInsertRowid);
        const um3 = seedUnmatched({ from: 'info@ristetrug.dk' });
        await http('PATCH', `/api/mail/unmatched/${um3}`, { status: 'linked', linked_customer_id: kollega });
        assert(emailsOn(kollega).length === 0,
            'en intern afsender skrives ALDRIG på kunden (det var #426-fejlen)');

        // ── 5) Videresendt mail: den reelle afsender læres ────────────────
        console.log('\n— Videresendt af en kollega —');
        const viaFwd = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name) VALUES ('Fwd','Kunde')`
        ).run().lastInsertRowid);
        const um4 = seedUnmatched({
            from: 'info@ristetrug.dk',
            parsedEmail: 'kunde@fjern-firma.invalid', parsedName: 'Fjern Kunde',
        });
        await http('PATCH', `/api/mail/unmatched/${um4}`, { status: 'linked', linked_customer_id: viaFwd });
        const e4 = emailsOn(viaFwd);
        assert(e4.length === 1 && e4[0].value === 'kunde@fjern-firma.invalid',
            'den VIDERESENDTE afsender læres, ikke kollegaens adresse');

        // ── 6) Adressen tilhører en anden kunde ───────────────────────────
        console.log('\n— Adressen er optaget —');
        const anden = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name) VALUES ('Anden','Kunde')`
        ).run().lastInsertRowid);
        const um5 = seedUnmatched({ from: 'lha@cap-partner.eu' });
        await http('PATCH', `/api/mail/unmatched/${um5}`, { status: 'linked', linked_customer_id: anden });
        assert(emailsOn(anden).length === 0,
            'en adresse der allerede står på en anden kunde skrives ikke (tvetydig routing)');
        assert(mailSvc.findCustomerByEmail(db, 'lha@cap-partner.eu').id === laerke,
            'den oprindelige ejer er urørt');

        // ── 7) Link til Bon lærer også ────────────────────────────────────
        console.log('\n— Link til Bon —');
        const bonKunde = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name) VALUES ('Bon','Kunde')`
        ).run().lastInsertRowid);
        const statusId = db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
        const locId = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get().id;
        const bonId = Number(db.prepare(
            `INSERT INTO bons (bon_number, order_date, delivery_date, status_id, customer_id, location_id)
             VALUES ('T-LEARN-1', date('now'), date('now'), ?, ?, ?)`
        ).run(statusId, bonKunde, locId).lastInsertRowid);
        const um6 = seedUnmatched({ from: 'bestiller@bonfirma.invalid' });
        await http('PATCH', `/api/mail/unmatched/${um6}`, { status: 'linked', linked_bon_id: bonId });
        assert(emailsOn(bonKunde).some(r => r.value === 'bestiller@bonfirma.invalid'),
            'kobling til en bon lærer adressen på bonens kunde');

        // ── 8) Deaktiveret adresse genoplives ikke ────────────────────────
        console.log('\n— Bevidst fjernet adresse —');
        const fjernet = Number(db.prepare(
            `INSERT INTO customers (first_name, last_name) VALUES ('Fjernet','Adresse')`
        ).run().lastInsertRowid);
        db.prepare(`INSERT INTO contact_points (entity_type,entity_id,kind,value,is_primary,is_public,source,is_active)
                    VALUES ('customer',?,'email','gammel@example.invalid',0,0,'manual',0)`).run(fjernet);
        const um7 = seedUnmatched({ from: 'gammel@example.invalid' });
        await http('PATCH', `/api/mail/unmatched/${um7}`, { status: 'linked', linked_customer_id: fjernet });
        const e7 = emailsOn(fjernet);
        assert(e7.length === 1 && e7[0].is_active === 0,
            'en adresse nogen har fjernet bevidst genoplives ikke');

        // ── 9) Idempotens ────────────────────────────────────────────────
        console.log('\n— Gentagen kobling —');
        const um8 = seedUnmatched({ from: 'LHA@cap-partner.eu' });
        await http('PATCH', `/api/mail/unmatched/${um8}`, { status: 'linked', linked_customer_id: laerke });
        assert(emailsOn(laerke).length === 1, 'samme adresse læres ikke to gange');
        assert(db.prepare(
            `SELECT COUNT(*) n FROM changelog WHERE entity_type='customer' AND entity_id=? AND action='contact_point_create'`
        ).get(laerke).n === 1, 'og laver ikke en ny changelog-linje');

        // ── 10) Opret lead ───────────────────────────────────────────────
        console.log('\n— Opret som lead —');
        const um9 = seedUnmatched({ from: 'nyt.lead@example.invalid', subject: 'Forespørgsel' });
        const lead = await http('POST', `/api/mail/unmatched/${um9}/create-lead`, {});
        assert(lead.status === 200, 'lead oprettes fra ufordelt mail');
        assert(emailsOn(lead.data.customer_id).some(r => r.value === 'nyt.lead@example.invalid'),
            'det nye lead har afsenderens adresse som kontaktpunkt');
        assert(mailSvc.findCustomerByEmail(db, 'nyt.lead@example.invalid')?.id === lead.data.customer_id,
            'og næste mail fra leadet rammer det');

    } finally {
        if (serverProc) serverProc.kill();
        try { db.close(); } catch {}
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
