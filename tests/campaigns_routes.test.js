// tests/campaigns_routes.test.js
// Integration-test for routes/campaigns.js mod express + in-memory db.
// Køres via: node --experimental-sqlite --test tests/campaigns_routes.test.js
//
// Vi monter routes/campaigns.js på en isoleret express-app og kalder via supertest-lignende
// fetch mod en spawned httpserver. Database og session mockes så vi ikke rammer prod-DB.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');

// ─── Setup: monkey-patch db/database.getDb() til at returnere in-memory DB ────

const dbModule = require('../db/database');
let _testDb = null;
const _origGetDb = dbModule.getDb;
dbModule.getDb = () => _testDb;

// Mock session-user på alle requests
let _mockUserId = 1;

// Hjælper: opret frisk test-db med minimum prerequisites + migration 084
function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');

    // Minimum prerequisites — kun det migration 084 + routes/campaigns.js + logChange behøver
    db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT
        );
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
            marketing_consent INTEGER NOT NULL DEFAULT 0,
            do_not_contact INTEGER NOT NULL DEFAULT 0,
            tags TEXT
        );
        CREATE TABLE changelog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            field_name TEXT,
            old_value TEXT, new_value TEXT,
            user_id INTEGER, notes TEXT, payload TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE crm_activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER, bon_id INTEGER,
            type TEXT NOT NULL, text TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Kør migration 084
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', '084_outreach_campaigns.sql'),
        'utf8',
    );
    db.exec(sql);

    // Seed: bruger + et par firmaer + kunder
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Test User');
    db.prepare('INSERT INTO companies (id, name, cvr) VALUES (?, ?, ?)').run(1, 'Magasin A/S', '12345678');
    db.prepare('INSERT INTO companies (id, name, cvr) VALUES (?, ?, ?)').run(2, 'Bagerhuset', '87654321');
    db.prepare('INSERT INTO customers (id, first_name, last_name, company_id) VALUES (?, ?, ?, ?)').run(1, 'Anne', 'Andersen', 1);
    db.prepare('INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)').run(2, 'Privat', 'Person');
    db.prepare('INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)').run(3, 'B2C', 'Consent');
    db.prepare('INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)').run(4, 'DNC', 'Kunde');
    db.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent) VALUES (?, ?)').run(2, 0); // B2C uden consent
    db.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent) VALUES (?, ?)').run(3, 1); // B2C MED consent
    db.prepare('INSERT INTO crm_customer_meta (customer_id, do_not_contact) VALUES (?, ?)').run(4, 1); // DNC

    return db;
}

// Stub SSE-broadcast så vi ikke kræver en SSE-router i tests
const sseModule = require('../shared/sse');
const _sseEvents = [];
sseModule.broadcast = (event, payload) => _sseEvents.push({ event, payload });

// Mount router på en isoleret express-app
const express = require('express');
const app = express();
app.use(express.json());
// requireAuth() middleware (hvis aktiv på router) tjekker req.session.userId.
// Vores handlers læser også req.session.userId direkte. Mocken sætter begge så
// vi er robuste hvis router-mounting senere ændres.
app.use((req, _res, next) => { req.session = { userId: _mockUserId, user: { id: _mockUserId } }; next(); });
app.use('/api/campaigns', require('../routes/campaigns'));

// Hjælpere
let server, baseUrl;
async function startServer() {
    return new Promise((resolve) => {
        server = app.listen(0, () => {
            const { port } = server.address();
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
}
async function stopServer() {
    return new Promise((resolve) => server.close(resolve));
}
async function jsonRequest(method, path, body) {
    const r = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* tom respons */ }
    return { status: r.status, body: data };
}

test.before(startServer);
test.after(stopServer);
test.beforeEach(() => {
    _testDb = createFreshDb();
    _sseEvents.length = 0;
});

// ─── Kampagne-CRUD ──────────────────────────────────────────

test('POST /api/campaigns opretter kampagne og broadcaster SSE', async () => {
    const r = await jsonRequest('POST', '/api/campaigns', { name: 'Forår 2026' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.id > 0);
    assert.ok(_sseEvents.some(e => e.event === 'campaign_created'));

    // Verificér changelog-row
    const log = _testDb.prepare(`
        SELECT * FROM changelog WHERE entity_type = 'outreach_campaign' AND action = 'create'
    `).get();
    assert.ok(log);
    assert.strictEqual(log.user_id, 1);
});

test('POST /api/campaigns uden name returnerer 400', async () => {
    const r = await jsonRequest('POST', '/api/campaigns', {});
    assert.strictEqual(r.status, 400);
});

test('POST /api/campaigns med duplikat-navn (aktiv) returnerer 409 name_in_use', async () => {
    await jsonRequest('POST', '/api/campaigns', { name: 'Duplikat' });
    const r = await jsonRequest('POST', '/api/campaigns', { name: 'Duplikat' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'name_in_use');
});

test('POST /api/campaigns med navn på lukket kampagne returnerer 409 name_closed reopenable', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Lukket' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/close`);

    const r = await jsonRequest('POST', '/api/campaigns', { name: 'Lukket' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'name_closed');
    assert.strictEqual(r.body.reopenable, true);
    assert.strictEqual(r.body.existing_id, c.body.id);
});

test('POST /:id/reopen genåbner lukket kampagne', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'TilGenåbning' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/close`);

    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/reopen`);
    assert.strictEqual(r.status, 200);

    const row = _testDb.prepare('SELECT is_active, closed_at FROM outreach_campaigns WHERE id = ?').get(c.body.id);
    assert.strictEqual(row.is_active, 1);
    assert.strictEqual(row.closed_at, null);
});

test('GET /api/campaigns skjuler lukkede kampagner default', async () => {
    const a = await jsonRequest('POST', '/api/campaigns', { name: 'Aktiv' });
    const b = await jsonRequest('POST', '/api/campaigns', { name: 'Lukket' });
    await jsonRequest('POST', `/api/campaigns/${b.body.id}/close`);

    const r = await jsonRequest('GET', '/api/campaigns');
    assert.strictEqual(r.body.length, 1);
    assert.strictEqual(r.body[0].name, 'Aktiv');
});

test('GET /api/campaigns?active=0 viser også lukkede', async () => {
    await jsonRequest('POST', '/api/campaigns', { name: 'Aktiv' });
    const b = await jsonRequest('POST', '/api/campaigns', { name: 'Lukket' });
    await jsonRequest('POST', `/api/campaigns/${b.body.id}/close`);

    const r = await jsonRequest('GET', '/api/campaigns?active=0');
    assert.strictEqual(r.body.length, 2);
});

test('GET /api/campaigns inkluderer member_count + won_count + open_count', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Stats' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }, { company_id: 2 }],
    });

    const r = await jsonRequest('GET', '/api/campaigns');
    const camp = r.body.find(c => c.name === 'Stats');
    assert.strictEqual(camp.member_count, 2);
    assert.strictEqual(camp.won_count, 0);
    assert.strictEqual(camp.open_count, 2);
});

test('GET /api/campaigns/:id med ukendt id returnerer 404', async () => {
    const r = await jsonRequest('GET', '/api/campaigns/9999');
    assert.strictEqual(r.status, 404);
});

test('PATCH /api/campaigns/:id opdaterer felter', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Original' });
    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}`, { description: 'Ny beskrivelse' });
    assert.strictEqual(r.status, 200);

    const row = _testDb.prepare('SELECT description FROM outreach_campaigns WHERE id = ?').get(c.body.id);
    assert.strictEqual(row.description, 'Ny beskrivelse');
});

test('PATCH /api/campaigns/:id med duplikat-navn returnerer 409', async () => {
    await jsonRequest('POST', '/api/campaigns', { name: 'Eksisterer' });
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'AndenKampagne' });

    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}`, { name: 'Eksisterer' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'name_in_use');
});

// ─── Medlemmer ──────────────────────────────────────────────

test('POST /:id/members tilføjer B2B-medlem', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.added, 1);
    assert.strictEqual(r.body.skipped.length, 0);
    assert.ok(_sseEvents.some(e => e.event === 'campaign_members_added'));
});

test('POST /:id/members tilføjer privatkunde MED consent', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ customer_id: 3 }], // consent=1
    });
    assert.strictEqual(r.body.added, 1);
});

test('POST /:id/members blokerer privatkunde UDEN consent (§10)', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ customer_id: 2 }], // consent=0
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped.length, 1);
    assert.strictEqual(r.body.skipped[0].reason, 'no_marketing_consent_b2c');
});

test('POST /:id/members blokerer privatkunde UDEN meta-row (§10: samtykke kan ikke antages)', async () => {
    // Kunde uden crm_customer_meta-row — ingen explicit consent givet
    _testDb.prepare('INSERT INTO customers (id, first_name) VALUES (?, ?)').run(99, 'NoMeta');
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ customer_id: 99 }], // ingen meta-row
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'no_marketing_consent_b2c');
});

test('POST /:id/members blokerer DNC uanset B2B/B2C', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1, customer_id: 4 }], // B2B men customer har DNC
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'do_not_contact');
});

test('POST /:id/members tillader B2B uden customer_id (ingen consent-tjek)', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    // company_id 1 alene — selv om customer 2 (privat uden consent) er knyttet, røres han ikke
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    assert.strictEqual(r.body.added, 1);
});

test('POST /:id/members blokerer dublet på samme firma alene', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'already_member');
});

test('POST /:id/members tillader firma+kontakt og firma-alene side om side', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [
            { company_id: 1 },              // firma alene
            { company_id: 1, customer_id: 1 }, // firma + kontakt
        ],
    });
    assert.strictEqual(r.body.added, 2);
});

test('POST /:id/members blokerer tom payload (intet entity)', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{}],
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'no_entity');
});

test('POST /:id/members på lukket kampagne returnerer 409', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/close`);

    const r = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'campaign_closed');
});

test('POST /:id/members på ukendt kampagne returnerer 404', async () => {
    const r = await jsonRequest('POST', '/api/campaigns/9999/members', {
        members: [{ company_id: 1 }],
    });
    assert.strictEqual(r.status, 404);
});

test('PATCH /:campaignId/members/:memberId opdaterer status og logger', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const memberId = add.body.member_ids[0];

    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}/members/${memberId}`, {
        member_status: 'quote_sent',
    });
    assert.strictEqual(r.status, 200);

    const row = _testDb.prepare('SELECT member_status FROM campaign_members WHERE id = ?').get(memberId);
    assert.strictEqual(row.member_status, 'quote_sent');

    const log = _testDb.prepare(`
        SELECT * FROM changelog
        WHERE entity_type = 'campaign_member' AND action = 'status_change'
    `).get();
    assert.ok(log);
    assert.strictEqual(log.old_value, 'lead');
    assert.strictEqual(log.new_value, 'quote_sent');
});

test('PATCH .../members/:m med status=lost uden lost_reason returnerer 400', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const memberId = add.body.member_ids[0];

    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}/members/${memberId}`, {
        member_status: 'lost',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'lost_reason_required');
});

test('PATCH .../members/:m med status=lost + lost_reason går igennem', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const memberId = add.body.member_ids[0];

    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}/members/${memberId}`, {
        member_status: 'lost',
        lost_reason: 'Pris',
    });
    assert.strictEqual(r.status, 200);
});

test('PATCH .../members/:m med ugyldig status returnerer 400', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const r = await jsonRequest('PATCH', `/api/campaigns/${c.body.id}/members/${add.body.member_ids[0]}`, {
        member_status: 'invalid',
    });
    assert.strictEqual(r.status, 400);
});

test('PATCH .../members/:m hvor member tilhører anden kampagne returnerer 404', async () => {
    const a = await jsonRequest('POST', '/api/campaigns', { name: 'A' });
    const b = await jsonRequest('POST', '/api/campaigns', { name: 'B' });
    const add = await jsonRequest('POST', `/api/campaigns/${a.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const r = await jsonRequest('PATCH', `/api/campaigns/${b.body.id}/members/${add.body.member_ids[0]}`, {
        member_status: 'won',
    });
    assert.strictEqual(r.status, 404);
});

test('DELETE .../members/:m fjerner member og logger', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }],
    });
    const memberId = add.body.member_ids[0];

    const r = await jsonRequest('DELETE', `/api/campaigns/${c.body.id}/members/${memberId}`);
    assert.strictEqual(r.status, 200);

    const row = _testDb.prepare('SELECT id FROM campaign_members WHERE id = ?').get(memberId);
    assert.strictEqual(row, undefined);

    const log = _testDb.prepare(`
        SELECT * FROM changelog WHERE entity_type = 'campaign_member' AND action = 'delete'
    `).get();
    assert.ok(log);
});

test('GET /:id/members?status=lead filtrerer på status', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    const add = await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1 }, { company_id: 2 }],
    });
    // Skift første til quote_sent
    await jsonRequest('PATCH', `/api/campaigns/${c.body.id}/members/${add.body.member_ids[0]}`, {
        member_status: 'quote_sent',
    });

    const r = await jsonRequest('GET', `/api/campaigns/${c.body.id}/members?status=lead`);
    assert.strictEqual(r.body.length, 1);
    assert.strictEqual(r.body[0].member_status, 'lead');
});

test('GET /:id/members joiner kontaktperson som first_name + last_name', async () => {
    const c = await jsonRequest('POST', '/api/campaigns', { name: 'Test' });
    await jsonRequest('POST', `/api/campaigns/${c.body.id}/members`, {
        members: [{ company_id: 1, customer_id: 1 }],
    });

    const r = await jsonRequest('GET', `/api/campaigns/${c.body.id}/members`);
    assert.strictEqual(r.body[0].contact_person, 'Anne Andersen');
    assert.strictEqual(r.body[0].company_name, 'Magasin A/S');
});
