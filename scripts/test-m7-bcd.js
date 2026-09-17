// scripts/test-m7-bcd.js
// ==========================================
// Verifikation for M7b/c/d (Fase 14 — Booking-modul):
//
//   M7b: buildSmagningMailVars / buildKontaktMailVars / buildInternalNotificationVars
//        producerer alle skabelon-variabler.
//   M7c: handleSmagningBooking + handleKontaktBooking sender bekræftelse
//        til kunden via smtp_kontakt med korrekt skabelon, customerId og context.
//   M7d: sendInternalNotification sendes til ejer (med email), respekterer
//        booking_notify_owner_enabled. Sendes ved ENHVER booking — også token-flow.
//
// Strategi: stub sendFromTemplate i mailService og fang alle kald.
//           Kald handlers direkte (intet HTTP, ingen rigtig SMTP).
//           Cleanup: slet test-aktiviteter + restore settings i finally.
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const { getDb } = require('../db/database');
const mailService = require('../services/mailService');
const bookingMatcher = require('../services/bookingMatcher');

const captured = [];
const realSendFromTemplate = mailService.sendFromTemplate;
mailService.sendFromTemplate = async (args) => {
    captured.push(args);
    return { messageId: 'fake-' + captured.length, threadId: 999, subject: 'fake' };
};

// routes/booking.js bruger require('../services/bookingMatcher') for sendInternalNotification —
// denne henter selv mailService via inline require. Så stubben skal være sat
// FØR routes/booking.js indlæses.
const booking = require('../routes/booking');

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

async function main() {
const db = getDb();
const createdActivityIds = [];
const createdTokens = [];

// Husk og restore alle berørte settings
const savedSettings = {};
const settingsKeys = [
    'booking_smagning_enabled', 'booking_kontakt_enabled',
    'booking_default_owner_user_id', 'booking_public_url_base',
    'booking_notify_owner_enabled'
];
for (const k of settingsKeys) savedSettings[k] = getSetting(db, k);

try {
    // ─── Konfiguration ───────────────────────────────────
    setSetting(db, 'booking_smagning_enabled',     '1');
    setSetting(db, 'booking_kontakt_enabled',      '1');
    setSetting(db, 'booking_public_url_base',      'https://bon.test.local');
    setSetting(db, 'booking_notify_owner_enabled', '1');

    // Find en owner med email
    const owner = db.prepare("SELECT id, name, email FROM users WHERE is_active = 1 AND email IS NOT NULL AND email != '' ORDER BY id LIMIT 1").get();
    if (!owner) throw new Error('Ingen aktiv bruger med email — kan ikke teste intern notif');
    setSetting(db, 'booking_default_owner_user_id', String(owner.id));
    console.log(`Owner: #${owner.id} ${owner.name} <${owner.email}>`);

    const customer = db.prepare("SELECT id, first_name, last_name, email, phone, company_id FROM customers WHERE is_active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1").get();
    if (!customer) throw new Error('Ingen aktiv kunde med email');
    console.log(`Kunde: #${customer.id} ${customer.first_name} <${customer.email}>`);

    // Smagning-mødetype
    const mt = db.prepare("SELECT id, key, label, duration_min FROM meeting_types WHERE key = 'smagning' AND is_active = 1").get();
    if (!mt) throw new Error('Ingen aktiv "smagning" mødetype');

    // Vælg en åben dato (i dag + min_days_ahead + 7, hverdag)
    const minDays = parseInt(getSetting(db, 'booking_min_days_ahead') || '2');
    const blockedRaw = getSetting(db, 'booking_blocked_weekdays') || '[0]';
    const blocked = JSON.parse(blockedRaw);
    let target = new Date(); target.setHours(0,0,0,0);
    target.setDate(target.getDate() + minDays + 5);
    while (blocked.includes(target.getDay())) target.setDate(target.getDate() + 1);
    const dateStr = target.toISOString().slice(0, 10);

    // Find et ledigt slot ved at scanne computeSlotsForDate
    const slotsRes = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
    if (!slotsRes.available) throw new Error('Ingen åben dato fundet: ' + slotsRes.reason);
    const freeSlot = slotsRes.slots.find(s => s.available);
    if (!freeSlot) throw new Error('Ingen ledige slots på ' + dateStr);
    const timeStr = freeSlot.time;
    console.log(`Test-slot: ${dateStr} ${timeStr}`);

    // ─── M7b: vars-builders ──────────────────────────────
    console.log('\n[M7b] Vars-builders');

    const sVars = bookingMatcher.buildSmagningMailVars({
        customerId: customer.id, meetingType: mt, date: dateStr, time: timeStr
    });
    const sExpectedKeys = ['kundeFornavn', 'kundeNavn', 'kundeEmail', 'kundeTelefon',
        'moedeTypeLabel', 'varighed', 'datoFormatteret', 'tid',
        'firmaNavn', 'firmaAdresse', 'firmaTelefon', 'firmaEmail'];
    for (const k of sExpectedKeys) {
        assert(k in sVars, `buildSmagningMailVars: nøgle "${k}" findes`);
    }
    assert(sVars.moedeTypeLabel === mt.label, `moedeTypeLabel = "${mt.label}"`);
    assert(sVars.varighed === String(mt.duration_min), `varighed = "${mt.duration_min}"`);
    assert(sVars.tid === timeStr, `tid = "${timeStr}"`);
    assert(/\d{4}/.test(sVars.datoFormatteret), `datoFormatteret indeholder årstal: "${sVars.datoFormatteret}"`);

    const reason = db.prepare("SELECT id, key, label FROM contact_reasons WHERE key = 'send_menu' AND is_active = 1").get();
    const kVars = bookingMatcher.buildKontaktMailVars({
        customerId: customer.id, contactReason: reason
    });
    assert(kVars.kontaktAarsagLabel === reason.label, `buildKontaktMailVars.kontaktAarsagLabel = "${reason.label}"`);
    assert(kVars.kundeFornavn === customer.first_name, `buildKontaktMailVars.kundeFornavn = "${customer.first_name}"`);

    const iVars = bookingMatcher.buildInternalNotificationVars({
        customerId: customer.id, flow: 'smagning', meetingType: mt,
        date: dateStr, time: timeStr,
        formData: { guest_count: 8, message: 'Glæder os' }
    });
    assert(iVars.flowType === 'Smagsprøve', `flowType = "Smagsprøve"`);
    assert(iVars.antalGaester === '8', `antalGaester = "8"`);
    assert(iVars.beskedFraKunde === 'Glæder os', `beskedFraKunde = "Glæder os"`);
    assert(iVars.crmKundeUrl.includes('crm-kunde360'), `crmKundeUrl peger på crm-kunde360`);
    assert(iVars.crmKundeUrl.includes(`id=${customer.id}`), `crmKundeUrl indeholder kunde-id`);

    // ─── M7c: kunde-bekræftelse for SMAGNING ─────────────
    console.log('\n[M7c] handleSmagningBooking → bekræftelsesmail');

    captured.length = 0;
    const sRes = booking.handleSmagningBooking({
        first_name: customer.first_name,
        last_name:  customer.last_name,
        email:      customer.email,
        phone:      customer.phone,
        date:       dateStr,
        time:       timeStr,
        meeting_type: 'smagning',
        guest_count: 4,
        message: 'Test booking'
    });
    if (sRes?.activityId) createdActivityIds.push(sRes.activityId);
    assert(sRes && sRes.activityId, `Booking oprettet (activity #${sRes?.activityId})`);

    // Vent kort på fire-and-forget
    await new Promise(r => setTimeout(r, 100));

    const customerMail = captured.find(c => c.templateKey === 'booking_smagning_confirmation');
    assert(customerMail, 'Bekræftelsesmail til kunde fanget');
    assert(customerMail.to === customer.email, `to = ${customer.email}`);
    assert(customerMail.smtpPrefix === 'smtp_kontakt', `smtpPrefix = smtp_kontakt`);
    assert(customerMail.customerId === customer.id, `customerId = ${customer.id}`);
    assert(customerMail.context?.type === 'customer', `context.type = customer (giver #k-NNN tag)`);
    assert(customerMail.context?.number === customer.id, `context.number = customer.id`);
    assert(customerMail.vars.moedeTypeLabel === mt.label, `vars.moedeTypeLabel = "${mt.label}"`);

    // ─── M7d: intern notif til sælger ────────────────────
    console.log('\n[M7d] sendInternalNotification (anonym booking → notif sendes)');

    const internalMail = captured.find(c => c.templateKey === 'booking_internal_notification');
    assert(internalMail, 'Intern notifikation fanget');
    assert(internalMail.to === owner.email, `Intern notif sendes til owner (${owner.email})`);
    assert(internalMail.smtpPrefix === 'smtp_kontakt', `Intern smtpPrefix = smtp_kontakt`);
    assert(internalMail.vars.flowType === 'Smagsprøve', `Intern flowType = Smagsprøve`);

    // ─── Token-flow: intern notif sendes OGSÅ ───────────
    //
    // ÆNDRET ADFÆRD (sep. 2026): token-flow var undtaget ud fra "sælgeren
    // sendte jo linket, hun ved det". Den holder ikke i en kampagne, hvor
    // der sendes mange links på få dage. Se scripts/test-booking-notif.js.
    console.log('\n[M7d] Token-flow → intern notif sendes også');

    // Generér token til samme kunde + owner, så booking ankommer "kendt"
    const token = mailService.generateBookingToken({
        customer_id: customer.id, sales_user_id: owner.id, flow: 'smagning',
        intent_meeting_type_key: 'smagning', ttl_days: 60
    });
    createdTokens.push(token);

    // Find et nyt slot (det forrige er nu optaget)
    const slotsRes2 = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
    const freeSlot2 = slotsRes2.slots.find(s => s.available);
    if (!freeSlot2) throw new Error('Ingen flere ledige slots');

    captured.length = 0;
    const sRes2 = booking.handleSmagningBooking({
        token,
        first_name: customer.first_name,
        last_name:  customer.last_name,
        email:      customer.email,
        date:       dateStr,
        time:       freeSlot2.time,
        meeting_type: 'smagning'
    });
    if (sRes2?.activityId) createdActivityIds.push(sRes2.activityId);
    assert(sRes2 && sRes2.activityId, `Token-booking oprettet (activity #${sRes2?.activityId})`);
    await new Promise(r => setTimeout(r, 100));

    const tokenCustomerMail = captured.find(c => c.templateKey === 'booking_smagning_confirmation');
    const tokenInternalMail = captured.find(c => c.templateKey === 'booking_internal_notification');
    assert(tokenCustomerMail, 'Kunde-bekræftelse sendes også ved token-flow');
    assert(tokenInternalMail, 'Intern notif sendes OGSÅ ved token-flow');
    assert(tokenInternalMail?.vars?.bookingKilde === 'Dit mail-link',
        `bookingKilde siger at den kom fra sælgerens link (fik '${tokenInternalMail?.vars?.bookingKilde}')`);

    // ─── Kontakt-flow ────────────────────────────────────
    console.log('\n[M7c+d] handleKontaktBooking');
    captured.length = 0;
    const kRes = booking.handleKontaktBooking({
        first_name: customer.first_name,
        last_name:  customer.last_name,
        email:      customer.email,
        phone:      customer.phone,
        reason: 'send_menu',
        message: 'Vil gerne se menuen'
    });
    if (kRes?.activityId) createdActivityIds.push(kRes.activityId);
    assert(kRes && kRes.activityId, `Kontakt-task oprettet (activity #${kRes?.activityId})`);
    await new Promise(r => setTimeout(r, 100));

    const kCustomerMail = captured.find(c => c.templateKey === 'booking_kontakt_confirmation');
    const kInternalMail = captured.find(c => c.templateKey === 'booking_internal_notification');
    assert(kCustomerMail, 'Kontakt-bekræftelse til kunde');
    assert(kCustomerMail.smtpPrefix === 'smtp_kontakt', `Kontakt smtpPrefix = smtp_kontakt`);
    assert(kCustomerMail.context?.type === 'customer', `Kontakt context.type = customer`);
    assert(kInternalMail, 'Intern notif ved kontakt-flow (anonym)');
    assert(kInternalMail.vars.flowType === 'Kontakt', `Intern flowType = Kontakt`);

    // ─── Notify-toggle off → ingen intern notif ─────────
    console.log('\n[M7d] booking_notify_owner_enabled = 0 → ingen intern notif');
    setSetting(db, 'booking_notify_owner_enabled', '0');
    captured.length = 0;
    const slotsRes3 = bookingMatcher.computeSlotsForDate(dateStr, 'smagning');
    const freeSlot3 = slotsRes3.slots.find(s => s.available);
    if (freeSlot3) {
        const sRes3 = booking.handleSmagningBooking({
            first_name: customer.first_name, last_name: customer.last_name,
            email: customer.email, date: dateStr, time: freeSlot3.time,
            meeting_type: 'smagning'
        });
        if (sRes3?.activityId) createdActivityIds.push(sRes3.activityId);
        await new Promise(r => setTimeout(r, 100));
        const noInternal = captured.find(c => c.templateKey === 'booking_internal_notification');
        assert(!noInternal, 'Ingen intern notif når toggle er off');
        const stillCustomer = captured.find(c => c.templateKey === 'booking_smagning_confirmation');
        assert(stillCustomer, 'Kunde-bekræftelse sendes stadig');
    } else {
        console.log('  (skippet — ingen flere ledige slots)');
    }

    console.log('\n✅ M7b/c/d alle tests bestået');
} finally {
    // Restore stub
    mailService.sendFromTemplate = realSendFromTemplate;

    // booking_tokens.booking_activity_id REFERENCES crm_activities — tokens skal slettes FØRST
    for (const t of createdTokens) {
        db.prepare('DELETE FROM booking_tokens WHERE token = ?').run(t);
    }
    // Også tokens skabt af handleSmagningBooking når booking blev forbrugt
    for (const id of createdActivityIds) {
        db.prepare('DELETE FROM booking_tokens WHERE booking_activity_id = ?').run(id);
    }
    // Tokens skabt af render under tests (hverken brugt eller eksplicit gemt)
    db.prepare("DELETE FROM booking_tokens WHERE created_at > datetime('now', '-1 hour') AND booking_activity_id IS NULL")
      .run();
    // Slet test-aktiviteter
    for (const id of createdActivityIds) {
        db.prepare('DELETE FROM crm_activities WHERE id = ?').run(id);
    }

    // Restore settings
    for (const [k, v] of Object.entries(savedSettings)) {
        if (v === null) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
        else setSetting(db, k, v);
    }
    console.log('\n🧹 Test-data ryddet op');
}
}

main().catch(err => { console.error(err); process.exit(1); });
