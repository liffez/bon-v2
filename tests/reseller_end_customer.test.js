// tests/reseller_end_customer.test.js
// ============================================================
// Forhandler-ordrer: hvem betaler, og hvem er maden til?
//
// Able er et frokostbestillings-firma. De lægger ordren ind på vores egen
// bestillingsformular for deres kunder, og skriver slutkundens navn i
// formularens Firma-felt. Webhooken matchede firma på eksakt navn og oprettede
// en ny firma-række når navnet ikke fandtes — så bonnen forlod Ables kartotek,
// og hverken e-conomic-nummeret, omsætningen eller den stående rabat fulgte med.
//
// Kernepåstandene der holdes fast her:
//   1. En forhandler-ordre lander på FORHANDLEREN, ikke på det tastede navn.
//   2. Det tastede navn overlever som bonens slutkunde.
//   3. Den stående rabat (migration 111) rammer først når 1 er sand — den
//      læser jo satsen fra det firma bonnen ligger på.
//   4. Alle andre firmaer opfører sig NØJAGTIGT som før.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en
// kolonne der flytter sig får testen til at fejle i stedet for at bestå mod en
// håndskrevet kopi.
//
// Kør: node --experimental-sqlite --test tests/reseller_end_customer.test.js
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

// Mailen er fire-and-forget i webhooken. Stubbes så testen hverken venter på
// eller forsøger SMTP — vi tester routingen, ikke posten.
const mailService = require('../services/mailService');
const _mails = [];
mailService.sendFromTemplate = async (args) => { _mails.push(args); return { ok: true }; };

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

const ABLE = 'Able';
const ABLE_EMAIL = 'care@able.dk';

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    // Webhook-secret tom ⇒ ingen header-krav (som i drift, hvor den er valgfri)
    db.prepare("UPDATE settings SET value='' WHERE key='webhook_secret'").run();

    // Forhandleren + dens kontaktperson
    db.prepare('INSERT INTO companies (id, name, is_reseller, discount_percent, economic_customer_id) VALUES (?,?,?,?,?)')
      .run(1, ABLE, 1, 12.5, '733');
    db.prepare('INSERT INTO customers (id, first_name, last_name, email, company_id) VALUES (?,?,?,?,?)')
      .run(1, 'Maikenn', 'Pedersen', ABLE_EMAIL, 1);

    // Et helt almindeligt firma med en kendt kontakt — kontrolgruppen
    db.prepare('INSERT INTO companies (id, name) VALUES (?,?)').run(2, 'Stromma Danmark A/S');
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,?)')
      .run(2, 'Info', 'info@stromma.dk', 2);

    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/webhook', require('../routes/web-orders'));
app.use('/api/companies', require('../routes/companies'));
app.use('/api/bons', require('../routes/bons'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); _mails.length = 0; });

async function post(url, body, method = 'POST') {
    const res = await fetch(baseUrl + url, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** Én web-bestilling. Feltnavnene er formularens egne. */
function order(extra = {}) {
    return {
        first_name: 'Caroline', last_name: 'Holme',
        email: ABLE_EMAIL, phone: '39209700',
        delivery_date: '2026-09-03', delivery_time: '10:00',
        ordertype: 'catering', pax: '11',
        ...extra,
    };
}

const lastBon = () => _testDb.prepare('SELECT * FROM bons ORDER BY id DESC LIMIT 1').get();
const companyCount = () => _testDb.prepare('SELECT COUNT(*) AS n FROM companies').get().n;

// ─────────────────────────────────────────────────────────────
// A. Forhandler-routing
// ─────────────────────────────────────────────────────────────

test('forhandler-ordre lander på forhandleren, ikke på det tastede firmanavn', async () => {
    const before = companyCount();
    const r = await post('/webhook/bestilling', order({ company: 'Systematic  (Able)' }));
    assert.equal(r.status, 200);

    const bon = lastBon();
    assert.equal(bon.company_id, 1, 'bonnen ligger på Able');
    // Dobbelt mellemrum samles til ét — det var netop den slags varianter der
    // gav en firma-række pr. skrivemåde (#607).
    assert.equal(bon.end_customer_name, 'Systematic (Able)', 'det tastede navn overlever som slutkunde');
    assert.equal(companyCount(), before, 'ingen ny firma-række oprettet');
    assert.equal(bon.customer_id, 1, 'kunden er stadig Ables kontakt');
});

test('to skrivemåder af samme slutkunde giver stadig kun ét firma', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ company: 'Systematic  (Able)' }));
    await post('/webhook/bestilling', order({ company: 'Systematic / able' }));
    assert.equal(companyCount(), before, 'hver skrivemåde plejede at blive sit eget firma');
    const bons = _testDb.prepare('SELECT company_id FROM bons').all();
    assert.ok(bons.every(b => b.company_id === 1), 'begge bons ligger på Able');
});

test('changelog forklarer hvorfor bonnen ikke ligger på det tastede navn', async () => {
    await post('/webhook/bestilling', order({ company: 'Systematic' }));
    const bon = lastBon();
    const cl = _testDb.prepare(
        "SELECT new_value FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='create'"
    ).get(bon.id);
    assert.match(cl.new_value, /forhandleren Able/);
    assert.match(cl.new_value, /slutkunde: Systematic/);
});

// ─────────────────────────────────────────────────────────────
// B. Rabatten virker først når routingen gør
// ─────────────────────────────────────────────────────────────

test('den stående rabat rammer forhandler-ordren', async () => {
    await post('/webhook/bestilling', order({ company: 'Systematic' }));
    assert.equal(lastBon().offer_discount_percent, 12.5);
});

test('uden forhandler-markering er det tastede navn en note, ikke en slutkunde', async () => {
    // Kontrolprøve: samme firma, samme rabat, men markeringen slået fra.
    // Siden #567 beholder en kendt bestiller sit eget firma uanset hvad hun
    // taster — så bonnen bliver på Able og arver rabatten også uden flaget.
    // Det flaget stadig afgør alene: om navnet er en SLUTKUNDE (bonnens felt)
    // eller bare noget kunden skrev (en linje i ønskerne).
    _testDb.prepare('UPDATE companies SET is_reseller = 0 WHERE id = 1').run();
    await post('/webhook/bestilling', order({ company: 'Systematic' }));

    const bon = lastBon();
    assert.equal(bon.company_id, 1, 'kendt bestiller → eget firma (#567)');
    assert.equal(bon.offer_discount_percent, 12.5, 'og rabatten følger med');
    assert.equal(bon.end_customer_name, null, 'men uden flaget er navnet ikke en slutkunde');
    assert.match(bon.customer_wishes, /Firma: Systematic/, 'det står i ønskerne i stedet');
});

// ─────────────────────────────────────────────────────────────
// C. Ingen ændring for alle andre
// ─────────────────────────────────────────────────────────────

test('almindelig kunde: kendt firmanavn genbruges, som før', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'info@stromma.dk', company: 'Stromma Danmark A/S' }));

    const bon = lastBon();
    assert.equal(bon.company_id, 2);
    assert.equal(bon.end_customer_name, null, 'ingen slutkunde på en almindelig ordre');
    assert.equal(companyCount(), before);
});

test('almindelig kunde: ukendt firmanavn opretter stadig et firma', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'ny@kunde.dk', company: 'Helt Nyt Firma ApS' }));

    assert.equal(companyCount(), before + 1);
    const bon = lastBon();
    const co = _testDb.prepare('SELECT name FROM companies WHERE id = ?').get(bon.company_id);
    assert.equal(co.name, 'Helt Nyt Firma ApS');
    assert.equal(bon.end_customer_name, null);
});

test('ukendt afsender hos forhandleren falder tilbage til gammel adfærd', async () => {
    // Ny medarbejder hos Able som vi ikke kender endnu. Vi gætter ikke på at
    // hun er forhandler ud fra et navn nogen har tastet.
    await post('/webhook/bestilling', order({ email: 'nyansat@able.dk', company: 'Systematic' }));

    const bon = lastBon();
    assert.notEqual(bon.company_id, 1);
    assert.equal(bon.end_customer_name, null);
});

// ─────────────────────────────────────────────────────────────
// D. Kanttilfælde
// ─────────────────────────────────────────────────────────────

test('forhandleren bestiller til sig selv — ingen slutkunde', async () => {
    await post('/webhook/bestilling', order({ company: '  able  ' }));
    const bon = lastBon();
    assert.equal(bon.company_id, 1);
    assert.equal(bon.end_customer_name, null, 'eget navn er ikke en slutkunde');
});

test('tomt firma-felt hos forhandleren: bonen lander stadig rigtigt', async () => {
    await post('/webhook/bestilling', order({ company: '' }));
    const bon = lastBon();
    assert.equal(bon.company_id, 1);
    assert.equal(bon.end_customer_name, null);
});

test('EAN fra en forhandler-ordre skrives ikke på forhandlerens firma', async () => {
    // EAN'et hører til slutkunden. Skrev vi det på Able, ville næste faktura
    // til Able gå til en fremmed EAN-modtager.
    await post('/webhook/bestilling', order({ company: 'Systematic', ean_info: 'EAN 5798009811578' }));
    const able = _testDb.prepare('SELECT ean FROM companies WHERE id = 1').get();
    assert.equal(able.ean, null);
    assert.match(lastBon().invoice_info, /5798009811578/, 'men teksten står stadig på bonen');
});

test('EAN skrives stadig på et almindeligt firma', async () => {
    await post('/webhook/bestilling', order({
        email: 'info@stromma.dk', company: 'Stromma Danmark A/S', ean_info: 'EAN 5798009811578',
    }));
    const co = _testDb.prepare('SELECT ean FROM companies WHERE id = 2').get();
    assert.equal(co.ean, '5798009811578');
});

// ─────────────────────────────────────────────────────────────
// E. Slutkunden kan findes
// ─────────────────────────────────────────────────────────────

test('bon-listens søgning finder bonnen på slutkundens navn', async () => {
    await post('/webhook/bestilling', order({ company: 'Systematic' }));

    // Hverken kunde- eller firmanavn indeholder "Systematic" — uden feltet i
    // søgeudtrykket er bonnen ikke til at finde.
    const res = await fetch(baseUrl + '/api/bons?q=Systematic');
    const rows = await res.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].end_customer_name, 'Systematic');
    assert.equal(rows[0].company_name, ABLE);
});

test('søgning på firmanavn virker uændret', async () => {
    await post('/webhook/bestilling', order({ company: 'Systematic' }));
    const res = await fetch(baseUrl + '/api/bons?q=Able');
    assert.equal((await res.json()).length, 1);
});

// ─────────────────────────────────────────────────────────────
// F. Handelsvilkår (rabat + forhandler-markering)
// ─────────────────────────────────────────────────────────────

test('rabat kan sættes med både punktum og komma', async () => {
    const r = await post('/api/companies/2/commercial', { discount_percent: '7,5' }, 'PATCH');
    assert.equal(r.status, 200);
    assert.equal(_testDb.prepare('SELECT discount_percent FROM companies WHERE id=2').get().discount_percent, 7.5);
});

test('rabat uden for 0–100 afvises', async () => {
    for (const bad of ['-5', '100', '150', 'tolv']) {
        const r = await post('/api/companies/2/commercial', { discount_percent: bad }, 'PATCH');
        assert.equal(r.status, 400, `${bad} skal afvises`);
    }
    assert.equal(_testDb.prepare('SELECT discount_percent FROM companies WHERE id=2').get().discount_percent, null);
});

test('tom rabat rydder feltet', async () => {
    await post('/api/companies/2/commercial', { discount_percent: '10' }, 'PATCH');
    await post('/api/companies/2/commercial', { discount_percent: '' }, 'PATCH');
    assert.equal(_testDb.prepare('SELECT discount_percent FROM companies WHERE id=2').get().discount_percent, null);
});

test('forhandler-markeringen kan slås til og fra', async () => {
    await post('/api/companies/2/commercial', { is_reseller: 1 }, 'PATCH');
    assert.equal(_testDb.prepare('SELECT is_reseller FROM companies WHERE id=2').get().is_reseller, 1);
    await post('/api/companies/2/commercial', { is_reseller: 0 }, 'PATCH');
    assert.equal(_testDb.prepare('SELECT is_reseller FROM companies WHERE id=2').get().is_reseller, 0);
});

test('ændring af handelsvilkår skrives i changelog', async () => {
    await post('/api/companies/2/commercial', { discount_percent: '12,5', is_reseller: 1 }, 'PATCH');
    const rows = _testDb.prepare(
        "SELECT field_name, new_value FROM changelog WHERE entity_type='company' AND entity_id=2"
    ).all();
    const fields = rows.map(r => r.field_name).sort();
    assert.deepEqual(fields, ['discount_percent', 'is_reseller']);
});

test('ukendt firma og tomt kald afvises', async () => {
    assert.equal((await post('/api/companies/9999/commercial', { is_reseller: 1 }, 'PATCH')).status, 404);
    assert.equal((await post('/api/companies/2/commercial', {}, 'PATCH')).status, 400);
});

// ─────────────────────────────────────────────────────────────
// G. Ingen utilsigtet ændring i den fælles bon-oprettelse
// ─────────────────────────────────────────────────────────────

test('createBon uden slutkunde giver NULL — alle eksisterende kaldere er upåvirkede', () => {
    const { createBon } = require('../db/helpers');
    const { bonId } = createBon({ delivery_date: '2026-10-01', delivery_time: '09:00' });
    assert.equal(_testDb.prepare('SELECT end_customer_name FROM bons WHERE id=?').get(bonId).end_customer_name, null);
});

test('slutkunden kan rettes i hånden på bonnen', async () => {
    await post('/webhook/bestilling', order({ company: 'Systmatic' }));   // stavefejl
    const id = lastBon().id;
    const r = await post(`/api/bons/${id}`, { end_customer_name: 'Systematic' }, 'PATCH');
    assert.equal(r.status, 200);
    assert.equal(_testDb.prepare('SELECT end_customer_name FROM bons WHERE id=?').get(id).end_customer_name, 'Systematic');
});
