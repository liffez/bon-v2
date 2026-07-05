// scripts/test-m8.js
// ==========================================
// Verifikation for M8 (Fase 14 — Booking-modul):
//
//   M8a: GET /b/:token → 302 redirect til tools-siden, no-bump
//        Ukendt token → 410 Gone, ugyldigt format → 400
//   M8b: GET /api/booking/token/:token →
//         - returnerer customer + intent + sales_user
//         - bumper open_count + sætter opened_at
//         - 404 ved ukendt, 410 ved udløbet
//   M8c: handleSmagningBooking + handleKontaktBooking respekterer token:
//         - booked_via = 'token_link'
//         - booking_tokens.booking_activity_id sættes
//         - intern notif springes over
//
// Strategi: spawn frisk server på PORT=4323 → HTTP-tests → SIGTERM i finally.
// ==========================================

const path = require('path');
const { spawn } = require('child_process');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const fs = require('fs');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

const { getDb } = require('../db/database');
const mailService = require('../services/mailService');

// Stub sendFromTemplate så vi ikke spammer rigtige mails ved test
const realSendFromTemplate = mailService.sendFromTemplate;
mailService.sendFromTemplate = async () => ({ messageId: 'stubbed', threadId: 0, subject: 'stubbed' });

const booking = require('../routes/booking');

const PORT = 4323;
const BASE = `http://localhost:${PORT}`;

function assert(cond, msg) {
    if (!cond) {
        console.error('  ✗', msg);
        process.exitCode = 1;
        throw new Error(msg);
    }
    console.log('  ✓', msg);
}

function setSetting(db, key, value) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
    else        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function getSetting(db, key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

async function waitForServer(maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(BASE + '/api/sse', { method: 'HEAD' });
            // Selv 401/404/etc. betyder at serveren svarer
            if (r.status > 0) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function main() {
    const db = getDb();

    // Find test-data
    const customer = db.prepare("SELECT id FROM customers WHERE LOWER(email) = LOWER(?)").get('leifzeeberg@hotmail.com')
                  || db.prepare("SELECT id FROM customers WHERE is_active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1").get();
    if (!customer) throw new Error('Ingen kunde fundet');

    const owner = db.prepare("SELECT id, email FROM users WHERE is_active = 1 AND email IS NOT NULL AND email != '' ORDER BY id LIMIT 1").get();
    if (!owner) throw new Error('Ingen aktiv bruger med email — kan ikke teste booking-ejer');

    const reason = db.prepare("SELECT id, key, label FROM contact_reasons WHERE key = 'send_menu' AND is_active = 1").get();
    if (!reason) throw new Error('contact_reason "send_menu" ikke fundet');

    // Husk og restore
    const savedDefaultOwner    = getSetting(db, 'booking_default_owner_user_id');
    const savedNotifyEnabled   = getSetting(db, 'booking_notify_owner_enabled');
    const savedSmagningEnabled = getSetting(db, 'booking_smagning_enabled');
    const savedKontaktEnabled  = getSetting(db, 'booking_kontakt_enabled');
    const savedPublicUrlBase   = getSetting(db, 'booking_public_url_base');

    setSetting(db, 'booking_smagning_enabled',     '1');
    setSetting(db, 'booking_kontakt_enabled',      '1');
    setSetting(db, 'booking_default_owner_user_id', String(owner.id));
    setSetting(db, 'booking_public_url_base',       BASE);
    setSetting(db, 'booking_notify_owner_enabled',  '1');

    const createdActivityIds = [];
    const createdTokens = [];

    let serverProc = null;
    try {
        // ─── Spawn server ─────────────────────────────────────
        console.log(`\nStarter test-server på port ${PORT}...`);
        serverProc = spawn(
            'node',
            ['--experimental-sqlite', 'server.js'],
            {
                cwd: path.join(__dirname, '..'),
                env: { ...process.env, PORT: String(PORT) },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        serverProc.stdout.on('data', d => {
            const s = d.toString();
            if (s.includes('SERVER KØRER') || s.includes('Server kører')) {
                process.stdout.write('  ' + s);
            }
        });
        serverProc.stderr.on('data', d => process.stderr.write('  [server-err] ' + d.toString()));

        const ready = await waitForServer();
        if (!ready) throw new Error('Server startede ikke inden timeout');
        console.log('  ✓ server svarer\n');

        // ─── Generér token til test ───────────────────────────
        const token = mailService.generateBookingToken({
            customer_id: customer.id,
            sales_user_id: owner.id,
            flow: 'smagning',
            intent_meeting_type_key: 'gennemgang',
            ttl_days: 60
        });
        createdTokens.push(token);
        console.log(`Test-token: ${token}\n`);

        // ─── M8b: Token info endpoint ─────────────────────────
        console.log('[M8b] GET /api/booking/token/:token');

        const r1 = await fetch(`${BASE}/api/booking/token/${token}`);
        assert(r1.ok, `Status 200 (fik ${r1.status})`);
        const j1 = await r1.json();
        assert(j1.token === token, 'Returnerer token');
        assert(j1.flow === 'smagning', 'flow = smagning');
        assert(j1.used === false, 'used = false (token endnu ikke forbrugt)');
        assert(j1.customer?.id === customer.id, `customer.id = ${customer.id}`);
        assert(j1.intent_meeting_type?.key === 'gennemgang', 'intent_meeting_type.key = gennemgang');
        assert(j1.sales_user?.id === owner.id, `sales_user.id = ${owner.id}`);

        // open_count + opened_at bumpet?
        const t1 = db.prepare('SELECT open_count, opened_at FROM booking_tokens WHERE token = ?').get(token);
        assert(t1.open_count === 1, `open_count = 1 efter første lookup (fik ${t1.open_count})`);
        assert(!!t1.opened_at, 'opened_at sat efter første lookup');

        // Andet lookup → open_count = 2, opened_at uændret
        const opened1 = t1.opened_at;
        await new Promise(r => setTimeout(r, 1100));
        await fetch(`${BASE}/api/booking/token/${token}`);
        const t2 = db.prepare('SELECT open_count, opened_at FROM booking_tokens WHERE token = ?').get(token);
        assert(t2.open_count === 2, `open_count = 2 efter andet lookup (fik ${t2.open_count})`);
        assert(t2.opened_at === opened1, 'opened_at uændret efter andet lookup');

        // Ukendt token → 404
        const r404 = await fetch(`${BASE}/api/booking/token/0000000000000000`);
        assert(r404.status === 404, `Ukendt token → 404 (fik ${r404.status})`);

        // Ugyldigt format → 400
        const r400 = await fetch(`${BASE}/api/booking/token/not-hex!`);
        assert(r400.status === 400, `Ugyldigt format → 400 (fik ${r400.status})`);

        // ─── M8a: Short URL redirect ─────────────────────────
        console.log('\n[M8a] GET /b/:token redirect');

        const r2 = await fetch(`${BASE}/b/${token}`, { redirect: 'manual' });
        assert(r2.status === 302, `Status 302 (fik ${r2.status})`);
        const loc = r2.headers.get('location');
        assert(loc === `/tools/booking-smagning.html?t=${token}`, `Location: /tools/booking-smagning.html?t=${token} (fik ${loc})`);

        // /b bumper IKKE — open_count stadig = 2 (fra tidligere)
        const t3 = db.prepare('SELECT open_count FROM booking_tokens WHERE token = ?').get(token);
        assert(t3.open_count === 2, `open_count uændret efter /b/ (= 2, fik ${t3.open_count})`);

        // Ukendt token → 410
        const r410 = await fetch(`${BASE}/b/0000000000000000`, { redirect: 'manual' });
        assert(r410.status === 410, `Ukendt /b/-token → 410 (fik ${r410.status})`);

        // Ugyldigt format → 400
        const r400b = await fetch(`${BASE}/b/not-hex!`, { redirect: 'manual' });
        assert(r400b.status === 400, `Ugyldigt /b/-format → 400 (fik ${r400b.status})`);

        // ─── M8c-A: handleSmagningBooking respekterer token ───
        console.log('\n[M8c] Token-flow: handleSmagningBooking');

        // Find ledigt slot
        const bookingMatcher = require('../services/bookingMatcher');
        const minDays = parseInt(getSetting(db, 'booking_min_days_ahead') || '2');
        const blocked = JSON.parse(getSetting(db, 'booking_blocked_weekdays') || '[0]');
        let target = new Date(); target.setHours(0,0,0,0);
        target.setDate(target.getDate() + minDays + 8);
        while (blocked.includes(target.getDay())) target.setDate(target.getDate() + 1);
        const dateStr = target.toISOString().slice(0, 10);

        const slots = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
        const freeSlot = slots.slots.find(s => s.available);
        if (!freeSlot) throw new Error('Ingen ledige slots');

        const sRes = booking.handleSmagningBooking({
            token,
            first_name: 'TokenTest',
            email:      'leifzeeberg@hotmail.com',
            date:       dateStr,
            time:       freeSlot.time,
            meeting_type: 'smagning'
        });
        assert(sRes?.activityId, `Booking oprettet: activity #${sRes?.activityId}`);
        createdActivityIds.push(sRes.activityId);

        const act = db.prepare('SELECT booked_via FROM crm_activities WHERE id = ?').get(sRes.activityId);
        assert(act.booked_via === 'token_link', `booked_via = token_link (fik ${act.booked_via})`);

        const tFinal = db.prepare('SELECT booking_activity_id FROM booking_tokens WHERE token = ?').get(token);
        assert(tFinal.booking_activity_id === sRes.activityId, 'booking_tokens.booking_activity_id sat korrekt');

        // ─── M8c-B: handleKontaktBooking respekterer token ────
        console.log('\n[M8c] Token-flow: handleKontaktBooking');

        // Nyt token til kontakt-flow (det forrige er nu forbrugt)
        const kontaktToken = mailService.generateBookingToken({
            customer_id: customer.id,
            sales_user_id: owner.id,
            flow: 'kontakt',
            intent_meeting_type_key: null,
            ttl_days: 60
        });
        createdTokens.push(kontaktToken);

        const kRes = booking.handleKontaktBooking({
            token: kontaktToken,
            first_name: 'TokenTest',
            email:      'leifzeeberg@hotmail.com',
            reason:     'send_menu',
            message:    'Token-kontakt-test'
        });
        assert(kRes?.activityId, `Kontakt-task oprettet: activity #${kRes?.activityId}`);
        createdActivityIds.push(kRes.activityId);

        const kAct = db.prepare('SELECT booked_via FROM crm_activities WHERE id = ?').get(kRes.activityId);
        assert(kAct.booked_via === 'token_link', `kontakt booked_via = token_link (fik ${kAct.booked_via})`);

        const kTokFinal = db.prepare('SELECT booking_activity_id FROM booking_tokens WHERE token = ?').get(kontaktToken);
        assert(kTokFinal.booking_activity_id === kRes.activityId, 'kontakt-token markeret som forbrugt');

        // ─── used:true når token er forbrugt ──────────────────
        console.log('\n[M8b] used-flag når token er forbrugt');

        const r3 = await fetch(`${BASE}/api/booking/token/${token}`);
        const j3 = await r3.json();
        assert(j3.used === true, `used = true efter booking (fik ${j3.used})`);

        console.log('\n✅ M8 alle tests bestået');

    } finally {
        // ─── Cleanup ──────────────────────────────────────────
        if (serverProc) {
            serverProc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 300));
            if (!serverProc.killed) serverProc.kill('SIGKILL');
        }

        // booking_tokens før crm_activities (FK)
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
        }
        for (const t of createdTokens) {
            db.prepare('DELETE FROM booking_tokens WHERE token = ?').run(t);
        }
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
        }

        const restoreOrUnset = (key, val) => {
            if (val === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
            else setSetting(db, key, val);
        };
        restoreOrUnset('booking_default_owner_user_id', savedDefaultOwner);
        restoreOrUnset('booking_notify_owner_enabled',  savedNotifyEnabled);
        restoreOrUnset('booking_smagning_enabled',      savedSmagningEnabled);
        restoreOrUnset('booking_kontakt_enabled',       savedKontaktEnabled);
        restoreOrUnset('booking_public_url_base',       savedPublicUrlBase);

        mailService.sendFromTemplate = realSendFromTemplate;

        console.log('\n🧹 Test-data ryddet op + server stoppet');
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
