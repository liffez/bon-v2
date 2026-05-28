// tests/crm_outreach_integration.test.js
// Integration-test for routes/crm.js sektion 1.2.5:
//   - POST /api/crm/activity accepterer campaign_id og opdaterer
//     campaign_members.last_activity_at målrettet (erstatter den fjernede trigger)
//   - PATCH /api/crm/customer/:id/consent gemmer marketing_consent + do_not_contact
//     og logger til changelog
//
// Køres via: node --experimental-sqlite --test tests/crm_outreach_integration.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

// Stub SSE
const sseModule = require('../shared/sse');
const _sse = [];
sseModule.broadcast = (event, payload) => _sse.push({ event, payload });

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cvr TEXT, ean TEXT, city TEXT,
            is_internal INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL, last_name TEXT,
            email TEXT, phone TEXT,
            company_id INTEGER REFERENCES companies(id)
        );
        CREATE TABLE crm_customer_meta (
            customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
            owner_user_id INTEGER, stage TEXT DEFAULT 'active',
            marketing_consent INTEGER NOT NULL DEFAULT 0,
            do_not_contact INTEGER NOT NULL DEFAULT 0,
            tags TEXT, last_contact_at DATETIME, next_followup_at DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE crm_activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER, bon_id INTEGER,
            type TEXT NOT NULL, result TEXT, sentiment TEXT,
            text TEXT NOT NULL, due_at DATETIME, done_at DATETIME,
            owner_user_id INTEGER, purpose_id INTEGER,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
            action TEXT NOT NULL, field_name TEXT,
            old_value TEXT, new_value TEXT,
            user_id INTEGER, notes TEXT, payload TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Migrations 084 + 085 (085 omdøber quote_sent → contacted)
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '084_outreach_campaigns.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '085_campaign_status_rename.sql'), 'utf8'));

    // Seed
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Tester');
    db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run(1, 'Magasin A/S');
    db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run(2, 'Bagerhuset');
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, ?)').run(1, 'Anne', 1);
    db.prepare('INSERT INTO customers (id, first_name) VALUES (?, ?)').run(2, 'Bob');
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
// requireAuth() middleware tjekker req.session.userId; handlers læser req.session.user.id.
// Mock'en sætter begge så routen ikke 401'er.
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1 } }; next(); });
app.use('/api/crm', require('../routes/crm'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); _sse.length = 0; });

async function req(method, path, body) {
    const r = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, body: data };
}

// ─── POST /activity med campaign_id (sektion 1.2.5) ──────────

test('POST /activity uden campaign_id opdaterer ALLE kundens medlemskaber', async () => {
    // Setup: 2 kampagner, kunde 1 er medlem af begge
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(2, 'B');
    _testDb.prepare('INSERT INTO campaign_members (id, campaign_id, customer_id) VALUES (?, ?, ?)').run(101, 1, 1);
    _testDb.prepare('INSERT INTO campaign_members (id, campaign_id, customer_id) VALUES (?, ?, ?)').run(102, 2, 1);

    const r = await req('POST', '/api/crm/activity', {
        customer_id: 1, type: 'note', text: 'Generel note',
    });
    assert.strictEqual(r.status, 200);

    const m1 = _testDb.prepare('SELECT last_activity_at FROM campaign_members WHERE id = 101').get();
    const m2 = _testDb.prepare('SELECT last_activity_at FROM campaign_members WHERE id = 102').get();
    assert.ok(m1.last_activity_at, 'Medlem 101 skulle have last_activity_at sat');
    assert.ok(m2.last_activity_at, 'Medlem 102 skulle have last_activity_at sat');
});

test('POST /activity MED campaign_id opdaterer KUN det ene medlemskab', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(2, 'B');
    _testDb.prepare('INSERT INTO campaign_members (id, campaign_id, customer_id) VALUES (?, ?, ?)').run(101, 1, 1);
    _testDb.prepare('INSERT INTO campaign_members (id, campaign_id, customer_id) VALUES (?, ?, ?)').run(102, 2, 1);

    const r = await req('POST', '/api/crm/activity', {
        customer_id: 1, type: 'note', text: 'Kun for kampagne A',
        campaign_id: 1,
    });
    assert.strictEqual(r.status, 200);

    const m1 = _testDb.prepare('SELECT last_activity_at FROM campaign_members WHERE id = 101').get();
    const m2 = _testDb.prepare('SELECT last_activity_at FROM campaign_members WHERE id = 102').get();
    assert.ok(m1.last_activity_at, 'Medlem i kampagne A skulle være opdateret');
    assert.strictEqual(m2.last_activity_at, null, 'Medlem i kampagne B skal IKKE opdateres');

    // Aktivitet skal også selv have campaign_id sat
    const act = _testDb.prepare('SELECT campaign_id FROM crm_activities WHERE text = ?').get('Kun for kampagne A');
    assert.strictEqual(act.campaign_id, 1);
});

test('POST /activity for kunde uden medlemskaber gør ingenting på campaign_members', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    // Bob (id 2) er IKKE medlem

    const r = await req('POST', '/api/crm/activity', {
        customer_id: 2, type: 'note', text: 'For non-member',
    });
    assert.strictEqual(r.status, 200);

    const count = _testDb.prepare('SELECT COUNT(*) AS c FROM campaign_members').get().c;
    assert.strictEqual(count, 0, 'Ingen medlemmer skal være oprettet');
});

test('POST /activity broadcaster SSE med campaign_id i payload', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    await req('POST', '/api/crm/activity', {
        customer_id: 1, type: 'note', text: 'Test', campaign_id: 1,
    });
    const evt = _sse.find(e => e.event === 'crm_activity_created');
    assert.ok(evt);
    assert.strictEqual(evt.payload.campaign_id, 1);
});

// ─── PATCH /customer/:id/consent (sektion 1.3) ───────────────

test('PATCH /consent opretter crm_customer_meta hvis den ikke findes', async () => {
    const r = await req('PATCH', '/api/crm/customer/1/consent', {
        marketing_consent: 1,
    });
    assert.strictEqual(r.status, 200);

    const meta = _testDb.prepare('SELECT * FROM crm_customer_meta WHERE customer_id = 1').get();
    assert.ok(meta);
    assert.strictEqual(meta.marketing_consent, 1);
    assert.strictEqual(meta.do_not_contact, 0);
});

test('PATCH /consent opdaterer eksisterende crm_customer_meta', async () => {
    _testDb.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent) VALUES (?, ?)').run(1, 0);

    const r = await req('PATCH', '/api/crm/customer/1/consent', {
        marketing_consent: 1, do_not_contact: 1,
    });
    assert.strictEqual(r.status, 200);

    const meta = _testDb.prepare('SELECT marketing_consent, do_not_contact FROM crm_customer_meta WHERE customer_id = 1').get();
    assert.strictEqual(meta.marketing_consent, 1);
    assert.strictEqual(meta.do_not_contact, 1);
});

test('PATCH /consent logger changelog-row per ændret felt', async () => {
    _testDb.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact) VALUES (?, ?, ?)').run(1, 0, 0);

    await req('PATCH', '/api/crm/customer/1/consent', {
        marketing_consent: 1, do_not_contact: 1,
    });

    const logs = _testDb.prepare(`
        SELECT field_name, old_value, new_value FROM changelog
        WHERE entity_type = 'crm_customer_meta' AND entity_id = 1
        ORDER BY id
    `).all();
    assert.strictEqual(logs.length, 2);
    assert.deepStrictEqual(
        logs.map(l => l.field_name).sort(),
        ['do_not_contact', 'marketing_consent']
    );
});

test('PATCH /consent logger ikke uændrede felter', async () => {
    _testDb.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact) VALUES (?, ?, ?)').run(1, 1, 0);

    await req('PATCH', '/api/crm/customer/1/consent', {
        marketing_consent: 1, do_not_contact: 1, // marketing er uændret
    });

    const logs = _testDb.prepare(`
        SELECT field_name FROM changelog WHERE entity_type = 'crm_customer_meta' AND entity_id = 1
    `).all();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].field_name, 'do_not_contact');
});

test('PATCH /consent uden felter returnerer 400', async () => {
    const r = await req('PATCH', '/api/crm/customer/1/consent', {});
    assert.strictEqual(r.status, 400);
});

test('PATCH /consent for ukendt kunde returnerer 404', async () => {
    const r = await req('PATCH', '/api/crm/customer/9999/consent', { marketing_consent: 1 });
    assert.strictEqual(r.status, 404);
});

test('PATCH /consent broadcaster crm_consent_updated', async () => {
    await req('PATCH', '/api/crm/customer/1/consent', { marketing_consent: 1 });
    const evt = _sse.find(e => e.event === 'crm_consent_updated');
    assert.ok(evt);
    assert.strictEqual(evt.payload.customer_id, 1);
});

test('PATCH /consent accepterer true/false (ikke kun 0/1)', async () => {
    await req('PATCH', '/api/crm/customer/1/consent', {
        marketing_consent: true, do_not_contact: false,
    });
    const meta = _testDb.prepare('SELECT marketing_consent, do_not_contact FROM crm_customer_meta WHERE customer_id = 1').get();
    assert.strictEqual(meta.marketing_consent, 1);
    assert.strictEqual(meta.do_not_contact, 0);
});
