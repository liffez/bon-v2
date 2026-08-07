// scripts/test-inbox-access.js
// ============================================================
// Regressionstest: Ufordelt-post skal følge CRM-rettigheden, ikke admin-rollen.
//
// Bug (fundet i drift, aug. 2026): hele ufordelt-fladen var requireAuth('admin').
// En office-bruger med fuld CRM-adgang så tælleren "⚠ Ufordelt 3" og de tre
// mails i "Nyt"-dropdownen (begge endpoints er åbne for alle roller), men
// listen bagved svarede 403 — og frontenden slugte fejlen i et console.error.
// Symptomet lignede en browser-/maskinfejl, fordi det fulgte brugeren.
//
// Spawner en frisk server mod isoleret test-DB i /tmp — prod røres ikke.
// Rammer de ÆGTE endpoints over HTTP, fordi gaten sidder i route-definitionen.
//
// Kør:
//   node --experimental-sqlite scripts/test-inbox-access.js
// ============================================================

'use strict';
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-inboxaccess-${Date.now()}.db`);
const PORT = 4334;
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

// Hver rolle har sin egen cookie-krukke, så sessionerne ikke træder på hinanden.
function makeClient() {
    let cookies = [];
    return async function http(method, url, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookies.length) headers.Cookie = cookies.join('; ');
        const res = await fetch(BASE + url, {
            method, headers, body: body == null ? undefined : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookies = [set.split(';')[0]];
        let data = null;
        try { data = await res.json(); } catch {}
        return { status: res.status, data };
    };
}

function seedUnmatched(db, { from, subject }) {
    return Number(db.prepare(`
        INSERT INTO mail_unmatched (mailbox, message_id, from_email, from_name, subject,
                                    body_text, received_at, status, created_at)
        VALUES ('kontakt@test.local', ?, ?, 'Test Afsender', ?, 'brødtekst', datetime('now'), 'open', datetime('now'))
    `).run('<' + Math.random().toString(36).slice(2) + '@test>', from, subject).lastInsertRowid);
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    let db = openDb(TEST_DB);

    const PIN = { admin: '9911', office: '9922', kitchen: '9933' };
    const uid = {};
    for (const role of ['admin', 'office', 'kitchen']) {
        const existing = db.prepare(`SELECT id FROM users WHERE role=? ORDER BY id LIMIT 1`).get(role);
        if (existing) {
            db.prepare(`UPDATE users SET pin=?, is_active=1 WHERE id=?`).run(PIN[role], existing.id);
            uid[role] = existing.id;
        } else {
            uid[role] = Number(db.prepare(
                `INSERT INTO users (name,email,role,pin,is_active) VALUES (?,?,?,?,1)`
            ).run('T_ACC ' + role, `t_acc_${role}@test.local`, role, PIN[role]).lastInsertRowid);
        }
    }

    // Rettighedsmatricen er testens forudsætning: office har crm, kitchen har ikke.
    const perms = {};
    for (const role of ['office', 'kitchen']) {
        const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(`role_permissions_${role}`);
        perms[role] = row ? JSON.parse(row.value) : {};
    }

    const um1 = seedUnmatched(db, { from: 't_acc_a@test.local', subject: 'T_ACC Forespørgsel' });
    const um2 = seedUnmatched(db, { from: 't_acc_b@test.local', subject: 'T_ACC Anden mail' });
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

        console.log('\nUfordelt post · adgang følger CRM-rettigheden\n');

        assert(perms.office.crm === true,  'forudsætning: office har crm i rettighedsmatricen');
        assert(perms.kitchen.crm !== true, 'forudsætning: kitchen har IKKE crm');

        const as = {};
        for (const role of ['admin', 'office', 'kitchen']) {
            as[role] = makeClient();
            const login = await as[role]('POST', '/api/auth/pin', { pin: PIN[role] });
            if (login.status !== 200) throw new Error(`login som ${role} fejlede: ${login.status}`);
        }

        // ── S1 · Listen (drifts-sagen) ──
        console.log('S1 · Ufordelt-listen');
        const a1 = await as.admin('GET', '/api/mail/inbox');
        assert(a1.status === 200, 'admin: GET /mail/inbox → 200');

        const o1 = await as.office('GET', '/api/mail/inbox');
        assert(o1.status === 200, 'office: GET /mail/inbox → 200 (var 403 før)');
        assert(Array.isArray(o1.data) && o1.data.some(m => m.subject === 'T_ACC Forespørgsel'),
               'office ser faktisk de ufordelte mails i svaret');

        const k1 = await as.kitchen('GET', '/api/mail/inbox');
        assert(k1.status === 403, 'kitchen: GET /mail/inbox → 403 (uden crm)');

        // Tælleren har hele tiden været åben — det er dét, der gjorde
        // symptomet forvirrende. Den skal blive ved med at være det.
        const kc = await as.kitchen('GET', '/api/mail/threads/counts');
        assert(kc.status === 200, 'kitchen: /threads/counts → 200 (tælleren er stadig åben)');

        // ── S2 · Handlingerne, ikke kun læsning ──
        console.log('\nS2 · Handlinger på ufordelt post');
        const o2 = await as.office('GET', '/api/mail/unmatched?status=open');
        assert(o2.status === 200, 'office: GET /mail/unmatched → 200');

        const oLead = await as.office('POST', `/api/mail/unmatched/${um2}/create-lead`);
        assert(oLead.status === 200, 'office: POST /unmatched/:id/create-lead → 200');

        const oBulk = await as.office('POST', '/api/mail/unmatched/bulk',
            { ids: [um1], action: 'ignored' });
        assert(oBulk.status === 200, 'office: POST /unmatched/bulk (ignorer) → 200');

        const kBulk = await as.kitchen('POST', '/api/mail/unmatched/bulk',
            { ids: [um2], action: 'ignored' });
        assert(kBulk.status === 403, 'kitchen: POST /unmatched/bulk → 403');

        // ── S3 · Systemfladerne forbliver admin ──
        console.log('\nS3 · Ægte admin-flader er urørte');
        const oTpl = await as.office('POST', '/api/mail/templates',
            { key: 't_acc_skabelon', label: 'T_ACC' });
        assert(oTpl.status === 403, 'office: POST /mail/templates → 403 (skabeloner er stadig admin)');

        const oStatus = await as.office('GET', '/api/mail/status');
        assert(oStatus.status === 403, 'office: GET /mail/status → 403 (IMAP-status er stadig admin)');

        // ── S4 · Matricen er den faktiske kilde, ikke rollenavnet ──
        console.log('\nS4 · Adgangen kan styres uden en udrulning');
        const flip = await as.admin('PATCH', '/api/settings/role-permissions/kitchen',
            { ...perms.kitchen, crm: true });
        assert(flip.status === 200, 'admin slår crm til for kitchen i Indstillinger');
        const k2 = await as.kitchen('GET', '/api/mail/inbox');
        assert(k2.status === 200, 'kitchen: GET /mail/inbox → 200 straks efter (cachen ryddes)');

        const flipBack = await as.admin('PATCH', '/api/settings/role-permissions/kitchen',
            { ...perms.kitchen, crm: false });
        assert(flipBack.status === 200, 'admin slår crm fra igen');
        const k3 = await as.kitchen('GET', '/api/mail/inbox');
        assert(k3.status === 403, 'kitchen: GET /mail/inbox → 403 igen');

        // ── S5 · Per-bruger-override slår rolle-defaulten ──
        console.log('\nS5 · Per-bruger-override');
        db = openDb(TEST_DB);
        db.prepare(`UPDATE users SET modules_json=? WHERE id=?`)
          .run(JSON.stringify({ crm: false }), uid.office);
        db.close();
        // Rolle-defaults caches 60s, men modules_json læses pr. request.
        const o3 = await as.office('GET', '/api/mail/inbox');
        assert(o3.status === 403, 'office med modules_json {crm:false} → 403 trods rolle-default');

        db = openDb(TEST_DB);
        db.prepare(`UPDATE users SET modules_json=NULL WHERE id=?`).run(uid.office);
        db.close();
        const o4 = await as.office('GET', '/api/mail/inbox');
        assert(o4.status === 200, 'override fjernet → office er inde igen');

        // ── S6 · Uden login er alt lukket ──
        console.log('\nS6 · Ikke logget ind');
        const anon = makeClient();
        const an = await anon('GET', '/api/mail/inbox');
        assert(an.status === 401, 'anonym: GET /mail/inbox → 401');

    } finally {
        srv.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(TEST_DB + suffix); } catch {}
        }
    }

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
