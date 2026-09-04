// tests/mark_internal_companies.test.js
// ============================================================
// Markér vores egne firma-rækker som interne — og lad være hvis det ville
// gøre en kundes mailadresse til en intern afsender.
//
// Baggrund (4. sep. 2026): 16 aktive firma-rækker ER Ristet Rug (smagninger,
// prep, salgsmøder), men ingen var markeret interne. Et automatisk CVR-match
// mod e-conomic ville koble dem til VORES EGEN kunde #116 — og så kan vi
// udstede fakturaer til os selv.
//
// Flaget gør mere end at skjule i CRM: `services/internalIdentity.js` gør
// firmaets kunders adresser til INTERNE afsendere, så mail derfra behandles
// som en videresendelse i stedet for at blive koblet til en kunde. Under
// Ristet Rug-rækken lå to FREMMEDE adresser (frederik@rebelfood.dk,
// julie@glaecier.com) — fejlplaceringer fra v1-importen. Uden en spærre
// ville markeringen tavst have ændret mail-routingen for dem.
//
// Scriptet køres som en rigtig CLI mod en temp-database bygget af de RIGTIGE
// migrations. En omskrevet kopi af forespørgslerne ville bevise, at kopien
// virker — ikke at scriptet gør.
//
// Kør: node --experimental-sqlite --test tests/mark_internal_companies.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'mark-internal-companies.js');
const MIGRATIONS = path.join(ROOT, 'db', 'migrations');

const OUR_CVR = '27606644';          // Nordic Fast Food (e-conomic /self)
const OUR_CVR2 = '40140255';         // Ristet Rug I/S
const OTHER_CVR = '36500336';        // Rebel Food — en rigtig kunde

let dbPath, db;

function run(args = []) {
    try {
        return {
            code: 0,
            out: execFileSync(process.execPath,
                ['--experimental-sqlite', SCRIPT, ...args],
                { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        };
    } catch (err) {
        // Scriptet exit'er 1 når det afbryder — det er en forventet udgang,
        // ikke et crash. Stdout bæres med, for det er dér begrundelsen står.
        return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
    }
}

const co = (id, name, cvr, active = 1) =>
    db.prepare('INSERT INTO companies (id, name, cvr, is_active) VALUES (?,?,?,?)').run(id, name, cvr, active);

function cust(id, navn, companyId, email) {
    db.prepare('INSERT INTO customers (id, first_name, company_id, email, is_active) VALUES (?,?,?,?,1)')
        .run(id, navn, companyId, email);
    if (email) {
        db.prepare(`INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_primary, is_public, is_active)
                    VALUES ('customer', ?, 'email', ?, 'manual', 1, 0, 1)`).run(id, email);
    }
}

const internal = (id) => db.prepare('SELECT is_internal AS v FROM companies WHERE id = ?').get(id).v;

test.beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-int-')), 'test.db');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare("UPDATE settings SET value = 'ristetrug.dk' WHERE key = 'internal_mail_domains'").run();

    // Vores eget hus under fire navne — sådan ser det ud i drift.
    co(10, 'Ristet Rug', OUR_CVR);
    co(11, 'Nordic Fast Food', OUR_CVR);
    co(12, 'Ristet Rug prep', OUR_CVR2);
    co(13, 'Ristet Rug (nedlagt)', OUR_CVR, 0);
    // En rigtig kunde med samme slags navn — må ALDRIG rammes.
    co(20, 'Rebel Food', OTHER_CVR);
    cust(200, 'Sigurd', 20, 'sigurd@rebelfood.dk');
});

test.afterEach(() => { try { db.close(); } catch { /* lukket */ } });

// ─────────────────────────────────────────────────────────────
// A. Hvem udpeges
// ─────────────────────────────────────────────────────────────

test('kun firmaer med de angivne CVR-numre markeres', () => {
    const r = run(['--cvr', OUR_CVR, '--cvr', OUR_CVR2, '--apply']);
    assert.equal(r.code, 0);
    for (const id of [10, 11, 12]) assert.equal(internal(id), 1, `#${id} markeret`);
    assert.equal(internal(20), 0, 'kunden er urørt');
});

test('inaktive rækker lades ligge', () => {
    run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(internal(13), 0, 'en nedlagt række skal ikke vækkes');
});

test('uden --cvr afvises kørslen — vi gætter aldrig på hvem der er os', () => {
    const r = run(['--apply']);
    assert.equal(r.code, 2);
    assert.match(r.out, /gætter aldrig/i);
    assert.equal(internal(10), 0, 'intet skrevet');
});

test('dry-run er default og skriver ikke', () => {
    const r = run(['--cvr', OUR_CVR]);
    assert.match(r.out, /DRY-RUN/);
    assert.equal(internal(10), 0);
});

test('anden kørsel er en no-op', () => {
    run(['--cvr', OUR_CVR, '--apply']);
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.match(r.out, /allerede markeret/i);
    assert.equal(internal(10), 1);
});

test('markeringen efterlader et spor i changelog', () => {
    run(['--cvr', OUR_CVR, '--apply']);
    const row = db.prepare(`SELECT * FROM changelog
        WHERE entity_type='company' AND entity_id=10 AND field_name='is_internal'
        ORDER BY id DESC LIMIT 1`).get();
    assert.ok(row, 'der er en linje');
    assert.equal(row.old_value, '0');
    assert.equal(row.new_value, '1');
    assert.match(row.notes || '', new RegExp(OUR_CVR), 'noten siger hvilket CVR der udpegede rækken');
});

// ─────────────────────────────────────────────────────────────
// B. Mail-spærren — den egentlige beskyttelse
// ─────────────────────────────────────────────────────────────

test('en fremmed adresse under vores eget firma blokerer kørslen', () => {
    cust(300, 'Frederik', 10, 'frederik@rebelfood.dk');
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.out, /EKSTERNE adresser/);
    assert.match(r.out, /frederik@rebelfood\.dk/);
    assert.equal(internal(10), 0, 'INTET markeret — spærren er alt-eller-intet');
    assert.equal(internal(11), 0);
});

test('en adresse på vores eget domæne blokerer ikke', () => {
    cust(301, 'Anne', 10, 'anne@ristetrug.dk');
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 0);
    assert.equal(internal(10), 1);
});

test('en hel adresse kan stå på listen, ikke kun et domæne', () => {
    db.prepare("UPDATE settings SET value = 'ristetrug.dk,leif@privat.dk' WHERE key = 'internal_mail_domains'").run();
    cust(302, 'Leif', 10, 'leif@privat.dk');
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 0, 'adressen er nævnt eksplicit');
    assert.equal(internal(10), 1);
});

test('et andet navn på samme domæne blokerer stadig', () => {
    db.prepare("UPDATE settings SET value = 'ristetrug.dk,leif@privat.dk' WHERE key = 'internal_mail_domains'").run();
    cust(303, 'Nogen', 10, 'anden@privat.dk');
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 1, 'kun den nævnte adresse er intern');
});

test('en værdi der ikke er en adresse spærrer ikke', () => {
    // v1-import har rækker hvor "email" er et navn. Sættet i internalIdentity
    // tager dem harmløst med; de må ikke kunne blokere en oprydning.
    cust(304, 'Ukendt', 10, 'Ristet Rug');
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 0);
    assert.equal(internal(10), 1);
});

test('--accept-external-mail kører videre, men siger det højt', () => {
    cust(305, 'Frederik', 10, 'frederik@rebelfood.dk');
    const r = run(['--cvr', OUR_CVR, '--apply', '--accept-external-mail']);
    assert.equal(r.code, 0);
    assert.match(r.out, /fortsætter alligevel/i);
    assert.equal(internal(10), 1);
});

test('en fremmed adresse på et ANDET firma blokerer ikke', () => {
    const r = run(['--cvr', OUR_CVR, '--apply']);
    assert.equal(r.code, 0, 'Sigurd hos Rebel Food er uvedkommende');
});

// ─────────────────────────────────────────────────────────────
// C. Forslaget gør blokeringen handlingsbar
// ─────────────────────────────────────────────────────────────

test('maildomænet peger på det firma adressen hører til', () => {
    cust(306, 'Frederik', 10, 'frederik@rebelfood.dk');
    const r = run(['--cvr', OUR_CVR]);
    assert.match(r.out, /↳ hører formentlig til #20 Rebel Food/);
});

test('to firmaer på samme domæne → vi gætter ikke', () => {
    co(21, 'Vega', '11111111');
    cust(210, 'Andrea', 21, 'andrea@rebelfood.dk');
    cust(307, 'Frederik', 10, 'frederik@rebelfood.dk');
    const r = run(['--cvr', OUR_CVR]);
    assert.match(r.out, /↳ flere kandidater på @rebelfood\.dk/);
    assert.doesNotMatch(r.out, /↳ hører formentlig til/, 'to kandidater må ikke blive til ét svar');
});

test('gratis-domæner giver aldrig et forslag', () => {
    co(22, 'Tilfældigt Firma', '22222222');
    cust(220, 'Nogen', 22, 'nogen@gmail.com');
    cust(308, 'Leif', 10, 'leif@gmail.com');
    const r = run(['--cvr', OUR_CVR]);
    assert.match(r.out, /leif@gmail\.com/, 'adressen nævnes stadig');
    assert.doesNotMatch(r.out, /↳/, 'men gmail siger intet om arbejdsgiver');
});

test('et ukendt domæne giver intet forslag frem for et gæt', () => {
    cust(309, 'Julie', 10, 'julie@glaecier.com');
    const r = run(['--cvr', OUR_CVR]);
    assert.match(r.out, /julie@glaecier\.com/);
    assert.doesNotMatch(r.out, /↳/, 'et ukendt domæne får intet gæt');
});

// ─────────────────────────────────────────────────────────────
// D. Det scriptet IKKE gør
// ─────────────────────────────────────────────────────────────

test('bons røres aldrig — kun firma-flaget', () => {
    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
    const locId = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO bons (id, bon_number, status_id, location_id, company_id,
                                  order_date, delivery_date, payment_type, total_price)
                VALUES (1,'B1',?,?,10,date('now'),date('now'),'invoice',5000)`).run(statusId, locId);

    const før = db.prepare('SELECT is_internal AS i, total_price AS t FROM bons WHERE id=1').get();
    const r = run(['--cvr', OUR_CVR, '--apply']);
    const efter = db.prepare('SELECT is_internal AS i, total_price AS t FROM bons WHERE id=1').get();

    assert.deepEqual(efter, før, 'bonnen er byte-for-byte den samme');
    assert.match(r.out, /IKKE markeret interne på selve bonen/,
        'og rapporten siger at bon-flaget er en anden beslutning');
});
