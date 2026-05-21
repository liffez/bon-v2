// scripts/test-delivery-spor2-courier.js
// ==========================================
// Integration-test for Delivery Spor 2 — S2.3 (courier).
//
// Spawner en frisk server mod en isoleret test-DB i /tmp og verificerer
// hele courier-HTTP-flowet:
//   - GET  /api/delivery/courier/today  (kun egne ruter)
//   - POST /api/delivery/routes/:id/depart
//   - POST /api/delivery/stops/:id/status  (leveret → bon → LEVERET)
//   - POST /api/delivery/incidents         (multipart + foto)
//   - rute auto-completes når alle stop er færdige
//   - auth-tjek (endpoints kræver login)
//
// Kør:
//   node --experimental-sqlite scripts/test-delivery-spor2-courier.js
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-spor2c-${Date.now()}.db`);
const PORT = 4328;
const BASE = `http://localhost:${PORT}`;
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function assertEqual(actual, expected, msg) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { console.log('  ✓', msg); pass++; }
    else    { console.error('  ✗', msg, '\n      expected:', expected, '\n      actual:  ', actual); fail++; }
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

let _cookies = [];
function getCookieHeader() { return _cookies.join('; '); }
function captureCookies(res) {
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
}
async function http(method, url, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const cookie = getCookieHeader();
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    const res = await fetch(BASE + url, {
        method, headers,
        body: body == null ? undefined : JSON.stringify(body),
    });
    captureCookies(res);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}
// Multipart POST (til /incidents)
async function httpMultipart(url, fields, photo) {
    const fd = new FormData();
    Object.keys(fields).forEach(k => fd.append(k, String(fields[k])));
    if (photo) fd.append('photo', new Blob([photo.buf], { type: photo.mime }), photo.name);
    const headers = {};
    const cookie = getCookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + url, { method: 'POST', headers, body: fd });
    captureCookies(res);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    // Test-admin med kendt PIN (fungerer som chauffør i denne test).
    const TEST_PIN = '9191';
    let admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else {
        const r = db.prepare(`INSERT INTO users (name, email, role, pin, is_active)
                               VALUES ('Test Bud', 'bud@local', 'admin', ?, 1)`).run(TEST_PIN);
        admin = { id: Number(r.lastInsertRowid) };
    }
    // En anden bruger — for at verificere at courier/today kun viser EGNE ruter.
    const otherUser = Number(db.prepare(`INSERT INTO users (name, email, role, is_active)
        VALUES ('Anden Bud', 'anden@local', 'kitchen_personal', 1)`).run().lastInsertRowid);

    const statusNY  = db.prepare(`SELECT id FROM status_definitions WHERE code='NY'`).get().id;
    const statusKLAR = db.prepare(`SELECT id FROM status_definitions WHERE code='KLAR'`).get().id;
    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const volvo = Number(db.prepare(`
        INSERT INTO delivery_vehicles (code, label, type, is_internal, booking_method, is_active, sort_order, color)
        VALUES ('t_s2c_volvo', 'Test Volvo', 'volvo', 1, 'calendar', 1, 99, '#8e631f')
    `).run().lastInsertRowid);

    function mkAddr() {
        return Number(db.prepare(`INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
            VALUES ('Testvej', '3', '2200', 'KBH N', 55.70, 12.56)`).run().lastInsertRowid);
    }
    function mkBon(num, statusId) {
        return Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
                              delivery_time, delivery_type, delivery_address_id, pax, boxes, total_units,
                              day_contact_name, day_contact_phone, delivery_notes)
            VALUES (?, ?, ?, ?, ?, '12:30', 'delivery', ?, 10, 4, 0, 'Maja', '+4512121212', 'Ring porttelefon')
        `).run(num, statusId, locId, TODAY, TODAY, mkAddr()).lastInsertRowid);
    }

    // Rute til chaufføren (admin) — 2 stop.
    const bonA = mkBon('T_DEL_A', statusKLAR);
    const bonB = mkBon('T_DEL_B', statusKLAR);
    const myRoute = Number(db.prepare(`
        INSERT INTO delivery_routes (route_date, vehicle_id, courier_user_id, status)
        VALUES (?, ?, ?, 'confirmed')
    `).run(TODAY, volvo, admin.id).lastInsertRowid);
    const stopA = Number(db.prepare(`INSERT INTO delivery_route_stops (route_id, bon_id, sequence)
        VALUES (?, ?, 1)`).run(myRoute, bonA).lastInsertRowid);
    const stopB = Number(db.prepare(`INSERT INTO delivery_route_stops (route_id, bon_id, sequence)
        VALUES (?, ?, 2)`).run(myRoute, bonB).lastInsertRowid);

    // Rute til en ANDEN bruger — må ikke dukke op i admin's courier/today.
    const bonC = mkBon('T_DEL_C', statusKLAR);
    const otherRoute = Number(db.prepare(`
        INSERT INTO delivery_routes (route_date, vehicle_id, courier_user_id, status)
        VALUES (?, ?, ?, 'confirmed')
    `).run(TODAY, volvo, otherUser).lastInsertRowid);
    db.prepare(`INSERT INTO delivery_route_stops (route_id, bon_id, sequence) VALUES (?, ?, 1)`)
        .run(otherRoute, bonC);
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

        if (!await waitForServer()) throw new Error('Server startede ikke');
        console.log('  ✓ server svarer');

        // ─── Auth-tjek: endpoints kræver login ─────────────
        console.log('\n=== Auth: courier-endpoints kræver login ===');
        const noAuth = await http('GET', '/api/delivery/courier/today', null, { noCookie: true });
        assert(noAuth.status === 401, `courier/today uden login → 401 (fik ${noAuth.status})`);

        // ─── Login ─────────────────────────────────────────
        console.log('\n=== Login ===');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        assert(login.status === 200, `PIN-login OK (status ${login.status})`);

        // ─── GET /courier/today ─────────────────────────────
        console.log('\n=== GET /api/delivery/courier/today ===');
        const ct = await http('GET', '/api/delivery/courier/today');
        assert(ct.status === 200, `Status 200 (fik ${ct.status})`);
        assertEqual(ct.data.date, TODAY, 'date = i dag');
        assertEqual(ct.data.routes.length, 1, 'kun chaufførens EGEN rute (1, ikke 2)');
        const route = ct.data.routes[0];
        assertEqual(route.id, myRoute, 'rigtige rute-id');
        assertEqual(route.stops.length, 2, 'ruten har 2 stop');
        assert(route.stops[0].bon_number === 'T_DEL_A', 'stop 1 = T_DEL_A');
        assert(route.stops[0].day_contact_name === 'Maja', 'kontakt på dagen med');
        assert(route.stops[0].delivery_notes === 'Ring porttelefon', 'leveringsnote med');
        assert(Array.isArray(route.stops[0].items), 'stop har items-array');
        assert(Array.isArray(route.stops[0].incidents), 'stop har incidents-array');

        // ─── POST /routes/:id/depart ────────────────────────
        console.log('\n=== POST /api/delivery/routes/:id/depart ===');
        const dep = await http('POST', `/api/delivery/routes/${myRoute}/depart`);
        assert(dep.status === 200, `depart OK (fik ${dep.status})`);
        assertEqual(dep.data.status, 'active', 'rute-status = active');

        // ─── POST /stops/:id/status — leveret ───────────────
        console.log('\n=== POST /api/delivery/stops/:id/status (leveret) ===');
        const badStatus = await http('POST', `/api/delivery/stops/${stopA}/status`, { status: 'flyvende' });
        assert(badStatus.status === 400, `ugyldig status → 400 (fik ${badStatus.status})`);

        const lev = await http('POST', `/api/delivery/stops/${stopA}/status`,
            { status: 'leveret', lat: 55.70, lng: 12.56 });
        assert(lev.status === 200, `leveret OK (fik ${lev.status})`);
        assertEqual(lev.data.bon_delivered, true, 'bon flyttet til LEVERET');
        assertEqual(lev.data.route_completed, false, 'ruten ikke færdig endnu (1 stop tilbage)');

        // ─── POST /incidents — multipart + foto ─────────────
        console.log('\n=== POST /api/delivery/incidents (multipart + foto) ===');
        const badInc = await httpMultipart('/api/delivery/incidents',
            { bon_id: bonB, incident_type: 'noget-vrøvl' });
        assert(badInc.status === 400, `ukendt incident_type → 400 (fik ${badInc.status})`);

        // 1x1 PNG
        const pngBuf = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
            'base64');
        const inc = await httpMultipart('/api/delivery/incidents', {
            bon_id: bonB,
            route_stop_id: stopB,
            incident_type: 'left_at_door',
            description: 'Stillet ved receptionen',
            location_lat: 55.71,
            location_lng: 12.57
        }, { buf: pngBuf, mime: 'image/png', name: 'foto.png' });
        assert(inc.status === 201, `incident oprettet (fik ${inc.status})`);
        assert(inc.data.incident_id > 0, 'incident_id returneret');
        assert(inc.data.photo_attachment_id > 0, 'foto gemt som attachment');

        // ─── Rute auto-completed ────────────────────────────
        console.log('\n=== Rute auto-completes når alle stop er færdige ===');
        const ct2 = await http('GET', '/api/delivery/courier/today');
        const r2 = ct2.data.routes[0];
        assertEqual(r2.status, 'completed', 'rute auto-completed (begge stop færdige)');
        assertEqual(r2.stops[0].status, 'leveret', 'stop A = leveret');
        assertEqual(r2.stops[1].status, 'problem', 'stop B = problem (incident)');
        assert((r2.stops[1].incidents || []).length === 1, 'stop B har 1 incident i historikken');

        // ─── Verificér bon-status + changelog ───────────────
        console.log('\n=== Bon-status efter levering ===');
        const bonAState = await http('GET', `/api/bons/${bonA}`);
        assertEqual(bonAState.data.status_code, 'LEVERET', 'bon A status = LEVERET');

        // ─── 404-tjek ───────────────────────────────────────
        console.log('\n=== 404 / fejl-tilfælde ===');
        const noStop = await http('POST', '/api/delivery/stops/999999/status', { status: 'leveret' });
        assert(noStop.status === 404, `ukendt stop → 404 (fik ${noStop.status})`);
        const noRoute = await http('POST', '/api/delivery/routes/999999/depart');
        assert(noRoute.status === 404, `ukendt rute → 404 (fik ${noRoute.status})`);

        console.log(`\n${pass} passed, ${fail} failed`);
    } finally {
        if (serverProc) serverProc.kill('SIGTERM');
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(TEST_DB + ext); } catch {}
        }
    }
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FEJL:', e); process.exit(1); });
