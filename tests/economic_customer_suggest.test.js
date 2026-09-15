// tests/economic_customer_suggest.test.js
// ============================================================
// "Find i e-conomic" på Firma 360° (#502): GET /api/companies/:id/economic-suggest
// + den delte søgning i services/economicCustomerLookup.js.
//
// e-conomic stubbes på adapterens `rest` (svar i REST-API'ets egen form:
// {collection:[{customerNumber, name, corporateIdentificationNumber, ean}]}).
// Routen, DB-opslaget ("bruges allerede af") og rangeringen rammes ægte.
//
// Kør: npm run test:economic-forslag
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;
require('../shared/sse').broadcast = () => {};

const eco = require('../services/economicAdapter');
const lookup = require('../services/economicCustomerLookup');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id) VALUES (1, 'Den Hirschsprungske Samling', '64174614', NULL, NULL)").run();
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id) VALUES (2, 'RUST/Københavns Kommune', '64942212', '5798009696922', NULL)").run();
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id) VALUES (3, 'Klatretræet på Vesterbro', '64942212', NULL, '459')").run();
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id, legal_name) VALUES (4, 'KU FOOD', NULL, NULL, NULL, 'Institut for Fødevarevidenskab')").run();
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id) VALUES (5, 'Helt Ukendt ApS', '11111111', NULL, NULL)").run();
    db.prepare("INSERT INTO companies (id, name, cvr, ean, economic_customer_id) VALUES (6, 'Københavns Universitet, Institut for Psykologi', '29979812', NULL, NULL)").run();
    return db;
}

// ── e-conomic-stub ──────────────────────────────────────────
const ECO = [
    { customerNumber: 674, name: 'Den Hirschsprungske Samling', corporateIdentificationNumber: '', ean: '' },
    { customerNumber: 459, name: 'RUST KK', corporateIdentificationNumber: '', ean: '5798009696922' },
    { customerNumber: 898, name: 'RUST/Københavns Kommune', corporateIdentificationNumber: '', ean: '5798009696922' },
    { customerNumber: 51,  name: 'BUF Område Nørrebro/Bispebjerg', corporateIdentificationNumber: '64942212', ean: '5798009375674' },
    { customerNumber: 109, name: 'Københavns Universitet Plen', corporateIdentificationNumber: '29979812', ean: '' },
    { customerNumber: 551, name: 'Københavns Universitet - PLEN-Frb.', corporateIdentificationNumber: '29979812', ean: '' },
    { customerNumber: 800, name: 'Institut for Psykologi', corporateIdentificationNumber: '', ean: '' },
    { customerNumber: 436, name: 'Institut for Fødevarevidenskab', corporateIdentificationNumber: '', ean: '' },
    { customerNumber: 9,   name: 'FoodNexus Nordic', corporateIdentificationNumber: '', ean: '' },
    { customerNumber: 40,  name: 'Samlingen af Alting', corporateIdentificationNumber: '', ean: '' },
];
const calls = [];
let _configured = true;
eco.isConfigured = () => _configured;
eco.rest = async (p) => {
    calls.push(p);
    const u = new URL('http://x' + p);
    const f = decodeURIComponent(u.searchParams.get('filter') || '');
    let m;
    if ((m = f.match(/^corporateIdentificationNumber\$eq:(\d+)$/))) return { collection: ECO.filter(c => c.corporateIdentificationNumber === m[1]) };
    if ((m = f.match(/^ean\$eq:(\d+)$/))) return { collection: ECO.filter(c => c.ean === m[1]) };
    if ((m = f.match(/^name\$like:(.+)$/))) { const w = m[1].toLowerCase(); return { collection: ECO.filter(c => c.name.toLowerCase().includes(w)) }; }
    throw new Error('uventet filter: ' + f);
};

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/api/companies', require('../routes/companies'));
let server, baseUrl;
test.before(() => new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; r(); }); }));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); calls.length = 0; _configured = true; });

async function get(url) { const res = await fetch(baseUrl + url); return { status: res.status, body: await res.json().catch(() => null) }; }

// ── 1. Søgningen ────────────────────────────────────────────

test('søgeord: længste betydende ord først, og fyldord springes over', () => {
    assert.deepEqual(lookup.searchWords('Institut for Fødevarevidenskab'), ['Fødevarevidenskab', 'Institut']);
    assert.deepEqual(lookup.searchWords('Den Hirschsprungske Samling'), ['Hirschsprungske']);
    assert.deepEqual(lookup.searchWords('Empano ApS'), ['Empano']);
    assert.deepEqual(lookup.searchWords(''), []);
});

test('EAN og CVR spørges først; rammer de, spørges der ikke på navn — EAN står over CVR', async () => {
    const r = await lookup.searchEconomicCustomers({ cvr: '64942212', ean: '5798009696922', name: 'RUST/Københavns Kommune' });
    assert.deepEqual(r.map(c => c.number), ['898', '459', '51'], 'EAN-kortene først, det bedste navn øverst, så CVR-kortet');
    assert.equal(r[0].match, 'ean');
    assert.equal(r[2].match, 'cvr');
    assert.ok(!calls.some(p => p.includes('name%24like')), 'ingen navnesøgning når CVR/EAN gav noget');
});

test('navnesøgning: kandidater rangeres efter lighed, det rigtige øverst', async () => {
    const r = await lookup.searchEconomicCustomers({ cvr: '64174614', name: 'Den Hirschsprungske Samling' });
    assert.equal(r[0].number, '674');
    assert.equal(r[0].match, 'name');
    assert.equal(r[0].score, 1);
    assert.ok(!r.some(c => c.number === '40') || r.at(-1).number === '40', '"Samlingen af Alting" er enten væk eller sidst');
});

test('paraply-CVR: flere kort på samme CVR er forslag, ikke facts — og navnet søges alligevel', async () => {
    const r = await lookup.searchEconomicCustomers({ cvr: '29979812', name: 'Københavns Universitet, Institut for Psykologi' });
    assert.equal(r[0].number, '800', 'Institut for Psykologi (navn 1.00) vinder over KU-Plen (samme CVR)');
    assert.equal(r[0].match, 'name');
    assert.ok(r.filter(c => c.match === 'cvr_shared').length === 2, 'de to Plen-kort er markeret som paraply');
    assert.ok(!r.some(c => c.match === 'cvr'), 'ingen af dem er et fact');
});

// ── 2. Routen ───────────────────────────────────────────────

test('route: navnematch + "bruges allerede af" er tomt når ingen anden peger på nummeret', async () => {
    const r = await get('/api/companies/1/economic-suggest');
    assert.equal(r.status, 200);
    assert.equal(r.body.company.name, 'Den Hirschsprungske Samling');
    assert.equal(r.body.candidates[0].number, '674');
    assert.deepEqual(r.body.candidates[0].in_use_by, []);
});

test('route: et kort som et ANDET Bon-firma allerede peger på siges højt', async () => {
    const r = await get('/api/companies/2/economic-suggest');
    const c459 = r.body.candidates.find(c => c.number === '459');
    assert.ok(c459, 'EAN-match 459 er med');
    assert.deepEqual(c459.in_use_by.map(u => u.id), [3], 'Klatretræet peger allerede på 459');
    const c898 = r.body.candidates.find(c => c.number === '898');
    assert.deepEqual(c898.in_use_by, []);
});

test('route: juridisk navn prøves når kaldenavnet ikke gav noget', async () => {
    const r = await get('/api/companies/4/economic-suggest');
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates[0].number, '436', 'KU FOOD → Institut for Fødevarevidenskab via legal_name');
});

test('route: intet match giver en tom liste, ikke en fejl', async () => {
    const r = await get('/api/companies/5/economic-suggest');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.candidates, []);
});

test('route: ukendt firma → 404, e-conomic ikke konfigureret → 503 uden opslag', async () => {
    assert.equal((await get('/api/companies/999/economic-suggest')).status, 404);
    _configured = false;
    const r = await get('/api/companies/1/economic-suggest');
    assert.equal(r.status, 503);
    assert.equal(calls.length, 0);
});
