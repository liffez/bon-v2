// scripts/test-booking-notif.js
// ============================================================
// Sælgeren skal have besked ved ENHVER booking — også sit eget mail-link.
//
// Sagen: token-flow (en booking via {{booking_link}}) sprang den interne
// notifikation over. Begrundelsen var "sælgeren sendte jo linket, hun ved det".
// Den holder ikke i en kampagne: sendes der tyve links på en uge, kan ingen
// huske hvem der har booket — og det er præcis dét CRM'et er bedre til end
// hukommelsen. Konsekvensen var at kampagne-bookinger KUN kunne opdages ved
// selv at kigge på CRM-dashboardet.
//
// Undtagelsen er væk. Til gengæld skal mailen kunne sige hvilken slags booking
// det var, så et svar på et udsendt link kan skelnes fra en der selv fandt
// siden — ellers ser de to ens ud i indbakken.
//
// Kør:  node --experimental-sqlite scripts/test-booking-notif.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-booking-notif-${Date.now()}.db`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

process.env.DB_PATH  = TEST_DB;
process.env.NODE_ENV = 'test';

require('../db/migrate').runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const mailService = require('../services/mailService');

// Stub FØR routes/booking.js indlæses — den henter mailService via inline require.
const captured = [];
mailService.sendFromTemplate = async (args) => {
    captured.push(args);
    return { messageId: 'fake-' + captured.length, threadId: 999, subject: 'fake' };
};

const booking        = require('../routes/booking');
const bookingMatcher = require('../services/bookingMatcher');

const db = getDb();
const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);

const internalOf = () => captured.find(c => c.templateKey === 'booking_internal_notification');
const confirmOf  = (key) => captured.find(c => c.templateKey === key);

function nextFreeSlot(dateStr) {
    const r = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
    return (r.slots || []).find(s => s.available) || null;
}

// sendBookingMails er fire-and-forget, og den interne notifikation ligger EFTER
// kunde-bekræftelsens await. Den er derfor først sendt et par microtasks senere;
// måler man synkront, ser man kun bekræftelsen og tror notifikationen mangler.
const settle = () => new Promise(r => setTimeout(r, 100));

async function main() {
    // ── Opsætning ────────────────────────────────────────────────────
    const defaultOwner = Number(db.prepare(
        `INSERT INTO users (name,email,role,is_active) VALUES ('Default Ejer','default@ristetrug.invalid','office',1)`
    ).run().lastInsertRowid);
    // En ANDEN sælger — den der sender kampagne-linket. Notifikationen skal
    // lande hos hende, ikke hos husets standard-ejer.
    const kampagneSaelger = Number(db.prepare(
        `INSERT INTO users (name,email,role,is_active) VALUES ('Anne','anne@ristetrug.invalid','office',1)`
    ).run().lastInsertRowid);

    setSetting('booking_smagning_enabled', '1');
    setSetting('booking_kontakt_enabled', '1');
    setSetting('booking_notify_owner_enabled', '1');
    setSetting('booking_default_owner_user_id', String(defaultOwner));
    setSetting('booking_customer_url_base', 'https://kontakt.ristetrug.dk');

    const kunde = Number(db.prepare(
        `INSERT INTO customers (first_name,last_name,email,is_active) VALUES ('Lærke','Andersen','laerke@example.invalid',1)`
    ).run().lastInsertRowid);

    // Find en dag der faktisk har ledige slots.
    let dateStr = null, slot = null;
    for (let d = 1; d <= 40 && !slot; d++) {
        const cand = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);   // utc-ok: kun til at finde en fremtidig dag
        const s = nextFreeSlot(cand);
        if (s) { dateStr = cand; slot = s; }
    }
    if (!slot) throw new Error('Ingen ledige slots i de næste 40 dage — kan ikke teste');

    // ── 1) Anonym booking (uændret adfærd) ───────────────────────────
    console.log('\n1 · Booking uden token — som hidtil');
    captured.length = 0;
    const r1 = booking.handleSmagningBooking({
        first_name: 'Lærke', last_name: 'Andersen', email: 'laerke@example.invalid',
        date: dateStr, time: slot.time, meeting_type: 'smagning'
    });
    ok(!!r1?.activityId, `bookingen oprettes (activity #${r1?.activityId})`);
    await settle();

    const i1 = internalOf();
    ok(!!i1, 'intern notifikation sendt');
    ok(i1?.to === 'default@ristetrug.invalid', `til husets standard-ejer (fik '${i1?.to}')`);
    ok(i1?.vars?.bookingKilde === 'Fandt selv booking-siden',
        `bookingKilde: 'Fandt selv booking-siden' (fik '${i1?.vars?.bookingKilde}')`);
    ok(!!confirmOf('booking_smagning_confirmation'), 'kunden får sin bekræftelse');

    // ── 2) Token-booking: REGRESSIONEN ───────────────────────────────
    console.log('\n2 · Booking via sælgerens mail-link');
    const token = mailService.generateBookingToken({
        customer_id: kunde, sales_user_id: kampagneSaelger, flow: 'smagning', ttl_days: 60
    });
    const slot2 = nextFreeSlot(dateStr);
    if (!slot2) throw new Error('Ingen flere ledige slots på ' + dateStr);

    captured.length = 0;
    const r2 = booking.handleSmagningBooking({
        token,
        first_name: 'Lærke', last_name: 'Andersen', email: 'laerke@example.invalid',
        date: dateStr, time: slot2.time, meeting_type: 'smagning'
    });
    ok(!!r2?.activityId, `token-bookingen oprettes (activity #${r2?.activityId})`);
    await settle();

    const i2 = internalOf();
    ok(!!i2, 'REGRESSIONEN: intern notifikation sendes OGSÅ ved token-flow');
    ok(i2?.to === 'anne@ristetrug.invalid',
        `og den lander hos sælgeren der sendte linket, ikke standard-ejeren (fik '${i2?.to}')`);
    ok(i2?.vars?.bookingKilde === 'Dit mail-link',
        `bookingKilde: 'Dit mail-link' (fik '${i2?.vars?.bookingKilde}')`);
    ok(!!confirmOf('booking_smagning_confirmation'), 'kunden får stadig sin bekræftelse');

    // De to slags booking må ikke se ens ud i indbakken.
    ok(i1?.vars?.bookingKilde !== i2?.vars?.bookingKilde,
        'de to kilder er skelnelige — ellers er linjen værdiløs i en kampagne');

    // Og aktiviteten bærer stadig sin egen kilde i databasen.
    const act = db.prepare(`SELECT booked_via FROM crm_activities WHERE id = ?`).get(r2.activityId);
    ok(act?.booked_via === 'token_link', `crm_activities.booked_via = 'token_link' (fik '${act?.booked_via}')`);

    // ── 3) Kontakt-flow: samme regel ─────────────────────────────────
    console.log('\n3 · Kontakt-flow via mail-link');
    const kToken = mailService.generateBookingToken({
        customer_id: kunde, sales_user_id: kampagneSaelger, flow: 'kontakt', ttl_days: 60
    });
    const reason = db.prepare(`SELECT key FROM contact_reasons WHERE is_active = 1 ORDER BY id LIMIT 1`).get();
    ok(!!reason, 'der findes en kontaktårsag at booke på');

    captured.length = 0;
    const r3 = booking.handleKontaktBooking({
        token: kToken,
        first_name: 'Lærke', last_name: 'Andersen', email: 'laerke@example.invalid',
        reason: reason.key, message: 'Ring gerne'
    });
    ok(!!r3?.activityId, `kontakt-opgaven oprettes (activity #${r3?.activityId})`);
    await settle();
    const i3 = internalOf();
    ok(!!i3, 'intern notifikation sendes også her');
    ok(i3?.vars?.bookingKilde === 'Dit mail-link', 'og bærer den rigtige kilde');

    // ── 4) Kontrolprøve: toggle slår stadig alt fra ──────────────────
    console.log('\n4 · Kontrolprøve — booking_notify_owner_enabled = 0');
    setSetting('booking_notify_owner_enabled', '0');
    const slot4 = nextFreeSlot(dateStr) || (() => {
        for (let d = 1; d <= 40; d++) {
            const c = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);   // utc-ok: kun til at finde en fremtidig dag
            const s = nextFreeSlot(c); if (s) { dateStr = c; return s; }
        }
        return null;
    })();
    if (!slot4) throw new Error('Ingen ledige slots til kontrolprøven');

    captured.length = 0;
    booking.handleSmagningBooking({
        token,
        first_name: 'Lærke', last_name: 'Andersen', email: 'laerke@example.invalid',
        date: dateStr, time: slot4.time, meeting_type: 'smagning'
    });
    await settle();
    ok(!internalOf(), 'ingen intern notifikation når toggle er slået fra');
    ok(!!confirmOf('booking_smagning_confirmation'), 'men kunden får stadig sin bekræftelse');
    setSetting('booking_notify_owner_enabled', '1');

    // ── 5) Migration 171: skabelonen ────────────────────────────────
    console.log('\n5 · Migration 171 — {{bookingKilde}} i skabelonen');
    const tmpl = db.prepare(`SELECT body_text FROM mail_templates WHERE key = 'booking_internal_notification'`).get();
    ok((tmpl?.body_text || '').includes('{{bookingKilde}}'), 'linjen er sat ind i den seedede skabelon');
    ok((tmpl?.body_text || '').includes('Kom fra:'), 'med en læsbar etiket');

    // Skabelonen er redigerbar i Settings, og en redigeret skabelon er brugerens
    // — vi skriver ikke i den bag ryggen på hende.
    //
    // Fixturen BEHOLDER bevidst "Flow:"-linjen. En tekst uden den ville bestå af
    // den forkerte grund: SQL'ens replace() er i sig selv et no-op når søgestrengen
    // ikke findes, så vagten ville aldrig blive afprøvet. Det er netop den
    // realistiske redigering — nogen retter hilsenen og lader felterne stå.
    const egenTekst = [
        'Hej! Ny booking til dig:',
        '',
        '  Kunde:       {{kundeNavn}}',
        '  Flow:        {{flowType}}',
        '  Dato:        {{datoFormatteret}} kl {{tid}}',
    ].join('\n');
    db.prepare(`UPDATE mail_templates SET body_text = ? WHERE key = 'booking_internal_notification'`).run(egenTekst);
    db.prepare(`DELETE FROM _migrations WHERE filename LIKE '171%'`).run();
    require('../db/migrate').runMigrations(TEST_DB);
    const after = db.prepare(`SELECT body_text FROM mail_templates WHERE key = 'booking_internal_notification'`).get();
    ok(after?.body_text === egenTekst, 'en redigeret skabelon bliver IKKE rørt');
    ok(!(after?.body_text || '').includes('Kom fra:'),
        'og der bliver ikke skrevet en ny linje ind i den');

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); try { fs.unlinkSync(TEST_DB); } catch {}; process.exit(1); });
