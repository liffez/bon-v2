// scripts/test-economic-ledger.js
// ═══════════════════════════════════════════════════════════════════════════
// Verificerer services/economicLedger + rytmens brug af posteringerne, mod en
// isoleret test-DB med attrap-adapter — ingen netværk, ingen rigtige tokens.
//
// Køres med: node --experimental-sqlite scripts/test-economic-ledger.js
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const eco = require('../services/economicAdapter');
const ledger = require('../services/economicLedger');
const rhythm = require('../services/paymentRhythm');

const TMP = path.join(__dirname, '..', 'data', 'test-economic-ledger.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
runMigrations(TMP);
const db = openDb(TMP);

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
}

/* ── Attrap ──────────────────────────────────────────────────────────────── */
// closed-flaget kommer fra e-conomic; det er dét der afgør om et år genhentes.
let YEARS = [
    { year: '2015/2016', closed: true,  slug: '2015_6_2016' },
    { year: '2025',      closed: true,  slug: '2025' },
    { year: '2026',      closed: false, slug: '2026' },
];
let ENTRIES = {};              // år → posteringer
let FAIL_403 = false;
const calls = [];
eco.rest = async (p) => {
    calls.push(p);
    if (FAIL_403) { const e = new Error('403'); e.status = 403; throw e; }
    if (p.startsWith('/accounting-years?')) return { collection: YEARS.map(y => ({
        year: y.year, closed: y.closed,
        entries: `https://restapi.e-conomic.com/accounting-years/${y.slug}/entries`,
    })) };
    const m = p.match(/^\/accounting-years\/([^/?]+)\/entries/);
    // Nøglen er SLUGGEN, ikke årets navn — attrappen efterligner at "2015/2016"
    // hedder "2015_6_2016" i stien, hvilket var den fejl der væltede første kørsel.
    if (m) { const y = YEARS.find(v => v.slug === m[1]); return { collection: (y && ENTRIES[y.year]) || [], pagination: {} }; }
    throw new Error('uventet sti: ' + p);
};
const entry = (n, { type = 'customerPayment', date = '2026-02-01', amount = -1000, inv = null, cust = '7', text = '' } = {}) => ({
    entryNumber: n, entryType: type, date, amount, amountInBaseCurrency: amount,
    invoiceNumber: inv == null ? null : Number(inv),
    customer: cust ? { customerNumber: Number(cust) } : undefined,
    text, voucherNumber: 100 + n,
});

const rows = () => db.prepare('SELECT * FROM cf_economic_payments ORDER BY entry_number').all();
const meta = (k) => db.prepare('SELECT value FROM cf_meta WHERE key = ?').get(k)?.value || null;

async function main() {

console.log('\n— Kun betalingsposteringer spejles —');
ENTRIES = { '2026': [
    entry(1, { inv: 4001, date: '2026-02-10', amount: -1500 }),
    entry(2, { type: 'customerInvoice', inv: 4001, date: '2026-01-10', amount: 1500 }),
    entry(3, { type: 'reminder', date: '2026-02-05' }),
    entry(4, { type: 'financeVoucher', date: '2026-02-05' }),
], '2025': [], '2015/2016': [] };
let r = await ledger.syncPayments(db, {});
assert(r.available === true, 'tilgængelig');
assert(r.payments === 1, `1 betaling af 4 posteringer (fik ${r.payments})`);
assert(rows().length === 1, 'kun betalingen er skrevet');
assert(rows()[0].invoice_number === '4001', 'fakturanr gemt som tekst (matcher economic_number)');
assert(rows()[0].amount === -1500, 'beløb gemt med fortegn (negativt = modtaget)');

console.log('\n— Idempotens: samme kørsel igen ændrer intet —');
const before = rows().length;
r = await ledger.syncPayments(db, {});
assert(rows().length === before, `stadig ${before} række(r)`);

console.log('\n— Opdatering: e-conomic retter en postering —');
ENTRIES['2026'][0] = entry(1, { inv: 4001, date: '2026-02-12', amount: -1600 });
await ledger.syncPayments(db, {});
assert(rows()[0].entry_date === '2026-02-12' && rows()[0].amount === -1600, 'rækken opdateres, ikke duplikeres');
assert(rows().length === 1, 'stadig én række');

console.log('\n— Vandmærke: kolde år hentes én gang, varme hver gang —');
// 2015/2016 og 2025 er LUKKEDE; 2026 er åbent.
ENTRIES['2015/2016'] = [entry(10, { inv: 3001, date: '2015-05-01' })];
await ledger.syncPayments(db, {});
assert(meta('economic_entries_year_2015/2016') != null, 'lukket år markeret hentet');
calls.length = 0;
r = await ledger.syncPayments(db, {});
assert(r.skippedYears.includes('2015/2016') && r.skippedYears.includes('2025'),
    `lukkede år springes over (fik ${JSON.stringify(r.skippedYears)})`);
assert(r.years.length === 1 && r.years[0] === '2026', 'kun det ÅBNE år hentes igen');
assert(!calls.some(c => c.includes('2015_6_2016')), 'der kaldes ikke ud for et lukket år');
assert(calls.some(c => c.includes('/2026/entries')), 'det åbne år hentes via API-linket');

console.log('\n— full: ignorér vandmærket —');
calls.length = 0;
r = await ledger.syncPayments(db, { full: true });
assert(r.years.length === 3 && r.skippedYears.length === 0, 'alle år hentes ved full');
assert(calls.some(c => c.includes('2015_6_2016/entries')), 'slug-året hentes på sin RIGTIGE sti, ikke "2015%2F2016"');

console.log('\n— dryRun skriver ikke —');
ENTRIES['2026'].push(entry(99, { inv: 4099, date: '2026-03-01' }));
const n0 = rows().length;
r = await ledger.syncPayments(db, { dryRun: true });
assert(r.payments > 0 && rows().length === n0, 'talt op, men intet skrevet');

console.log('\n— Manglende Bookkeeping-rolle er en tilstand, ikke en fejl —');
FAIL_403 = true;
r = await ledger.syncPayments(db, {});
assert(r.available === false && r.reason === 'missing_bookkeeping_role', '403 → available:false, kaster ikke');
FAIL_403 = false;

console.log('\n— Delbetalinger: sidste dato tæller —');
db.prepare('DELETE FROM cf_economic_payments').run();
ENTRIES['2026'] = [
    entry(20, { inv: 5000, date: '2026-01-10', amount: -500 }),
    entry(21, { inv: 5000, date: '2026-03-20', amount: -500 }),
    entry(22, { inv: 5001, date: '2026-01-15', amount: -900 }),
];
await ledger.syncPayments(db, { full: true });
const byInv = ledger.paymentByInvoice(db);
assert(byInv.get('5000').date === '2026-03-20', `sidste betaling afgør (fik ${byInv.get('5000').date})`);
assert(byInv.get('5000').n === 2, '2 delbetalinger talt');
assert(byInv.get('5000').amount === 1000, 'modtaget beløb summeret positivt');

console.log('\n— Rytmen lærer af posteringerne —');
db.prepare(`INSERT INTO companies (name) VALUES ('Hospitalet')`).run();
const mkInv = (id, eco_no, forfald) => db.prepare(
    `INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, economic_number) VALUES (?, 'Hospitalet', 1000, ?, 1, ?)`
).run(id, forfald, eco_no);
db.prepare('DELETE FROM cf_economic_payments').run();
// Tre fakturaer, alle betalt 20 dage efter forfald — kun kendt via posteringerne
ENTRIES['2026'] = [
    entry(30, { inv: 6001, date: '2026-01-21' }),
    entry(31, { inv: 6002, date: '2026-02-20' }),
    entry(32, { inv: 6003, date: '2026-03-22' }),
];
await ledger.syncPayments(db, { full: true });
mkInv('R1', '6001', '2026-01-01');
mkInv('R2', '6002', '2026-01-31');
mkInv('R3', '6003', '2026-03-02');
rhythm.invalidate();
let d = rhythm.getDelays(db, { fresh: true });
assert(d.get('Hospitalet')?.days === 20, `Hospitalet → +20 dage fra posteringerne (fik ${d.get('Hospitalet')?.days})`);
assert(d.get('Hospitalet')?.n === 3, `3 observationer (fik ${d.get('Hospitalet')?.n})`);

console.log('\n— Én observation pr. faktura, selv med to kilder —');
// Samme faktura R1 får OGSÅ et bankmatch, med en dato der afviger 2 dage.
// Uden rangeringen ville den tælle to gange og trække medianen.
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence)
            VALUES ('2026-01-23', 'FAKTURA 6001', 1000, 'R1', 95)`).run();
rhythm.invalidate();
d = rhythm.getDelays(db, { fresh: true });
assert(d.get('Hospitalet')?.n === 3, `stadig 3 observationer, ikke 4 (fik ${d.get('Hospitalet')?.n})`);
assert(d.get('Hospitalet')?.days === 20, 'posteringen vinder over bankmatchet — medianen er uændret');

console.log('\n— Faktura uden economic_number lærer os intet fra posteringerne —');
db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES ('R9', 'Uden nr', 1000, '2026-01-01', 1)`).run();
rhythm.invalidate();
d = rhythm.getDelays(db, { fresh: true });
assert(!d.has('Uden nr'), 'ingen kobling → ingen rytme');

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
}

main().then(() => {
    db.close();
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
    process.exit(fail ? 1 : 0);
}).catch(err => { console.error('\nTesten kastede:', err); process.exit(1); });
