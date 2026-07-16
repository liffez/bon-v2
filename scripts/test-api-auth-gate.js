// scripts/test-api-auth-gate.js
// ============================================================
// Global auth-gate på /api (server.js).
//
// Indtil gaten satte hver router sin egen auth, og en router uden requireAuth
// var helt åben for enhver der kunne nå serveren. Fejlen var strukturel: at
// huske auth på hver ny rute er en tilstand man ikke kan holde, og en glemt
// rute fejlede ÅBENT. Gaten vender det om — /api kræver login som standard.
//
// Testen kører mod den ÆGTE server (spawnet, isoleret temp-DB), ikke en kopi af
// gate-logikken. Det er hele pointen: en gate der kun virker i en test-mock er
// ingen gate.
//
// Verificerer:
//   • Skrive-endpoints der før stod åbne, afvises nu uden login (401)
//   • Og at de rent faktisk ikke skrev noget
//   • Login-flowet er stadig offentligt (ellers kan ingen komme ind)
//   • Kundevendt booking er stadig offentligt (ellers kan ingen booke)
//   • Nær-misser er IKKE offentlige (/booking/meeting-types/intent, /admin/*)
//   • Inde-logget kommer igennem gaten som før
//   • /webhook og /embed er upåvirkede (de ligger uden for /api)
//   • Aliaset /api/web-orders/bestilling er lukket (webhooken selv lever videre)
//
//   node --experimental-sqlite scripts/test-api-auth-gate.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-api-gate-${Date.now()}.db`);
const PORT = 4331;
const BASE = `http://localhost:${PORT}`;
const TEST_PIN = '9999';

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);

let _cookies = [];
async function http(method, url, body, { withCookie = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (withCookie && _cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, {
        method, headers,
        body: body == null ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    return res.status;
}
const anon = (method, url, body) => http(method, url, body, { withCookie: false });

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(BASE + '/api/auth/pin-users');
            if (r.status > 0) return true;
        } catch { /* endnu ikke oppe */ }
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    require('../db/migrate').runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=?, is_active=1 WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Gate Test','gate@local','admin',?,1)`).run(TEST_PIN);
    const bonsBefore = db.prepare(`SELECT COUNT(*) c FROM bons`).get().c;
    db.close();

    let proc = null;
    try {
        proc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', () => {});
        proc.stderr.on('data', () => {});
        if (!await waitForServer()) throw new Error('server startede ikke');

        console.log('\n— Uden login: skrive-endpoints der før stod åbne —');
        check(await anon('POST',  '/api/bons', { delivery_date: '2026-09-01' }) === 401, 'POST /api/bons → 401');
        check(await anon('PATCH', '/api/settings/smtp_host', { value: 'evil' }) === 401, 'PATCH /api/settings/:key → 401');
        check(await anon('POST',  '/api/grocy/recipes', { name: 'x' }) === 401, 'POST /api/grocy/recipes → 401');
        check(await anon('POST',  '/api/quotes', {}) === 401, 'POST /api/quotes → 401');
        check(await anon('POST',  '/api/flags', {}) === 401, 'POST /api/flags → 401');
        check(await anon('POST',  '/api/contact-points', {}) === 401, 'POST /api/contact-points → 401');

        console.log('\n— Uden login: læse-endpoints —');
        check(await anon('GET', '/api/bons/today') === 401, 'GET /api/bons/today → 401');
        check(await anon('GET', '/api/customers') === 401, 'GET /api/customers → 401');
        check(await anon('GET', '/api/settings') === 401, 'GET /api/settings → 401');
        check(await anon('GET', '/api/sse') === 401, 'GET /api/sse → 401 (live bon-stream var åben)');

        console.log('\n— Uden login: der blev ikke skrevet noget —');
        const db2 = openDb(TEST_DB);
        check(db2.prepare(`SELECT COUNT(*) c FROM bons`).get().c === bonsBefore, 'ingen bon oprettet');
        check(db2.prepare(`SELECT value FROM settings WHERE key='smtp_host'`).get()?.value !== 'evil', 'smtp_host uændret');
        db2.close();

        console.log('\n— Login-flowet skal forblive offentligt —');
        check(await anon('GET',  '/api/auth/pin-users') === 200, 'GET /api/auth/pin-users → 200');
        // Tomt login → auth.js svarer 400 ("Mangler email eller password").
        // Havde gaten blokeret, ville svaret være 401. 400 beviser derfor at
        // kaldet NÅR FREM til ruten — uden at hænge testen op på en fejltekst.
        check(await anon('POST', '/api/auth/login', {}) === 400,
            'POST /api/auth/login → 400, ikke 401 (kaldet passerer gaten)');

        console.log('\n— Kundevendt booking skal forblive offentlig —');
        for (const p of ['/api/booking/meeting-types', '/api/booking/contact-reasons',
                         '/api/booking/page-templates/intro_smagning', '/api/booking/slots?date=2026-09-01']) {
            check(await anon('GET', p) !== 401, `GET ${p.split('?')[0]} → ikke 401`);
        }
        check(await anon('GET', '/api/booking/token/findes-ikke') !== 401, 'GET /api/booking/token/:token → ikke 401');

        console.log('\n— Nær-misser skal IKKE være offentlige —');
        check(await anon('GET', '/api/booking/meeting-types/intent') === 401,
            'GET /api/booking/meeting-types/intent → 401 (sælger-værktøj, ligger under en public præfiks)');
        check(await anon('GET', '/api/booking/admin/meeting-types') === 401, 'GET /api/booking/admin/meeting-types → 401');
        check(await anon('GET', '/api/web-orders') === 401, 'GET /api/web-orders → 401');
        check(await anon('POST', '/api/web-orders/bestilling', {}) === 401,
            'POST /api/web-orders/bestilling → 401 (utilsigtet public kopi af webhooken)');

        console.log('\n— Webhook + embed ligger uden for /api og er upåvirkede —');
        check(await anon('POST', '/webhook/bestilling', { hp: '' }) !== 401, 'POST /webhook/bestilling → ikke 401');
        check(await anon('GET',  '/embed/config') !== 401, 'GET /embed/config → ikke 401');

        console.log('\n— Inde-logget kommer igennem gaten —');
        check(await http('POST', '/api/auth/pin', { pin: TEST_PIN }) === 200, 'PIN-login → 200');
        check(await http('GET', '/api/bons/today') === 200, 'GET /api/bons/today → 200');
        check(await http('GET', '/api/customers') === 200, 'GET /api/customers → 200');
        check(await http('GET', '/api/settings') === 200, 'GET /api/settings → 200');
    } finally {
        if (proc) proc.kill('SIGTERM');
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
