// scripts/test-settings-permissions.js
// ==========================================
// Integration-test for skrive-rettigheder på PATCH /api/settings/:key.
//
// Baggrund: Settings-siden har altid vist "Hastebestilling" for office
// (`st-office-only`), men PATCH'en krævede admin. Kontoret trykkede, fik en
// grøn kvittering (fronten tjekkede ikke svaret) og intet blev gemt.
//
// Verificerer:
//   - office må sætte bestilling.cutoff_override_date
//   - kitchen må IKKE
//   - office må ikke skrive en vilkårlig admin-nøgle
//   - alle må skrive de generelt bruger-skrivbare nøgler
//   - admin må stadig alt
//   - datoen sættes af SERVEREN (dansk dato), ikke af klientens ur
//   - tom værdi lukker igen
//   - /embed/config afspejler flaget
//
// Spawner en frisk server mod en isoleret test-DB i /tmp.
//
// Kør:
//   node --experimental-sqlite scripts/test-settings-permissions.js
// ==========================================

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-setperm-${Date.now()}.db`);
const PORT    = 4329;
const BASE    = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      forventet:', expected, '\n      fik:      ', actual); fail++; }
}

async function waitForServer(maxMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(BASE + '/api/auth/pin-users');
            if (r.status > 0) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

// Cookie-jar pr. "browser", så tre roller kan være logget ind samtidig
function makeClient() {
    let cookies = [];
    return async function http(method, url, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookies.length) headers.Cookie = cookies.join('; ');
        const res = await fetch(BASE + url, {
            method, headers,
            body: body == null ? undefined : JSON.stringify(body)
        });
        const set = res.headers.get('set-cookie');
        if (set) cookies = [set.split(';')[0]];
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { status: res.status, data };
    };
}

const KEY = 'bestilling.cutoff_override_date';

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    // Én bruger pr. rolle med kendt PIN
    const PINS = { admin: '9001', office: '9002', kitchen: '9003' };
    for (const [role, pin] of Object.entries(PINS)) {
        const existing = db.prepare(`SELECT id FROM users WHERE role = ? ORDER BY id LIMIT 1`).get(role);
        if (existing) db.prepare(`UPDATE users SET pin = ?, is_active = 1 WHERE id = ?`).run(pin, existing.id);
        else db.prepare(`
            INSERT INTO users (name, email, role, pin, is_active)
            VALUES (?, ?, ?, ?, 1)
        `).run(`Test ${role}`, `test-${role}@local`, role, pin);
    }
    db.close();

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT} med DB: ${TEST_DB}`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        serverProc.stdout.on('data', () => {});
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) {
                process.stderr.write('  [server-err] ' + s);
            }
        });

        if (!await waitForServer()) throw new Error('Server startede ikke inden timeout');
        console.log('  ✓ server svarer');

        const admin = makeClient(), office = makeClient(), kitchen = makeClient();

        console.log('\n=== Login ===');
        for (const [name, client, role] of [['admin', admin, 'admin'], ['office', office, 'office'], ['kitchen', kitchen, 'kitchen']]) {
            const r = await client('POST', '/api/auth/pin', { pin: PINS[role] });
            assert(r.status === 200 && r.data.role === role, `${name} logget ind (status ${r.status}, rolle ${r.data?.role})`);
        }

        // ─── Hastebestilling: office må ────────────────────
        console.log('\n=== Hastebestilling — office må åbne ===');
        const openRes = await office('PATCH', `/api/settings/${KEY}`, { value: '2020-01-01' });
        assertEqual(openRes.status, 200, 'office → 200');

        const { todayISO } = require('../db/helpers');
        assertEqual(openRes.data?.value, todayISO(),
            'Serveren sætter dagens danske dato — klientens værdi ignoreres');

        const all = await office('GET', '/api/settings');
        const stored = (all.data || []).find(s => s.key === KEY)?.value;
        assertEqual(stored, todayISO(), 'Værdien er faktisk gemt i settings');

        const cfg = await fetch(BASE + '/embed/config').then(r => r.json());
        assertEqual(cfg.cutoffOverride, true, '/embed/config viser cutoffOverride = true');

        // ─── Hastebestilling: kitchen må ikke ──────────────
        console.log('\n=== Hastebestilling — kitchen må ikke ===');
        const kRes = await kitchen('PATCH', `/api/settings/${KEY}`, { value: '' });
        assertEqual(kRes.status, 403, 'kitchen → 403');
        const stillOpen = (await office('GET', '/api/settings')).data.find(s => s.key === KEY)?.value;
        assertEqual(stillOpen, todayISO(), 'Afvist kald ændrede ikke værdien');

        // ─── Office må ikke skrive vilkårlige nøgler ───────
        console.log('\n=== Office er ikke blevet admin ===');
        const escalate = await office('PATCH', '/api/settings/bon_number_prefix', { value: 'X' });
        assertEqual(escalate.status, 403, 'office kan ikke ændre bon_number_prefix');

        // ─── Bruger-skrivbare nøgler er urørte ─────────────
        console.log('\n=== Generelt bruger-skrivbare nøgler ===');
        const kitchenToggle = await kitchen('PATCH', '/api/settings/show_prices_in_planning', { value: '1' });
        assertEqual(kitchenToggle.status, 200, 'kitchen kan stadig sætte show_prices_in_planning');

        // ─── Luk igen ──────────────────────────────────────
        console.log('\n=== Hastebestilling — luk igen ===');
        const closeRes = await office('PATCH', `/api/settings/${KEY}`, { value: '' });
        assertEqual(closeRes.status, 200, 'office → 200');
        assertEqual(closeRes.data?.value, '', 'Tom værdi lukker');
        const cfg2 = await fetch(BASE + '/embed/config').then(r => r.json());
        assertEqual(cfg2.cutoffOverride, false, '/embed/config viser cutoffOverride = false');

        // ─── Admin kan stadig det hele ─────────────────────
        console.log('\n=== Admin uændret ===');
        const aOpen = await admin('PATCH', `/api/settings/${KEY}`, { value: 'i dag tak' });
        assertEqual(aOpen.status, 200, 'admin kan åbne');
        assertEqual(aOpen.data?.value, todayISO(), 'også normaliseret for admin');
        await admin('PATCH', `/api/settings/${KEY}`, { value: '' });

        // ─── Ikke-logget afvises ───────────────────────────
        console.log('\n=== Ikke-logget ===');
        const anon = makeClient();
        const anonRes = await anon('PATCH', `/api/settings/${KEY}`, { value: 'x' });
        assertEqual(anonRes.status, 401, 'ikke-logget → 401');

        console.log('\n=== Resultat ===');
        console.log(`✓ ${pass} passed,  ✗ ${fail} failed`);

    } finally {
        if (serverProc) {
            serverProc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 300));
            if (!serverProc.killed) serverProc.kill('SIGKILL');
        }
        for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm',
                         path.join(path.dirname(TEST_DB), 'sessions.db')]) {
            try { fs.unlinkSync(f); } catch {}
        }
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
}).then(() => {
    process.exit(fail > 0 ? 1 : 0);
});
