// scripts/test-booking-confirmed-by.js
// ============================================================
// Regressionstest for #365 — påstår ruten at leverandøren har bekræftet?
//
// POST /api/delivery/routes/:id/book tager `status` fra request body med
// default 'booked' og skriver booked_at + booked_by_user_id. Intet verificerer
// at bookingen fandt sted: office kalder endpointet EFTER at have sendt
// bestillingen via popout-vinduet. Blev vinduet lukket, formularen aldrig
// indsendt, eller afviste buddet opgaven, stod ruten alligevel som "✓ Booket"
// — med tidsstempel og et navngivet menneske, hvilket får den til at se
// autoritativ ud.
//
// Verificeret ved gennemgang: dette endpoint er det ENESTE sted der sætter
// booking_status='booked' på en rute. "Booket" har altså aldrig betydet
// andet end "et menneske trykkede".
//
// Testen kører mod en RIGTIG server med isoleret test-DB, så den rammer den
// faktiske SQL frem for at replikere den.
//
// Kør:
//   node --experimental-sqlite scripts/test-booking-confirmed-by.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TEST_DB = path.join(os.tmpdir(), `bon-booking-cb-${Date.now()}.db`);
const PORT = 4329;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

let _cookies = [];
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, {
        method, headers, body: body == null ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch { /* tomt svar */ }
    return { status: res.status, data };
}

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch { /* ikke oppe endnu */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

(async () => {
    process.env.DB_PATH = TEST_DB;
    require('../db/migrate').runMigrations(TEST_DB);

    const db = new DatabaseSync(TEST_DB);
    const PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(PIN);
    // En vogn der bookes eksternt (manual_clipboard → booking_status starter 'pending')
    const vehicleId = Number(db.prepare(`
        INSERT INTO delivery_vehicles (code, label, type, booking_method, is_active)
        VALUES ('test-bud', 'Test-bud', 'bike', 'manual_clipboard', 1)
    `).run().lastInsertRowid);
    db.close();

    let proc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}`);
        proc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stderr.on('data', d => {
            const s = d.toString();
            if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write('  [server] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');

        console.log('\nBooking: "booket" eller bare "sendt"? (#365)\n');

        const login = await http('POST', '/api/auth/pin', { pin: PIN });
        ok(login.status === 200, `logget ind — status ${login.status}`);

        const created = await http('POST', '/api/delivery/routes',
            { route_date: '2026-12-24', vehicle_id: vehicleId });
        ok(created.status === 201, `rute oprettet — status ${created.status}`);
        const routeId = created.data && created.data.id;

        console.log('\nS1 · Book via popout-flowet (det manuelle endpoint)');
        const booked = await http('POST', `/api/delivery/routes/${routeId}/book`,
            { external_reference: 'REF-123' });
        ok(booked.status === 200, `status ${booked.status}`);
        ok(booked.data.booking_status === 'booked', `booking_status = 'booked' (uændret adfærd) — fik '${booked.data.booking_status}'`);
        ok(booked.data.booking_confirmed_by === 'manual',
            `booking_confirmed_by = 'manual' — fik '${booked.data.booking_confirmed_by}'`);

        console.log('\nS2 · Databasen husker at påstanden var menneskelig');
        const verify = new DatabaseSync(TEST_DB, { readOnly: true });
        const row = verify.prepare(
            `SELECT booking_status, booking_confirmed_by, external_reference, booked_at, booked_by_user_id
             FROM delivery_routes WHERE id = ?`).get(routeId);
        verify.close();
        ok(row.booking_confirmed_by === 'manual', `gemt som 'manual' — fik '${row.booking_confirmed_by}'`);
        ok(!!row.booked_at && !!row.booked_by_user_id, 'tidsstempel og bruger bevaret (sporbarhed uændret)');
        ok(row.external_reference === 'REF-123', `reference gemt — fik '${row.external_reference}'`);

        console.log('\nS3 · Klienten kan ikke påstå at leverandøren har bekræftet');
        const spoof = await http('POST', `/api/delivery/routes/${routeId}/book`,
            { status: 'booked', booking_confirmed_by: 'api' });
        ok(spoof.data.booking_confirmed_by === 'manual',
            `'api' fra request body ignoreres — fik '${spoof.data.booking_confirmed_by}'`);

        console.log('\nS4 · Ugyldig status afvises stadig');
        const bad = await http('POST', `/api/delivery/routes/${routeId}/book`, { status: 'vupti' });
        ok(bad.status === 400, `status 400 — fik ${bad.status}`);

    } finally {
        if (proc) proc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch { /* ligegyldigt */ }
    }

    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
