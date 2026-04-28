// scripts/test-m7-live.js
// ==========================================
// LIVE end-to-end test af M7 mod rigtig SMTP.
//
// Sender:
//   1. Bekræftelsesmail til kunden (med {{booking_link}} for at vise URL renders)
//   2. Intern notifikation til Anne
//
// Modificerer midlertidigt:
//   - booking_default_owner_user_id (→ Anne)
//   - booking_public_url_base (→ http://localhost:4321 så linket peger på dev-serveren)
//   - mail_templates.booking_smagning_confirmation (tilføj {{booking_link}} linje)
//
// Alle ændringer rulles tilbage i finally.
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

// Indlæs .env (SMTP_KONTAKT_PASSWORD skal være sat)
const envPath = path.join(__dirname, '../.env');
const fs = require('fs');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) process.env[m[1]] = m[2];
    });
}

const { getDb } = require('../db/database');
const bookingMatcher = require('../services/bookingMatcher');
const booking = require('../routes/booking');

const TEST_EMAIL = 'leifzeeberg@hotmail.com';
const ANNE_EMAIL = 'anne@ristetrug.dk';
const PUBLIC_URL_BASE = 'http://localhost:4321';
const ANNE_USER_ID = 4;

function setSetting(db, key, value) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
    else        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
function getSetting(db, key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

async function main() {
    const db = getDb();

    // ─── Verificér at SMTP_KONTAKT_PASSWORD er sat ────────────
    if (!process.env.SMTP_KONTAKT_PASSWORD) {
        throw new Error('SMTP_KONTAKT_PASSWORD mangler i .env — kan ikke sende rigtig mail');
    }
    if (!process.env.SMTP_PASSWORD) {
        console.warn('SMTP_PASSWORD mangler — kun smtp_kontakt vil virke');
    }

    // ─── Husk og restore ──────────────────────────────────────
    const savedDefaultOwner    = getSetting(db, 'booking_default_owner_user_id');
    const savedPublicUrlBase   = getSetting(db, 'booking_public_url_base');
    const savedNotifyEnabled   = getSetting(db, 'booking_notify_owner_enabled');
    const savedSmagningEnabled = getSetting(db, 'booking_smagning_enabled');
    const savedTemplate = db.prepare("SELECT body_text FROM mail_templates WHERE key = 'booking_smagning_confirmation'").get();

    const createdActivityIds = [];
    let testCustomerId = null;

    try {
        // ─── Konfigurer settings for test ───────────────────────
        setSetting(db, 'booking_smagning_enabled',     '1');
        setSetting(db, 'booking_default_owner_user_id', String(ANNE_USER_ID));
        setSetting(db, 'booking_public_url_base',       PUBLIC_URL_BASE);
        setSetting(db, 'booking_notify_owner_enabled',  '1');

        console.log('Settings konfigureret:');
        console.log(`  booking_default_owner_user_id = ${ANNE_USER_ID} (Anne)`);
        console.log(`  booking_public_url_base       = ${PUBLIC_URL_BASE}`);
        console.log(`  booking_notify_owner_enabled  = 1`);

        // ─── Tilføj {{booking_link}} til skabelonen midlertidigt ─
        const newBody = savedTemplate.body_text.replace(
            /\nPå gensyn!/,
            `\nVil du booke endnu et møde efter dette? Brug dette link: {{booking_link}}\n\nPå gensyn!`
        );
        db.prepare("UPDATE mail_templates SET body_text = ? WHERE key = 'booking_smagning_confirmation'").run(newBody);
        console.log('  booking_smagning_confirmation skabelon udvidet med {{booking_link}}\n');

        // ─── Sørg for at Anne har den rigtige email ─────────────
        const anne = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(ANNE_USER_ID);
        console.log(`Anne (#${anne.id}): ${anne.name} <${anne.email}>`);

        // ─── Opret eller find test-kunde med leifzeeberg@hotmail.com ─
        let cust = db.prepare("SELECT id FROM customers WHERE LOWER(email) = LOWER(?) AND is_active = 1").get(TEST_EMAIL);
        if (cust) {
            testCustomerId = cust.id;
            console.log(`Test-kunde fundet: #${testCustomerId}`);
        } else {
            const r = db.prepare(`
                INSERT INTO customers (first_name, last_name, email, is_active)
                VALUES (?, ?, ?, 1)
            `).run('Leif', 'Test', TEST_EMAIL);
            testCustomerId = Number(r.lastInsertRowid);
            console.log(`Test-kunde oprettet: #${testCustomerId} <${TEST_EMAIL}>`);
        }

        // ─── Find ledigt slot ───────────────────────────────────
        const minDays = parseInt(getSetting(db, 'booking_min_days_ahead') || '2');
        const blocked = JSON.parse(getSetting(db, 'booking_blocked_weekdays') || '[0]');
        let target = new Date(); target.setHours(0,0,0,0);
        target.setDate(target.getDate() + minDays + 5);
        while (blocked.includes(target.getDay())) target.setDate(target.getDate() + 1);
        const dateStr = target.toISOString().slice(0, 10);

        const slotsRes = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
        if (!slotsRes.available) throw new Error('Slot-beregning fejlede: ' + slotsRes.reason);
        const freeSlot = slotsRes.slots.find(s => s.available);
        if (!freeSlot) throw new Error('Ingen ledige slots på ' + dateStr);

        console.log(`\nBooker smagning: ${dateStr} kl ${freeSlot.time}`);

        // ─── Kør booking-handler (synchront — opretter activity) ──
        const result = booking.handleSmagningBooking({
            first_name: 'Leif',
            last_name:  'Test',
            email:      TEST_EMAIL,
            date:       dateStr,
            time:       freeSlot.time,
            meeting_type: 'smagning',
            guest_count: 6,
            event_type: 'firmaarrangement',
            message: 'Live-test af M7 mail-flow'
        });
        if (!result?.activityId) throw new Error('Booking-oprettelse fejlede: ' + JSON.stringify(result));
        createdActivityIds.push(result.activityId);
        console.log(`✓ Booking oprettet: activity #${result.activityId}`);

        // ─── Vent på fire-and-forget mail-promisen ────────────────
        // Vi ved at handleSmagningBooking kalder sendBookingMails(...).catch(err => ...)
        // og vi har ingen direkte handle på promisen. I stedet venter vi ~5 sekunder
        // så SMTP-kald + DB-insert af mail_messages er færdigt.
        console.log('\nVenter 6 sek på fire-and-forget mail-afsendelse...');
        await new Promise(r => setTimeout(r, 6000));

        // ─── Verificér at mail_messages har 2 nye outbound rækker ─
        const messages = db.prepare(`
            SELECT mm.id, mm.to_email, mm.subject, mm.message_id, mm.sent_at, mm.body_text
            FROM mail_messages mm
            WHERE mm.direction = 'out'
              AND mm.sent_at > datetime('now', '-10 seconds')
            ORDER BY mm.id
        `).all();

        console.log(`\n📬 ${messages.length} nye udgående mail(s):\n`);
        for (const m of messages) {
            console.log(`  [#${m.id}] → ${m.to_email}`);
            console.log(`           subject: ${m.subject}`);
            console.log(`           message_id: ${m.message_id || '(SMTP fejlede — ingen messageId)'}`);
            console.log(`           sent_at: ${m.sent_at}`);
            // Find {{booking_link}} URL i body
            const urlMatch = m.body_text?.match(/https?:\/\/[^\s]+booking-[a-z]+\.html\?t=[a-f0-9]+/);
            if (urlMatch) {
                console.log(`           booking_link: ${urlMatch[0]}`);
            }
            console.log('');
        }

        if (messages.length === 0) {
            console.warn('⚠️  Ingen udgående mails fundet — SMTP kald fejlede sandsynligvis. Tjek logs ovenfor.');
        } else {
            const customerMail = messages.find(m => m.to_email === TEST_EMAIL);
            const ownerMail    = messages.find(m => m.to_email === ANNE_EMAIL);
            if (customerMail?.message_id) console.log(`✅ Bekræftelsesmail leveret til ${TEST_EMAIL}`);
            if (ownerMail?.message_id)    console.log(`✅ Intern notif leveret til ${ANNE_EMAIL}`);
            if (!customerMail) console.warn(`⚠️  Ingen mail til kunden (${TEST_EMAIL})`);
            if (!ownerMail)    console.warn(`⚠️  Ingen mail til Anne (${ANNE_EMAIL})`);
        }

    } finally {
        // ─── Restore alle ændringer ──────────────────────────────

        // Restore skabelon
        if (savedTemplate) {
            db.prepare("UPDATE mail_templates SET body_text = ? WHERE key = 'booking_smagning_confirmation'")
              .run(savedTemplate.body_text);
        }

        // Restore settings
        const restoreOrUnset = (key, val) => {
            if (val === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
            else setSetting(db, key, val);
        };
        restoreOrUnset('booking_default_owner_user_id', savedDefaultOwner);
        restoreOrUnset('booking_public_url_base',       savedPublicUrlBase);
        restoreOrUnset('booking_notify_owner_enabled',  savedNotifyEnabled);
        restoreOrUnset('booking_smagning_enabled',      savedSmagningEnabled);

        // Slet booking_tokens der peger på test-aktiviteter (FK først)
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
        }
        // Slet test-tokens uden booking (skabt af render)
        if (testCustomerId) {
            db.prepare("DELETE FROM booking_tokens WHERE customer_id = ? AND created_at > datetime('now', '-10 minutes')")
              .run(testCustomerId);
        }
        // Slet test-aktiviteter
        for (const id of createdActivityIds) {
            db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
        }

        console.log('\n🧹 Test-data + skabelon-ændringer rullet tilbage');
        console.log('   (Test-kunden beholdes — den kan genbruges)');
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
