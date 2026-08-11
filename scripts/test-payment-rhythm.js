// scripts/test-payment-rhythm.js
// ═══════════════════════════════════════════════════════════════════════════
// Verificerer services/paymentRhythm mod isoleret test-DB.
//
// Det farlige ved denne funktion er ikke matematikken, men HVILKE observationer
// den lærer af. To fælder testes eksplicit:
//   1. `betalt_dato` er for 2.539 af 2.842 betalte fakturaer lig LEVERINGSDATOEN
//      (sat af cashflowSync ved BETALT) — den må aldrig tælle med.
//   2. Auto-matcherens 50-80-tier scorer på nærhed til forfaldsdatoen. Lærer man
//      timing af den, lærer man kun at folk betaler til tiden.
//
// Køres med: node --experimental-sqlite scripts/test-payment-rhythm.js
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');
const rhythm = require('../services/paymentRhythm');

const TMP = path.join(__dirname, '..', 'data', 'test-payment-rhythm.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
runMigrations(TMP);
const db = openDb(TMP);

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
}

let seq = 0;
/** Opret en betalt faktura + den bankpostering der betalte den. */
function paid(kunde, forfald, betaltDato, conf) {
    const id = `I${++seq}`;
    db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, betalt_dato)
                VALUES (?, ?, 1000, ?, 1, ?)`).run(id, kunde, forfald, betaltDato);
    if (conf != null) {
        db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id, match_confidence)
                    VALUES (?, ?, 1000, ?, ?)`).run(betaltDato, `betaling ${id}`, id, conf);
    }
    return id;
}
/** Betalt faktura koblet af et menneske (allokering) i stedet for auto-match. */
function paidByAllocation(kunde, forfald, betaltDato) {
    const id = paid(kunde, forfald, betaltDato, null);
    const tx = db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES (?, ?, 1000)`)
        .run(betaltDato, `manuel ${id}`);
    db.prepare(`INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount)
                VALUES (?, 'invoice', ?, 1000)`).run(tx.lastInsertRowid, id);
    return id;
}
const fresh = () => (rhythm.invalidate(), rhythm.getDelays(db, { fresh: true }));

console.log('\n— Lærer af fakturanr-match (conf 95) —');
// Kommune der konsekvent betaler ~20 dage efter fristen
paid('Kommunen', '2026-01-15', '2026-02-04', 95);   // +20
paid('Kommunen', '2026-02-15', '2026-03-08', 95);   // +21
paid('Kommunen', '2026-03-15', '2026-04-02', 95);   // +18
let d = fresh();
assert(d.get('Kommunen')?.days === 20, `Kommunen → +20 dage (fik ${d.get('Kommunen')?.days})`);
assert(d.get('Kommunen')?.n === 3, `3 observationer (fik ${d.get('Kommunen')?.n})`);

console.log('\n— Under mindstekravet → ingen justering —');
paid('Sjælden Kunde', '2026-01-15', '2026-02-14', 95);   // +30, men kun 1 måling
paid('Sjælden Kunde', '2026-02-15', '2026-03-17', 95);   // +30, nu 2
d = fresh();
assert(!d.has('Sjælden Kunde'), '2 observationer er ikke nok — et gæt er værre end intet');

console.log('\n— Tidsscorede matches må IKKE lære os om timing —');
// conf 80 gives netop FORDI betalingen lå tæt på forfald. Lærer vi af den, lærer
// vi kun at folk betaler til tiden — og en sen betaling uden fakturanr får conf 40
// og registreres slet ikke, så de langsomme ville være usynlige.
paid('Tidsmatchet', '2026-01-15', '2026-01-16', 80);
paid('Tidsmatchet', '2026-02-15', '2026-02-16', 80);
paid('Tidsmatchet', '2026-03-15', '2026-03-16', 80);
paid('Tidsmatchet', '2026-04-15', '2026-04-16', 55);
d = fresh();
assert(!d.has('Tidsmatchet'), 'conf 55/80 tæller ikke med (cirkulært)');

console.log('\n— betalt_dato uden bankpostering ignoreres —');
// cashflowSync sætter betalt_dato = delivery_date når bonnen går til BETALT.
// Det er ikke en betalingsdato. 2.539 af 2.842 rækker i drift ser sådan ud.
paid('Statusbetalt', '2026-01-15', '2026-01-02', null);
paid('Statusbetalt', '2026-02-15', '2026-02-02', null);
paid('Statusbetalt', '2026-03-15', '2026-03-02', null);
d = fresh();
assert(!d.has('Statusbetalt'), 'faktura uden bankpostering lærer os intet');

console.log('\n— Manuel allokering tæller (menneskeskabt, ikke tidsscoret) —');
paidByAllocation('Manuelt Koblet', '2026-01-15', '2026-02-04');   // +20
paidByAllocation('Manuelt Koblet', '2026-02-15', '2026-03-07');   // +20
paidByAllocation('Manuelt Koblet', '2026-03-15', '2026-04-04');   // +20
d = fresh();
assert(d.get('Manuelt Koblet')?.days === 20, `allokering lærer +20 (fik ${d.get('Manuelt Koblet')?.days})`);

console.log('\n— Median, ikke gennemsnit —');
// Indsat i den værste rækkefølge med vilje: en median der ikke sorterer først
// ville ramme +90 her, og en enkelt sovende bogholder ville parkere alle kundens
// fremtidige fakturaer tre måneder ude.
paid('Enkelt Skævert', '2026-03-15', '2026-06-13', 95);   // +90 (bogholderiet sov)
paid('Enkelt Skævert', '2026-01-15', '2026-01-17', 95);   // +2
paid('Enkelt Skævert', '2026-02-15', '2026-02-18', 95);   // +3
d = fresh();
assert(d.get('Enkelt Skævert')?.days === 3, `median 3, ikke gennemsnit 32 (fik ${d.get('Enkelt Skævert')?.days})`);

// SQLites UNION dedupliserer via en temp-B-tree og leverer derfor rækkerne
// sorteret. Sorteringen i median() kan altså ikke provokeres frem gennem
// SQL-stien — den testes direkte, ellers ser den ud som død kode indtil den
// dag forespørgslen laves om til UNION ALL og rækkefølgen ikke længere holder.
assert(rhythm.median([90, 2, 3]) === 3, 'median sorterer selv (usorteret input)');
assert(rhythm.median([4, 1, 3, 2]) === 2.5, 'lige antal → gennemsnit af de to midterste');

console.log('\n— Kun senere, aldrig tidligere —');
paid('Hurtigbetaler', '2026-01-15', '2026-01-05', 95);   // −10
paid('Hurtigbetaler', '2026-02-15', '2026-02-05', 95);   // −10
paid('Hurtigbetaler', '2026-03-15', '2026-03-05', 95);   // −10
d = fresh();
assert(!d.has('Hurtigbetaler'), 'tidlig betaling gør ikke en sprunget frist mindre sprunget');

console.log('\n— Loft —');
for (const [f, b] of [['2026-01-15','2026-05-15'],['2026-02-15','2026-06-15'],['2026-03-15','2026-07-15']]) paid('Ekstrem', f, b, 95);
d = fresh();
assert(d.get('Ekstrem')?.days === rhythm.MAX_SHIFT_DAYS, `klampet til ${rhythm.MAX_SHIFT_DAYS} dage (fik ${d.get('Ekstrem')?.days})`);

console.log('\n— annotate: forventet dag + sen-for-denne-kunde —');
const rows = [
    { id: 'A', kunde: 'Kommunen',     forfald: '2026-05-01', betalt: 0 },   // +20 → forventet 21/5
    { id: 'B', kunde: 'Ukendt Kunde', forfald: '2026-05-01', betalt: 0 },   // ingen rytme
];
rhythm.annotate(db, rows, '2026-05-15');
assert(rows[0].expected_date === '2026-05-21', `Kommunen forventet 21/5 (fik ${rows[0].expected_date})`);
assert(rows[0].late_for_customer === 0, '14/5 forfalden på papiret, men ikke sen for kommunen');
assert(rows[1].expected_date === '2026-05-01', 'uden rytme = forfaldsdatoen uændret');
assert(rows[1].late_for_customer === 1, 'ukendt kunde er sen med det samme');
rhythm.annotate(db, rows, '2026-05-25');
assert(rows[0].late_for_customer === 1, '25/5 er kommunen sen selv efter sin egen rytme');
assert(rows[0].days_past_expected === 4, `4 dage forbi forventet (fik ${rows[0].days_past_expected})`);

console.log('\n— forfald røres aldrig —');
assert(rows[0].forfald === '2026-05-01', 'den juridiske frist er urørt');

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
db.close();
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP + s)) fs.unlinkSync(TMP + s);
process.exit(fail ? 1 : 0);
