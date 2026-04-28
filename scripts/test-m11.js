// scripts/test-m11.js
// ==========================================
// Verifikation for M11 (CRM mail-compose med booking-link).
//
// In-process test:
//   M11a: renderTemplate(text, {}, ctx) — som det kaldes fra
//         POST /api/customers/:id/mail — substituerer {{booking_link}}
//         til kort URL og opretter token bundet til (customer, user, flow, intent).
//   M11b: SQL-query der bagved /api/booking/meeting-types/intent endpoint
//         returnerer alle aktive types inkl. is_bookable=0.
//
// HTTP-validering af endpointene + auth-flowet er allerede dækket af
// server-spawn-mønstret i test-m8.js.
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const { getDb } = require('../db/database');
const { renderTemplate } = require('../services/mailService');

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

const db = getDb();

// Find test-data
const customer = db.prepare("SELECT id FROM customers WHERE LOWER(email) = LOWER(?)").get('leifzeeberg@hotmail.com')
              || db.prepare("SELECT id FROM customers WHERE is_active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1").get();
if (!customer) throw new Error('Ingen test-kunde');

const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
if (!admin) throw new Error('Ingen admin');

const savedPublicUrlBase = getSetting(db, 'booking_public_url_base');
setSetting(db, 'booking_public_url_base', 'https://bon.test.local');

const createdTokens = [];

try {
    // ─── M11b: meeting_types/intent SQL ────────────────────
    console.log('[M11b] SQL bag /api/booking/meeting-types/intent');
    const types = db.prepare(`
        SELECT id, key, label, emoji, description, duration_min, is_bookable
        FROM meeting_types
        WHERE is_active = 1
        ORDER BY sort_order, id
    `).all();
    assert(types.length >= 4, `Returnerer alle aktive typer (fik ${types.length})`);
    const hasBookable    = types.some(mt => mt.is_bookable === 1);
    const hasNonBookable = types.some(mt => mt.is_bookable === 0);
    assert(hasBookable,    'Indeholder is_bookable=1 typer (smagning, andet)');
    assert(hasNonBookable, 'Indeholder is_bookable=0 typer (gennemgang m.fl.)');

    // ─── M11a: renderTemplate({{booking_link}}) ────────────
    console.log('\n[M11a] renderTemplate substituerer {{booking_link}}');

    const body = 'Hej!\n\nKlik for at booke: {{booking_link}}\n\n— Anne';
    const rendered = renderTemplate(body, {}, {
        customerId: customer.id,
        userId:     admin.id,
        bookingFlow:   'smagning',
        bookingIntent: 'gennemgang',
        appendSignature: false
    });

    const linkMatch = rendered.match(/https:\/\/bon\.test\.local\/b\/([a-f0-9]+)/);
    assert(!!linkMatch, 'Output indeholder kort URL /b/TOKEN');
    assert(!rendered.includes('{{booking_link}}'), 'Placeholder fuldt erstattet');
    assert(!rendered.includes('Med venlig hilsen'), 'Ingen signatur appended (appendSignature: false)');

    const token = linkMatch[1];
    createdTokens.push(token);

    const t = db.prepare(`
        SELECT bt.flow, bt.customer_id, bt.sales_user_id,
               mt.key AS intent_key
        FROM booking_tokens bt
        LEFT JOIN meeting_types mt ON mt.id = bt.intent_meeting_type_id
        WHERE bt.token = ?
    `).get(token);
    assert(t, 'Token findes i DB');
    assert(t.flow === 'smagning',     `flow = smagning (fik ${t.flow})`);
    assert(t.intent_key === 'gennemgang', `intent = gennemgang (fik ${t.intent_key})`);
    assert(t.customer_id === customer.id, `customer_id = ${customer.id}`);
    assert(t.sales_user_id === admin.id,  `sales_user_id = admin (${admin.id})`);

    // ─── Idempotens: samme params → samme token ───────────
    console.log('\n[M11/idempotens] Andet kald med samme params');
    const rendered2 = renderTemplate('Link: {{booking_link}}', {}, {
        customerId: customer.id, userId: admin.id,
        bookingFlow: 'smagning', bookingIntent: 'gennemgang',
        appendSignature: false
    });
    const link2 = rendered2.match(/\/b\/([a-f0-9]+)/);
    assert(link2[1] === token, `Samme token genbrugt (idempotens P4)`);

    // ─── Forskellig flow → nyt token ──────────────────────
    console.log('\n[M11/idempotens] Forskellig flow → nyt token');
    const rendered3 = renderTemplate('Skriv til os: {{booking_link}}', {}, {
        customerId: customer.id, userId: admin.id,
        bookingFlow: 'kontakt', bookingIntent: null,
        appendSignature: false
    });
    const link3 = rendered3.match(/\/b\/([a-f0-9]+)/);
    assert(link3[1] !== token, `Nyt token til kontakt-flow`);
    createdTokens.push(link3[1]);

    const t3 = db.prepare("SELECT flow FROM booking_tokens WHERE token = ?").get(link3[1]);
    assert(t3.flow === 'kontakt', `Nyt token har flow=kontakt (fik ${t3.flow})`);

    // ─── Forskellig sales_user → nyt token ────────────────
    console.log('\n[M11/idempotens] Forskellig sælger → nyt token');
    const otherUser = db.prepare("SELECT id FROM users WHERE id != ? AND is_active = 1 LIMIT 1").get(admin.id);
    if (otherUser) {
        const rendered4 = renderTemplate('Link: {{booking_link}}', {}, {
            customerId: customer.id, userId: otherUser.id,
            bookingFlow: 'smagning', bookingIntent: 'gennemgang',
            appendSignature: false
        });
        const link4 = rendered4.match(/\/b\/([a-f0-9]+)/);
        assert(link4[1] !== token, `Nyt token når sales_user_id ændres`);
        createdTokens.push(link4[1]);
    }

    console.log('\n✅ M11 alle tests bestået');
} finally {
    if (savedPublicUrlBase === null) db.prepare('DELETE FROM settings WHERE key = ?').run('booking_public_url_base');
    else setSetting(db, 'booking_public_url_base', savedPublicUrlBase);

    for (const t of createdTokens) {
        db.prepare('DELETE FROM booking_tokens WHERE token = ?').run(t);
    }
    db.prepare("DELETE FROM booking_tokens WHERE customer_id = ? AND created_at > datetime('now', '-5 minutes') AND booking_activity_id IS NULL")
      .run(customer.id);

    console.log('\n🧹 Test-data ryddet op');
}
