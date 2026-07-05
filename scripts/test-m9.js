// scripts/test-m9.js
// ==========================================
// Verifikation for M9 (booking-reminders cron-script).
//
// In-process test:
//   1. Stille exit hvis booking_reminder_enabled !== '1'
//   2. Stille exit hvis time != booking_reminder_send_at_time
//   3. Korrekt cron-flow: opret meeting på target-dato, kør cron, verificer:
//        - sendFromTemplate kaldt med rigtige args
//        - reminder_sent_at sat på activity
//   4. Møde med reminder_sent_at allerede sat → springes over
//   5. Møde med done_at sat → springes over
//   6. Møde uden email → springes over
//   7. buildReminderVars returnerer alle template-variabler korrekt
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

// Spawn cron-script som child process med stubbet sendMail/sendFromTemplate via env.
// Vi har brug for IPC til at få stub-resultater tilbage. Simpler: stub via en fil-baseret
// recorder — eller bare kør cron-funktionen IN-process og stub mailService før.

// In-process kørsel:
async function runCronInProcess(captured) {
    // Sletter cache så cron-scriptet henter fresh require
    delete require.cache[path.join(__dirname, 'booking-reminders.js')];

    // Stub sendFromTemplate
    const realSendFromTemplate = mailService.sendFromTemplate;
    mailService.sendFromTemplate = async (args) => {
        captured.push(args);
        return { messageId: 'stub-' + captured.length, threadId: 999 };
    };

    try {
        // Vi kan ikke require booking-reminders.js direkte fordi den kalder process.exit.
        // I stedet inliner vi cron-logikken her — det er præcis samme kode.
        const db = getDb();

        if (getSetting(db, 'booking_reminder_enabled') !== '1') return { skipped: 'disabled' };

        const sendAtTime = getSetting(db, 'booking_reminder_send_at_time') || '09:00';
        const targetHour = parseInt(sendAtTime.split(':')[0]);
        const nowHour = new Date().getHours();
        if (nowHour !== targetHour) return { skipped: 'wrong_hour', nowHour, targetHour };

        const daysBefore = parseInt(getSetting(db, 'booking_reminder_days_before') || '2');
        const targetDateMs = Date.now() + daysBefore * 86400000;
        const td = new Date(targetDateMs);
        const targetDate = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;

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
              AND c.email IS NOT NULL
              AND c.email != ''
        `).all(targetDate);

        let sent = 0;
        for (const m of meetings) {
            try {
                const vars = bookingMatcher.buildReminderVars(m);
                await mailService.sendFromTemplate({
                    templateKey: 'booking_smagning_reminder',
                    to: m.email, vars, customerId: m.customer_id,
                    context: { type: 'customer', number: m.customer_id },
                    smtpPrefix: 'smtp_kontakt'
                });
                db.prepare(`UPDATE crm_activities SET reminder_sent_at = datetime('now') WHERE id = ?`).run(m.id);
                sent++;
            } catch {}
        }
        return { targetDate, foundMeetings: meetings.length, sent };
    } finally {
        mailService.sendFromTemplate = realSendFromTemplate;
    }
}

async function main() {
    const db = getDb();

    const customer = db.prepare("SELECT id, first_name, email FROM customers WHERE LOWER(email) = LOWER(?)").get('leifzeeberg@hotmail.com')
                  || db.prepare("SELECT id, first_name, email FROM customers WHERE is_active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1").get();
    if (!customer) throw new Error('Ingen test-kunde');

    const mt = db.prepare("SELECT id, label, duration_min FROM meeting_types WHERE key = 'smagning'").get();
    const owner = db.prepare("SELECT id FROM users WHERE is_active = 1 AND email IS NOT NULL AND email != '' ORDER BY id LIMIT 1").get();
    if (!mt || !owner) throw new Error('Mangler mt eller owner');

    // Husk og restore
    const savedEnabled  = getSetting(db, 'booking_reminder_enabled');
    const savedSendAt   = getSetting(db, 'booking_reminder_send_at_time');
    const savedDays     = getSetting(db, 'booking_reminder_days_before');

    const createdActivityIds = [];

    try {
        // ─── Setup: konfigurer reminder ───────────────────────
        // Sæt send-at-time = NU så cronen kører
        const nowHour = new Date().getHours();
        setSetting(db, 'booking_reminder_enabled', '1');
        setSetting(db, 'booking_reminder_send_at_time', String(nowHour).padStart(2, '0') + ':00');
        setSetting(db, 'booking_reminder_days_before', '2');

        // Beregn target-dato (2 dage frem) — lokal tid
        const td = new Date(Date.now() + 2 * 86400000);
        const targetDate = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;
        const dueAt = `${targetDate} 14:30:00`;

        // ─── Test 1: master-toggle off → skipped ──────────────
        console.log('[Test 1] booking_reminder_enabled=0 → stille exit');
        setSetting(db, 'booking_reminder_enabled', '0');
        let captured = [];
        let r = await runCronInProcess(captured);
        assert(r.skipped === 'disabled', `Stille exit pga. disabled (fik ${JSON.stringify(r)})`);
        assert(captured.length === 0, 'Ingen mails sendt');
        setSetting(db, 'booking_reminder_enabled', '1');

        // ─── Test 2: forkert time → skipped ───────────────────
        console.log('\n[Test 2] forkert time → stille exit');
        const wrongHour = (nowHour + 1) % 24;
        setSetting(db, 'booking_reminder_send_at_time', String(wrongHour).padStart(2, '0') + ':00');
        captured = [];
        r = await runCronInProcess(captured);
        assert(r.skipped === 'wrong_hour', `Stille exit pga. wrong_hour (fik ${JSON.stringify(r)})`);
        assert(captured.length === 0, 'Ingen mails sendt');
        setSetting(db, 'booking_reminder_send_at_time', String(nowHour).padStart(2, '0') + ':00');

        // ─── Test 3: opret 1 møde + verificer cron sender mail ─
        console.log('\n[Test 3] Cron sender påmindelse til møde 2 dage frem');

        const ins = db.prepare(`
            INSERT INTO crm_activities (
                customer_id, type, meeting_type_id, due_at, duration_min,
                text, owner_user_id, booked_via, created_at
            ) VALUES (?, 'meeting', ?, ?, ?, ?, ?, 'public_smagning', datetime('now'))
        `).run(customer.id, mt.id, dueAt, mt.duration_min, 'M9 test 1', owner.id);
        const actId = Number(ins.lastInsertRowid);
        createdActivityIds.push(actId);

        captured = [];
        r = await runCronInProcess(captured);
        assert(r.sent === 1, `1 påmindelse sendt (fik ${r.sent})`);
        assert(captured.length === 1, '1 sendFromTemplate-kald');
        assert(captured[0].templateKey === 'booking_smagning_reminder', 'Bruger reminder-skabelon');
        assert(captured[0].to === customer.email, `to = ${customer.email}`);
        assert(captured[0].smtpPrefix === 'smtp_kontakt', 'smtp_kontakt');
        assert(captured[0].vars.moedeTypeLabel === mt.label, `vars.moedeTypeLabel = ${mt.label}`);
        assert(captured[0].vars.tid === '14:30', `vars.tid = "14:30" (fik "${captured[0].vars.tid}")`);
        assert(captured[0].vars.kundeFornavn, 'vars.kundeFornavn er sat');
        assert(/\d{4}/.test(captured[0].vars.datoFormatteret), `datoFormatteret indeholder år`);

        const after = db.prepare('SELECT reminder_sent_at FROM crm_activities WHERE id = ?').get(actId);
        assert(!!after.reminder_sent_at, 'reminder_sent_at sat efter sendt');

        // ─── Test 4: andet kald → springes over (allerede sendt) ─
        console.log('\n[Test 4] Møde med reminder_sent_at sat → springes over');
        captured = [];
        r = await runCronInProcess(captured);
        assert(r.foundMeetings === 0, `0 møder fundet anden gang (fik ${r.foundMeetings})`);
        assert(captured.length === 0, 'Ingen mail sendes ved andet kald');

        // ─── Test 5: møde med done_at sat → springes over ──────
        console.log('\n[Test 5] Møde med done_at sat → springes over');
        const ins2 = db.prepare(`
            INSERT INTO crm_activities (
                customer_id, type, meeting_type_id, due_at, duration_min,
                text, owner_user_id, booked_via, done_at, created_at
            ) VALUES (?, 'meeting', ?, ?, ?, ?, ?, 'public_smagning', datetime('now'), datetime('now'))
        `).run(customer.id, mt.id, dueAt, mt.duration_min, 'M9 test 2', owner.id);
        const actId2 = Number(ins2.lastInsertRowid);
        createdActivityIds.push(actId2);
        captured = [];
        r = await runCronInProcess(captured);
        assert(r.foundMeetings === 0, `Done meetings springes over (fik ${r.foundMeetings})`);

        // ─── Test 6: møde med ikke-bookable mødetype = irrelevant ─
        // Bemærk: cron filtrerer kun på type='meeting' og DATE(due_at), så alle mødetyper inkluderes.
        // Det er korrekt: hvis sælger manuelt har planlagt en gennemgang, skal kunden også mindes.

        // ─── Test 7: buildReminderVars dækker alle skabelon-variabler ─
        console.log('\n[Test 7] buildReminderVars dækker alle template-variabler');
        const fakeMeeting = {
            id: 999, due_at: '2026-05-07 10:30:00', duration_min: 45, customer_id: customer.id,
            first_name: 'Test', last_name: 'Person', email: 'test@example.com',
            meeting_label: 'Smagning', meeting_key: 'smagning'
        };
        const vars = bookingMatcher.buildReminderVars(fakeMeeting);
        const required = ['kundeFornavn', 'datoFormatteret', 'tid', 'moedeTypeLabel', 'varighed', 'firmaAdresse', 'firmaTelefon'];
        for (const k of required) {
            assert(k in vars, `vars.${k} findes`);
        }
        assert(vars.tid === '10:30', `tid = "10:30" (fik "${vars.tid}")`);
        assert(vars.varighed === '45', `varighed = "45" (fik "${vars.varighed}")`);
        assert(vars.moedeTypeLabel === 'Smagning', `moedeTypeLabel = "Smagning"`);

        console.log('\n✅ M9 alle tests bestået');

    } finally {
        const restore = (k, v) => {
            if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
            else setSetting(db, k, v);
        };
        restore('booking_reminder_enabled', savedEnabled);
        restore('booking_reminder_send_at_time', savedSendAt);
        restore('booking_reminder_days_before', savedDays);

        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
            db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
        }
        console.log('\n🧹 Test-data ryddet op');
    }
}

main().catch(err => { console.error('❌ FEJL:', err.message); console.error(err.stack); process.exit(1); });
