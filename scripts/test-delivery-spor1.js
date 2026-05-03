// scripts/test-delivery-spor1.js
// ==========================================
// Integration-test for Spor 1 (manuel bestilling).
//
// Spawner en frisk server mod en isoleret test-DB i /tmp så
// produktions-data forbliver urørt. Verificerer hele HTTP-flowet:
//   - GET /api/delivery/vehicles
//   - GET /api/delivery/booking-payload
//   - POST /api/delivery/book
//   - POST /api/delivery/actual-cost
//   - GET /api/delivery/events
//   - PATCH /api/delivery/vehicles/:id (admin-only)
//   - Auth-verificering (PATCH kræver admin)
//
// Kør:
//   node --experimental-sqlite scripts/test-delivery-spor1.js
// ==========================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-spor1-${Date.now()}.db`);
const PORT = 4327;
const BASE = `http://localhost:${PORT}`;

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

// Cookie-jar — så fetch holder session-cookie ved login
let _cookies = [];
function getCookieHeader() {
    return _cookies.join('; ');
}
function captureCookies(res) {
    const set = res.headers.get('set-cookie');
    if (set) {
        _cookies = [set.split(';')[0]];
    }
}
async function http(method, url, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const cookie = getCookieHeader();
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + url, {
        method, headers,
        body: body == null ? undefined : JSON.stringify(body),
        ...opts
    });
    captureCookies(res);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function main() {
    // ─── Setup test-DB ────────────────────────────────────
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    // Opret test-admin med kendt PIN (kun i denne test-DB)
    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    let existingAdmin = db.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`).get();
    if (existingAdmin) {
        db.prepare(`UPDATE users SET pin = ? WHERE id = ?`).run(TEST_PIN, existingAdmin.id);
    } else {
        db.prepare(`
            INSERT INTO users (name, email, role, pin, is_active)
            VALUES ('Test Admin', 'test-admin@local', 'admin', ?, 1)
        `).run(TEST_PIN);
    }
    let adminUser = db.prepare(`SELECT id, name FROM users WHERE pin = ? AND role = 'admin'`).get(TEST_PIN);

    // Opret test-bon
    const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code = 'NY' LIMIT 1`).get()?.id
                  || db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get()?.id;
    const addrId = Number(db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city)
        VALUES ('Nørre Allé', '7', '2200', 'København N')
    `).run().lastInsertRowid);
    const customerId = Number(db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone)
        VALUES ('Anne', 'Test', 'anne@test.dk', '+4512345678')
    `).run().lastInsertRowid);
    const bonId = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, customer_id,
                          order_date, delivery_date, delivery_time, pickup_time,
                          delivery_type, delivery_address_id, delivery_notes,
                          day_contact_name, day_contact_phone, pax, boxes)
        VALUES ('TEST-1', ?, ?, ?, '2026-05-03', '2026-05-15', '12:30', '12:00',
                'delivery', ?, 'Ring på dørtelefon', 'Lene', '+4522113344', 15, 4)
    `).run(statusId, locId, customerId, addrId).lastInsertRowid);
    db.close();

    let serverProc = null;
    try {
        // ─── Spawn server ──────────────────────────────────
        console.log(`\nStarter test-server på port ${PORT} med DB: ${TEST_DB}`);
        serverProc = spawn(
            'node',
            ['--experimental-sqlite', 'server.js'],
            {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        serverProc.stdout.on('data', d => { /* silent */ });
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) {
                process.stderr.write('  [server-err] ' + s);
            }
        });

        const ready = await waitForServer();
        if (!ready) throw new Error('Server startede ikke inden timeout');
        console.log('  ✓ server svarer');

        // ─── Login ─────────────────────────────────────────
        console.log('\n=== Login ===');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        assert(login.status === 200, `PIN-login OK (status ${login.status})`);
        assertEqual(login.data.role, 'admin', 'Logget ind som admin');

        // ─── Test 1: GET /vehicles ─────────────────────────
        console.log('\n=== GET /api/delivery/vehicles ===');
        const v1 = await http('GET', '/api/delivery/vehicles');
        assert(v1.status === 200, `Status 200 (fik ${v1.status})`);
        assert(Array.isArray(v1.data), 'Returnerer array');
        assert(v1.data.length >= 4, `Mindst 4 vehicles seedet (fik ${v1.data.length})`);

        const taxa = v1.data.find(v => v.code === 'taxa-4x35');
        const byekspressen = v1.data.find(v => v.code === 'byekspressen');
        assert(!!taxa, 'taxa-4x35 findes');
        assert(!!byekspressen, 'byekspressen findes');
        assertEqual(taxa.booking_method, 'manual_clipboard', 'taxa = manual_clipboard');
        assertEqual(taxa.booking_url, 'https://taxa.nu/', 'taxa URL');
        assertEqual(byekspressen.booking_url, 'https://byexpressen.groupnet.at/lobo/#!//coreLogin/', 'byekspressen URL');
        assert(taxa.cost_formula?.standard_inner_city === 250, 'taxa cost-formel parsed (standard 250)');

        // ─── Test 2: PATCH /vehicles/:id (sæt template) ────
        console.log('\n=== PATCH /api/delivery/vehicles/:id ===');
        const tplText = 'Bon: {bon_number}\nAdresse: {delivery_address}\nDato: {delivery_date}\nKontakt: {delivery_contact_name} ({delivery_contact_phone})';
        const p1 = await http('PATCH', `/api/delivery/vehicles/${taxa.id}`, {
            booking_template: tplText
        });
        assert(p1.status === 200, `PATCH OK (fik ${p1.status})`);
        assertEqual(p1.data.booking_template, tplText, 'Template gemt');

        // ─── Test 3: GET /booking-payload ──────────────────
        console.log('\n=== GET /api/delivery/booking-payload ===');
        const bp = await http('GET', `/api/delivery/booking-payload?bon_id=${bonId}&vehicle_id=${taxa.id}`);
        assert(bp.status === 200, `Status 200 (fik ${bp.status})`);
        assertEqual(bp.data.booking_method, 'manual_clipboard', 'booking_method');
        assertEqual(bp.data.booking_url, 'https://taxa.nu/', 'booking_url');
        assert(bp.data.clipboard_text.includes('TEST-1'), 'clipboard_text inkluderer bon_number');
        assert(bp.data.clipboard_text.includes('Nørre Allé 7'), 'clipboard_text inkluderer adresse');
        assert(bp.data.clipboard_text.includes('Lene'), 'clipboard_text inkluderer day_contact');
        assertEqual(bp.data.estimated_cost_dkk, 250, 'Estimat = 250 (taxa standard)');
        assertEqual(bp.data.bon.bon_number, 'TEST-1', 'bon-info i payload');

        // Manglende template → warning
        const bpEmpty = await http('GET', `/api/delivery/booking-payload?bon_id=${bonId}&vehicle_id=${byekspressen.id}`);
        assert(bpEmpty.status === 200, 'Status 200 selv uden template');
        assert(bpEmpty.data.warnings.includes('template_not_configured'), 'template_not_configured warning');
        assertEqual(bpEmpty.data.clipboard_text, null, 'clipboard_text=null uden template');

        // Ugyldig bon_id
        const bp404 = await http('GET', `/api/delivery/booking-payload?bon_id=99999&vehicle_id=${taxa.id}`);
        assertEqual(bp404.status, 404, 'Ugyldig bon_id → 404');

        // ─── Test 4: POST /book ────────────────────────────
        console.log('\n=== POST /api/delivery/book ===');
        const b1 = await http('POST', '/api/delivery/book', {
            bon_id: bonId,
            vehicle_id: taxa.id,
            reference: 'TEST-REF-1',
            status: 'booked'
        });
        assertEqual(b1.status, 201, 'Book → 201');
        assertEqual(b1.data.event_type, 'booked', 'event_type=booked');
        assertEqual(b1.data.external_reference, 'TEST-REF-1', 'reference gemt');

        // Ugyldig status
        const bInvalid = await http('POST', '/api/delivery/book', {
            bon_id: bonId, vehicle_id: taxa.id, status: 'completed'
        });
        assertEqual(bInvalid.status, 400, 'Ugyldig status → 400');

        // Manglende felter
        const bMissing = await http('POST', '/api/delivery/book', { bon_id: bonId });
        assertEqual(bMissing.status, 400, 'Mangler vehicle_id → 400');

        // Spring over (in_progress)
        const b2 = await http('POST', '/api/delivery/book', {
            bon_id: bonId, vehicle_id: byekspressen.id, status: 'in_progress'
        });
        assertEqual(b2.status, 201, 'Spring over (in_progress) → 201');

        // ─── Test 5: POST /actual-cost ─────────────────────
        console.log('\n=== POST /api/delivery/actual-cost ===');
        const c1 = await http('POST', '/api/delivery/actual-cost', {
            bon_id: bonId, amount_dkk: 275
        });
        assertEqual(c1.status, 200, 'Status 200');
        assertEqual(c1.data.delivery_cost, 275, 'Cost gemt');
        assertEqual(c1.data.delivery_cost_source, 'manual', 'Source = manual');

        // Ugyldig source
        const cInvalid = await http('POST', '/api/delivery/actual-cost', {
            bon_id: bonId, amount_dkk: 100, source: 'invalid'
        });
        assertEqual(cInvalid.status, 400, 'Ugyldig source → 400');

        // ─── Test 6: GET /events ───────────────────────────
        console.log('\n=== GET /api/delivery/events ===');
        const e1 = await http('GET', `/api/delivery/events?bon_id=${bonId}`);
        assertEqual(e1.status, 200, 'Status 200');
        assert(Array.isArray(e1.data), 'Returnerer array');
        assert(e1.data.length === 2, `2 events oprettet (fik ${e1.data.length})`);
        assert(e1.data.some(ev => ev.external_reference === 'TEST-REF-1'), 'TEST-REF-1 event findes');
        assert(e1.data.some(ev => ev.vehicle_label === 'Taxa 4×35'), 'vehicle_label joinet');

        // ─── Test 7: Auth — non-admin kan ikke PATCH ───────
        console.log('\n=== Auth: PATCH er admin-only ===');
        // Logout + opret office-bruger
        await http('POST', '/api/auth/logout');
        _cookies = [];

        // Tilføj office-bruger med PIN i test-DB
        const dbReopen = openDb(TEST_DB);
        const officePin = '8888';
        dbReopen.prepare(`
            INSERT INTO users (name, email, role, pin, is_active)
            VALUES ('Test Office', 'office@test', 'office', ?, 1)
        `).run(officePin);
        dbReopen.close();

        const officeLogin = await http('POST', '/api/auth/pin', { pin: officePin });
        assertEqual(officeLogin.status, 200, 'Office login OK');

        // GET /vehicles skal stadig virke for office
        const vAuth = await http('GET', '/api/delivery/vehicles');
        assertEqual(vAuth.status, 200, 'Office kan GET /vehicles');

        // GET booking-payload virker også
        const bpAuth = await http('GET', `/api/delivery/booking-payload?bon_id=${bonId}&vehicle_id=${taxa.id}`);
        assertEqual(bpAuth.status, 200, 'Office kan GET /booking-payload');

        // POST /book virker (åben for alle aktive brugere — vi besluttede dette)
        const bAuth = await http('POST', '/api/delivery/book', {
            bon_id: bonId, vehicle_id: taxa.id, status: 'booked'
        });
        assertEqual(bAuth.status, 201, 'Office kan POST /book');

        // PATCH /vehicles/:id skal IKKE virke for office
        const pAuth = await http('PATCH', `/api/delivery/vehicles/${taxa.id}`, {
            label: 'Hacked'
        });
        assertEqual(pAuth.status, 403, 'Office kan IKKE PATCH /vehicles (admin-only)');

        // ─── Test 8: Ikke-logget kan slet ikke ────────────
        console.log('\n=== Auth: Ikke-logget afvises ===');
        await http('POST', '/api/auth/logout');
        _cookies = [];

        const noAuth = await http('GET', '/api/delivery/vehicles');
        assertEqual(noAuth.status, 401, 'Ikke-logget → 401');

        console.log('\n=== Resultat ===');
        console.log(`✓ ${pass} passed,  ✗ ${fail} failed`);

    } finally {
        if (serverProc) {
            serverProc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 300));
            if (!serverProc.killed) serverProc.kill('SIGKILL');
        }
        // Slet test-DB
        try { fs.unlinkSync(TEST_DB); } catch (e) {}
        try { fs.unlinkSync(TEST_DB + '-wal'); } catch (e) {}
        try { fs.unlinkSync(TEST_DB + '-shm'); } catch (e) {}
        // Slet sessions DB
        const sessDir = path.join(path.dirname(TEST_DB), 'sessions.db');
        try { fs.unlinkSync(sessDir); } catch (e) {}
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
}).then(() => {
    process.exit(fail > 0 ? 1 : 0);
});
