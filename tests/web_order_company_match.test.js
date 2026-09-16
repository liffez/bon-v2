// tests/web_order_company_match.test.js
// ============================================================
// Web-bestillingens firma: kendt bestiller beholder sit firma, resten går
// gennem matcheren — og et escapet navn gemmes aldrig (#567 + #607).
//
// Formularens Firma-felt er fri tekst. Begge indgange (routes/web-orders.js og
// routes/webhooks.js) slog firmaet op på EKSAKT navn og oprettede en ny række
// når strengen ikke ramte tegn for tegn. Målt i drift: 39 af 114 web-bons lå
// på et andet firma end bestillerens eget, og "Landbrug & Fødevarer" fandtes
// 13 gange — flere af dem som det bogstavelige `LANDBRUG &amp; FØDEVARER`.
//
// Kernereglerne der holdes fast her (beslutning, Leif, 13. sep 2026):
//   1. Kender vi bestilleren, og har hun et firma, beholdes det. Ingen ny
//      række — det tastede navn bliver en note (ønsker + changelog).
//   2. Ellers matcher (CVR → EAN → e-mail → navnelighed) FØR oprettelse.
//   3. HTML-entiteter afkodes FØR normalisering; escapede navne gemmes aldrig.
//   4. Forhandler-routingen (migration 167) vinder fortsat.
//   5. Samme regel i begge indgange.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, og
// endpoints rammes over HTTP — det er routens egen kode der efterprøves.
//
// Kør: npm run test:web-order-firma
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

const mailService = require('../services/mailService');
const _mails = [];
mailService.sendFromTemplate = async (args) => { _mails.push(args); return { ok: true }; };

const { decodeEntities, extractCvr, extractEan, appendWishesLine } = require('../services/orderCompanyResolver');

// Leveringsdatoen regnes ud fra i dag. En fast dato ville begynde at fejle
// den dag den passerer, nu hvor serveren haandhaever deadline (cut-off).
const { offsetISO } = require('../db/helpers');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

// Fixture — navne og CVR fra #607's drifts-tabel
const KU        = 1;   // Københavns Universitet — Annes firma
const LF        = 2;   // Landbrug & Fødevarer A.m.b.A, CVR 25529529, EAN
const LF_KUNST  = 3;   // Kunstforeningen Landbrug & Fødevarer, CVR 42281751 — ANDEN enhed
const ABLE      = 4;   // forhandler
const DEAD      = 5;   // lagt væk af "Ryd tomme firmaer"
const NO_CO     = 6;   // firmaet Bo står på — men inaktivt
const BAGER     = 7;   // "Bager & Søn" — æ/ø/& i navnet

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value='' WHERE key='webhook_secret'").run();

    const co = db.prepare('INSERT INTO companies (id, name, cvr, ean, is_reseller, is_active) VALUES (?,?,?,?,?,?)');
    co.run(KU,       'Københavns Universitet',                null,       null,            0, 1);
    co.run(LF,       'Landbrug & Fødevarer A.m.b.A',          '25529529', '5790000000019', 0, 1);
    co.run(LF_KUNST, 'Kunstforeningen Landbrug & Fødevarer',  '42281751', null,            0, 1);
    co.run(ABLE,     'Able',                                   null,       null,            1, 1);
    co.run(DEAD,     'Gate 21',                                null,       null,            0, 0);
    co.run(NO_CO,    'Nedlagt Kantine',                        null,       null,            0, 0);
    co.run(BAGER,    'Bager & Søn',                            null,       null,            0, 1);

    // Kunde med firma (Anne), kunde uden firma (Carl), kunde på inaktivt firma (Bo)
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,?)')
      .run(1, 'Anne', 'anne@ku.dk', KU);
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,?)')
      .run(2, 'Carl', 'carl@privat.dk', null);
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,?)')
      .run(3, 'Bo', 'bo@kantine.dk', NO_CO);
    db.prepare('INSERT INTO customers (id, first_name, email, company_id) VALUES (?,?,?,?)')
      .run(4, 'Maikenn', 'care@able.dk', ABLE);

    // Et firma-kontaktpunkt (e-mail-match i matcheren)
    db.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_public, is_primary)
                VALUES ('company', ?, 'email', 'post@lf.dk', 'manual', 0, 1)`).run(LF);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/webhook', require('../routes/web-orders'));
app.use('/api/webhooks', require('../routes/webhooks'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); _mails.length = 0; });

async function post(url, body) {
    const res = await fetch(baseUrl + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** Web-bestilling (den nye formular). */
function order(extra = {}) {
    return {
        first_name: 'Anne', last_name: 'Test', email: 'anne@ku.dk', phone: '39209700',
        delivery_date: offsetISO(30), delivery_time: '10:00', ordertype: 'catering', pax: '11',
        wishes: '3× Kyllingen', _form_meta: { menu_id: 'standard', menu_version: 1 },
        ...extra,
    };
}
/** Den gamle formular (f-felter) — samme regel skal gælde. */
function legacy(extra = {}) {
    return { f2: 'Anne Test', f3: 'anne@ku.dk', f7_date: offsetISO(30), f7_time: '10:00', f9: 'noget', ...extra };
}

const lastBon = () => _testDb.prepare('SELECT * FROM bons ORDER BY id DESC LIMIT 1').get();
const companyCount = () => _testDb.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
const changelogOf = (bonId) => _testDb.prepare(
    "SELECT new_value FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='create'"
).get(bonId).new_value;
const companyName = (id) => _testDb.prepare('SELECT name FROM companies WHERE id=?').get(id)?.name;

// ─────────────────────────────────────────────────────────────
// 1. Kendt bestiller beholder sit firma
// ─────────────────────────────────────────────────────────────

test('kendt bestiller med firma: bonnen bliver på hendes firma uanset hvad hun taster', async () => {
    const before = companyCount();
    const r = await post('/webhook/bestilling', order({ company: 'University of Copenhagen' }));
    assert.equal(r.status, 200);

    const bon = lastBon();
    assert.equal(bon.company_id, KU, 'bonnen ligger på Københavns Universitet');
    assert.equal(companyCount(), before, 'ingen ny firma-række');
    assert.equal(bon.end_customer_name, null, 'ikke en slutkunde — det er ikke en forhandler');
});

test('det tastede navn står i ønskerne og i changelog, så office kan se hvad kunden skrev', async () => {
    await post('/webhook/bestilling', order({ company: 'University of Copenhagen' }));
    const bon = lastBon();
    assert.match(bon.customer_wishes, /Firma: University of Copenhagen/);
    assert.match(bon.customer_wishes, /^3× Kyllingen/, 'kundens egne ønsker står stadig først');
    assert.match(bon.customer_wishes, /\[Form: standard v1\]$/, 'form-markøren bliver sidst');
    assert.match(changelogOf(bon.id), /kunden skrev firma "University of Copenhagen" — beholdt kundens firma Københavns Universitet/);
});

test('taster hun sit eget firmanavn (også i anden stavemåde), er der intet at notere', async () => {
    await post('/webhook/bestilling', order({ company: 'københavns  universitet' }));
    const bon = lastBon();
    assert.equal(bon.company_id, KU);
    assert.doesNotMatch(bon.customer_wishes, /Firma:/);
    assert.doesNotMatch(changelogOf(bon.id), /beholdt/);
});

test('tomt firma-felt hos kendt bestiller: firmaet beholdes, ingen note', async () => {
    await post('/webhook/bestilling', order({ company: '' }));
    const bon = lastBon();
    assert.equal(bon.company_id, KU);
    assert.doesNotMatch(bon.customer_wishes, /Firma:/);
});

test('ejer-mailen siger både bonnens firma og hvad kunden skrev', async () => {
    _testDb.prepare("UPDATE settings SET value='ejer@ristetrug.dk' WHERE key='web_order_notification_email'").run();
    await post('/webhook/bestilling', order({ company: 'University of Copenhagen' }));
    const owner = _mails.find(m => m.templateKey === 'web_order_owner_notification');
    assert.ok(owner, 'ejer-mail sendt');
    assert.match(owner.vars.firmaBlok, /Firma: Københavns Universitet/);
    assert.match(owner.vars.firmaBlok, /Kunden skrev: University of Copenhagen/);
});

test('kendt bestiller på et INAKTIVT firma: reglen giver slip, og matcheren tager over', async () => {
    // Bo's firma er lagt væk. En gammel kundekobling må ikke sende nye bons
    // ind på en række "Ryd tomme firmaer" har lukket.
    await post('/webhook/bestilling', order({ email: 'bo@kantine.dk', company: 'Landbrug og Fødevarer' }));
    const bon = lastBon();
    assert.notEqual(bon.company_id, NO_CO, 'ikke det inaktive firma');
    assert.equal(bon.company_id, LF, 'matcheren fandt det rigtige på navnelighed');
});

// ─────────────────────────────────────────────────────────────
// 2. Matcheren før oprettelse
// ─────────────────────────────────────────────────────────────

test('CVR i faktura-teksten skiller to næsten ens navne ad', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({
        email: 'ny@lf.dk', company: 'Landbrug & Fødevarer', ean_info: 'CVR: 42281751',
    }));
    const bon = lastBon();
    assert.equal(bon.company_id, LF_KUNST, 'CVR vinder over navnet');
    assert.equal(companyCount(), before);
    assert.match(changelogOf(bon.id), /matchet på CVR/);
});

test('et nøgent 8-cifret tal i faktura-teksten er IKKE et CVR', () => {
    // Danske telefonnumre er også 8 cifre — kun med "CVR" foran tæller det.
    assert.equal(extractCvr('Ring på 39209700 ved levering'), null);
    assert.equal(extractCvr('CVR 25529529'), '25529529');
    assert.equal(extractCvr('cvr-nr.: 25529529'), '25529529');
    assert.equal(extractCvr('CVR DK25529529'), '25529529');
    assert.equal(extractEan('EAN 5790000000019, att. Bogholderiet'), '5790000000019');
});

test('EAN i faktura-teksten finder firmaet', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({
        email: 'ny@lf.dk', company: 'L&F', ean_info: 'EAN 5790000000019',
    }));
    const bon = lastBon();
    assert.equal(bon.company_id, LF);
    assert.equal(companyCount(), before);
    assert.match(changelogOf(bon.id), /matchet på EAN/);
});

test('bestillerens e-mail som firma-kontaktpunkt finder firmaet — også når personen er ny', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'post@lf.dk', company: 'Fødevarer' }));
    assert.equal(lastBon().company_id, LF);
    assert.equal(companyCount(), before);
});

test('navnelighed: "Landbrug og Fødevarer" rammer "Landbrug & Fødevarer A.m.b.A"', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'ny@lf.dk', company: 'Landbrug og Fødevarer' }));
    const bon = lastBon();
    assert.equal(bon.company_id, LF);
    assert.equal(companyCount(), before, 'plejede at blive række nr. 14');
    assert.match(bon.customer_wishes, /Firma: Landbrug og Fødevarer/, 'det tastede navn kan ses');
    assert.match(changelogOf(bon.id), /matchet på navnelighed \d+ %/);
});

test('intet match: nyt firma oprettes, og changelog siger det', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'ny@firma.dk', company: 'Helt Nyt Firma ApS' }));
    const bon = lastBon();
    assert.equal(companyCount(), before + 1);
    assert.equal(companyName(bon.company_id), 'Helt Nyt Firma ApS');
    assert.match(changelogOf(bon.id), /nyt firma oprettet: Helt Nyt Firma ApS/);
    assert.doesNotMatch(bon.customer_wishes, /Firma:/, 'navnet ER bonnens firma — ingen note');
    const cust = _testDb.prepare('SELECT company_id FROM customers WHERE email=?').get('ny@firma.dk');
    assert.equal(cust.company_id, bon.company_id, 'den nye kunde hænger på det nye firma');
});

test('et inaktivt firma matches ikke — heller ikke på præcis samme navn', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'ny@gate21.dk', company: 'Gate 21' }));
    const bon = lastBon();
    assert.notEqual(bon.company_id, DEAD);
    assert.equal(companyCount(), before + 1);
});

test('kendt bestiller UDEN firma går gennem matcheren som en ukendt', async () => {
    await post('/webhook/bestilling', order({ email: 'carl@privat.dk', company: 'Landbrug og Fødevarer' }));
    const bon = lastBon();
    assert.equal(bon.company_id, LF);
    assert.equal(bon.customer_id, 2, 'Carl er stadig Carl');
});

test('"Kable" og "Sustainable Foods" er ikke Able — delstreng tæller kun som hele ord', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'x@kable.dk', company: 'Kable ApS' }));
    await post('/webhook/bestilling', order({ email: 'y@sf.dk', company: 'Sustainable Foods' }));
    const bons = _testDb.prepare('SELECT company_id FROM bons').all();
    assert.ok(bons.every(b => b.company_id !== ABLE), 'ingen af dem landede på forhandleren');
    assert.equal(companyCount(), before + 2);
});

// ─────────────────────────────────────────────────────────────
// 3. HTML-entiteter
// ─────────────────────────────────────────────────────────────

test('decodeEntities: navngivne, numeriske og dobbelt-escapede', () => {
    assert.equal(decodeEntities('LANDBRUG &amp; F&Oslash;DEVARER'), 'LANDBRUG & FØDEVARER');
    assert.equal(decodeEntities('A &#38; B &#x26; C'), 'A & B & C');
    assert.equal(decodeEntities('Sm&oslash;rrebr&oslash;d &amp;amp; Co'), 'Smørrebrød & Co');
    assert.equal(decodeEntities('&quot;Tunen&quot; &#39;s'), '"Tunen" \'s');
    assert.equal(decodeEntities('Ukendt &foo; bliver stående'), 'Ukendt &foo; bliver stående');
    assert.equal(decodeEntities(null), '');
});

test('et escapet navn matcher det rigtige firma — normalisering alene redder det ikke', async () => {
    // Uden afkodning bliver `&amp;` til tokenet "amp" og `&oslash;` til "oslash":
    // "bager amp s oslash n" mod "bager søn" er under tærsklen, og der ville
    // blive oprettet en række til.
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'ny@bager.dk', company: 'Bager &amp; S&oslash;n' }));
    assert.equal(lastBon().company_id, BAGER);
    assert.equal(companyCount(), before, 'plejede at blive `Bager &amp; S&oslash;n`-rækken');
});

test('et escapet navn der er nyt gemmes AFKODET — i companies, web_orders og ønskerne', async () => {
    await post('/webhook/bestilling', order({ email: 'ny@x.dk', company: 'Kro &amp; K&aelig;lder' }));
    const bon = lastBon();
    assert.equal(companyName(bon.company_id), 'Kro & Kælder');
    const wo = _testDb.prepare('SELECT company FROM web_orders WHERE bon_id=?').get(bon.id);
    assert.equal(wo.company, 'Kro & Kælder');
    const all = _testDb.prepare("SELECT COUNT(*) AS n FROM companies WHERE name LIKE '%&amp;%' OR name LIKE '%&aelig;%'").get().n;
    assert.equal(all, 0, 'intet escapet navn i basen');
});

test('slutkunden på en forhandler-ordre gemmes afkodet', async () => {
    await post('/webhook/bestilling', order({ email: 'care@able.dk', company: 'Cisco &amp; Co' }));
    const bon = lastBon();
    assert.equal(bon.company_id, ABLE);
    assert.equal(bon.end_customer_name, 'Cisco & Co');
});

// ─────────────────────────────────────────────────────────────
// 4. Forhandler vinder
// ─────────────────────────────────────────────────────────────

test('kendt kunde hos forhandleren: bonnen på forhandleren, det tastede som slutkunde', async () => {
    const before = companyCount();
    await post('/webhook/bestilling', order({ email: 'care@able.dk', company: 'Systematic' }));
    const bon = lastBon();
    assert.equal(bon.company_id, ABLE);
    assert.equal(bon.end_customer_name, 'Systematic');
    assert.doesNotMatch(bon.customer_wishes, /Firma:/, 'slutkunden har sit eget felt — ingen dobbelt note');
    assert.equal(companyCount(), before);
});

test('ukendt person hvis tastede navn matcher forhandleren lander OGSÅ dér, med slutkunde', async () => {
    // "Cisco / able" fra en adresse vi ikke kender: matcheren rammer Able på
    // navnet, og forhandler-reglen gælder så uanset hvordan vi kom dertil.
    await post('/webhook/bestilling', order({ email: 'nyansat@able.dk', company: 'Cisco / able' }));
    const bon = lastBon();
    assert.equal(bon.company_id, ABLE);
    assert.equal(bon.end_customer_name, 'Cisco / able');
});

test('EAN skrives ikke på forhandleren, men på et almindeligt firma', async () => {
    await post('/webhook/bestilling', order({ email: 'care@able.dk', company: 'Systematic', ean_info: 'EAN 5798009811578' }));
    assert.equal(_testDb.prepare('SELECT ean FROM companies WHERE id=?').get(ABLE).ean, null);
    await post('/webhook/bestilling', order({ company: 'Uni', ean_info: 'EAN 5798009811578' }));
    assert.equal(_testDb.prepare('SELECT ean FROM companies WHERE id=?').get(KU).ean, '5798009811578');
});

// ─────────────────────────────────────────────────────────────
// 5. Samme regel i den gamle formular (routes/webhooks.js)
// ─────────────────────────────────────────────────────────────

test('gammel formular: kendt bestiller beholder sit firma, navnet bliver en note', async () => {
    const before = companyCount();
    await post('/api/webhooks/bestilling', legacy({ f5: 'University of Copenhagen' }));
    const bon = lastBon();
    assert.equal(bon.company_id, KU);
    assert.equal(companyCount(), before);
    assert.match(bon.customer_wishes, /^noget\n\nFirma: University of Copenhagen$/);
    assert.match(changelogOf(bon.id), /beholdt kundens firma/);
});

test('gammel formular: CVR i f12 og escapet navn behandles som i den nye', async () => {
    const before = companyCount();
    await post('/api/webhooks/bestilling', legacy({ f3: 'ny@lf.dk', f5: 'Landbrug &amp; Fødevarer', f12: 'CVR 42281751' }));
    assert.equal(lastBon().company_id, LF_KUNST);
    assert.equal(companyCount(), before);
    const all = _testDb.prepare("SELECT COUNT(*) AS n FROM companies WHERE name LIKE '%&amp;%'").get().n;
    assert.equal(all, 0);
});

test('gammel formular: forhandler-reglen gælder også her', async () => {
    await post('/api/webhooks/bestilling', legacy({ f3: 'care@able.dk', f5: 'Systematic' }));
    const bon = lastBon();
    assert.equal(bon.company_id, ABLE);
    assert.equal(bon.end_customer_name, 'Systematic');
});

// ─────────────────────────────────────────────────────────────
// 6. Hjælpere
// ─────────────────────────────────────────────────────────────

test('appendWishesLine lægger linjen før form-markøren og rører ellers intet', () => {
    assert.equal(appendWishesLine('a\n\n[Form: x v1]', 'Firma: X'), 'a\n\nFirma: X\n\n[Form: x v1]');
    assert.equal(appendWishesLine('a', 'Firma: X'), 'a\n\nFirma: X');
    assert.equal(appendWishesLine(null, 'Firma: X'), 'Firma: X');
    assert.equal(appendWishesLine('a', null), 'a');
    assert.equal(appendWishesLine(null, null), null);
});
