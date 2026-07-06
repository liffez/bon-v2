// tests/campaigns_from_suggestion.test.js
// Integration-test for POST /api/campaigns/from-suggestion (Fase 5):
//   - Opret kampagne fra sovende kunder
//   - Filtrér på days_since_last + min_total_revenue
//   - Håndhæv jura: §10 (B2C consent) + DNC
//   - Dedup pr. firma (samme firma med flere kontakter = ét B2B-medlemskab)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
const _sse = [];
sseModule.broadcast = (event, payload) => _sse.push({ event, payload });

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        CREATE TABLE addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, street TEXT, city TEXT, zipcode TEXT);
        CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cvr TEXT, ean TEXT,
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
            marketing_consent INTEGER NOT NULL DEFAULT 0,
            do_not_contact INTEGER NOT NULL DEFAULT 0,
            tags TEXT
        );
        CREATE TABLE bons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER, customer_id INTEGER,
            total_price REAL NOT NULL DEFAULT 0,
            delivery_date TEXT,
            is_offer INTEGER NOT NULL DEFAULT 0,
            is_internal INTEGER NOT NULL DEFAULT 0
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
    return db;
}

// Helper: opret en kunde med en ordre N dage tilbage og given total_revenue
function _seedDormantCustomer(db, opts) {
    const { id, first_name, company_id = null, days_ago, revenue, marketing_consent = 0, do_not_contact = 0 } = opts;
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, ?)').run(id, first_name, company_id);
    db.prepare(`INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact)
                VALUES (?, ?, ?)`).run(id, marketing_consent, do_not_contact);
    // Læg en bon med delivery_date N dage tilbage
    const date = new Date();
    date.setDate(date.getDate() - days_ago);
    const dateStr = date.toISOString().slice(0, 10);
    db.prepare(`INSERT INTO bons (customer_id, total_price, delivery_date) VALUES (?, ?, ?)`).run(id, revenue, dateStr);
}

// Helper: sæson-kunde — én ordre ~365 dage siden (i 10-14 mdr.-vinduet).
// recent:true lægger også en ordre 10 dage siden (skal ekskludere kunden).
function _seedSeasonalCustomer(db, opts) {
    const { id, first_name, company_id = null, recent = false, marketing_consent = 0, do_not_contact = 0 } = opts;
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, ?)').run(id, first_name, company_id);
    db.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact) VALUES (?, ?, ?)').run(id, marketing_consent, do_not_contact);
    const d = new Date(); d.setDate(d.getDate() - 365);
    db.prepare('INSERT INTO bons (customer_id, company_id, total_price, delivery_date) VALUES (?, ?, 5000, ?)').run(id, company_id, d.toISOString().slice(0, 10));
    if (recent) {
        const r = new Date(); r.setDate(r.getDate() - 10);
        db.prepare('INSERT INTO bons (customer_id, company_id, total_price, delivery_date) VALUES (?, ?, 5000, ?)').run(id, company_id, r.toISOString().slice(0, 10));
    }
}

// Helper: rytme-kunde — flere ordrer med kontrollerede datoer.
// Default [400,340,280,220,160] → snit 60 dage, days_since 160 ∈ (1.3×,3×) → med.
function _seedRytmeCustomer(db, opts, daysAgoList = [400, 340, 280, 220, 160]) {
    const { id, first_name, company_id = null, marketing_consent = 0, do_not_contact = 0 } = opts;
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?, ?, ?)').run(id, first_name, company_id);
    db.prepare('INSERT INTO crm_customer_meta (customer_id, marketing_consent, do_not_contact) VALUES (?, ?, ?)').run(id, marketing_consent, do_not_contact);
    for (const da of daysAgoList) {
        const d = new Date(); d.setDate(d.getDate() - da);
        db.prepare('INSERT INTO bons (customer_id, company_id, total_price, delivery_date) VALUES (?, ?, 5000, ?)').run(id, company_id, d.toISOString().slice(0, 10));
    }
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

// ─── from-suggestion ────────────────────────────────────────

test('from-suggestion: opretter kampagne + tilføjer sovende B2B-kunder', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Magasin A/S');
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('Bagerhuset');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Anne',   company_id: 1, days_ago: 200, revenue: 10000 });
    _seedDormantCustomer(_testDb, { id: 2, first_name: 'Bob',    company_id: 2, days_ago: 250, revenue: 8000 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'Reaktivering Q1',
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.campaign_id > 0);
    assert.strictEqual(r.body.added, 2);
    assert.strictEqual(r.body.candidates_count, 2);

    const camp = _testDb.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(r.body.campaign_id);
    assert.strictEqual(camp.name, 'Reaktivering Q1');
    assert.strictEqual(camp.is_active, 1);
    assert.ok(camp.description?.includes('180+'));

    const members = _testDb.prepare('SELECT * FROM campaign_members WHERE campaign_id = ?').all(r.body.campaign_id);
    assert.strictEqual(members.length, 2);
    // Begge skal være B2B (company_id sat, customer_id null pga. dedup-mønster)
    members.forEach(m => {
        assert.ok(m.company_id);
        assert.strictEqual(m.customer_id, null);
        assert.strictEqual(m.member_status, 'lead');
    });
});

test('from-suggestion: dedup pr. firma — to kontakter under samme firma giver ét medlem', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Magasin A/S');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Anne', company_id: 1, days_ago: 200, revenue: 8000 });
    _seedDormantCustomer(_testDb, { id: 2, first_name: 'Bob',  company_id: 1, days_ago: 250, revenue: 6000 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'Test',
    });
    assert.strictEqual(r.body.added, 1);
    assert.ok(r.body.skipped.find(s => s.reason === 'duplicate_company'));
});

test('from-suggestion: blokerer B2C uden marketing_consent', async () => {
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Privat1', days_ago: 200, revenue: 8000, marketing_consent: 0 });
    _seedDormantCustomer(_testDb, { id: 2, first_name: 'Privat2', days_ago: 200, revenue: 9000, marketing_consent: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'B2C-test',
    });
    assert.strictEqual(r.body.added, 1);  // kun Privat2 med consent
    const skip = r.body.skipped.find(s => s.customer_id === 1);
    assert.strictEqual(skip.reason, 'no_marketing_consent_b2c');
});

test('from-suggestion: blokerer DNC uanset B2B/B2C', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Anne', company_id: 1, days_ago: 200, revenue: 8000, do_not_contact: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'DNC-test',
    });
    // candidates_count=1 (filteret tillader DNC at være kandidat),
    // men skipped med do_not_contact-reason
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'do_not_contact');
});

test('from-suggestion: filtrerer på min_total_revenue', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('A');
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('B');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Stor',  company_id: 1, days_ago: 200, revenue: 50000 });
    _seedDormantCustomer(_testDb, { id: 2, first_name: 'Lille', company_id: 2, days_ago: 200, revenue: 1000 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'Min-rev-test',
    });
    assert.strictEqual(r.body.candidates_count, 1);
    assert.strictEqual(r.body.added, 1);
});

test('from-suggestion: filtrerer på days_since_last', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('A');
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('B');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'Sovende',     company_id: 1, days_ago: 200, revenue: 10000 });
    _seedDormantCustomer(_testDb, { id: 2, first_name: 'Lige bestilt', company_id: 2, days_ago: 30,  revenue: 10000 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 0 },
        campaign_name: 'Days-test',
    });
    assert.strictEqual(r.body.candidates_count, 1);
});

test('from-suggestion: navn-konflikt med aktiv kampagne → 409', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (name) VALUES (?)').run('Eksisterer');
    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180 },
        campaign_name: 'Eksisterer',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'name_in_use');
});

test('from-suggestion: navn-konflikt med lukket → 409 reopenable', async () => {
    _testDb.prepare('INSERT INTO outreach_campaigns (name, is_active, closed_at) VALUES (?, 0, ?)').run('Lukket', '2026-01-01');
    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180 },
        campaign_name: 'Lukket',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'name_closed');
    assert.strictEqual(r.body.reopenable, true);
});

test('from-suggestion: ingen kandidater → 400 no_candidates', async () => {
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'For ny', days_ago: 30, revenue: 10000, marketing_consent: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 0 },
        campaign_name: 'Tom',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'no_candidates');
});

test('from-suggestion: ugyldig type → 400', async () => {
    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'unknown',
        campaign_name: 'X',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'unsupported_type');
});

// ─── seasonal (#230 Fase 2) ─────────────────────────────────

test('from-suggestion seasonal: opretter kampagne fra sæson-kunder', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedSeasonalCustomer(_testDb, { id: 1, first_name: 'Anne', company_id: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'seasonal', campaign_name: 'Sæson 2026',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.added, 1);
    const camp = _testDb.prepare('SELECT description FROM outreach_campaigns WHERE id = ?').get(r.body.campaign_id);
    assert.ok(camp.description.includes('Sæson'), 'default-beskrivelse nævner Sæson');
});

test('from-suggestion seasonal: ekskluderer kunde med ordre inden for 60 dage', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedSeasonalCustomer(_testDb, { id: 1, first_name: 'Anne', company_id: 1, recent: true });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'seasonal', campaign_name: 'Sæson tom',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'no_candidates');
});

test('from-suggestion seasonal: respekterer DNC', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedSeasonalCustomer(_testDb, { id: 1, first_name: 'Anne', company_id: 1, do_not_contact: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'seasonal', campaign_name: 'Sæson DNC',
    });
    assert.strictEqual(r.body.added, 0);
    assert.strictEqual(r.body.skipped[0].reason, 'do_not_contact');
});

// ─── rytme (#230 Fase 3) ────────────────────────────────────

test('from-suggestion rytme: opretter kampagne fra rytme-kunder', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedRytmeCustomer(_testDb, { id: 1, first_name: 'Bo', company_id: 1 });

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'rytme', campaign_name: 'Rytme jan',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.added, 1);
    const camp = _testDb.prepare('SELECT description FROM outreach_campaigns WHERE id = ?').get(r.body.campaign_id);
    assert.ok(/rytme/i.test(camp.description), 'default-beskrivelse nævner rytme');
});

test('from-suggestion rytme: kunde med kun 4 ordrer → no_candidates', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedRytmeCustomer(_testDb, { id: 1, first_name: 'Bo', company_id: 1 }, [400, 300, 200, 100]);

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'rytme', campaign_name: 'Rytme tom',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'no_candidates');
});

test('from-suggestion rytme: reelt sovende (days_since > 3× snit) → no_candidates', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma A');
    _seedRytmeCustomer(_testDb, { id: 1, first_name: 'Bo', company_id: 1 }, [800, 740, 680, 620, 560]);

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'rytme', campaign_name: 'Rytme dormant',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'no_candidates');
});

test('from-suggestion: tomt navn → 400', async () => {
    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180 },
        campaign_name: '   ',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'campaign_name_required');
});

test('from-suggestion: SSE campaign_created + members_added broadcastes', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'A', company_id: 1, days_ago: 200, revenue: 8000 });

    await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 0 },
        campaign_name: 'SSE-test',
    });
    assert.ok(_sse.find(e => e.event === 'campaign_created'));
    assert.ok(_sse.find(e => e.event === 'campaign_members_added'));
});

test('from-suggestion: changelog logges for både kampagne og medlemmer', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    _seedDormantCustomer(_testDb, { id: 1, first_name: 'A', company_id: 1, days_ago: 200, revenue: 8000 });

    await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180 },
        campaign_name: 'Log-test',
    });
    const logs = _testDb.prepare(`SELECT entity_type FROM changelog WHERE action = 'create' ORDER BY id`).all();
    const types = logs.map(l => l.entity_type);
    assert.ok(types.includes('outreach_campaign'));
    assert.ok(types.includes('campaign_member'));
});

test('from-suggestion: ekskluderer tilbud (is_offer=1) fra revenue-summen', async () => {
    _testDb.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Firma');
    // Manuel seeding for at have kontrol over is_offer
    _testDb.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (1, ?, 1)').run('A');
    _testDb.prepare(`INSERT INTO crm_customer_meta (customer_id) VALUES (1)`).run();
    const oldDate = new Date(); oldDate.setDate(oldDate.getDate() - 200);
    const ds = oldDate.toISOString().slice(0, 10);
    _testDb.prepare(`INSERT INTO bons (customer_id, total_price, delivery_date, is_offer) VALUES (1, 1000, ?, 0)`).run(ds);
    _testDb.prepare(`INSERT INTO bons (customer_id, total_price, delivery_date, is_offer) VALUES (1, 9999, ?, 1)`).run(ds);

    const r = await req('POST', '/api/campaigns/from-suggestion', {
        type: 'dormant',
        filter: { days_since_last: 180, min_total_revenue: 5000 },
        campaign_name: 'Offer-test',
    });
    // Total ex tilbud = 1000 < min 5000 → kunden filtreres ud
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'no_candidates');
});
