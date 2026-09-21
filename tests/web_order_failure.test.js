// tests/web_order_failure.test.js
// ============================================================
// En web-bestilling må ikke kunne forsvinde i stilhed (#638 + #644).
//
// To fejl i samme kodevej, begge af fejlklassen "handlingen påstod at være
// sket, bivirkningen fyrede aldrig, og intet sted mødtes de to" (jf. #305/#319):
//
//   #638 — catch-grenen i POST /webhook/bestilling svarede `res.json({ok:true})`
//          på ALT den ikke genkendte. Gik createBon galt, fik kunden "tak for
//          din bestilling", der fandtes ingen bon, og web_orders-rækken (som
//          blev skrevet EFTER bonen) fandtes heller ikke. Ingen kunne bagefter
//          se at ordren havde eksisteret.
//
//   #644 — `delivery_date` blev kun tjekket for at VÆRE der. "i morgen" gav en
//          bon der var halvt synlig (Senere viser den, I dag og Kalender ikke),
//          og gik samtidig uden om deadline, fordi cut-off bevidst fejler ÅBENT
//          på en dato den ikke kan læse.
//
// Reglerne der holdes fast her:
//   1. `ok: true` kun når der FAKTISK er oprettet en bon.
//   2. En ordre vi ikke kunne tage imod efterlader et spor i web_orders.
//   3. Beskeden til kunden er SAND — vi lover kun at have ordren når vi har den.
//   4. Sporet ligger uden for transaktionen; sideeffekterne inden i.
//   5. En ulæselig dato/tid afvises FØR guards der fejler åbent.
//   6. Samme dato-regel i begge indgange.
//   7. Den fejlede ordre er synlig for office uden at læse serverloggen.
//
// Endpoints rammes over HTTP — det er SVARET til kunden der er fejlen, så en
// test der kaldte handleWebOrder direkte ville ikke måle det der gik galt.
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database.
//
// Kør: npm run test:web-order-fejl
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
mailService.sendFromTemplate = async () => ({ ok: true });

const { offsetISO } = require('../db/helpers');
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value='' WHERE key='webhook_secret'").run();
    db.prepare("INSERT INTO companies (id, name, is_active) VALUES (1, 'Testfirma', 1)").run();
    db.prepare("INSERT INTO customers (id, first_name, email, company_id) VALUES (1,'Anne','anne@test.dk',1)").run();
    return db;
}

// ── Testserver. Routeren monteres BÅDE offentligt (som server.js:154) og bag
//    en session, så auth på det nye acknowledge-endpoint kan efterprøves.
const express = require('express');
const app = express();
app.use(express.json());
app.use('/webhook', require('../routes/web-orders'));          // ingen session
app.use('/api/webhooks', require('../routes/webhooks'));       // ingen session
app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/web-orders', require('../routes/web-orders'));   // med session
app.use('/api/nav', require('../routes/nav'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function post(url, body, headers = {}) {
    const res = await fetch(baseUrl + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}
async function get(url) {
    const res = await fetch(baseUrl + url);
    return { status: res.status, body: await res.json().catch(() => null) };
}

function order(extra = {}) {
    return {
        first_name: 'Anne', last_name: 'Test', email: 'anne@test.dk', phone: '39209700',
        delivery_date: offsetISO(30), delivery_time: '10:00',
        ordertype: 'catering', pax: '11', wishes: '3× Kyllingen',
        ...extra,
    };
}
function legacy(extra = {}) {
    return { f2: 'Anne Test', f3: 'anne@test.dk', f7_date: offsetISO(30), f7_time: '10:00', ...extra };
}

const rows   = () => _testDb.prepare('SELECT * FROM web_orders ORDER BY id').all();
const bons   = () => _testDb.prepare('SELECT * FROM bons').all();
const kunder = () => _testDb.prepare('SELECT * FROM customers').all();

/** Få createBon til at fejle ægte, inde i transaktionen. */
function breakBonInsert() {
    _testDb.exec(`CREATE TRIGGER t_fail_bons BEFORE INSERT ON bons
                  BEGIN SELECT RAISE(ABORT, 'simuleret fejl i createBon'); END;`);
}
/** Få selve sporet til at fejle — den ene situation hvor vi INTET har. */
function breakWebOrderInsert() {
    _testDb.exec(`CREATE TRIGGER t_fail_wo BEFORE INSERT ON web_orders
                  BEGIN SELECT RAISE(ABORT, 'simuleret fejl i web_orders'); END;`);
}

// ════════════════════════════════════════════════════════════════════
// §1 — Formatet på leveringstidspunktet (#644)
// ════════════════════════════════════════════════════════════════════

test('§1.1 gyldig bestilling giver ok:true, et bonnummer og en konverteret række', async () => {
    const r = await post('/webhook/bestilling', order());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true, 'ok:true kun når bonen findes');
    assert.ok(r.body.bon_number, 'bonnummeret returneres som hidtil');
    assert.strictEqual(bons().length, 1);

    const wo = rows();
    assert.strictEqual(wo.length, 1);
    assert.strictEqual(wo[0].status, 'konverteret');
    assert.ok(wo[0].bon_id, 'sporet er koblet til bonen');
    assert.strictEqual(wo[0].failure_reason, null);
});

test('§1.2 "i morgen" afvises med 409 — og bliver ALDRIG en bon', async () => {
    const r = await post('/webhook/bestilling', order({ delivery_date: 'i morgen' }));
    assert.strictEqual(r.status, 409, 'ikke 200, ikke 500');
    assert.strictEqual(r.body.code, 'invalid_date');
    assert.ok(/dato/i.test(r.body.message), 'beskeden er dansk og handler om datoen');
    assert.strictEqual(bons().length, 0);
    assert.strictEqual(rows().length, 0, 'en ulæselig dato giver ingen brugbar ordre at gemme');
});

test('§1.3 2026-02-31 matcher regexen men er ikke en dag — regex alene er ikke nok', async () => {
    const r = await post('/webhook/bestilling', order({ delivery_date: '2026-02-31' }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'invalid_date');
    assert.strictEqual(bons().length, 0);
});

test('§1.4 2026-9-17 uden nul-udfyldning afvises — den sorterer forkert i alle lister', async () => {
    const r = await post('/webhook/bestilling', order({ delivery_date: '2026-9-17' }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'invalid_date');
});

test('§1.5 ulæseligt klokkeslæt afvises', async () => {
    for (const t of ['9:30', '24:00', '11:60', 'frokost']) {
        const r = await post('/webhook/bestilling', order({ delivery_time: t }));
        assert.strictEqual(r.status, 409, `"${t}" skulle afvises`);
        assert.strictEqual(r.body.code, 'invalid_time', `"${t}" skulle give invalid_time`);
    }
    assert.strictEqual(bons().length, 0);
});

test('§1.6 randtidspunkter og skudårsdag slipper igennem — vi afviser ikke ægte ordrer', async () => {
    for (const t of ['00:00', '23:59', '10:00']) {
        const r = await post('/webhook/bestilling', order({ delivery_time: t }));
        assert.strictEqual(r.status, 200, `"${t}" er et gyldigt tidspunkt`);
    }
    const skud = await post('/webhook/bestilling', order({ delivery_date: '2028-02-29' }));
    assert.notStrictEqual(skud.body?.code, 'invalid_date', '29. februar 2028 findes');
});

test('§1.7 den gamle f-felt-webhook har samme dato-regel (#644 nævner den eksplicit)', async () => {
    const r = await post('/api/webhooks/bestilling', legacy({ f7_date: 'i morgen' }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'invalid_date');
    assert.strictEqual(bons().length, 0);

    const t = await post('/api/webhooks/bestilling', legacy({ f7_time: '9:30' }));
    assert.strictEqual(t.status, 409);
    assert.strictEqual(t.body.code, 'invalid_time');

    const ok = await post('/api/webhooks/bestilling', legacy());
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(bons().length, 1);
});

// ════════════════════════════════════════════════════════════════════
// §2 — Uændret adfærd: honeypot, manglende felter, secret
// ════════════════════════════════════════════════════════════════════

test('§2.1 honeypot svarer stadig 200 og efterlader intet — sig ikke til en bot at den er fanget', async () => {
    const r = await post('/webhook/bestilling', order({ website: 'spam' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(bons().length, 0);
    assert.strictEqual(rows().length, 0, 'bot-spam må ikke fylde tabellen');
});

test('§2.2 manglende påkrævede felter afvises i stilhed og gemmes ikke', async () => {
    const r = await post('/webhook/bestilling', order({ first_name: '' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(bons().length, 0);
    assert.strictEqual(rows().length, 0);
});

test('§2.3 forkert webhook-secret giver 401', async () => {
    _testDb.prepare("UPDATE settings SET value='hemmelig' WHERE key='webhook_secret'").run();
    const r = await post('/webhook/bestilling', order(), { 'x-webhook-secret': 'forkert' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(rows().length, 0);
});

// ════════════════════════════════════════════════════════════════════
// §3 — Bevidste afvisninger: 409 bevares, og de gemmes nu
// ════════════════════════════════════════════════════════════════════

test('§3.1 deadline passeret giver stadig 409 med sin besked — og gemmes som afvist', async () => {
    const r = await post('/webhook/bestilling', order({ delivery_date: offsetISO(0) }));
    assert.strictEqual(r.status, 409, 'kunden skal ikke tro bestillingen er modtaget');
    assert.strictEqual(r.body.ok, false);
    assert.ok(/deadline/i.test(r.body.message), 'beskeden forklarer hvorfor');
    assert.strictEqual(bons().length, 0);

    const wo = rows();
    assert.strictEqual(wo.length, 1, 'en afvist ordre er stadig en kunde der ville handle');
    assert.strictEqual(wo[0].status, 'afvist');
    assert.ok(/cutoff/.test(wo[0].failure_reason || ''), 'grunden står på rækken');
    assert.ok(JSON.parse(wo[0].raw_data).first_name, 'rådata er gemt');
});

test('§3.2 ferielukket dato gemmes som afvist med sin egen grund', async () => {
    const d = offsetISO(30);
    _testDb.prepare("UPDATE settings SET value=? WHERE key='bestilling.closed_dates'")
        .run(JSON.stringify([{ from: d, to: d, label: 'Sommerferie' }]));

    const r = await post('/webhook/bestilling', order({ delivery_date: d }));
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'closed_period');
    const wo = rows();
    assert.strictEqual(wo[0].status, 'afvist');
    assert.ok(/closed_period/.test(wo[0].failure_reason), 'grunden skelnes fra deadline');
});

// ════════════════════════════════════════════════════════════════════
// §4 — Kernen i #638: en uventet serverfejl
// ════════════════════════════════════════════════════════════════════

test('§4.1 fejler bon-oprettelsen, får kunden IKKE "tak for din bestilling"', async () => {
    breakBonInsert();
    const r = await post('/webhook/bestilling', order());

    assert.strictEqual(r.status, 500, 'det var 200 før — dét var fejlen');
    assert.notStrictEqual(r.body.ok, true, 'ok:true kun når der findes en bon');
    assert.strictEqual(bons().length, 0);
});

test('§4.2 ordren er ikke tabt: sporet ligger i web_orders med rådata og grund', async () => {
    breakBonInsert();
    await post('/webhook/bestilling', order({ wishes: '12× Falaflen, ingen mayo' }));

    const wo = rows();
    assert.strictEqual(wo.length, 1, 'rækken skrives FØR bonen, så den overlever fejlen');
    assert.strictEqual(wo[0].bon_id, null);
    assert.strictEqual(wo[0].status, 'ny', 'ikke "afvist" — vi sagde ikke nej, vi kunne ikke');
    assert.ok(wo[0].failure_reason, 'hvorfor den ikke blev til en bon');
    assert.strictEqual(JSON.parse(wo[0].raw_data).wishes, '12× Falaflen, ingen mayo',
        'hele bestillingen kan genskabes af et menneske');
});

test('§4.3 transaktionen ruller tilbage — ingen halvfærdig kunde som affald', async () => {
    breakBonInsert();
    const før = kunder().length;
    await post('/webhook/bestilling', order({ email: 'helt.ny@kunde.dk', first_name: 'Ny' }));
    assert.strictEqual(kunder().length, før,
        'uden transaktionen stod der en ny kunderække tilbage som ingen kunne forklare');
});

test('§4.4 beskeden er SAND: har vi ordren, siger vi det', async () => {
    breakBonInsert();
    const r = await post('/webhook/bestilling', order());
    assert.strictEqual(r.body.code, 'internal_error_saved');
    assert.ok(/modtaget dine oplysninger/i.test(r.body.message));
});

test('§4.5 kan vi ikke engang gemme sporet, lover vi det ikke', async () => {
    breakWebOrderInsert();
    const r = await post('/webhook/bestilling', order());
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.body.code, 'internal_error');
    assert.ok(!/modtaget dine oplysninger/i.test(r.body.message),
        'vi må ikke påstå at have en ordre vi ikke har');
    assert.strictEqual(rows().length, 0);
});

test('§4.6 kunden ser aldrig en statuskode — kun dansk tekst', async () => {
    breakBonInsert();
    const r = await post('/webhook/bestilling', order());
    assert.ok(!/\b500\b/.test(r.body.message), '"500" må ikke optræde i det kunden læser');
    assert.ok(r.body.message.length > 20, 'der ER en besked at vise — ellers falder formularen tilbage til sin egen');
});

// ════════════════════════════════════════════════════════════════════
// §5 — Synlighed: office skal kunne se det uden at læse serverloggen
// ════════════════════════════════════════════════════════════════════

test('§5.1 den fejlede ordre står i opmærksomheds-panelet', async () => {
    breakBonInsert();
    await post('/webhook/bestilling', order({ first_name: 'Mette', phone: '12345678' }));

    const a = await get('/api/nav/attention');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.failed_orders.length, 1,
        'panelets hovedliste går FROM bons JOIN web_orders — uden denne gren er rækken usynlig');
    assert.match(a.body.failed_orders[0].customer_name, /Mette/);
    assert.strictEqual(a.body.failed_orders[0].customer_phone, '12345678',
        'office skal kunne ringe op uden at slå noget op');
    assert.ok(a.body.counts.total >= 1, 'den tæller med i badgen');
});

test('§5.2 en AFVIST ordre larmer ikke i panelet — kunden fik en forklaring', async () => {
    await post('/webhook/bestilling', order({ delivery_date: offsetISO(0) }));
    assert.strictEqual(rows()[0].status, 'afvist');

    const a = await get('/api/nav/attention');
    assert.strictEqual(a.body.failed_orders.length, 0);
});

test('§5.3 "Klaret" fjerner den fra panelet, men ikke fra databasen', async () => {
    breakBonInsert();
    await post('/webhook/bestilling', order());
    const id = rows()[0].id;

    const ack = await post(`/api/web-orders/${id}/acknowledge`, {});
    assert.strictEqual(ack.status, 200);
    assert.ok(ack.body.acknowledged_at);

    const a = await get('/api/nav/attention');
    assert.strictEqual(a.body.failed_orders.length, 0, 'et panel der aldrig kan ryddes bliver ikke læst');
    assert.strictEqual(rows().length, 1, 'ordren er stadig i databasen');
});

test('§5.4 acknowledge kræver login — routeren er også monteret offentligt på /webhook', async () => {
    breakBonInsert();
    await post('/webhook/bestilling', order());
    const id = rows()[0].id;

    const uden = await post(`/webhook/${id}/acknowledge`, {});
    assert.strictEqual(uden.status, 401, 'uden requireAuth() ville den være åben for internettet');
    assert.strictEqual(rows()[0].acknowledged_at, null);
});
