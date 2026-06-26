// scripts/test-delivery-lobo.js
// ==========================================
// REGRESSIONS-test for By-expressen/Lobo-integrationen (trin 1-3 + webhooks).
//
// Formål: fange hvis ændringer ANDRE STEDER i Bon brækker Lobo-integrationen —
// uden at ramme det rigtige Lobo-API. Spawner en frisk server mod en isoleret
// migreret test-DB (så schema-ændringer i bons/delivery_events/settings fanges)
// og kører hele HTTP-flowet for de stier der IKKE kræver Lobo-netværk:
//
//   - Endpoints er monteret + auth-gated korrekt (mount-regression)
//   - GET/POST /lobo/status + /lobo/sandbox (master-kontakt, DB-only)
//   - GET /lobo/order-status guards (booked:false / 400)
//   - GET /lobo/webhooks (registrerings-status, DB-only)
//   - POST /api/webhooks/lobo: SELVKALIBRERENDE HMAC end-to-end gennem den
//     RIGTIGE route + RIGTIGE schema: simuleret signeret 'finished'-callback →
//     kalibrerer (verify flippes, format gemt) → event anvendt → idempotent →
//     forfalsket signatur afvises efter kalibrering.
//
// Stier der kræver Lobo-netværk (preview/book/order-status m. booking/register)
// dækkes af unit-tests (injiceret adapter) + manuel live-verifikation.
//
// Kør:  node --experimental-sqlite scripts/test-delivery-lobo.js
// ==========================================

const path = require('path');
const os = require('os');
const crypto = require('node:crypto');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-lobo-${Date.now()}.db`);
const PORT = 4329;
const BASE = `http://localhost:${PORT}`;
const TEST_PIN = '9999';
const ORDER_UUID = 'test-order-uuid-0001';

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
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch { /* */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
function captureCookies(res) { const set = res.headers.get('set-cookie'); if (set) _cookies = [set.split(';')[0]]; }
async function http(method, url, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    captureCookies(res);
    let data = null; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    // Admin med kendt PIN
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);

    // En leverings-bon + adresse + kunde
    const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code='NY' LIMIT 1`).get()?.id
                  || db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get()?.id;
    const addrId = Number(db.prepare(`INSERT INTO addresses (street_name,street_nr,postal_code,city) VALUES ('Bülowsvej','21','1870','Frederiksberg C')`).run().lastInsertRowid);
    const custId = Number(db.prepare(`INSERT INTO customers (first_name,last_name,email,phone) VALUES ('Anne','Test','anne@test.dk','+4528145590')`).run().lastInsertRowid);
    const bonId = Number(db.prepare(`
        INSERT INTO bons (bon_number,status_id,location_id,customer_id,order_date,delivery_date,delivery_time,pickup_time,
                          delivery_type,delivery_address_id,delivery_notes,day_contact_name,day_contact_phone,pax,boxes)
        VALUES ('B4089',?,?,?,'2026-06-20','2026-06-24','11:45','11:00','delivery',?,'3. sal','Anne','+4528145590',60,4)
    `).run(statusId, locId, custId, addrId).lastInsertRowid);

    // En bon UDEN booking (til order-status booked:false-guard)
    const bonNoBook = Number(db.prepare(`
        INSERT INTO bons (bon_number,status_id,location_id,customer_id,order_date,delivery_date,delivery_type,delivery_address_id,pax)
        VALUES ('B4090',?,?,?,'2026-06-20','2026-06-24','delivery',?,10)
    `).run(statusId, locId, custId, addrId).lastInsertRowid);

    // En 'booked' delivery_event så webhook-callbacket kan linke uuid → bon
    const veh = db.prepare(`SELECT id FROM delivery_vehicles WHERE code='byekspressen'`).get();
    db.prepare(`INSERT INTO delivery_events (bon_id,event_type,provider,external_reference,vehicle_id,event_time)
                VALUES (?, 'booked', 'byekspressen', ?, ?, CURRENT_TIMESTAMP)`).run(bonId, ORDER_UUID, veh.id);

    // Webhook-nøgler (som efter en registrering) — verify endnu ikke kalibreret
    const KEY_FINISHED = 'finished-secret-key';
    const keys = { dispatched: 'k-disp', finished: KEY_FINISHED, changed: 'k-chg' };
    const setS = (k, v) => db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
    setS('lobo_webhook_keys', JSON.stringify(keys));
    setS('lobo_webhook_url', 'https://bon.ristetrug.dk/api/webhooks/lobo');
    setS('lobo_webhook_algorithm', 'sha256');
    db.close();

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på ${PORT} (DB ${TEST_DB})`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc.stderr.on('data', d => { const s = d.toString(); if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write('  [srv] ' + s); });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        console.log('  ✓ server svarer');

        // ─── Auth-gating (mount-regression) ───────────────────────────
        console.log('\n=== Auth-gating ===');
        assert((await http('GET', '/api/delivery/lobo/webhooks')).status === 401, 'GET /lobo/webhooks kræver login (401 uden)');
        assert((await http('POST', '/api/delivery/lobo/sandbox', { enabled: true })).status === 401, 'POST /lobo/sandbox kræver login (401 uden)');

        console.log('\n=== Login ===');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        assertEqual(login.data && login.data.role, 'admin', 'Logget ind som admin');

        // ─── /lobo/status + master-kontakt (DB-only, ingen netværk) ───
        console.log('\n=== /lobo/status + /lobo/sandbox ===');
        const st0 = await http('GET', '/api/delivery/lobo/status');
        assert(st0.status === 200 && st0.data.configured === true, 'status: configured=true (vogn har config)');
        assert(typeof st0.data.use_sandbox === 'boolean', 'status: use_sandbox er boolean');
        const on = await http('POST', '/api/delivery/lobo/sandbox', { enabled: true });
        assert(on.status === 200 && on.data.use_sandbox === true, 'sandbox ON → use_sandbox=true');
        assert((await http('GET', '/api/delivery/lobo/status')).data.host.includes('/sandbox/'), 'host skifter til sandbox-URL');
        await http('POST', '/api/delivery/lobo/sandbox', { enabled: false });
        assert(!(await http('GET', '/api/delivery/lobo/status')).data.host.includes('/sandbox/'), 'sandbox OFF → produktions-host');

        // ─── order-status guards (uden Lobo-netværk) ─────────────────
        console.log('\n=== /lobo/order-status guards ===');
        assert((await http('GET', '/api/delivery/lobo/order-status')).status === 400, 'manglende bon_id → 400');
        const noBook = await http('GET', `/api/delivery/lobo/order-status?bon_id=${bonNoBook}`);
        assert(noBook.status === 200 && noBook.data.booked === false, 'bon uden booking → {booked:false}');

        // ─── webhook-registrerings-status (DB-only) ──────────────────
        console.log('\n=== /lobo/webhooks status ===');
        const wh0 = await http('GET', '/api/delivery/lobo/webhooks');
        assert(wh0.status === 200, 'GET /lobo/webhooks OK');
        assert(wh0.data.registered === true && wh0.data.events.includes('finished'), 'viser seedede nøgler som registreret');
        assertEqual(wh0.data.calibrated, false, 'calibrated=false før første callback');

        // ─── SELVKALIBRERENDE WEBHOOK end-to-end gennem rigtig route ──
        console.log('\n=== Webhook self-calibration (rigtig route + schema) ===');
        // Simulér Lobo: signér query-strengen med 'finished'-nøglen, læg i x-lobo-signature.
        const qs = `ts=1719230400&event=finished&target=order&orderuuid=${ORDER_UUID}`;
        const sig = crypto.createHmac('sha256', KEY_FINISHED).update(qs, 'utf8').digest('hex');
        const cb1 = await http('POST', `/api/webhooks/lobo?${qs}`, null, { 'x-lobo-signature': sig });
        assert(cb1.status === 200 && cb1.data.ok === true, 'callback → 200 {ok:true}');

        const whCal = await http('GET', '/api/delivery/lobo/webhooks');
        assertEqual(whCal.data.calibrated, true, 'AUTO-KALIBRERET: verify flippet til 1');
        assertEqual(whCal.data.sig_header, 'x-lobo-signature', 'opdaget header gemt');
        assertEqual(whCal.data.sign_target, 'query', 'opdaget signeret streng = query');

        // Event anvendt? Re-åbn DB read-only og tjek delivery_events.
        const db2 = openDb(TEST_DB);
        const delivered = db2.prepare(`SELECT COUNT(*) n FROM delivery_events WHERE bon_id=? AND event_type='delivered'`).get(bonId);
        assert(delivered.n === 1, "event anvendt: 'delivered' delivery_event oprettet");

        // Idempotens: samme callback igen → ingen dublet
        await http('POST', `/api/webhooks/lobo?${qs}`, null, { 'x-lobo-signature': sig });
        const delivered2 = db2.prepare(`SELECT COUNT(*) n FROM delivery_events WHERE bon_id=? AND event_type='delivered'`).get(bonId);
        assert(delivered2.n === 1, 'idempotent: ingen dublet ved gentaget callback');

        // Efter kalibrering: forfalsket signatur afvises + intet nyt event
        const before = db2.prepare(`SELECT COUNT(*) n FROM delivery_events WHERE bon_id=?`).get(bonId).n;
        const qs2 = `ts=1719230999&event=finished&target=order&orderuuid=${ORDER_UUID}`;
        const bad = await http('POST', `/api/webhooks/lobo?${qs2}`, null, { 'x-lobo-signature': 'deadbeef'.repeat(8) });
        assert(bad.data && bad.data.ok === false, 'forfalsket signatur afvist ({ok:false}) efter kalibrering');
        const after = db2.prepare(`SELECT COUNT(*) n FROM delivery_events WHERE bon_id=?`).get(bonId).n;
        assert(after === before, 'forfalsket callback tilføjede intet event');
        db2.close();

    } finally {
        if (serverProc) serverProc.kill();
    }

    console.log(`\n${'='.repeat(40)}\nRESULTAT: ${pass} passed, ${fail} failed\n${'='.repeat(40)}`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
