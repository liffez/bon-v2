// tests/bon_attribution.test.js
// ============================================================
// Hvem gjorde det? Changelog er det eneste spor der peger på et menneske.
//
// routes/bons.js læste brugeren fra REQUEST-BODY flere steder — `created_by_user_id`
// ved oprettelse, `user_id` på varelinjer, køkkeninfo, menu-grupper og pakkeliste.
// To følger af det:
//
//   1. Ingen klient sendte nogensinde felterne, så oprettelse og varelinjer stod
//      uden bruger. Da en bon skulle spores i september 2026, var de fire første
//      linjer i historikken tomme, mens resten pegede på en bruger — det lignede
//      to forskellige mennesker og var én.
//   2. Afsenderen kunne skrive en ANDEN ind i historikken. Samme hul som Patch D
//      lukkede for status-skift (D-3); de øvrige endpoints blev ikke rørt dengang.
//
// Kør: npm run test:attribution
// ============================================================

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

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

const ANNE = 5;   // den der sidder ved skærmen
const ADMIN = 1;  // den afsenderen forsøger at skrive ind i stedet

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("INSERT INTO users (id, name, email, role, is_active) VALUES (?,?,?,'office',1)")
      .run(ANNE, 'Anne', 'anne@test.dk');
    db.prepare('INSERT INTO companies (id, name) VALUES (1, ?)').run('Testfirma');
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (1, ?, 1)').run('Caroline');
    return db;
}

// Sessionen er Anne. Body vil i nogle tests forsøge at påstå noget andet.
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.session = { userId: ANNE, user: { id: ANNE, role: 'office' } };
    next();
});
app.use('/api/bons', require('../routes/bons'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function req(method, url, body) {
    const res = await fetch(baseUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const { todayISO } = require('../db/helpers');
const newBon = (extra = {}) => req('POST', '/api/bons', {
    customer_id: 1, company_id: 1, delivery_date: todayISO(), delivery_time: '12:00', ...extra,
});
const log = (bonId, field) => _testDb.prepare(
    `SELECT * FROM changelog WHERE entity_type='bon' AND entity_id=? ${field ? 'AND field_name=?' : ''} ORDER BY id DESC LIMIT 1`
).get(...(field ? [bonId, field] : [bonId]));

// ─────────────────────────────────────────────────────────────

test('oprettelse peger på den der er logget ind', async () => {
    const r = await newBon();
    assert.ok(r.status === 200 || r.status === 201, `status=${r.status}`);
    const cl = log(r.body.id);
    assert.equal(cl.action, 'create');
    assert.equal(cl.user_id, ANNE, 'create-entryet stod tomt før');
});

test('bons.created_by_user_id sættes også fra sessionen', async () => {
    // Kolonnen stod altid tom, fordi ingen klient sendte feltet — og den kunne
    // samtidig fyldes med hvem som helst af afsenderen.
    const r = await newBon({ created_by_user_id: ADMIN });
    const row = _testDb.prepare('SELECT created_by_user_id FROM bons WHERE id=?').get(r.body.id);
    assert.equal(row.created_by_user_id, ANNE);
});

test('oprettelse bærer kilden, ikke bon-nummeret', async () => {
    const r = await newBon();
    const cl = log(r.body.id);
    assert.equal(cl.new_value, 'Oprettet manuelt');
    assert.equal(cl.field_name, 'manual');
    assert.notEqual(cl.new_value, r.body.bon_number, 'bon-nummeret står i entity_id i forvejen');
});

test('body kan ikke skrive en anden bruger ind ved oprettelse', async () => {
    const r = await newBon({ created_by_user_id: ADMIN });
    assert.equal(log(r.body.id).user_id, ANNE, 'sessionen vinder over body');
});

test('tilføjet varelinje peger på den der er logget ind', async () => {
    const bon = (await newBon()).body;
    const r = await req('POST', `/api/bons/${bon.id}/lines`, {
        product_name: 'Kartoflen', quantity: 10, unit_price: 100, category: '01 Sandwich',
    });
    assert.equal(r.status, 201, `status=${r.status}`);
    const cl = log(bon.id, 'bon_lines');
    assert.match(cl.new_value, /Kartoflen/);
    assert.equal(cl.user_id, ANNE, 'varelinjer stod uden bruger før');
});

test('body kan ikke skrive en anden bruger ind på en varelinje', async () => {
    const bon = (await newBon()).body;
    await req('POST', `/api/bons/${bon.id}/lines`, {
        product_name: 'Æggesalaten', quantity: 10, unit_price: 100, user_id: ADMIN,
    });
    assert.equal(log(bon.id, 'bon_lines').user_id, ANNE);
});

test('slettet varelinje får også en bruger', async () => {
    const bon = (await newBon()).body;
    const line = (await req('POST', `/api/bons/${bon.id}/lines`, {
        product_name: 'Italieneren', quantity: 10, unit_price: 100,
    })).body;
    const r = await req('DELETE', `/api/bons/${bon.id}/lines/${line.id}`);
    assert.equal(r.status, 200, `status=${r.status}`);
    const cl = log(bon.id, 'bon_lines');
    assert.equal(cl.notes, 'linje slettet');
    assert.equal(cl.user_id, ANNE, 'sletning loggede slet ingen bruger før');
});

test('køkkeninfo: body kan ikke skrive en anden bruger ind', async () => {
    const bon = (await newBon()).body;
    const r = await req('PATCH', `/api/bons/${bon.id}/kitchen-info`, {
        text: 'Husk allergi', user_id: ADMIN,
    });
    assert.equal(r.status, 200, `status=${r.status}`);
    assert.equal(log(bon.id, 'kitchen_info').user_id, ANNE);
});

test('menu-grupper: body kan ikke skrive en anden bruger ind', async () => {
    const bon = (await newBon()).body;
    const line = (await req('POST', `/api/bons/${bon.id}/lines`, {
        product_name: 'Kartoflen', quantity: 2, unit_price: 100,
    })).body;
    const r = await req('PUT', `/api/bons/${bon.id}/menu-groups`, {
        groups: [{ title: 'Bord 1', line_ids: [line.id] }], user_id: ADMIN,
    });
    assert.equal(r.status, 200, `status=${r.status}`);
    assert.equal(log(bon.id, 'menu_groups').user_id, ANNE);
});
