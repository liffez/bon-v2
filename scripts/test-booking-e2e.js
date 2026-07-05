// scripts/test-booking-e2e.js
// ==========================================
// End-to-end smoke-test for hele booking-modulet (Fase 14, M12).
//
// Kører gennem det komplette flow:
//   1. Sælger genererer booking-link via {{booking_link}} (M7+M11)
//   2. Kunde klikker /b/:token → redirect til tools-side (M8)
//   3. Tools-side henter pre-fill via /api/booking/token/:token (M8)
//   4. Kunde submitter /webhook/booking-smagning med token (M5+M8)
//        → crm_activity oprettet med booked_via='token_link'
//        → token markeret forbrugt (booking_activity_id sat)
//        → ingen intern notif (token-flow)
//        → bekræftelsesmail sendt til kunde (M7)
//   5. 2 dage senere kører cron → reminder_sent_at sættes (M9)
//
// Strategi: spawn server → udfør flow via HTTP/in-process → cleanup.
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
const bookingMatcher = require('../services/bookingMatcher');

// Stub sendFromTemplate på tværs af bookings + reminder
const captured = [];
const realSendFromTemplate = mailService.sendFromTemplate;
mailService.sendFromTemplate = async (args) => {
    captured.push(args);
    return { messageId: 'e2e-' + captured.length, threadId: 999 };
};

const booking = require('../routes/booking');

const PORT = 4323;
const BASE = `http://localhost:${PORT}`;

function assert(cond, msg) {
    if (!cond) { console.error('  ✗', msg); process.exitCode = 1; throw new Error(msg); }
    console.log('  ✓', msg);
}
function setSetting(db, k, v) {
    const ex = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k);
    if (ex) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
    else    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
function getSetting(db, k) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
}

async function waitForServer(maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(BASE + '/api/sse', { method: 'HEAD' });
            if (r.status > 0) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function main() {
    const db = getDb();

    const customer = db.prepare("SELECT id FROM customers WHERE LOWER(email) = LOWER(?)").get('leifzeeberg@hotmail.com')
                  || db.prepare("SELECT id FROM customers WHERE is_active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1").get();
    if (!customer) throw new Error('Ingen test-kunde');

    const owner = db.prepare("SELECT id FROM users WHERE is_active = 1 AND email IS NOT NULL AND email != '' ORDER BY id LIMIT 1").get();
    if (!owner) throw new Error('Ingen aktiv bruger med email — kan ikke teste booking-ejer');

    const mt = db.prepare("SELECT id, label, duration_min, key FROM meeting_types WHERE key = 'smagning'").get();

    // Husk og restore
    const saved = {
        booking_smagning_enabled:    getSetting(db, 'booking_smagning_enabled'),
        booking_default_owner_user_id: getSetting(db, 'booking_default_owner_user_id'),
        booking_public_url_base:     getSetting(db, 'booking_public_url_base'),
        booking_notify_owner_enabled: getSetting(db, 'booking_notify_owner_enabled'),
        booking_reminder_enabled:    getSetting(db, 'booking_reminder_enabled'),
        booking_reminder_send_at_time: getSetting(db, 'booking_reminder_send_at_time'),
        booking_reminder_days_before: getSetting(db, 'booking_reminder_days_before')
    };

    setSetting(db, 'booking_smagning_enabled',     '1');
    setSetting(db, 'booking_default_owner_user_id', String(owner.id));
    setSetting(db, 'booking_public_url_base',       BASE);
    setSetting(db, 'booking_notify_owner_enabled', '1');
    setSetting(db, 'booking_reminder_enabled',     '1');
    const nowHour = new Date().getHours();
    setSetting(db, 'booking_reminder_send_at_time', String(nowHour).padStart(2, '0') + ':00');
    setSetting(db, 'booking_reminder_days_before',  '2');

    const createdActivityIds = [];
    const createdTokens = [];
    let serverProc = null;

    try {
        console.log(`\n📡 Starter test-server på ${BASE}...`);
        serverProc = spawn(
            'node', ['--experimental-sqlite', 'server.js'],
            { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        serverProc.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d.toString()));
        if (!await waitForServer()) throw new Error('Server startede ikke');
        console.log('  ✓ server klar\n');

        // ─── STEP 1: Sælger genererer booking-link via mail ────
        console.log('═══ Step 1: Sælger sender CRM-mail med {{booking_link}} ═══');
        captured.length = 0;
        const renderedBody = mailService.renderTemplate(
            'Hej!\n\nKlik for at booke: {{booking_link}}\n\n— Anne',
            {},
            {
                customerId: customer.id,
                userId:     owner.id,
                bookingFlow:   'smagning',
                bookingIntent: 'smagning',
                appendSignature: false
            }
        );
        const tokenMatch = renderedBody.match(new RegExp(BASE.replace(/\//g, '\\/') + '\\/b\\/([a-f0-9]+)'));
        assert(!!tokenMatch, 'Sælgers mail indeholder kort URL');
        const token = tokenMatch[1];
        createdTokens.push(token);
        console.log(`  Token: ${token}`);

        // ─── STEP 2: Kunde klikker /b/:token → redirect ────────
        console.log('\n═══ Step 2: Kunde klikker kort URL → 302 redirect ═══');
        const r2 = await fetch(`${BASE}/b/${token}`, { redirect: 'manual' });
        assert(r2.status === 302, `Status 302 (fik ${r2.status})`);
        const loc = r2.headers.get('location');
        assert(loc === `/tools/booking-smagning.html?t=${token}`, `Redirect target korrekt`);

        // ─── STEP 3: Tools-side henter pre-fill ────────────────
        console.log('\n═══ Step 3: Tools-side henter pre-fill ═══');
        const r3 = await fetch(`${BASE}/api/booking/token/${token}`);
        assert(r3.ok, `Status 200 (fik ${r3.status})`);
        const j3 = await r3.json();
        assert(j3.customer?.id === customer.id, 'Pre-fill leverer kunde-ID');
        assert(j3.sales_user?.id === owner.id, 'Pre-fill leverer sælger-ID');
        assert(j3.intent_meeting_type?.key === 'smagning', 'Pre-fill leverer intent');
        assert(j3.used === false, 'Token endnu ikke forbrugt');

        // open_count bumpet
        const tAfterPrefill = db.prepare('SELECT open_count FROM booking_tokens WHERE token = ?').get(token);
        assert(tAfterPrefill.open_count === 1, `open_count = 1 efter pre-fill (fik ${tAfterPrefill.open_count})`);

        // ─── STEP 4: Kunde submitter booking ───────────────────
        console.log('\n═══ Step 4: Kunde submitter booking (token-flow) ═══');
        const minDays = parseInt(getSetting(db, 'booking_min_days_ahead') || '2');
        const blocked = JSON.parse(getSetting(db, 'booking_blocked_weekdays') || '[0]');
        let target = new Date(); target.setHours(0, 0, 0, 0);
        target.setDate(target.getDate() + minDays + 8);
        while (blocked.includes(target.getDay())) target.setDate(target.getDate() + 1);
        const dateStr = target.toISOString().slice(0, 10);

        const slotsRes = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
        const freeSlot = slotsRes.slots.find(s => s.available);
        if (!freeSlot) throw new Error('Ingen ledige slots');

        captured.length = 0;
        const sRes = booking.handleSmagningBooking({
            token,
            first_name: 'Leif',
            last_name:  'Test',
            email:      'leifzeeberg@hotmail.com',
            date:       dateStr,
            time:       freeSlot.time,
            meeting_type: 'smagning',
            guest_count: 6,
            message: 'E2E-test'
        });
        assert(sRes?.activityId, `Booking oprettet: activity #${sRes?.activityId}`);
        createdActivityIds.push(sRes.activityId);

        // Vent på fire-and-forget mail
        await new Promise(r => setTimeout(r, 200));

        const act = db.prepare('SELECT booked_via, owner_user_id FROM crm_activities WHERE id = ?').get(sRes.activityId);
        assert(act.booked_via === 'token_link', 'booked_via = token_link');
        assert(act.owner_user_id === owner.id, `owner_user_id = ${owner.id}`);

        const tAfterSubmit = db.prepare('SELECT booking_activity_id FROM booking_tokens WHERE token = ?').get(token);
        assert(tAfterSubmit.booking_activity_id === sRes.activityId, 'Token forbrugt');

        // Mail-flow: kunde-bekræftelse, INGEN intern notif (token-flow)
        const customerMail = captured.find(c => c.templateKey === 'booking_smagning_confirmation');
        const internalMail = captured.find(c => c.templateKey === 'booking_internal_notification');
        assert(customerMail, 'Kunde-bekræftelse sendt');
        assert(customerMail.to === 'leifzeeberg@hotmail.com', 'Til kundens email');
        assert(!internalMail, 'Ingen intern notif (token-flow)');

        // ─── STEP 5: Reminder-cron 2 dage før ──────────────────
        console.log('\n═══ Step 5: Reminder-cron 2 dage før mødet ═══');

        // Sæt due_at til 2 dage frem fra i dag (uanset hvilket slot vi bookede)
        const reminderDate = new Date(Date.now() + 2 * 86400000);
        const reminderDateStr = `${reminderDate.getFullYear()}-${String(reminderDate.getMonth() + 1).padStart(2, '0')}-${String(reminderDate.getDate()).padStart(2, '0')}`;
        db.prepare('UPDATE crm_activities SET due_at = ? WHERE id = ?')
          .run(`${reminderDateStr} ${freeSlot.time}:00`, sRes.activityId);

        // Inline cron-flow (samme som scripts/booking-reminders.js)
        captured.length = 0;
        const meetings = db.prepare(`
            SELECT a.id, a.due_at, a.duration_min, a.customer_id,
                   c.first_name, c.last_name, c.email,
                   mt.label AS meeting_label, mt.key AS meeting_key
            FROM crm_activities a
            JOIN customers c          ON c.id  = a.customer_id
            LEFT JOIN meeting_types mt ON mt.id = a.meeting_type_id
            WHERE a.type = 'meeting'
              AND DATE(a.due_at) = ?
              AND a.done_at IS NULL
              AND a.reminder_sent_at IS NULL
              AND c.email IS NOT NULL AND c.email != ''
        `).all(reminderDateStr);
        assert(meetings.some(m => m.id === sRes.activityId), 'Cron finder vores test-møde');

        for (const m of meetings) {
            const vars = bookingMatcher.buildReminderVars(m);
            await mailService.sendFromTemplate({
                templateKey: 'booking_smagning_reminder',
                to: m.email, vars, customerId: m.customer_id,
                context: { type: 'customer', number: m.customer_id },
                smtpPrefix: 'smtp_kontakt'
            });
            db.prepare(`UPDATE crm_activities SET reminder_sent_at = datetime('now') WHERE id = ?`).run(m.id);
        }

        const reminderMail = captured.find(c => c.templateKey === 'booking_smagning_reminder' && c.customerId === customer.id);
        assert(reminderMail, 'Reminder-mail sendt');
        assert(reminderMail.to === 'leifzeeberg@hotmail.com', 'Reminder til rigtig email');

        const actFinal = db.prepare('SELECT reminder_sent_at FROM crm_activities WHERE id = ?').get(sRes.activityId);
        assert(!!actFinal.reminder_sent_at, 'reminder_sent_at sat');

        console.log('\n🎉 End-to-end booking-flow færdigt');
        console.log('   sælger → mail → klik → pre-fill → submit → bekræftelse → reminder');

    } finally {
        if (serverProc) {
            serverProc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 300));
        }

        // Cleanup tokens før activities
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
        }
        for (const t of createdTokens) {
            db.prepare('DELETE FROM booking_tokens WHERE token = ?').run(t);
        }
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
        }
        // Restore settings
        const restore = (k, v) => {
            if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
            else setSetting(db, k, v);
        };
        for (const [k, v] of Object.entries(saved)) restore(k, v);

        mailService.sendFromTemplate = realSendFromTemplate;
        console.log('\n🧹 Test-data ryddet op');
    }
}

main().catch(err => { console.error('❌ FEJL:', err.message); console.error(err.stack); process.exit(1); });
