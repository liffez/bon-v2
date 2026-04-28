// scripts/test-m8-live.js
// ==========================================
// LIVE M8 end-to-end:
//   - Spawner server på PORT=4323
//   - Sætter booking_public_url_base til http://localhost:4323
//   - Sender RIGTIG bekræftelsesmail til leifzeeberg@hotmail.com med kort URL
//   - Tilføjer {{booking_link}} til skabelonen midlertidigt
//   - Lader serveren køre så længe denne proces lever (Ctrl-C eller timeout)
//
// Klik på linket i mailen for at se kort URL → redirect → pre-fill virke.
// Standard timeout: 10 minutter. Override: TIMEOUT_SEC=600 node ...
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
const bookingMatcher = require('../services/bookingMatcher');
const booking = require('../routes/booking');

const PORT = 4323;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = 'leifzeeberg@hotmail.com';
const ANNE_USER_ID = 4;
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || '600');

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
            if (r.status > 0) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function main() {
    const db = getDb();

    if (!process.env.SMTP_KONTAKT_PASSWORD) {
        throw new Error('SMTP_KONTAKT_PASSWORD mangler i .env');
    }

    // Husk og restore
    const savedDefaultOwner    = getSetting(db, 'booking_default_owner_user_id');
    const savedNotifyEnabled   = getSetting(db, 'booking_notify_owner_enabled');
    const savedSmagningEnabled = getSetting(db, 'booking_smagning_enabled');
    const savedPublicUrlBase   = getSetting(db, 'booking_public_url_base');
    const savedTpl = db.prepare("SELECT body_text FROM mail_templates WHERE key = 'booking_smagning_confirmation'").get();

    const createdActivityIds = [];
    let testCustomerId = null;
    let serverProc = null;
    let timeoutHandle = null;

    const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (serverProc && !serverProc.killed) {
            serverProc.kill('SIGTERM');
        }
        try {
            if (savedTpl) {
                db.prepare("UPDATE mail_templates SET body_text = ? WHERE key = 'booking_smagning_confirmation'")
                  .run(savedTpl.body_text);
            }
            const restoreOrUnset = (k, v) => {
                if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
                else setSetting(db, k, v);
            };
            restoreOrUnset('booking_default_owner_user_id', savedDefaultOwner);
            restoreOrUnset('booking_notify_owner_enabled',  savedNotifyEnabled);
            restoreOrUnset('booking_smagning_enabled',      savedSmagningEnabled);
            restoreOrUnset('booking_public_url_base',       savedPublicUrlBase);

            for (const id of createdActivityIds) {
                db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
            }
            if (testCustomerId) {
                db.prepare("DELETE FROM booking_tokens WHERE customer_id = ? AND created_at > datetime('now', '-1 hour') AND booking_activity_id IS NULL")
                  .run(testCustomerId);
            }
            for (const id of createdActivityIds) {
                db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
            }
            console.log('\n🧹 Settings + skabelon + test-data ryddet op');
        } catch (err) {
            console.error('Cleanup-fejl:', err.message);
        }
    };

    process.on('SIGINT',  () => { console.log('\n[live] SIGINT → cleanup'); cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    try {
        // ─── Sæt settings ─────────────────────────────────────
        setSetting(db, 'booking_smagning_enabled',     '1');
        setSetting(db, 'booking_default_owner_user_id', String(ANNE_USER_ID));
        setSetting(db, 'booking_public_url_base',       BASE);
        setSetting(db, 'booking_notify_owner_enabled',  '1');

        // Tilføj {{booking_link}} til skabelonen midlertidigt
        const newBody = savedTpl.body_text.replace(
            /\nPå gensyn!/,
            `\nVil du booke endnu et møde efter dette? Klik her:\n\n  {{booking_link}}\n\nPå gensyn!`
        );
        db.prepare("UPDATE mail_templates SET body_text = ? WHERE key = 'booking_smagning_confirmation'").run(newBody);

        // ─── Find test-kunde ──────────────────────────────────
        let cust = db.prepare("SELECT id FROM customers WHERE LOWER(email) = LOWER(?)").get(TEST_EMAIL);
        if (!cust) {
            const r = db.prepare("INSERT INTO customers (first_name, last_name, email, is_active) VALUES (?, ?, ?, 1)")
                .run('Leif', 'Test', TEST_EMAIL);
            cust = { id: Number(r.lastInsertRowid) };
        }
        testCustomerId = cust.id;

        // ─── Spawn server ─────────────────────────────────────
        console.log(`\n📡 Starter test-server på ${BASE}...`);
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
            if (s.includes('SERVER KØRER') || s.includes('Server kører') || s.includes('booking') || s.includes('mail')) {
                process.stdout.write('  [srv] ' + s.split('\n').filter(l => l.trim()).join('\n  [srv] ') + '\n');
            }
        });
        serverProc.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d.toString()));

        const ready = await waitForServer();
        if (!ready) throw new Error('Server startede ikke');
        console.log('  ✓ server klar\n');

        // ─── Find slot + book ─────────────────────────────────
        const minDays = parseInt(getSetting(db, 'booking_min_days_ahead') || '2');
        const blocked = JSON.parse(getSetting(db, 'booking_blocked_weekdays') || '[0]');
        let target = new Date(); target.setHours(0,0,0,0);
        target.setDate(target.getDate() + minDays + 6);
        while (blocked.includes(target.getDay())) target.setDate(target.getDate() + 1);
        const dateStr = target.toISOString().slice(0, 10);

        const slotsRes = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
        const freeSlot = slotsRes.slots.find(s => s.available);
        if (!freeSlot) throw new Error('Ingen ledige slots');

        console.log(`📅 Booker smagning ${dateStr} kl ${freeSlot.time} for ${TEST_EMAIL}\n`);

        const result = booking.handleSmagningBooking({
            first_name: 'Leif',
            last_name:  'Test',
            email:      TEST_EMAIL,
            date:       dateStr,
            time:       freeSlot.time,
            meeting_type: 'smagning',
            guest_count: 6,
            message: 'M8 live-test'
        });
        if (!result?.activityId) throw new Error('Booking fejlede: ' + JSON.stringify(result));
        createdActivityIds.push(result.activityId);
        console.log(`✓ Booking oprettet: activity #${result.activityId}\n`);

        // Vent på fire-and-forget mail
        await new Promise(r => setTimeout(r, 6000));

        const messages = db.prepare(`
            SELECT id, to_email, subject, message_id, body_text
            FROM mail_messages
            WHERE direction = 'out' AND sent_at > datetime('now', '-15 seconds')
            ORDER BY id
        `).all();

        console.log(`📬 ${messages.length} udgående mail(s):\n`);
        let shortUrl = null;
        for (const m of messages) {
            console.log(`  → ${m.to_email}`);
            console.log(`    subject:    ${m.subject}`);
            console.log(`    message_id: ${m.message_id || '(SMTP fejlede)'}`);
            const urlMatch = m.body_text?.match(/https?:\/\/[^\s]+\/b\/[a-f0-9]+/);
            if (urlMatch) {
                console.log(`    booking_link: ${urlMatch[0]}`);
                if (m.to_email === TEST_EMAIL) shortUrl = urlMatch[0];
            }
            console.log('');
        }

        if (shortUrl) {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('  Klik nu linket i din mail (eller åbn manuelt):');
            console.log('  ' + shortUrl);
            console.log('');
            console.log('  Forventet:');
            console.log('   1. Browser → kort URL → redirect til /tools/booking-smagning.html?t=...');
            console.log('   2. Felterne (Fornavn, Email osv.) er pre-fyldt med dine data');
            console.log('   3. "Gennemgang" mødetype er auto-valgt (intent fra token)');
            console.log('   4. Banner øverst: "Velkommen Leif — du booker hos anne"');
            console.log('═══════════════════════════════════════════════════════════');
            console.log(`\n⏳ Serveren kører i op til ${TIMEOUT_SEC} sek. Tryk Ctrl-C for at stoppe nu.`);
        } else {
            console.warn('⚠️  Ingen kort URL fundet i mailen — booking_link blev ikke renderet?');
        }

        // Hold serveren oppe så user kan klikke
        await new Promise(r => { timeoutHandle = setTimeout(r, TIMEOUT_SEC * 1000); });
        console.log('\n⏰ Timeout — stopper test-server');

    } finally {
        cleanup();
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
