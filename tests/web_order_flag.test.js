// tests/web_order_flag.test.js
// ============================================================
// `from_web_order` på getBon.
//
// Advarslen "kundens bestilling og bonens varer stemmer ikke" gælder kun
// web-bestillinger: dér er kundeønske-feltet maskingenereret fra kundens
// menu-valg og BURDE matche varelinjerne. På en almindelig bon er feltet en
// note fra en telefonsamtale, som office allerede har oversat til linjer — at
// den ikke matcher ordret er normalt.
//
// Målt på driftsdata ramte den uafgrænsede sammenligning 369 bons, hvoraf 342
// var almindelige. En stikprøve på 6 af dem gav 5 falske ("9 x Sliderboks, med
// 3 stk:" mod en bon der har de tre sliders; "4 x Tunen" mod bonens «"Tunen"»).
// Med flaget: 27 bons, og 3 efter at lukkede bons også tier.
//
// Skemaet bygges af de RIGTIGE migrations, så en kolonne der flytter sig får
// testen til at fejle i stedet for at bestå mod en håndskrevet kopi.
//
// Kør: npm run test:web-order-flag
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const { getBon } = require('../db/helpers');
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function freshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare('INSERT INTO companies (id, name) VALUES (?,?)').run(1, 'Testfirma');
    db.prepare('INSERT INTO customers (id, first_name, company_id) VALUES (?,?,?)').run(1, 'Anne', 1);
    return db;
}

function makeBon(db, nr, wishes) {
    const st = db.prepare("SELECT id FROM status_definitions WHERE code='NY'").get().id;
    const lo = db.prepare('SELECT id FROM locations LIMIT 1').get().id;
    db.prepare(`INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
        customer_id, company_id, customer_wishes) VALUES (?,?,?,date('now'),date('now'),1,1,?)`)
      .run(nr, st, lo, wishes);
    return db.prepare('SELECT id FROM bons WHERE bon_number=?').get(nr).id;
}

test.beforeEach(() => { _testDb = freshDb(); });

test('en bon uden web-ordre har from_web_order = 0', () => {
    const id = makeBon(_testDb, 'T-ALM', '3× Kyllingen');
    assert.strictEqual(Number(getBon(id).from_web_order), 0);
});

test('en bon fra bestillingsformularen har from_web_order = 1', () => {
    const id = makeBon(_testDb, 'T-WEB', '3× Kyllingen\n\n[Form: standard v1]');
    _testDb.prepare(`INSERT INTO web_orders (raw_data, bon_id) VALUES ('{}', ?)`).run(id);
    assert.strictEqual(Number(getBon(id).from_web_order), 1);
});

test('flaget følger den enkelte bon, ikke alle bons', () => {
    const web = makeBon(_testDb, 'T-W2', 'x');
    const alm = makeBon(_testDb, 'T-A2', 'x');
    _testDb.prepare(`INSERT INTO web_orders (raw_data, bon_id) VALUES ('{}', ?)`).run(web);
    assert.strictEqual(Number(getBon(web).from_web_order), 1, 'web-bonen');
    assert.strictEqual(Number(getBon(alm).from_web_order), 0, 'den almindelige');
});

test('en web_order uden bon_id smitter ikke af på andre bons', () => {
    const alm = makeBon(_testDb, 'T-A3', 'x');
    _testDb.prepare(`INSERT INTO web_orders (raw_data, bon_id) VALUES ('{}', NULL)`).run();
    assert.strictEqual(Number(getBon(alm).from_web_order), 0);
});
