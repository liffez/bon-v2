// tests/crm_companies_aggregation.test.js
// Regression-test for GET /api/crm/companies: total_revenue og total_orders må IKKE
// multipliceres med antallet af kontakter under firmaet.
//
// Tidligere bug: 84 bons × 39 kontakter → 12,5 mio kr (faktisk: 321k).

const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
sseModule.broadcast = () => {};

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Minimum schema for /crm/companies + dets joins
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        CREATE TABLE addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, street_name TEXT, street_nr TEXT, postal_code TEXT, city TEXT);
        CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL, legal_name TEXT, cvr TEXT, ean TEXT,
            alternate_names TEXT, last_enriched_at TEXT,
            address_id INTEGER REFERENCES addresses(id),
            is_active INTEGER NOT NULL DEFAULT 1,
            is_internal INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL, last_name TEXT,
            email TEXT, phone TEXT,
            company_id INTEGER REFERENCES companies(id),
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE crm_customer_meta (
            customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
            stage TEXT DEFAULT 'active',
            marketing_consent INTEGER NOT NULL DEFAULT 0,
            do_not_contact INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE bons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER REFERENCES companies(id),
            customer_id INTEGER REFERENCES customers(id),
            total_price REAL NOT NULL DEFAULT 0,
            delivery_date TEXT,
            is_offer INTEGER NOT NULL DEFAULT 0,
            is_internal INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE entity_flags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT, entity_id INTEGER,
            dismissed_at DATETIME
        );
    `);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1 } }; next(); });
app.use('/api/crm', require('../routes/crm'));

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

test('GET /companies: total_revenue multipliceres IKKE med antal kontakter', async () => {
    // Setup: ét firma, 3 kontakter, 2 bons à 1000 kr.
    // Forventet: total_revenue = 2000 (ikke 6000)
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Test Firma');
    _testDb.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, 1)').run(1, 'Anne');
    _testDb.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, 1)').run(2, 'Bob');
    _testDb.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, 1)').run(3, 'Carla');
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 1000, '2026-01-01')`).run();
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 1000, '2026-01-02')`).run();

    const r = await get('/api/crm/companies');
    const co = r.body[0];
    assert.strictEqual(co.contact_count, 3);
    assert.strictEqual(co.total_orders, 2, 'Skulle være 2 bons, ikke 6 (2×3)');
    assert.strictEqual(co.total_revenue, 2000, 'Skulle være 2000 kr, ikke 6000 (multipliceret med kontakter)');
});

test('GET /companies: total_orders skala-uafhængig — 84 bons × 39 kontakter', async () => {
    // Realistisk: stort universitet med mange afdelinger og bons
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Storrkunde');
    for (let i = 1; i <= 39; i++) {
        _testDb.prepare('INSERT INTO customers (first_name, company_id) VALUES (?, 1)').run('K' + i);
    }
    for (let i = 1; i <= 84; i++) {
        _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 3821, '2026-01-01')`).run();
    }
    // Faktisk: 84 × 3821 = 320.964 kr (matcher screenshot'ets "321k kr" detalje-side)

    const r = await get('/api/crm/companies');
    const co = r.body.find(x => x.name === 'Storrkunde');
    assert.strictEqual(co.contact_count, 39);
    assert.strictEqual(co.total_orders, 84);
    assert.strictEqual(co.total_revenue, 84 * 3821);
});

test('GET /companies: firma uden bons returnerer total_revenue=0', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Ingen ordrer');
    _testDb.prepare('INSERT INTO customers (first_name, company_id) VALUES (?, 1)').run('Anne');

    const r = await get('/api/crm/companies');
    const co = r.body[0];
    assert.strictEqual(co.total_orders, 0);
    assert.strictEqual(co.total_revenue, 0);
    assert.strictEqual(co.last_order_date, null);
});

test('GET /companies: bons med is_internal=1 ekskluderes', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, is_internal) VALUES (1, 500, 0)`).run();
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, is_internal) VALUES (1, 9999, 1)`).run();

    const r = await get('/api/crm/companies');
    const co = r.body[0];
    assert.strictEqual(co.total_orders, 1);
    assert.strictEqual(co.total_revenue, 500);
});

test('GET /companies: last_order_date er korrekt, ikke multipliceret', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    _testDb.prepare('INSERT INTO customers (first_name, company_id) VALUES (?, 1)').run('A');
    _testDb.prepare('INSERT INTO customers (first_name, company_id) VALUES (?, 1)').run('B');
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 100, '2025-12-01')`).run();
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 100, '2026-03-15')`).run();

    const r = await get('/api/crm/companies');
    assert.strictEqual(r.body[0].last_order_date, '2026-03-15');
});

test('GET /companies?order_after=X filtrerer på last_order_date', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Gammel');
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('Ny');
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (1, 100, '2024-01-01')`).run();
    _testDb.prepare(`INSERT INTO bons (company_id, total_price, delivery_date) VALUES (2, 100, '2026-03-01')`).run();

    const r = await get('/api/crm/companies?order_after=2025-01-01');
    const names = r.body.map(c => c.name);
    assert.ok(names.includes('Ny'));
    assert.ok(!names.includes('Gammel'));
});

test('GET /companies?stage=dormant inkluderer firmaer uden ordrer', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Aldrig handlet');

    const r = await get('/api/crm/companies?stage=dormant');
    assert.strictEqual(r.body.length, 1);
    assert.strictEqual(r.body[0].aggregated_stage, 'dormant');
});

test('GET /companies: interne firmaer ekskluderes', async () => {
    _testDb.prepare('INSERT INTO companies (id, name, is_internal) VALUES (1, ?, 1)').run('RR Produktion');
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('Rigtig kunde');

    const r = await get('/api/crm/companies');
    const names = r.body.map(c => c.name);
    assert.ok(!names.includes('RR Produktion'));
    assert.ok(names.includes('Rigtig kunde'));
});
