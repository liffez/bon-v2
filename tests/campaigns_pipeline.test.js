// tests/campaigns_pipeline.test.js
// Integration-test for GET /api/campaigns/pipeline (Fase 4).
// Verificerer kanban-grupperingen + multi-kampagne-tælling + kort-type-klassifikation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
sseModule.broadcast = () => {};

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        CREATE TABLE addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            street TEXT, city TEXT, zipcode TEXT
        );
        CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cvr TEXT, ean TEXT,
            -- Cachen fra contact_points (is_primary). Pipelinen læser dem, så et
            -- firma-medlem UDEN kontaktperson stadig har noget at ringe/maile til.
            phone TEXT, email TEXT,
            address_id INTEGER REFERENCES addresses(id),
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
            entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
            action TEXT NOT NULL, field_name TEXT,
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
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '084_outreach_campaigns.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '085_campaign_status_rename.sql'), 'utf8'));

    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Tester');
    db.prepare('INSERT INTO addresses (id, city) VALUES (?, ?)').run(1, 'København');
    db.prepare('INSERT INTO companies (id, name, address_id) VALUES (?, ?, ?)').run(1, 'Firma A', 1);
    db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run(2, 'Firma B');
    db.prepare('INSERT INTO customers (id, first_name, last_name, company_id) VALUES (?, ?, ?, ?)').run(1, 'Anne', 'A', 1);
    db.prepare('INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)').run(2, 'Privat', 'P');
    db.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent) VALUES (?, ?)').run(2, 1);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1 } }; next(); });
app.use('/api/campaigns', require('../routes/campaigns'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function get(path) {
    const r = await fetch(`${baseUrl}${path}`);
    return { status: r.status, body: await r.json() };
}

test('GET /pipeline tom returnerer kolonner med 0 medlemmer', async () => {
    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.columns);
    assert.deepStrictEqual(
        Object.keys(r.body.columns).sort(),
        ['contacted', 'lead', 'lost', 'negotiating', 'won']
    );
    assert.strictEqual(r.body.columns.lead.members.length, 0);
    assert.strictEqual(r.body.active_campaign_id, null);
});

test('GET /pipeline grupperer medlemmer pr. member_status', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 2, 'contacted')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (1, 2, 'won')`).run();

    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.body.columns.lead.members.length, 1);
    assert.strictEqual(r.body.columns.contacted.members.length, 1);
    assert.strictEqual(r.body.columns.won.members.length, 1);
    assert.strictEqual(r.body.columns.negotiating.members.length, 0);
});

test('GET /pipeline?campaign_id=X filtrerer til en kampagne', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(2, 'B');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (2, 2, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline?campaign_id=1');
    assert.strictEqual(r.body.active_campaign_id, 1);
    assert.strictEqual(r.body.columns.lead.members.length, 1);
    assert.strictEqual(r.body.columns.lead.members[0].campaign_id, 1);
});

test('GET /pipeline skjuler lukkede kampagner i global visning', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name, is_active) VALUES (?, ?, ?)').run(1, 'Aktiv', 1);
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name, is_active) VALUES (?, ?, ?)').run(2, 'Lukket', 0);
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (2, 2, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.body.columns.lead.members.length, 1);
    assert.strictEqual(r.body.columns.lead.members[0].campaign_id, 1);
});

test('GET /pipeline klassificerer card_type: b2b_only', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 1, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    const m = r.body.columns.lead.members[0];
    assert.strictEqual(m.card_type, 'b2b_only');
    assert.strictEqual(m.company_name, 'Firma A');
    assert.strictEqual(m.company_city, 'København');
    assert.strictEqual(m.contact_person, null);
});

test('GET /pipeline klassificerer card_type: b2b_with_contact', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, customer_id, member_status) VALUES (1, 1, 1, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    const m = r.body.columns.lead.members[0];
    assert.strictEqual(m.card_type, 'b2b_with_contact');
    assert.strictEqual(m.contact_person, 'Anne A');
    assert.strictEqual(m.company_name, 'Firma A');
});

test('GET /pipeline klassificerer card_type: b2c', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (1, 2, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    const m = r.body.columns.lead.members[0];
    assert.strictEqual(m.card_type, 'b2c');
    assert.strictEqual(m.contact_person, 'Privat P');
    assert.strictEqual(m.company_id, null);
});

test('GET /pipeline tæller in_n_open_campaigns korrekt på tværs af kampagner', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(2, 'B');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name, is_active) VALUES (?, ?, ?)').run(3, 'Lukket', 0);
    // Anne (id 1) er medlem af alle tre, men lukket-kampagne tæller ikke
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (1, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (2, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (3, 1, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    const annes = r.body.columns.lead.members.filter(m => m.customer_id === 1);
    assert.strictEqual(annes.length, 2);
    annes.forEach(a => assert.strictEqual(a.in_n_open_campaigns, 2,
        'Begge åbne kampagners medlemmer skal vise in_n_open_campaigns=2 (lukket tæller ikke)'));
});

test('GET /pipeline in_n_open_campaigns tæller IKKE won/lost-medlemmer', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(2, 'B');
    // Anne er won i B, lead i A → in_n_open_campaigns på A skal være 1
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status) VALUES (1, 1, 'lead')`).run();
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, customer_id, member_status, lost_reason) VALUES (2, 1, 'won', NULL)`).run();

    const r = await get('/api/campaigns/pipeline');
    const lead = r.body.columns.lead.members[0];
    const won = r.body.columns.won.members[0];
    assert.strictEqual(lead.in_n_open_campaigns, 1);
    assert.strictEqual(won.in_n_open_campaigns, 1);
});

test('GET /pipeline returnerer lost_reason på lost-medlemmer', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status, lost_reason) VALUES (1, 1, 'lost', 'Pris')`).run();

    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.body.columns.lost.members.length, 1);
    assert.strictEqual(r.body.columns.lost.members[0].lost_reason, 'Pris');
});

test('GET /pipeline inkluderer campaign_name pr. medlem', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'Forår 2026');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status) VALUES (1, 1, 'lead')`).run();

    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.body.columns.lead.members[0].campaign_name, 'Forår 2026');
});

test('GET /pipeline inkluderer assigned_name når sat', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (id, name) VALUES (?, ?)').run(1, 'A');
    _testDb.prepare(`INSERT INTO campaign_members (campaign_id, company_id, member_status, assigned_user_id) VALUES (1, 1, 'lead', 1)`).run();

    const r = await get('/api/campaigns/pipeline');
    assert.strictEqual(r.body.columns.lead.members[0].assigned_name, 'Tester');
});
