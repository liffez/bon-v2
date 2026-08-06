// scripts/test-inbox-link-visibility.js
// ============================================================
// Regressionstest: en mail linket fra Ufordelt må ALDRIG blive usynlig.
//
// Bug (fundet i drift, aug. 2026): "Link til Kunde"/"Link til Bon" oprettede
// tråden uden handling_status. Indbakkens tråd-visning filtrerer på
// `mt.handling_status IS NOT NULL` — også chippen "Alle" og søgefeltet — så
// mailen forsvandt fra Ufordelt uden at dukke op noget andet sted, og
// GET/POST på tråden svarede 404. Konkret sag: en mail fra en ny kontaktperson
// blev hægtet på firmaets eksisterende kunde og kunne derefter ikke findes.
//
// Spawner en frisk server mod isoleret test-DB i /tmp — prod røres ikke.
// Rammer de ÆGTE endpoints over HTTP, fordi bogføringen bor i route-handlerne.
// SMTP røres ikke: vi beviser at tråden er FUNDET (ikke 404) via de guardede
// GET/PATCH-endpoints i stedet for at sende rigtig mail.
//
// Kør:
//   node --experimental-sqlite scripts/test-inbox-link-visibility.js
// ============================================================

'use strict';
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-inboxlink-${Date.now()}.db`);
const PORT = 4333;
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

// Seed en ufordelt mail direkte i DB — det svarer til at IMAP-pollen har
// lagt den der (mailService's egen sti er dækket af andre tests).
function seedUnmatched(db, { from, subject }) {
    return Number(db.prepare(`
        INSERT INTO mail_unmatched (mailbox, message_id, from_email, from_name, subject,
                                    body_text, received_at, status, created_at)
        VALUES ('kontakt@test.local', ?, ?, ?, ?, 'brødtekst', datetime('now'), 'open', datetime('now'))
    `).run('<' + Math.random().toString(36).slice(2) + '@test>', from, 'Test Afsender', subject).lastInsertRowid);
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    let db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);

    // Firma + eksisterende kontaktperson — spejler drifts-sagen: mail fra en
    // NY person hægtes på firmaets kendte kunde.
    const companyId = Number(db.prepare(
        `INSERT INTO companies (name) VALUES ('T_INB Testfirma')`).run().lastInsertRowid);
    const customerId = Number(db.prepare(
        `INSERT INTO customers (company_id, first_name, last_name, email)
         VALUES (?, 'Kendt', 'Kontakt', 't_inb_kendt@test.local')`).run(companyId).lastInsertRowid);

    const um1 = seedUnmatched(db, { from: 't_inb_nyperson@test.local', subject: 'T_INB Forespørgsel' });
    const um2 = seedUnmatched(db, { from: 't_inb_lead@test.local',     subject: 'T_INB Lead-mail' });
    const um3 = seedUnmatched(db, { from: 't_inb_lead@test.local',     subject: 'T_INB Lead-mail 2' });
    db.close();

    const srv = spawn('node', ['--experimental-sqlite', 'server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DB_PATH: TEST_DB, PORT: String(PORT), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', () => {});
    srv.stderr.on('data', d => { const s = String(d); if (/Error|error:/.test(s)) process.stderr.write(s); });

    try {
        if (!await waitForServer()) throw new Error('server startede ikke');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        if (login.status !== 200) throw new Error('login fejlede: ' + login.status);

        console.log('\nIndbakke · linket mail må ikke blive usynlig\n');

        // ── S1 · Link til kunde (drifts-sagen) ──
        console.log('S1 · "Link til Kunde" — tråden skal være synlig og svarbar');
        const link = await http('PATCH', `/api/mail/unmatched/${um1}`,
            { status: 'linked', linked_customer_id: customerId });
        assert(link.status === 200, `PATCH /unmatched/${um1} → 200`);
        const threadId = link.data?.thread_id;
        assert(Number.isInteger(threadId), 'link returnerer thread_id');

        const ufordelt = await http('GET', '/api/mail/unmatched?status=open');
        assert(!(ufordelt.data || []).some(m => m.id === um1), 'mailen er væk fra Ufordelt (som før)');

        // Kernen i bug'en: disse tre var alle tomme/404 før fixet.
        const alle = await http('GET', '/api/mail/threads?status=alle');
        assert((alle.data || []).some(t => t.id === threadId), 'tråden findes under chippen "Alle"');

        const aabne = await http('GET', '/api/mail/threads?status=aabne');
        assert((aabne.data || []).some(t => t.id === threadId), 'tråden ligger i "Åbne" (uhåndteret arbejde)');

        const soeg = await http('GET', '/api/mail/threads?q=t_inb_nyperson');
        assert((soeg.data || []).some(t => t.id === threadId), 'søgning på afsenderens email finder tråden');

        const åbn = await http('GET', `/api/mail/threads/${threadId}`);
        assert(åbn.status === 200, `GET /threads/${threadId} → 200 (ikke 404)`);
        assert((åbn.data?.messages || []).some(m => m.from_email === 't_inb_nyperson@test.local'),
            'den oprindelige mail ligger i tråden med afsenderens email');

        // Svar-endpointet havde samme 404-guard. Vi sender ikke rigtig mail —
        // men beviser at tråden ikke længere afvises som "ikke fundet".
        const svar = await http('POST', `/api/mail/threads/${threadId}/reply`, { body: 'Testsvar' });
        assert(svar.status !== 404, `POST /threads/${threadId}/reply afvises ikke som 404 (fik ${svar.status})`);

        // Modtageren er seneste indgående afsender — altså den nye person,
        // ikke den kunde tråden hænger på. Det er dét der gør svaret brugbart.
        const genåbn = await http('GET', `/api/mail/threads/${threadId}`);
        assert(genåbn.data?.thread?.email === 't_inb_kendt@test.local'
            || genåbn.data?.thread?.link?.type === 'customer',
            'tråden er knyttet til den valgte kunde');

        // ── S2 · Opret lead fra indbakken ──
        console.log('\nS2 · "Opret lead" — samme krav om synlighed');
        const lead = await http('POST', `/api/mail/unmatched/${um2}/create-lead`);
        assert(lead.status === 200, 'create-lead → 200');
        const leadThread = lead.data?.thread_id;
        const alle2 = await http('GET', '/api/mail/threads?status=alle');
        assert((alle2.data || []).some(t => t.id === leadThread), 'lead-tråden er synlig under "Alle"');
        const åbn2 = await http('GET', `/api/mail/threads/${leadThread}`);
        assert(åbn2.status === 200, 'lead-tråden kan åbnes (ikke 404)');

        // ── S3 · En allerede besvaret tråd må ikke trækkes tilbage til "Åbne" ──
        // markRead=true skal bevare eksisterende handling_status.
        console.log('\nS3 · Eksisterende handling_status bevares (ingen falsk genåbning)');
        const upd = await http('PATCH', `/api/mail/threads/${leadThread}`, { handling_status: 'afventer_kunde' });
        assert(upd.status === 200, 'tråden sættes til "afventer_kunde"');
        // um3 er fra samme afsender → samme kunde → samme aktive tråd.
        const lead2 = await http('POST', `/api/mail/unmatched/${um3}/create-lead`);
        assert(lead2.status === 200 && lead2.data?.thread_id === leadThread,
            'anden mail fra samme afsender lander i den samme tråd');
        const efter = await http('GET', '/api/mail/threads?status=alle');
        const row = (efter.data || []).find(t => t.id === leadThread);
        assert(row?.handling_status === 'afventer_kunde',
            `handling_status er stadig "afventer_kunde" (fik ${row?.handling_status})`);

        // ── S4 · Backfill-migrationen ──
        console.log('\nS4 · Migration 138 — redder efterladte NULL-tråde, rører ikke leverandør-tråde');
        const db2 = openDb(TEST_DB);
        const orphan = Number(db2.prepare(
            `INSERT INTO mail_threads (subject, customer_id, status, created_at, updated_at)
             VALUES ('T_INB Efterladt', ?, 'active', datetime('now'), datetime('now'))`
        ).run(customerId).lastInsertRowid);
        db2.prepare(`
            INSERT INTO mail_messages (thread_id, direction, from_email, to_email, subject, body_text, is_read, received_at, created_at)
            VALUES (?, 'in', 't_inb_nyperson@test.local', 'kontakt@test.local', 'T_INB Efterladt', 'x', 0, datetime('now'), datetime('now'))
        `).run(orphan);

        const supplierId = Number(db2.prepare(
            `INSERT INTO suppliers (name, integration_type) VALUES ('T_INB Leverandør', 'manual')`
        ).run().lastInsertRowid);
        const poThread = Number(db2.prepare(
            `INSERT INTO mail_threads (subject, supplier_id, status, created_at, updated_at)
             VALUES ('T_INB Leverandørpost', ?, 'active', datetime('now'), datetime('now'))`
        ).run(supplierId).lastInsertRowid);

        // Kør migrationens EGEN SQL (ikke en omskrivning) — den er idempotent.
        const sql = fs.readFileSync(
            path.join(__dirname, '..', 'db', 'migrations', '138_inbox_link_handling_backfill.sql'), 'utf8');
        db2.exec(sql);

        const o = db2.prepare('SELECT handling_status, has_unread FROM mail_threads WHERE id = ?').get(orphan);
        assert(o.handling_status === 'aaben', `efterladt kunde-tråd → "aaben" (fik ${o.handling_status})`);
        assert(o.has_unread === 1, 'has_unread genberegnet til 1');
        const p = db2.prepare('SELECT handling_status FROM mail_threads WHERE id = ?').get(poThread);
        assert(p.handling_status === null, 'Leverandør-tråd forbliver NULL (holdes ude af kunde-indbakken)');
        db2.close();

        const efterBackfill = await http('GET', '/api/mail/threads?status=alle');
        assert((efterBackfill.data || []).some(t => t.id === orphan), 'den reddede tråd er nu synlig i indbakken');
        assert(!(efterBackfill.data || []).some(t => t.id === poThread), 'Leverandør-tråden lækker ikke ind i indbakken');

    } finally {
        srv.kill();
        try { fs.unlinkSync(TEST_DB); } catch {}
        for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suffix); } catch {} }
    }

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
