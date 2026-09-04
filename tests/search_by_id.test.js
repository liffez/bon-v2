// tests/search_by_id.test.js
// ============================================================
// Et rent tal i et søgefelt er også et kunde- eller firma-id.
//
// Baggrund (4. sep. 2026): listerne VISER id'et — firma-listen med tooltip'en
// "Firma-id (brug til sammenlægning)" — men søgefeltet lige ovenover kunne
// ikke finde det. Man kommer med id'et i hånden fra en changelog-linje, et
// oprydnings-script eller en fejlbesked, og stod uden vej ind.
//
// Set i drift: en søgning på kunde-id "4019" returnerede seks HELT ANDRE
// kunder — dem hvis telefonnummer (40195471) indeholder cifrene. Derfor er
// id-match noget der LÆGGES TIL tekstsøgningen, ikke noget der erstatter den.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, og
// endpointsene rammes over HTTP. En omskrevet kopi af SQL'en ville bevise at
// kopien virker, ikke at ruterne gør.
//
// Kør: node --experimental-sqlite --test tests/search_by_id.test.js
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

const { searchAsId } = require('../db/helpers');
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }

    const co = (id, name, cvr) =>
        db.prepare('INSERT INTO companies (id, name, cvr, is_active) VALUES (?,?,?,1)').run(id, name, cvr);
    const cust = (id, fornavn, efternavn, companyId, phone, email) =>
        db.prepare(`INSERT INTO customers (id, first_name, last_name, company_id, phone, email, is_active)
                    VALUES (?,?,?,?,?,?,1)`).run(id, fornavn, efternavn, companyId, phone, email);

    co(2533, 'Rebel Food', '36500336');
    co(3681, 'Rebel Food ApS', '36500336');
    co(2539, 'Ristet Rug', '27606644');
    // Naboer hvis id INDEHOLDER 2533 — uden dem kan et delstreng-match ikke
    // skelnes fra et eksakt, og påstanden om eksakthed ville måle ingenting.
    co(25330, 'Nabo over', '10000001');
    co(12533, 'Nabo under', '10000002');

    // Drifts-tilfældet: kunde #4019 er den man søger efter, men SEKS andre
    // bærer et telefonnummer der indeholder cifrene "4019".
    cust(4019, 'Frederik', 'Sønksen', 2533, '39209700', 'frederik@rebelfood.dk');
    cust(2966, 'Leif', 'Zeeberg', 2539, '40195471', 'leifzeeberg@hotmail.com');
    cust(4039, 'Miaenaya', 'Ravn', 2539, '40195471', 'festival@integrateddance.dk');

    // Naboer der IKKE må trækkes med af et eksakt id-match.
    cust(40190, 'Nabo', 'Over', 2539, '11111111', 'over@x.dk');
    db.prepare(`INSERT INTO customers (id, first_name, last_name, company_id, phone, email, is_active)
                VALUES (14019,'Nabo','Under',2539,'22222222','under@x.dk',1)`).run();

    // Inaktiv — må aldrig dukke op, heller ikke via id.
    db.prepare(`INSERT INTO customers (id, first_name, company_id, is_active)
                VALUES (9001,'Lukket',2539,0)`).run();
    db.prepare(`INSERT INTO companies (id, name, is_active) VALUES (9002,'Lukket firma',0)`).run();

    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1, role: 'admin' } }; next(); });
app.use('/api/crm', require('../routes/crm'));
app.use('/api/companies', require('../routes/companies'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

const get = async (url) => {
    const res = await fetch(baseUrl + url);
    return { status: res.status, body: await res.json().catch(() => null) };
};
const ids = (rows) => (rows || []).map(r => r.id).sort((a, b) => a - b);

// ─────────────────────────────────────────────────────────────
// A. Helperen
// ─────────────────────────────────────────────────────────────

test('searchAsId genkender et rent tal og afviser alt andet', () => {
    assert.equal(searchAsId('4019'), 4019);
    assert.equal(searchAsId('  4019 '), 4019, 'mellemrum trimmes');
    assert.equal(searchAsId('0'), 0);
    for (const v of ['4019a', 'abc', '', null, undefined, '-5', '4.0', '40 19']) {
        assert.equal(searchAsId(v), null, `${JSON.stringify(v)} er ikke et id`);
    }
    assert.equal(searchAsId('1234567890'), null, '10 cifre er et telefonnummer, ikke et id');
});

test('havelåge accepteres — listerne viser id\'et som "#4019"', () => {
    // Uden dette afviser søgningen sin egen notation: felterne siger "#id",
    // listerne skriver "#4019", og folk taster havelågen med.
    assert.equal(searchAsId('#4019'), 4019);
    assert.equal(searchAsId(' #4019 '), 4019);
    for (const v of ['##4019', '#abc', '#', '4019#']) {
        assert.equal(searchAsId(v), null, `${JSON.stringify(v)} er ikke et id`);
    }
});

test('havelågen SKÆRPER søgningen til netop den ene kunde', async () => {
    // "#4019" er utvetydigt et id — ingen navn, mail eller telefon indeholder
    // havelågen, så tekstdelen rammer ingenting og kun id-matchet står tilbage.
    // Det er en gevinst, ikke en bivirkning: skriver man havelågen, vil man
    // ikke have de otte kunder hvis telefonnummer indeholder cifrene.
    const med = await get('/api/crm/customers?q=%234019');
    assert.deepEqual(ids(med.body), [4019], 'kun kunden');

    const uden = await get('/api/crm/customers?q=4019');
    assert.equal(uden.body[0].id, 4019, 'uden havelåge står den først …');
    assert.ok(uden.body.length > 1, '… men de brede træffere er med');
});

// ─────────────────────────────────────────────────────────────
// B. Kundelisten — dét felt der fejlede i drift
// ─────────────────────────────────────────────────────────────

test('søgning på kunde-id finder kunden', async () => {
    const r = await get('/api/crm/customers?q=4019');
    assert.equal(r.status, 200);
    assert.ok(ids(r.body).includes(4019), 'kunden man søgte efter er med');
});

test('id-rækken ligger ØVERST, ikke begravet blandt telefon-match', async () => {
    // I drift lå #4019 som nr. 8 af 9, under de kunder hvis mobilnummer
    // (40195471) indeholder cifrene. Teknisk fundet, praktisk ubrugeligt.
    const r = await get('/api/crm/customers?q=4019');
    assert.equal(r.body[0].id, 4019, 'svaret man kom efter står først');
    assert.ok(r.body.length > 1, 'og de øvrige træffere er der stadig');
});

test('id-match ERSTATTER ikke tekstsøgningen', async () => {
    // Drifts-tilfældet: cifrene optræder også i to telefonnumre, og de skal
    // stadig rammes. Havde vi byttet LIKE ud med et id-opslag, ville de forsvinde.
    const r = await get('/api/crm/customers?q=4019');
    const fundet = ids(r.body);
    assert.ok(fundet.includes(2966), 'telefon 40195471 rammes stadig');
    assert.ok(fundet.includes(4039), 'og den anden med samme nummer');
});

test('id-match er EKSAKT — naboerne trækkes ikke med', async () => {
    const r = await get('/api/crm/customers?q=4019');
    const fundet = ids(r.body);
    assert.ok(!fundet.includes(40190), '40190 er ikke 4019');
    assert.ok(!fundet.includes(14019), '14019 er heller ikke');
});

test('et id der ikke findes giver tomt svar, ikke alt', async () => {
    const r = await get('/api/crm/customers?q=999999');
    assert.equal(ids(r.body).length, 0);
});

test('en inaktiv kunde findes ikke på sit id', async () => {
    const r = await get('/api/crm/customers?q=9001');
    assert.ok(!ids(r.body).includes(9001));
});

test('tekstsøgning opfører sig som før', async () => {
    const r = await get('/api/crm/customers?q=Frederik');
    assert.ok(ids(r.body).includes(4019));
});

// ─────────────────────────────────────────────────────────────
// C. Firmalisten — den der VISER id'et
// ─────────────────────────────────────────────────────────────

test('søgning på firma-id finder firmaet', async () => {
    const r = await get('/api/crm/companies?q=3681');
    assert.ok(ids(r.body).includes(3681), 'tooltip\'en lover at id\'et kan bruges');
});

test('firma-id-match er eksakt og additivt', async () => {
    const byCvr = await get('/api/crm/companies?q=36500336');
    assert.deepEqual(ids(byCvr.body), [2533, 3681], 'CVR-søgning uændret');

    const byId = await get('/api/crm/companies?q=2533');
    assert.deepEqual(ids(byId.body), [2533], 'ikke 12533 eller 25330');
});

test('et inaktivt firma findes ikke på sit id', async () => {
    const r = await get('/api/crm/companies?q=9002');
    assert.ok(!ids(r.body).includes(9002));
});

// ─────────────────────────────────────────────────────────────
// D. Røgtest — hele filen, ikke kun de to ruter vi ændrede
// ─────────────────────────────────────────────────────────────

// En template literal med en udefineret variabel er syntaktisk gyldig og
// evalueres først når ruten KALDES — `node --check` ser den ikke, og en test
// af nabo-ruten heller ikke. Præcis dét væltede /suggestions i produktion, da
// en ORDER BY-rettelse til /customers landede i den forkerte handler.
//
// Derfor rammes hver GET-rute i filen mindst én gang. Den siger intet om
// svarets INDHOLD — kun at ruten kan køre uden at kaste.
const CRM_GETS = [
    '/stats', '/meetings/upcoming', '/briefing', '/suggestions',
    '/suggestions/snoozed', '/suggestions/review-stats', '/season', '/rytme',
    '/cold-offers', '/service-calls', '/customers', '/companies',
    '/customer/4019', '/company/2533', '/customer-orders/4019',
    '/planned', '/followups', '/callbacks', '/dormant', '/call-log',
    '/call-stats', '/pipeline',
];

test('hver GET-rute i crm.js svarer uden at kaste', async () => {
    const brudte = [];
    for (const p of CRM_GETS) {
        const r = await get('/api/crm' + p);
        // 404 er et gyldigt svar for en opslags-rute med et id vi ikke seeder.
        if (r.status >= 500) brudte.push(`${p} → ${r.status} ${r.body && r.body.error || ''}`);
    }
    assert.deepEqual(brudte, [], 'ruter der kaster');
});

test('ruterne svarer også MED en søgetekst der ligner et id', async () => {
    // Id-grenen er den nye kodesti; den skal ikke kunne vælte en nabo-rute.
    const brudte = [];
    for (const p of ['/customers', '/companies', '/suggestions', '/season', '/rytme']) {
        const r = await get('/api/crm' + p + '?q=4019');
        if (r.status >= 500) brudte.push(`${p} → ${r.status} ${r.body && r.body.error || ''}`);
    }
    assert.deepEqual(brudte, [], 'ruter der kaster med q=4019');
});

// ─────────────────────────────────────────────────────────────
// E. Sammenlægnings-guiden — hvor tooltip'en sender folk hen
// ─────────────────────────────────────────────────────────────

test('guidens firmasøgning finder på id', async () => {
    const r = await get('/api/companies?q=3681');
    assert.equal(r.status, 200);
    assert.ok(ids(r.body).includes(3681),
        'ellers er henvisningen "brug til sammenlægning" en blindgyde');
});

test('guidens søgning på navn er uændret', async () => {
    const r = await get('/api/companies?q=Rebel');
    assert.deepEqual(ids(r.body), [2533, 3681]);
});

test('guidens søgning på id er eksakt', async () => {
    const r = await get('/api/companies?q=2533');
    assert.deepEqual(ids(r.body), [2533], 'ikke 25330 eller 12533');
});

test('guidens to-tegns-minimum er uændret', async () => {
    const r = await get('/api/companies?q=3');
    assert.deepEqual(r.body, [], 'ét tegn søger stadig ikke');
});
