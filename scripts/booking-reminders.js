// scripts/booking-reminders.js
// ==========================================
// Erindringscron for booking-modulet (Fase 14, M9).
//
// Køres af cron hver hele time (uanset hvad), fx:
//   0 * * * * cd /opt/bon-v2 && node --experimental-sqlite scripts/booking-reminders.js >> logs/reminders.log 2>&1
//
// Scriptet:
//   1. Læser settings live ved hver kørsel — UI-ændringer slår igennem næste time.
//   2. Exit'er stille hvis booking_reminder_enabled !== '1'.
//   3. Exit'er stille hvis nuværende time != booking_reminder_send_at_time.
//      → giver UI-fleksibilitet uden cron-redeploy.
//   4. Finder smagning-møder N dage frem hvor:
//        - type = 'meeting'
//        - DATE(due_at) = target_date
//        - done_at IS NULL                (matcher 019-skema, P1)
//        - reminder_sent_at IS NULL       (ikke allerede mindet om)
//        - kunde har email
//   5. Sender booking_smagning_reminder pr. møde via smtp_kontakt.
//   6. Opdaterer reminder_sent_at = NOW når mailen er gået igennem.
// ==========================================

const path = require('path');

// Load .env (SMTP_KONTAKT_PASSWORD osv.)
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb } = require('../db/database');

function getSetting(db, key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

function logLine(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
    const db = getDb();

    // ─── 1. Master-toggle ──────────────────────────────────────
    if (getSetting(db, 'booking_reminder_enabled') !== '1') {
        // Stille exit — ingen log, så cron-output ikke spammes hvert time
        return;
    }

    // ─── 2. Time-match ──────────────────────────────────────────
    const sendAtTime = getSetting(db, 'booking_reminder_send_at_time') || '09:00';
    const targetHour = parseInt(sendAtTime.split(':')[0]);
    if (Number.isNaN(targetHour) || targetHour < 0 || targetHour > 23) {
        logLine(`[reminder] Ugyldig booking_reminder_send_at_time: "${sendAtTime}" — exit`);
        return;
    }
    const nowHour = new Date().getHours();
    if (nowHour !== targetHour) {
        // Forkert time — stille exit
        return;
    }

    // ─── 3. Beregn target date ──────────────────────────────────
    const daysBefore = parseInt(getSetting(db, 'booking_reminder_days_before') || '2');
    const targetDateMs = Date.now() + daysBefore * 86400000;
    const td = new Date(targetDateMs);
    // Lokal dato (cron kører i system-timezone)
    const targetDate = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`;

    logLine(`[reminder] Søger møder for ${targetDate} (${daysBefore} dage frem fra i dag, kl ${sendAtTime})`);

    // ─── 4. Find møder der trænger til påmindelse ──────────────
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

    if (meetings.length === 0) {
        logLine(`[reminder] 0 møder at minde om — exit`);
        return;
    }

    logLine(`[reminder] ${meetings.length} møde(r) at minde om`);

    // ─── 5. Send påmindelser ────────────────────────────────────
    const { sendFromTemplate } = require('../services/mailService');
    const { buildReminderVars } = require('../services/bookingMatcher');

    let sent = 0;
    let failed = 0;

    for (const m of meetings) {
        try {
            const vars = buildReminderVars(m);
            await sendFromTemplate({
                templateKey: 'booking_smagning_reminder',
                to: m.email,
                vars,
                customerId: m.customer_id,
                context: { type: 'customer', number: m.customer_id },
                smtpPrefix: 'smtp_kontakt'
            });
            db.prepare(`UPDATE crm_activities SET reminder_sent_at = datetime('now') WHERE id = ?`).run(m.id);
            sent++;
            logLine(`[reminder] ✓ Activity #${m.id} (${m.email}) — påmindelse sendt`);
        } catch (err) {
            failed++;
            logLine(`[reminder] ✗ Activity #${m.id} (${m.email}) — fejl: ${err.message}`);
        }
    }

    logLine(`[reminder] Færdig: ${sent} sendt, ${failed} fejlede`);
}

main()
    .catch(err => { logLine(`[reminder] FATAL: ${err.message}\n${err.stack}`); process.exit(1); })
    .finally(() => { process.exit(0); });
