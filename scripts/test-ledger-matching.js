// scripts/test-ledger-matching.js
// ═══════════════════════════════════════════════════════════════════════════
// Verificerer matchByLedgerPayment + ledgerHints mod isoleret test-DB.
//
// Det farlige her er ikke de match den finder, men dem den IKKE må finde: en
// bankline uden fakturanummer kan kun kobles trygt når posteringen er entydig.
// Halvdelen af testene handler derfor om at holde fingrene væk.
//
// Køres med: node --experimental-sqlite scripts/test-ledger-matching.js
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const ledger = require('../services/economicLedger');

const TMP = path.join(__dirname, '..', 'data', 'test-ledger-matching.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
runMigrations(TMP);
const db = openDb(TMP);

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
}

let seq = 0;
const payment = (date, amount, invNo, cust = '100') => db.prepare(
    `INSERT INTO cf_economic_payments (entry_number, entry_date, amount, invoice_number, customer_number)
     VALUES (?, ?, ?, ?, ?)`).run(++seq, date, -amount, invNo == null ? null : String(invNo), cust);
const invoice = (id, ecoNo) => db.prepare(
    `INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number)
     VALUES (?, 'Kunde', 1000, '2026-01-01', 0, ?)`).run(id, ecoNo == null ? null : String(ecoNo));
const tx = (dato, beloeb, tekst = 'Overførsel') => db.prepare(
    `INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES (?, ?, ?)`).run(dato, tekst, beloeb).lastInsertRowid;
const txRow = (id) => db.prepare(`SELECT matched_invoice_id, match_confidence FROM cf_transactions WHERE id = ?`).get(id);

console.log('\n— Kobler når posteringen er entydig —');
invoice('B100', 4001);
payment('2026-03-10', 5000, 4001);
const t1 = tx('2026-03-10', 5000, 'OVERFØRSEL');          // ingen fakturanr i teksten
let r = ledger.matchByLedgerPayment(db, { dryRun: true });
assert(r.linked === 1, `1 kobling (fik ${r.linked})`);
assert(txRow(t1).matched_invoice_id === null, 'dryRun skriver ikke');
r = ledger.matchByLedgerPayment(db);
assert(txRow(t1).matched_invoice_id === 'B100', 'koblet til B100 selv om teksten intet nummer bar');
assert(txRow(t1).match_confidence === 95, 'conf 95 — kilden er e-conomics egen kobling');

console.log('\n— Idempotent —');
r = ledger.matchByLedgerPayment(db);
assert(r.linked === 0, 'anden kørsel kobler intet nyt');

console.log('\n— Forkert dag kobles IKKE —');
invoice('B200', 4002);
payment('2026-04-01', 7000, 4002);
const t2 = tx('2026-04-03', 7000);                         // 2 dage efter
ledger.matchByLedgerPayment(db);
assert(txRow(t2).matched_invoice_id === null, 'samme dag er kravet — ±2 dage er ikke godt nok');

console.log('\n— Forkert beløb kobles IKKE —');
invoice('B300', 4003);
payment('2026-05-01', 9000, 4003);
const t3 = tx('2026-05-01', 9100);
ledger.matchByLedgerPayment(db);
assert(txRow(t3).matched_invoice_id === null, '100 kr fra er ikke et match');

console.log('\n— Flertydigt kobles IKKE —');
invoice('B400', 4004); invoice('B401', 4005);
payment('2026-06-01', 3000, 4004);
payment('2026-06-01', 3000, 4005);                         // to betalinger, samme dag, samme beløb
const t4 = tx('2026-06-01', 3000);
ledger.matchByLedgerPayment(db);
assert(txRow(t4).matched_invoice_id === null, 'to kandidater → vi gætter ikke');

console.log('\n— Afregnet, men ikke vores faktura —');
payment('2026-07-01', 4500, 3899);                         // ingen cf_invoice med det nummer
const t5 = tx('2026-07-01', 4500, 'BETALING FRA KK');
r = ledger.matchByLedgerPayment(db);
assert(r.settledNotOurs === 1, `1 afregnet-men-ikke-vores (fik ${r.settledNotOurs})`);
assert(txRow(t5).matched_invoice_id === null, 'ikke koblet — der er intet at koble til');
let hints = ledger.ledgerHints(db);
assert(hints.get(t5)?.kind === 'settled', 'markeres som afregnet');
assert(hints.get(t5)?.invoices[0] === '3899', 'fakturanummeret navngives, så det kan slås op');

console.log('\n— Samlebetaling: én kundes fakturaer samme dag —');
payment('2026-08-01', 1000, 4010, '500');
payment('2026-08-01', 2000, 4011, '500');
payment('2026-08-01', 3000, 4012, '500');
const t6 = tx('2026-08-01', 6000, 'LEVERANDØR: 9026793');
ledger.matchByLedgerPayment(db);
assert(txRow(t6).matched_invoice_id === null, 'en samlebetaling kobles ALDRIG automatisk');
hints = ledger.ledgerHints(db);
assert(hints.get(t6)?.kind === 'aggregate', 'genkendt som samlebetaling');
assert(hints.get(t6)?.invoices.length === 3, `3 fakturaer navngivet (fik ${hints.get(t6)?.invoices.length})`);

console.log('\n— To kunder rammer samme sum → ingen forklaring —');
payment('2026-09-01', 1500, 4020, '600');
payment('2026-09-01', 2500, 4021, '600');
payment('2026-09-01', 1500, 4030, '700');
payment('2026-09-01', 2500, 4031, '700');
const t7 = tx('2026-09-01', 4000);
hints = ledger.ledgerHints(db);
assert(!hints.has(t7), 'to kunder passer lige godt → vi peger ikke på nogen af dem');

console.log('\n— Delmængde der tilfældigvis summer er IKKE en samlebetaling —');
// Én kundes tre betalinger; to af dem rammer beløbet. Kunde-reglen ser på
// kundens SAMLEDE dag, ikke på delmængder — derfor intet vink.
payment('2026-10-01', 1000, 4040, '800');
payment('2026-10-01', 2000, 4041, '800');
payment('2026-10-01', 9000, 4042, '800');
const t8 = tx('2026-10-01', 3000);
hints = ledger.ledgerHints(db);
assert(!hints.has(t8), 'ingen delmængdegætteri');

console.log('\n— Samlebetaling findes selv når 1:1 er flertydigt —');
// To enkeltbetalinger på 3.000 (flertydigt → ingen 1:1) OG én kunde hvis to
// regninger tilsammen giver 3.000. Kun den sidste er en samlebetaling; de to
// første er enkeltbetalinger og må ikke kaldes det. Det er dét COUNT(*) > 1
// står for — uden det ville alle tre grupper melde sig, og vinket forsvinde.
payment('2026-10-15', 3000, 4080, '900');
payment('2026-10-15', 3000, 4081, '901');
payment('2026-10-15', 1000, 4082, '902');
payment('2026-10-15', 2000, 4083, '902');
const t12 = tx('2026-10-15', 3000);
hints = ledger.ledgerHints(db);
assert(hints.get(t12)?.kind === 'aggregate', 'kunde 902s to regninger genkendes trods flertydig 1:1');
assert(hints.get(t12)?.customer_number === '902', `peger på den rigtige kunde (fik ${hints.get(t12)?.customer_number})`);
ledger.matchByLedgerPayment(db);
assert(txRow(t12).matched_invoice_id === null, 'stadig ikke automatisk koblet');

console.log('\n— Ignorerede og allokerede posteringer røres ikke —');
invoice('B500', 4050);
payment('2026-11-01', 8000, 4050);
const t9 = tx('2026-11-01', 8000);
db.prepare(`UPDATE cf_transactions SET ignored = 1 WHERE id = ?`).run(t9);
r = ledger.matchByLedgerPayment(db);
assert(txRow(t9).matched_invoice_id === null, 'ignoreret postering springes over');

invoice('B600', 4060);
payment('2026-12-01', 5500, 4060);
const t10 = tx('2026-12-01', 5500);
db.prepare(`INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount) VALUES (?, 'bon', '1', 5500)`).run(t10);
ledger.matchByLedgerPayment(db);
assert(txRow(t10).matched_invoice_id === null, 'fuldt allokeret postering er allerede håndteret');

console.log('\n— Udgående posteringer er ikke indbetalinger —');
invoice('B700', 4070);
payment('2027-01-05', 2200, 4070);
const t11 = tx('2027-01-05', -2200, 'UDBETALING');
ledger.matchByLedgerPayment(db);
assert(txRow(t11).matched_invoice_id === null, 'negativt beløb er ikke en indbetaling');

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
db.close();
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
process.exit(fail ? 1 : 0);
