// tests/ean_lookup.test.js
// ============================================================
// EAN-opslag til "+ Nyt firma" (#612, opfølgning): GET /api/cvr/ean/:ean.
//
// EAN er den stærkeste nøgle for institutionerne — netop dem der laver
// dubletter — og det tal kunden faktisk skriver på ordren. NemHandelsregistret
// svarer med den REGISTREREDE ENHED + CVR; cvrapi giver den juridiske enhed.
//
// Begge eksterne kald stubbes (global.fetch) med svar i den form registrene
// faktisk giver — HTML-fragmentet er klippet fra et ægte live-svar 15/9 2026.
// Routen, parseren og POST/søgning rammes ægte.
//
// Kør: npm run test:ean-opslag
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

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');
function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    return db;
}

// ── Stub af de to registre ───────────────────────────────────
const NH_HTML = (unit, cvr) => `<!DOCTYPE html><html lang="da"><body>
<h1>Opslagsside til Nemhandelsregistret</h1>
<h3>Understøttede profiler for GLN 5790000301959</h3>
<h5>${unit}</h5>
<p>CVR: <a href="cvrSearch?unitcvr=${cvr}">${cvr}</a></p>
<p>Registrering foretaget af NemHandel</p></body></html>`;
const NH_UNKNOWN = `<!DOCTYPE html><html><body><h1>Opslagsside til Nemhandelsregistret</h1><p>Ingen deltager fundet.</p></body></html>`;

const realFetch = global.fetch;
let _cvrapiDown = false;
function stubFetch() {
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return realFetch(url, opts);
        if (u.includes('registration.nemhandel.dk')) {
            const key = new URL(u).searchParams.get('key');
            if (key === '5790000301959') return new Response(NH_HTML('50570000 - KU-NS-SCIENCE-FAK (959)', '29979812'), { status: 200 });
            if (key === '5790002502255') return new Response(NH_HTML('Gate 21', '32112846'), { status: 200 });
            return new Response(NH_UNKNOWN, { status: 200 });
        }
        if (u.includes('cvrapi.dk')) {
            if (_cvrapiDown) return new Response('', { status: 503 });
            const vat = new URL(u).searchParams.get('vat');
            const map = { '29979812': 'Københavns Universitet', '32112846': 'Gate 21' };
            if (!map[vat]) return new Response('{}', { status: 404 });
            return new Response(JSON.stringify({ vat: Number(vat), name: map[vat], address: 'Nørregade 10', zipcode: '1165', city: 'København K' }), { status: 200 });
        }
        throw new Error('uventet ekstern URL i test: ' + u);
    };
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/api/cvr', require('../routes/cvr'));
app.use('/api/companies', require('../routes/companies'));
app.use('/api/crm', require('../routes/crm'));

let server, baseUrl;
test.before(() => new Promise(r => { stubFetch(); server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => new Promise(r => { global.fetch = realFetch; server.close(r); }));
test.beforeEach(() => { _testDb = createFreshDb(); _cvrapiDown = false; });

async function get(u) { const r = await realFetch(baseUrl + u); return { status: r.status, body: await r.json().catch(() => null) }; }
async function post(u, b) { const r = await realFetch(baseUrl + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }

// ── Parseren mod et ægte HTML-fragment ───────────────────────
test('nemhandelLookup: enhed + CVR ud af registrets HTML', async () => {
    const { nemhandelLookup } = require('../services/cvrEnrichment');
    const r = await nemhandelLookup('5790000301959');
    assert.deepEqual(r, { enhedsnavn: '50570000 - KU-NS-SCIENCE-FAK (959)', cvr: '29979812' });
});

// ── Routen ───────────────────────────────────────────────────
test('GET /api/cvr/ean/:ean: enheden fra NemHandel + den juridiske enhed fra cvrapi', async () => {
    const r = await get('/api/cvr/ean/5790000301959');
    assert.equal(r.status, 200);
    assert.equal(r.body.unit_name, '50570000 - KU-NS-SCIENCE-FAK (959)');
    assert.equal(r.body.cvr, '29979812');
    assert.equal(r.body.legal.name, 'Københavns Universitet');
    assert.equal(r.body.ean, '5790000301959');
});

test('GET /api/cvr/ean/:ean: cvrapi nede → enheden og CVR kommer stadig, legal er null', async () => {
    _cvrapiDown = true;
    const r = await get('/api/cvr/ean/5790002502255');
    assert.equal(r.status, 200);
    assert.equal(r.body.unit_name, 'Gate 21');
    assert.equal(r.body.cvr, '32112846');
    assert.equal(r.body.legal, null);
});

test('GET /api/cvr/ean/:ean: ukendt EAN → 404, forkert længde → 400', async () => {
    assert.equal((await get('/api/cvr/ean/5790000000000')).status, 404);
    assert.equal((await get('/api/cvr/ean/579000030195')).status, 400);
});

test('GET /api/cvr/ean/:ean tåler mellemrum i nummeret', async () => {
    const r = await get('/api/cvr/ean/' + encodeURIComponent('5790 0003 01959'));
    assert.equal(r.status, 200);
});

// ── legal_name på POST + EAN i listens søgning ───────────────
test('POST /api/companies gemmer legal_name (den juridiske enhed bag EAN\'et)', async () => {
    const r = await post('/api/companies', { name: '50570000 - KU-NS-SCIENCE-FAK (959)', cvr: '29979812', ean: '5790000301959', legal_name: 'Københavns Universitet' });
    assert.equal(r.status, 200);
    const co = _testDb.prepare('SELECT legal_name, ean FROM companies WHERE id=?').get(r.body.id);
    assert.equal(co.legal_name, 'Københavns Universitet');
    assert.equal(co.ean, '5790000301959');
});

test('Firmaer-listen kan søges på EAN', async () => {
    await post('/api/companies', { name: 'KU Science', ean: '5790000301959' });
    await post('/api/companies', { name: 'Gate 21', ean: '5790002502255' });
    const r = await get('/api/crm/companies?q=5790000301959');
    assert.equal(r.status, 200);
    const rows = Array.isArray(r.body) ? r.body : (r.body.companies || r.body.rows || []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'KU Science');
});
