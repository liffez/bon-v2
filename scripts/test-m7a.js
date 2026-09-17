// scripts/test-m7a.js
// ==========================================
// Verifikation for M7a (Fase 14 — Booking-modul):
//   1. generateBookingToken returnerer samme token for samme (customer, sales, flow, intent)
//   2. renderTemplate substituerer {{booking_link}} til en korrekt URL
//   3. Manglende customerId → {{booking_link}} fjernes uden fejl
//   4. Manglende booking_public_url_base → {{booking_link}} fjernes uden fejl
//
// Sletter alle indsatte test-tokens i finally — DB er ren efter kørsel.
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const { getDb } = require('../db/database');
const { renderTemplate, generateBookingToken } = require('../services/mailService');

const TEST_FLOW = 'smagning';
const TEST_INTENT_KEY = 'smagning';

function assert(cond, msg) {
    if (!cond) {
        console.error('  ✗', msg);
        process.exitCode = 1;
        throw new Error(msg);
    }
    console.log('  ✓', msg);
}

function pickCustomer(db) {
    const c = db.prepare('SELECT id, first_name, email FROM customers WHERE is_active = 1 AND email IS NOT NULL LIMIT 1').get();
    if (!c) throw new Error('Ingen aktiv kunde med email i test-DB');
    return c;
}

function setSetting(db, key, value) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
    else        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function getSetting(db, key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

const db = getDb();
const customer = pickCustomer(db);
const customerId = customer.id;

// Husk og restore disse settings
const originalBaseUrl = getSetting(db, 'booking_public_url_base');
const originalReuseDays = getSetting(db, 'booking_token_reuse_min_days');

const insertedTokens = [];

try {
    console.log(`Bruger kunde #${customerId} (${customer.first_name} <${customer.email}>)`);

    // ─── 1. Idempotens ────────────────────────────────────
    console.log('\n[Test 1] generateBookingToken-idempotens');
    setSetting(db, 'booking_token_reuse_min_days', '7');
    const t1 = generateBookingToken({
        customer_id: customerId,
        sales_user_id: null,
        flow: TEST_FLOW,
        intent_meeting_type_key: TEST_INTENT_KEY,
        ttl_days: 60
    });
    insertedTokens.push(t1);
    assert(typeof t1 === 'string' && t1.length === 16, `Token er 16 hex-tegn (fik ${t1?.length})`);

    const t2 = generateBookingToken({
        customer_id: customerId,
        sales_user_id: null,
        flow: TEST_FLOW,
        intent_meeting_type_key: TEST_INTENT_KEY,
        ttl_days: 60
    });
    assert(t1 === t2, 'Andet kald returnerer samme token (idempotens)');

    // Verificér at der KUN er én række
    const countSame = db.prepare(`
        SELECT COUNT(*) AS n FROM booking_tokens
        WHERE customer_id = ? AND flow = ? AND booking_activity_id IS NULL
    `).get(customerId, TEST_FLOW).n;
    assert(countSame === 1, `Kun én ubrugt token-række i DB (fik ${countSame})`);

    // ─── 2. {{booking_link}} substitution ─────────────────
    console.log('\n[Test 2] renderTemplate({{booking_link}})');
    setSetting(db, 'booking_public_url_base', 'https://bon.test.local');

    const body = 'Hej — book her: {{booking_link}}';
    const out = renderTemplate(body, {}, {
        customerId,
        userId: null,
        bookingFlow: TEST_FLOW,
        bookingIntent: TEST_INTENT_KEY,
        appendSignature: false
    });

    // Kort URL siden M8a — server redirect'er til den fulde tools-side.
    const expectedUrl = `https://bon.test.local/b/${t1}`;
    assert(out.includes(expectedUrl), `Output indeholder genbrugt token-URL: ${expectedUrl}`);
    assert(!out.includes('/book/'), 'URL er kort form (/b/), ikke fuld booking-sti');
    assert(!out.includes('{{booking_link}}'), 'Ingen rester af placeholder i output');

    // Verificér at idempotens stadig gælder ved render → samme antal rækker som før
    const countAfterRender = db.prepare(`
        SELECT COUNT(*) AS n FROM booking_tokens
        WHERE customer_id = ? AND flow = ? AND booking_activity_id IS NULL
    `).get(customerId, TEST_FLOW).n;
    assert(countAfterRender === 1, `Render skaber ikke ny token-række (stadig ${countAfterRender})`);

    // ─── 3. Manglende customerId ──────────────────────────
    //
    // ÆNDRET ADFÆRD: pladsholderen blev tidligere slettet i stilhed, og mailen
    // gik afsted med et hul hvor linket skulle stå. Nu kastes der, så afsenderen
    // får noget at handle på. Se scripts/test-booking-link-mail.js.
    console.log('\n[Test 3] Manglende customerId → kaster, sletter ikke');
    let threwNoCust = null;
    try { renderTemplate('Link: {{booking_link}}', {}, {}); } catch (e) { threwNoCust = e; }
    assert(threwNoCust !== null, 'Kaster uden customerId');
    assert(threwNoCust.code === 'booking_link_unresolvable', `Fejlkode booking_link_unresolvable (fik ${threwNoCust.code})`);

    // Test-mailen har pr. definition ingen kunde og skal stadig kunne sendes —
    // dér bliver linket til en synlig markering, ikke til ingenting.
    const lenientOut = renderTemplate('Link: {{booking_link}}', {}, { lenientBookingLink: true });
    assert(!lenientOut.includes('{{booking_link}}'), 'Lenient efterlader ikke pladsholderen rå');
    assert(lenientOut !== 'Link: ', 'Lenient efterlader ikke en tom plads');

    // ─── 4. Manglende baseUrl ─────────────────────────────
    console.log('\n[Test 4] Manglende booking_public_url_base → kaster');
    setSetting(db, 'booking_public_url_base', '');
    let threwNoUrl = null;
    try {
        renderTemplate('Link: {{booking_link}}', {}, { customerId, bookingFlow: TEST_FLOW });
    } catch (e) { threwNoUrl = e; }
    assert(threwNoUrl !== null, 'Kaster uden baseUrl');
    assert(/Settings/.test(threwNoUrl.message), 'Beskeden peger på Settings');

    console.log('\n✅ M7a alle tests bestået');
} finally {
    // Restore settings
    if (originalBaseUrl !== null) setSetting(db, 'booking_public_url_base', originalBaseUrl);
    else db.prepare('DELETE FROM settings WHERE key = ?').run('booking_public_url_base');
    if (originalReuseDays !== null) setSetting(db, 'booking_token_reuse_min_days', originalReuseDays);

    // Slet alle test-tokens
    for (const t of insertedTokens) {
        db.prepare('DELETE FROM booking_tokens WHERE token = ?').run(t);
    }
    // Sikkerhed: slet ALLE tokens for testkunden uden booking_activity_id (skabt under render)
    db.prepare(`
        DELETE FROM booking_tokens
        WHERE customer_id = ? AND flow = ? AND booking_activity_id IS NULL
    `).run(customerId, TEST_FLOW);
    console.log('\n🧹 Test-tokens og settings ryddet op');
}
