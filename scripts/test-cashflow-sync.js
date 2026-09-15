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

console.log('\n— matchByEconomicNumber v2: nummeret vinder, markerer betalt, tåler bonens gamle beløb —');
// Regressionen fra drift (sep 2026): "FAKTURA 4131" (2808,75) lå som beløbs-gæt på B4228,
// mens B4145 — som ER faktura 4131 — stod udestående. cf.beloeb på B4145 manglede leveringen.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B4145', 'CAP', 2000, '2026-08-19', 0, '4131')`).run();
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B4228', 'Stromma', 2595.25, '2026-09-16', 0, '4189')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4131', '2026-08-06', 2600, 2600, '#B4145')`).run();
const t4131 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-07', 'FAKTURA 4131', 2600, 'B4228', 50)`).run().lastInsertRowid;
// Forkert AUTO-betalt: "FAKTURA 4174" (1921,5) lå med conf 70 på B4220, som derfor stod betalt
// uden at være det. B4223 (= 4174) stod åben.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato, economic_number) VALUES ('B4220', 'Mørkhøj', 1916.25, '2026-09-10', 1, '2026-09-07', '4172')`).run();
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B4223', 'L&F', 1921.5, '2026-09-09', 0, '4174')`).run();
const t4174 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-07', 'FAKTURA 4174', 1921.5, 'B4220', 70)`).run().lastInsertRowid;
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4172', '2026-08-27', 2108.75, 2108.75, '#B4220')`).run();
// Samme mønster — men e-conomic siger 4177 ER betalt. Så var vores betalt-flag rigtigt
// (afstemningen daterede det bare med gættets bankdato), og det må IKKE rulles tilbage.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato, economic_number) VALUES ('B4230', 'X', 1000, '2026-09-10', 1, '2026-09-07', '4177')`).run();
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B4233', 'Y', 1000, '2026-09-09', 0, '4178')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4177', '2026-08-27', 1000, 0, '#B4230')`).run();
const t4178 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-07', 'FAKTURA 4178', 1000, 'B4230', 70)`).run().lastInsertRowid;
// Manuelt match (conf 100) må ALDRIG flyttes, selv om nummeret peger andetsteds
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B5001', 'A', 500, '2026-09-01', 0, '5001')`).run();
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato, economic_number) VALUES ('B5002', 'B', 500, '2026-09-01', 1, '2026-09-02', '5002')`).run();
const t5001 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-02', 'FAKTURA 5001', 500, 'B5002', 100)`).run().lastInsertRowid;
// Overskrift-vejen: bogført 4166 bærer "#B4130" men ingen cf_invoice har nummeret
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES ('B4130', 'UFM', 9060.25, '2026-09-08', 0)`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4166', '2026-08-25', 9620.25, 9620.25, '#B4130')`).run();
const t4166 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-09-07', 'FAKTURA 4166', 9620.25)`).run().lastInsertRowid;
// To-pas: "FAK.NO. 4172" (2108,75) lå som gæt på B4227. Den skal lande på B4220 — som i
// samme kørsel rulles tilbage af 4174-flytningen — og B4220 skal ENDE som betalt.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato) VALUES ('B4227', 'Z', 2105.25, '2026-09-12', 1, '2026-09-07')`).run();
const t4172 = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-07', 'FAK.NO. 4172', 2108.75, 'B4227', 70)`).run().lastInsertRowid;

const m2 = matchByEconomicNumber(db, { dryRun: false });
const txOf = (id) => db.prepare(`SELECT matched_invoice_id inv, match_confidence conf FROM cf_transactions WHERE id = ?`).get(id);
const invOf = (id) => db.prepare(`SELECT betalt, betalt_dato, betalingstype FROM cf_invoices WHERE id = ?`).get(id);
assert(txOf(t4131).inv === 'B4145' && txOf(t4131).conf === 95, `4131 flyttet fra beløbs-gættet B4228 til B4145 (got ${txOf(t4131).inv}/${txOf(t4131).conf})`);
assert(invOf('B4145').betalt === 1 && invOf('B4145').betalt_dato === '2026-09-07', `B4145 markeret betalt på tx-datoen (got ${JSON.stringify(invOf('B4145'))})`);
assert(invOf('B4145').betalt === 1, `beløbstolerancen målte mod e-conomics 2600, ikke bonens 2000`);
assert(invOf('B4228').betalt === 0, `B4228 (kun gæt, aldrig betalt) er urørt`);
assert(txOf(t4174).inv === 'B4223', `4174 flyttet fra forkert auto-betalt B4220 til B4223 (got ${txOf(t4174).inv})`);
assert(invOf('B4223').betalt === 1, `B4223 markeret betalt`);
assert(txOf(t4172).inv === 'B4220' && invOf('B4220').betalt === 1, `B4220: 4174 flyttes væk, men 4172 lander på den — så den forbliver betalt (got ${txOf(t4172).inv}/${JSON.stringify(invOf('B4220'))})`);
assert(invOf('B4227').betalt === 1, `B4227 (uden e-conomic-nr → ukendt dér) rulles IKKE tilbage`);
assert(txOf(t4178).inv === 'B4233' && invOf('B4233').betalt === 1, `4178 flyttet til B4233 og markeret betalt`);
assert(invOf('B4230').betalt === 1 && invOf('B4230').betalt_dato === '2026-09-07', `B4230 IKKE rullet tilbage — e-conomic siger betalt (got ${JSON.stringify(invOf('B4230'))})`);
assert(txOf(t5001).inv === 'B5002' && txOf(t5001).conf === 100, `manuelt match (conf 100) står urørt`);
assert(invOf('B5002').betalt === 1, `manuelt matchet faktura forbliver betalt`);
assert(txOf(t4166).inv === 'B4130' && invOf('B4130').betalt === 1, `4166 koblet via spejlets overskrift "#B4130" og markeret betalt (got ${txOf(t4166).inv})`);
// paid=4: B4220 var betalt i forvejen og forbliver det — 4172 lander på den FØR tilbagerulningen vurderes.
assert(m2.linked === 5 && m2.paid === 4 && m2.moved === 4, `tællere linked=5 paid=4 moved=4 (got ${m2.linked}/${m2.paid}/${m2.moved})`);
// Anden kørsel: idempotent
const m3 = matchByEconomicNumber(db, { dryRun: false });
assert(m3.linked === 0, `anden kørsel kobler intet nyt (got ${m3.linked})`);

console.log('\n— outstandingFigures: aldrig sendte holdes ude, sandsynligt betalte tælles for sig —');
const { outstandingFigures } = require('../routes/cashflow');
// Aldrig sendt = betalt=0, intet e-conomic-nr, ingen kladde på bonen. B4228 har nr → tæller med.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES ('B6001', 'Aldrig sendt', 45000, '2026-09-10', 0)`).run();
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES ('B6002', 'Sendt, gæt i bank', 700, '2026-09-30', 0, '6002')`).run();
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-09', 'Overførsel', 700, 'B6002', 55)`).run();
const before = db.prepare(`SELECT COALESCE(SUM(beloeb),0) t, COUNT(*) c FROM cf_invoices WHERE betalt = 0`).get();
const fig = outstandingFigures(db, '2026-09-15', '2026-10-15');
assert(fig.outstanding.total === before.t - 45000, `udestående udelader den aldrig sendte (got ${fig.outstanding.total}, rå ${before.t})`);
assert(fig.outstanding.count === before.c - 1, `udestående-antal udelader den aldrig sendte`);
assert(fig.likelyPaid.count === 1 && fig.likelyPaid.total === 700, `sandsynligt betalt = det ubekræftede beløbs-gæt (got ${fig.likelyPaid.count}/${fig.likelyPaid.total})`);
// En aldrig sendt faktura MED et bank-gæt: ude af udestående, men med i sandsynligt betalt —
// kortets linje og fanen "Sandsynlig betalt" skal vise samme tal.
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence) VALUES ('2026-09-09', 'OVERFØRSEL', 45004, 'B6001', 55)`).run();
const fig2 = outstandingFigures(db, '2026-09-15', '2026-10-15');
assert(fig2.outstanding.total === fig.outstanding.total, `aldrig sendt tæller stadig ikke i udestående`);
assert(fig2.likelyPaid.count === 2, `…men tæller i sandsynligt betalt, som fanen (got ${fig2.likelyPaid.count})`);
assert(fig.expected30.total <= fig.outstanding.total, `forventet ind ≤ udestående (samme udeladelse)`);

console.log('\n— e-conomic-fakturaer uden kobling: liste + manuel kobling (Derby-casen) —');
const { economicUnlinked, linkEconomicInvoice } = require('../routes/cashflow');
// B4255: event-salgsbon, 7.350 kr, markeret betalt af et FORKERT beløbs-gæt der siden er flyttet
// væk. E-conomic har to åbne fakturaer til den uden bon-nr i overskriften.
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato) VALUES ('B4255', 'Derby', 7350, '2026-09-13', 1, '2026-09-10')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4202', '2026-09-03', 2432, 2432, 'Madbilletter til Derby')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4204', '2026-09-08', 4225, 4225, 'Madbilletter på Derby, Travbanen')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4300', '2026-09-08', 500, 0, 'Betalt og ukoblet')`).run();
let ul = economicUnlinked(db);
assert(ul.some(r => r.booked_no === '4202') && ul.some(r => r.booked_no === '4204'), 'begge Derby-fakturaer står som ukoblede');
assert(!ul.some(r => r.booked_no === '4300'), 'afregnede (remainder 0) vises ikke');
assert(!ul.some(r => r.booked_no === '4131'), 'koblede numre vises ikke');
let lr = linkEconomicInvoice(db, { booked_no: '4202', bon_number: 'B4255' });
const b4255 = () => db.prepare(`SELECT economic_number, beloeb, betalt, betalt_dato, noter FROM cf_invoices WHERE id='B4255'`).get();
assert(lr.ok && !lr.created && lr.invoice_id === 'B4255', `første faktura sættes på bonens egen række (got ${JSON.stringify(lr)})`);
assert(b4255().economic_number === '4202' && b4255().beloeb === 2432, `nummer + e-conomics beløb på B4255 (got ${JSON.stringify(b4255())})`);
assert(b4255().betalt === 0 && lr.unpaid_again === true, 'åben hos e-conomic + ingen bankpostering → ubetalt igen (gættet rulles tilbage)');
assert(/koblet manuelt/.test(b4255().noter || ''), 'sporet står i noterne');
lr = linkEconomicInvoice(db, { booked_no: '4204', bon_number: 'B4255' });
const extra = db.prepare(`SELECT * FROM cf_invoices WHERE economic_number = '4204'`).get();
assert(lr.ok && lr.created && extra && extra.id === '4204', `anden faktura bliver en ekstra række (got ${JSON.stringify(lr)})`);
assert(extra.bon_id === null && extra.beloeb === 4225 && extra.betalt === 0 && extra.kunde === 'Derby', `ekstra række: uden bon_id, e-conomics beløb, ubetalt, bonens kunde (got ${JSON.stringify(extra)})`);
assert(extra.forfald === '2026-09-22', `forfald = fakturadato + 14 dage (got ${extra.forfald})`);
assert(economicUnlinked(db).every(r => !['4202','4204'].includes(r.booked_no)), 'begge er væk fra listen bagefter');
const figD = outstandingFigures(db, '2026-09-15', '2026-10-15');
assert(figD.outstanding.count >= 2, 'de tæller nu som udestående');
lr = linkEconomicInvoice(db, { booked_no: '4204', bon_number: 'B4145' });
assert(lr.error && lr.status === 409, `et nummer kan ikke kobles til to bons (got ${JSON.stringify(lr)})`);
lr = linkEconomicInvoice(db, { booked_no: '9999', bon_number: 'B4255' });
assert(lr.error && lr.status === 404, 'ukendt faktura afvises');
lr = linkEconomicInvoice(db, { booked_no: '4300', bon_number: 'B0000' });
assert(lr.error && lr.status === 404, 'bon uden faktura i pengestrømmen afvises');
// Afregnet hos e-conomic (remainder 0) → kobling markerer betalt
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES ('B4300', 'X', 500, '2026-09-20', 0)`).run();
lr = linkEconomicInvoice(db, { booked_no: '4300', bon_number: 'B4300' });
assert(lr.ok && db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B4300'`).get().betalt === 1, 'afregnet hos e-conomic → betalt ved kobling');
// Bank-match i samme greb: en postering med nummeret i teksten kobles og markerer betalt
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES ('B4310', 'Y', 900, '2026-09-20', 0)`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading) VALUES ('4310', '2026-09-08', 950, 950, 'Uden bon-nr')`).run();
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-09-12', 'FAKTURA 4310', 950)`).run();
lr = linkEconomicInvoice(db, { booked_no: '4310', bon_number: 'B4310' });
assert(lr.bank_paid === 1 && db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B4310'`).get().betalt === 1, `bankposteringen kobles i samme greb (got ${JSON.stringify(lr)})`);

console.log('\n— syncCashflowInvoice: bon-opdatering ruller ikke betalt tilbage, og et bogført beløb står —');
const bon8 = makeBon({ bon_number: 'B1008', status_code: 'FAKTURERET', total_price: 1500 });
syncCashflowInvoice(db, bon8);
db.prepare(`UPDATE cf_invoices SET betalt = 1, betalt_dato = '2026-09-05', economic_number = '7008', beloeb = 1656.25 WHERE id = 'B1008'`).run();
db.prepare(`UPDATE bons SET delivery_price = 100 WHERE id = ?`).run(bon8);   // som en PATCH af bonen
r = syncCashflowInvoice(db, bon8);
const i8 = db.prepare(`SELECT betalt, betalt_dato, beloeb FROM cf_invoices WHERE id = 'B1008'`).get();
assert(r.action === 'updated', `sync kørte (got ${r.action})`);
assert(i8.betalt === 1 && i8.betalt_dato === '2026-09-05', `betalt=1 overlever bon-opdatering (got ${JSON.stringify(i8)})`);
assert(i8.beloeb === 1656.25, `beløbet er e-conomics (1656,25), ikke bonens 1500 (got ${i8.beloeb})`);
const bon9 = makeBon({ bon_number: 'B1009', status_code: 'FAKTURERET', total_price: 800 });
syncCashflowInvoice(db, bon9);
db.prepare(`UPDATE bons SET total_price = 900 WHERE id = ?`).run(bon9);
syncCashflowInvoice(db, bon9);
assert(db.prepare(`SELECT beloeb FROM cf_invoices WHERE id = 'B1009'`).get().beloeb === 900, `uden e-conomic-nr følger beløbet stadig bonen`);

console.log('\n— cfCategorize: triage af "kan ikke matches"-listen —');
const { cfCategorize } = require('../routes/cashflow');
const cat = (tekst, dato, beloeb) => cfCategorize({ tekst, dato, beloeb }, 2025, 3000);
assert(cat('Zettle Michelin', '2026-06-09', 9105) === 'event_cash', 'Zettle → event_cash');
assert(cat('MobilePay: Festival', '2025-07-01', 5000) === 'event_cash', 'MobilePay 2025 → event_cash (historik uanset år)');
assert(cat('FAKTURA 3957', '2026-04-28', 24016) === 'invoice_check', 'faktura 2026 → invoice_check');
assert(cat('FAKTURA 3957', '2025-04-28', 24016) === 'invoice_paid', 'faktura 2025 → invoice_paid (lukket år)');
assert(cat('Fa.nr. 3865', '2026-03-18', 3437) === 'invoice_check', 'Fa.nr. (bred regex) → invoice_check');
assert(cat('3898', '2026-04-13', 59994) === 'invoice_check', 'bart nummer 2026 → invoice_check');
assert(cat('GLADSAXE KOMMUNE', '2026-01-29', 12459) === 'large_check', 'stort uden ref 2026 → large_check');
assert(cat('GLADSAXE KOMMUNE', '2026-01-29', 800) === 'minor', 'lille uden ref → minor');
// Var large_check indtil #445. Nu fanger ordlisten den som event_cash — stadig en
// surface-kategori (intet forsvinder), men med den rigtige handling: "kræver salgsbon".
assert(cat('SLUTAFREGNING RF25', '2025-10-08', 23545) === 'event_cash', 'festivalafregning LUKKET år → event_cash (var large_check før #445)');
assert(cat('AFREGNING FRA HAVNEN', '2025-10-08', 500) === 'event_cash', 'lille festivalafregning surfacer også — beløbet afgør ikke');
assert(cat('Overførsel', '2026-05-01', 30000) === 'large_check', 'stor overførsel uden nr → large_check (kan være faktura ELLER event)');
assert(cat('Overførsel', '2025-05-01', 30000) === 'large_check', 'stor overførsel 2025 → large_check (se på store 2025-beløb)');
assert(cat('Overførsel', '2025-05-01', 800) === 'minor', 'lille overførsel → minor (støj)');
assert(cat('LEVERANDØR: 9026793', '2025-01-05', 30768) === 'large_check', 'stor leverandør-ref → large_check');

// Genkendelse mod bogførte e-conomic-fakturanumre (cf_economic_invoices-spejl)
const booked = new Set(['3700', '4112']);
const catB = (tekst, dato, beloeb) => cfCategorize({ tekst, dato, beloeb }, 2025, 3000, booked);
assert(catB('FAKTURA 3700', '2026-04-01', 5000) === 'invoice_paid', '2026-faktura med RIGTIGT bogført nr → invoice_paid (afregnet)');
assert(catB('FAK 4112, REBEL FOOD', '2026-06-26', 137092) === 'invoice_paid', 'samlefaktura-nr findes bogført → invoice_paid (uanset bon-beløb)');
assert(catB('FAKTURA 9999', '2026-04-01', 5000) === 'invoice_check', '2026-faktura med UKENDT nr → invoice_check (ægte undtagelse)');
assert(catB('FAKTURA 9999', '2025-04-01', 5000) === 'invoice_paid', 'ukendt nr men lukket år → invoice_paid (fold)');

// Cleanup
db.close();
fs.unlinkSync(TMP);
['-shm', '-wal'].forEach(s => {
    const p = TMP + s;
    if (fs.existsSync(p)) fs.unlinkSync(p);
});


console.log('\n— Interne overførsler (#445) —');
// "Mellemregning LZ" er flytning mellem egne konti, ikke en indbetaling. Beløbet
// er stort (12-15 kkr), så uden reglen ville en indgående lande i "store ukoblede".
const catI = (tekst, dato, beloeb) => cfCategorize({ tekst, dato, beloeb }, 2025, 10000, new Set(['4112']));
assert(catI('Mellemregning LZ', '2026-03-18', 15000) === 'minor', 'Mellemregning → foldes uanset beløb');
assert(catI('MELLEMREGNING', '2026-03-18', 90000) === 'minor', 'stor mellemregning foldes også');
assert(catI('Overførsel egen konto', '2026-03-18', 40000) === 'minor', 'egen konto → foldes');
assert(catI('FAKTURA 4112 mellemregning', '2026-03-18', 40000) === 'invoice_paid', 'fakturanr slår intern-ordet');
assert(catI('Mellemhandel Grossist', '2026-03-18', 40000) === 'large_check', 'ligner men er det ikke — urørt');

console.log('\n— Festival-afregning (#445) —');
// Festivalafregning kommer som en almindelig overførsel: ingen Zettle, ingen
// MobilePay, intet fakturanr. Uden ordlisten landede 110.854 kr fra Vig i
// "store ukoblede" og 🎪-chippen stod på 0.
const catF = (tekst, dato, beloeb) => cfCategorize({ tekst, dato, beloeb }, 2025, 10000, new Set(['4112']));
assert(catF('AFREGN. VIG FESTIVAL', '2026-07-16', 110854) === 'event_cash', 'AFREGN. VIG FESTIVAL → event_cash');
assert(catF('SLUTAFREGNING RF25', '2025-10-08', 23545) === 'event_cash', 'SLUTAFREGNING RF25 → event_cash (også lukket år)');
assert(catF('Stadeleje retur', '2026-07-20', 4000) === 'event_cash', 'stade → event_cash');
// Fakturanr vinder over festivalordet — ellers ville en samlefaktura for et
// festivalsalg blive taget for kontantsalg.
assert(catF('FAK 4112, AFREGNING FESTIVAL', '2026-06-26', 137092) === 'invoice_paid', 'fakturanr slår festivalordet');
assert(catF('FAKTURA 9999 afregning', '2026-06-26', 50000) === 'invoice_check', 'ukendt fakturanr → invoice_check, ikke event');
// Ordlisten må ikke sluge almindelige indbetalinger
assert(catF('ALBERTSLUND KOMMUNE', '2026-07-06', 5774) === 'minor', 'kommune uden nøgleord → uændret');
assert(catF('Overførsel', '2026-07-09', 22518) === 'large_check', 'Overførsel → stadig large_check');

console.log(`\n══════════════\n${pass} PASS · ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
