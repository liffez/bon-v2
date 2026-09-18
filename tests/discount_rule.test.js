// tests/discount_rule.test.js
// ============================================================
// Den fælles rabatregel (services/bonDiscount.js): rabatten gælder varerne,
// ikke levering, gebyrer og emballage — og ALLE forbrugere regner den ens.
//
// Baggrund (sep. 2026): e-conomic-udkastet undtog levering/gebyrer/emballage,
// bonens egen total trak rabatten af alt, og driftsregnskab + rapporter summerede
// varelinjerne helt uden rabat. Tre svar på "hvad har Able betalt?".
//
// Skemaet bygges af de RIGTIGE migrations i :memory:, så settings-rækken
// (economic_no_discount_categories, migration 168) er den der står i drift.
//
// Kør: node --experimental-sqlite --test tests/discount_rule.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _db = null;
dbModule.getDb = () => _db;

const { recalcBonTotal } = require('../db/helpers');
const rule = require('../services/bonDiscount');
const economicInvoice = require('../services/economicInvoice');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function freshDb() {
    const db = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    db.prepare('INSERT INTO companies (id, name, discount_percent) VALUES (1, ?, 12.5)').run('Able');
    db.prepare('INSERT INTO companies (id, name) VALUES (2, ?)').run('Uden rabat');
    return db;
}

// Mad 1000 + emballage 100 + service 40 + leveringslinje 180 (alle INCL moms).
const LINES = [
    { product_name: 'Kyllingen', category: '01 Sandwich',  line_total: 1000 },
    { product_name: 'RR Boks',   category: '06 Emballage', line_total: 100 },
    { product_name: 'Gebyr',     category: 'x- Service',   line_total: 40 },
    { product_name: 'Levering',  category: 'x-Levering',   line_total: 180 },
];

function makeBon(db, { id, companyId, lines = LINES, deliveryPrice = 0 }) {
    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
    const locId = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date, company_id, delivery_price, payment_type)
                VALUES (?, ?, ?, ?, '2026-09-01', '2026-09-01', ?, ?, 'invoice')`).run(id, 'B' + id, statusId, locId, companyId, deliveryPrice);
    const ins = db.prepare(`INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit_price, line_total)
                            VALUES (?, ?, ?, 1, ?, ?)`);
    for (const l of lines) ins.run(id, l.product_name, l.category, l.line_total, l.line_total);
}

test.beforeEach(() => { _db = freshDb(); });

test('recalcBonTotal: rabat kun på varerne', () => {
    makeBon(_db, { id: 1, companyId: 1 });
    const pct = _db.prepare('SELECT offer_discount_percent AS p FROM bons WHERE id = 1').get().p;
    assert.strictEqual(pct, 12.5, 'triggeren kopierer firmaets sats');
    // 1320 − 12,5 % af 1000 = 1195. Den gamle regel gav 1155.
    assert.strictEqual(recalcBonTotal(_db, 1), 1195);
});

test('recalcBonTotal: linjeløs levering (delivery_price) får heller ikke rabat', () => {
    makeBon(_db, { id: 2, companyId: 1, lines: LINES.slice(0, 1), deliveryPrice: 200 });
    // 1000 + 200 − 125 = 1075
    assert.strictEqual(recalcBonTotal(_db, 2), 1075);
});

test('recalcBonTotal: bon uden rabat er uændret', () => {
    makeBon(_db, { id: 3, companyId: 2 });
    assert.strictEqual(recalcBonTotal(_db, 3), 1320);
});

test('lineNetSQL: rapporter og drift regner samme beløb som bonens total', () => {
    makeBon(_db, { id: 4, companyId: 1 });
    makeBon(_db, { id: 5, companyId: 2 });
    recalcBonTotal(_db, 4); recalcBonTotal(_db, 5);
    const rows = _db.prepare(`
        SELECT b.id, SUM(${rule.lineNetSQL(_db, 'bl.quantity * bl.unit_price')}) AS net, b.total_price
          FROM bons b JOIN bon_lines bl ON bl.bon_id = b.id GROUP BY b.id ORDER BY b.id
    `).all();
    for (const r of rows) assert.strictEqual(r.net, r.total_price, `bon ${r.id}: SQL-netto = bonens total`);
    assert.strictEqual(rows[0].net, 1195);
    assert.strictEqual(rows[1].net, 1320);
});

test('lineNetSQL: kategorien normaliseres (store bogstaver, mellemrum)', () => {
    makeBon(_db, { id: 6, companyId: 1, lines: [{ product_name: 'x', category: '  06 EMBALLAGE ', line_total: 100 }] });
    const r = _db.prepare(`SELECT SUM(${rule.lineNetSQL(_db, 'bl.line_total')}) AS net
                             FROM bons b JOIN bon_lines bl ON bl.bon_id = b.id WHERE b.id = 6`).get();
    assert.strictEqual(r.net, 100);
});

test('e-conomic bruger samme regel', () => {
    assert.strictEqual(economicInvoice.discountForLine, rule.discountForLine);
    const settings = { noDiscountCategories: rule.getNoDiscountCategories(_db) };
    assert.strictEqual(economicInvoice.discountForLine('01 Sandwich', 12.5, settings), 12.5);
    assert.strictEqual(economicInvoice.discountForLine('x-Levering', 12.5, settings), 0);
    assert.strictEqual(economicInvoice.discountForLine('06 Emballage', 12.5, settings), 0);
});

test('tom undtagelsesliste = rabat på alt (bagudkompatibelt)', () => {
    _db.prepare("UPDATE settings SET value = '[]' WHERE key = 'economic_no_discount_categories'").run();
    makeBon(_db, { id: 7, companyId: 1 });
    assert.strictEqual(recalcBonTotal(_db, 7), 1155);
});
