// scripts/test-cashflow-sync.js — verificerer syncCashflowInvoice mod isoleret test-DB.
// Køres med: node --experimental-sqlite scripts/test-cashflow-sync.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const { syncCashflowInvoice, parseInvoiceNumber, computeDueDate } = require('../services/cashflowSync');
const { matchByEconomicNumber } = require('../services/cashflowReconcile');

const TMP = path.join(__dirname, '..', 'data', 'test-cashflow-sync.db');
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
runMigrations(TMP);
const db = openDb(TMP);

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
}

// Seed
const co = db.prepare(`INSERT INTO companies (name) VALUES ('Test Firma A/S')`).run();
const cu = db.prepare(`INSERT INTO customers (company_id, first_name, last_name) VALUES (?, 'Anne', 'Andersen')`).run(co.lastInsertRowid);

const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code).id;
function makeBon(opts) {
    const r = db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date, total_price, payment_type, customer_id, company_id, invoice_info, is_offer, is_internal)
        VALUES (?, ?, 1, '2026-05-01', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        opts.bon_number,
        statusId(opts.status_code),
        opts.delivery_date ?? '2026-05-15',
        opts.total_price ?? 1500,
        opts.payment_type ?? 'invoice',
        cu.lastInsertRowid,
        co.lastInsertRowid,
        opts.invoice_info ?? null,
        opts.is_offer ?? 0,
        opts.is_internal ?? 0
    );
    return r.lastInsertRowid;
}
function setStatus(bonId, code) {
    db.prepare(`UPDATE bons SET status_id = ? WHERE id = ?`).run(statusId(code), bonId);
}

console.log('\n— Parse-helpers —');
assert(parseInvoiceNumber('Fakturanr: F-2026-0042') === 'F-2026-0042', 'parse "Fakturanr: F-2026-0042"');
assert(parseInvoiceNumber('Faktura #4821') === '4821', 'parse "Faktura #4821"');
assert(parseInvoiceNumber('Note: ikke et fakturanr') === null, 'parse fri tekst → null');
assert(parseInvoiceNumber(null) === null, 'parse null → null');
assert(computeDueDate('2026-05-15', 14) === '2026-05-29', 'forfald = delivery + 14d');

console.log('\n— FAKTURERET-bon uden fakturanr →');
const bon1 = makeBon({ bon_number: 'B1001', status_code: 'FAKTURERET' });
let r = syncCashflowInvoice(db, bon1);
assert(r.action === 'created', `created (got ${r.action})`);
assert(r.invoice_id === 'B1001', `id = B1001 (got ${r.invoice_id})`);
let inv = db.prepare(`SELECT * FROM cf_invoices WHERE bon_id = ?`).get(bon1);
assert(inv.beloeb === 1500, 'beløb = 1500');
assert(inv.kunde === 'Test Firma A/S', 'kunde = firmanavn');
assert(inv.forfald === '2026-05-29', 'forfald = +14 dage');
assert(inv.betalt === 0, 'ubetalt');

console.log('\n— Idempotent sync —');
r = syncCashflowInvoice(db, bon1);
assert(r.action === 'updated', `updated på 2. kald (got ${r.action})`);
let count = db.prepare(`SELECT COUNT(*) AS n FROM cf_invoices WHERE bon_id = ?`).get(bon1).n;
assert(count === 1, 'én række — ingen duplikat');

console.log('\n— Fakturanr tilføjes → rename —');
db.prepare(`UPDATE bons SET invoice_info = ? WHERE id = ?`).run('Fakturanr: F-2026-0042', bon1);
r = syncCashflowInvoice(db, bon1);
assert(r.action === 'renamed', `renamed (got ${r.action})`);
assert(r.invoice_id === 'F-2026-0042', `id = F-2026-0042 (got ${r.invoice_id})`);
inv = db.prepare(`SELECT id FROM cf_invoices WHERE bon_id = ?`).get(bon1);
assert(inv.id === 'F-2026-0042', 'id i DB = F-2026-0042');

console.log('\n— BETALT → marker som betalt —');
setStatus(bon1, 'BETALT');
r = syncCashflowInvoice(db, bon1);
inv = db.prepare(`SELECT * FROM cf_invoices WHERE bon_id = ?`).get(bon1);
assert(inv.betalt === 1, 'betalt = 1');
assert(inv.betalt_dato === '2026-05-15', `betalt_dato = delivery_date (got ${inv.betalt_dato})`);

console.log('\n— Tilbagerul fra FAKTURERET → behold (betalt) —');
setStatus(bon1, 'KLAR');
r = syncCashflowInvoice(db, bon1);
assert(r.action === 'skipped' && r.reason === 'cannot_delete_paid_invoice', `behold betalt faktura ved rollback (got ${r.action}/${r.reason})`);
inv = db.prepare(`SELECT * FROM cf_invoices WHERE bon_id = ?`).get(bon1);
assert(inv !== undefined, 'faktura ikke slettet');

console.log('\n— Ubetalt + tilbagerul → slet —');
const bon2 = makeBon({ bon_number: 'B1002', status_code: 'FAKTURERET' });
syncCashflowInvoice(db, bon2);
assert(db.prepare(`SELECT COUNT(*) AS n FROM cf_invoices WHERE bon_id = ?`).get(bon2).n === 1, 'oprettet');
setStatus(bon2, 'IGANG');
r = syncCashflowInvoice(db, bon2);
assert(r.action === 'deleted', `slettet (got ${r.action})`);
assert(db.prepare(`SELECT COUNT(*) AS n FROM cf_invoices WHERE bon_id = ?`).get(bon2).n === 0, 'fjernet fra DB');

console.log('\n— payment_type ≠ invoice → skip —');
const bon3 = makeBon({ bon_number: 'B1003', status_code: 'FAKTURERET', payment_type: 'card' });
r = syncCashflowInvoice(db, bon3);
assert(r.action === 'skipped' && r.reason === 'payment_type_not_invoice', `skip card (got ${r.action}/${r.reason})`);

console.log('\n— Tilbud → skip —');
const bon4 = makeBon({ bon_number: 'B1004', status_code: 'FAKTURERET', is_offer: 1 });
r = syncCashflowInvoice(db, bon4);
assert(r.action === 'skipped' && r.reason === 'is_offer_or_internal', `skip tilbud (got ${r.action}/${r.reason})`);

console.log('\n— AFLYST → slet —');
const bon5 = makeBon({ bon_number: 'B1005', status_code: 'FAKTURERET' });
syncCashflowInvoice(db, bon5);
setStatus(bon5, 'AFLYST');
r = syncCashflowInvoice(db, bon5);
assert(r.action === 'deleted', `slettet ved AFLYST (got ${r.action})`);

console.log('\n— Match-link bevares ved rename —');
const bon6 = makeBon({ bon_number: 'B1006', status_code: 'FAKTURERET' });
syncCashflowInvoice(db, bon6);
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-05-20', 'Overførsel', 1500, 'B1006', 95)`).run();
db.prepare(`UPDATE bons SET invoice_info = ? WHERE id = ?`).run('Fakturanr: F-2026-9999', bon6);
syncCashflowInvoice(db, bon6);
const tx = db.prepare(`SELECT matched_invoice_id FROM cf_transactions WHERE tekst='Overførsel' AND beloeb=1500`).get();
assert(tx.matched_invoice_id === 'F-2026-9999', `tx-link fulgte med (got ${tx.matched_invoice_id})`);

console.log('\n— Nul beløb → skip —');
const bon7 = makeBon({ bon_number: 'B1007', status_code: 'FAKTURERET', total_price: 0 });
r = syncCashflowInvoice(db, bon7);
assert(r.action === 'skipped' && r.reason === 'zero_amount', `skip 0 kr (got ${r.action}/${r.reason})`);

console.log('\n— matchByEconomicNumber: kobl bank-indbetaling via e-conomic-fakturanr —');
// faktura med gemt bogført fakturanr (det reconcile ville have gemt)
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B2001', 'Test', 24016.25, '2026-03-15', 1, '3957')`).run();
// A: nummer i tekst + rigtigt beløb → skal kobles
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-03-10', 'FAKTURA 3957', 24016.25)`).run();
// B: samme nummer men forkert beløb → må IKKE kobles (guard mod tilfældigt nummer-match)
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-03-10', 'FAKTURA 3957', 90000)`).run();
// C: rigtigt beløb men intet nummer → må ikke kobles af DENNE matcher
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-03-10', 'Overforsel uden nr', 24016.25)`).run();
const mres = matchByEconomicNumber(db, { dryRun: false });
const txA = db.prepare(`SELECT matched_invoice_id FROM cf_transactions WHERE tekst='FAKTURA 3957' AND beloeb=24016.25`).get();
const txB = db.prepare(`SELECT matched_invoice_id FROM cf_transactions WHERE tekst='FAKTURA 3957' AND beloeb=90000`).get();
const txC = db.prepare(`SELECT matched_invoice_id FROM cf_transactions WHERE tekst='Overforsel uden nr'`).get();
assert(txA.matched_invoice_id === 'B2001', `nummer+beløb-match koblet (got ${txA.matched_invoice_id})`);
assert(txB.matched_invoice_id === null, `nummer men forkert beløb IKKE koblet (guard)`);
assert(txC.matched_invoice_id === null, `intet nummer i tekst IKKE koblet`);
assert(mres.linked === 1, `linked-tæller = 1 (got ${mres.linked})`);

// Cleanup
db.close();
fs.unlinkSync(TMP);
['-shm', '-wal'].forEach(s => {
    const p = TMP + s;
    if (fs.existsSync(p)) fs.unlinkSync(p);
});

console.log(`\n══════════════\n${pass} PASS · ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
