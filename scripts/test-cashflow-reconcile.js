// scripts/test-cashflow-reconcile.js
// ═══════════════════════════════════════════════════════════════════════════
// Verificerer e-conomic-afstemningen (services/cashflowReconcile.reconcile) mod
// en isoleret test-DB med en attrap-adapter — ingen netværk, ingen rigtige tokens.
//
// Kernen der testes er #320: betalt-status skal komme fra den FULDE ubetalte
// liste, ikke fra det vandmærke-filtrerede booked-scan. Regressionen er case 1:
// en faktura udstedt FØR vandmærket, som er blevet betalt siden — den kommer
// aldrig med i booked-scanningen og blev derfor stående som forfalden for evigt.
//
// Køres med: node --experimental-sqlite scripts/test-cashflow-reconcile.js
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');
const { runMigrations } = require('../db/migrate');

// Attrap FØR reconcile bruger den (eco.rest slås op ved kaldet, så patch virker)
const eco = require('../services/economicAdapter');
const { reconcile } = require('../services/cashflowReconcile');

const TMP = path.join(__dirname, '..', 'data', 'test-cashflow-reconcile.db');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(TMP + suffix)) fs.unlinkSync(TMP + suffix);
runMigrations(TMP);
const db = openDb(TMP);

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else      { fail++; console.log(`  ✗ ${label}`); }
}

/* ── Attrap-adapter ──────────────────────────────────────────────────────── */
let UNPAID = [];     // hvad /invoices/unpaid svarer
let BOOKED = [];     // hvad /invoices/booked svarer
let UNPAID_REPORTED = null;   // pagination.results — sættes for at teste guarden
const calls = [];
eco.rest = async (path) => {
    calls.push(path);
    if (path.startsWith('/invoices/unpaid')) {
        return { collection: UNPAID, pagination: { results: UNPAID_REPORTED ?? UNPAID.length } };
    }
    if (path.startsWith('/invoices/booked')) {
        return { collection: BOOKED, pagination: { results: BOOKED.length } };
    }
    throw new Error('uventet sti: ' + path);
};

const inv = (no, { heading = '', remainder = 0, date = '2026-06-01', due = '2026-06-15', gross = 1000 } = {}) => ({
    bookedInvoiceNumber: Number(no), date, dueDate: due,
    grossAmount: gross, remainder, notes: { heading },
});

/* ── Seed: bons + cf_invoices ────────────────────────────────────────────── */
const co = db.prepare(`INSERT INTO companies (name) VALUES ('Test Firma A/S')`).run();
const cu = db.prepare(`INSERT INTO customers (company_id, first_name, last_name) VALUES (?, 'Anne', 'Andersen')`).run(co.lastInsertRowid);
const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code).id;
function makeBon(num) {
    return db.prepare(`INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date,
        total_price, payment_type, customer_id, company_id) VALUES (?, ?, 1, '2026-05-01', '2026-05-15', 1000, 'invoice', ?, ?)`)
        .run(num, statusId('FAKTURERET'), cu.lastInsertRowid, co.lastInsertRowid).lastInsertRowid;
}
function makeInvoice(id, { betalt = 0, ecoNo = null, beloeb = 1000, forfald = '2026-06-15' } = {}) {
    const bonId = makeBon(id);
    db.prepare(`INSERT INTO cf_invoices (id, bon_id, kunde, beloeb, forfald, betalt, economic_number)
                VALUES (?, ?, 'Test Firma A/S', ?, ?, ?, ?)`).run(id, bonId, beloeb, forfald, betalt, ecoNo);
    return bonId;
}
const betalt = (id) => db.prepare(`SELECT betalt, betalt_dato FROM cf_invoices WHERE id = ?`).get(id);
const mirrorRow = (no) => db.prepare(`SELECT * FROM cf_economic_invoices WHERE booked_no = ?`).get(String(no));

// Gammel, betalt siden sidst — kernen i #320. Faktura 4078 er udstedt i juni,
// vandmærket står i juli, så den kommer ALDRIG med i booked-scanningen igen.
makeInvoice('B4049', { ecoNo: '4078' });
// Åben hos e-conomic → skal blive stående som ubetalt
makeInvoice('B4081', { ecoNo: '4095', beloeb: 12128 });
// Vi siger betalt, e-conomic siger åben → uenighed, men vi flipper ikke tilbage
makeInvoice('B4118', { betalt: 1, ecoNo: '4123' });
// Nummer der slet ikke findes hos e-conomic → skal ikke røres
makeInvoice('B9999', { ecoNo: '8888' });
// Uden nummer → uden for betalt-aksen
makeInvoice('B7000');

// Spejl som en tidligere kørsel ville have efterladt det: fastfrossen remainder
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4078', '2026-06-11', 1242, 1242, '4049')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4095', '2026-06-19', 12775, 12775, '4081')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4123', '2026-07-02', 1111, 1111, '4118')`).run();
db.prepare(`INSERT OR REPLACE INTO cf_meta (key, value) VALUES ('economic_booked_until', '2026-07-14')`).run();

async function main() {

/* ══ 1. Fuld tilstand retter den gamle, betalte faktura ══════════════════ */
console.log('\n— Fuld tilstand: betalt-status uafhængig af vandmærket —');
UNPAID = [inv('4095', { heading: '4081', remainder: 12128, date: '2026-06-19' }),
          inv('4123', { heading: '4118', remainder: 1059, date: '2026-07-02' })];
BOOKED = [];                                   // intet nyt siden vandmærket
let r = await reconcile(db, { dryRun: true });

assert(r.openInEconomic === 2, `2 åbne hos e-conomic (fik ${r.openInEconomic})`);
assert(r.openInEconomicTotal === 13187, `åbent restbeløb 13.187 kr (fik ${r.openInEconomicTotal})`);
assert(r.flipped === 1, `1 faktura rettes til betalt (fik ${r.flipped})`);
assert(r.changes[0]?.cf_id === 'B4049', `det er B4049 der rettes (fik ${r.changes[0]?.cf_id})`);
assert(r.scanned === 0, 'booked-scanningen er tom — flippet kom IKKE derfra');
assert(betalt('B4049').betalt === 0, 'dry-run skriver ikke');

/* ══ 2. Åbne fakturaer røres ikke ════════════════════════════════════════ */
console.log('\n— Åbne fakturaer og uenigheder —');
assert(!r.changes.some(c => c.cf_id === 'B4081'), 'B4081 er åben hos e-conomic → ikke flippet');
assert(r.conflicts === 1, `1 uenighed (fik ${r.conflicts})`);
assert(r.conflictRows[0]?.cf_id === 'B4118', `uenigheden er B4118 (fik ${r.conflictRows[0]?.cf_id})`);
assert(r.conflictRows[0]?.remainder === 1059, 'uenigheden bærer e-conomics restbeløb');
assert(betalt('B4118').betalt === 1, 'vi flipper ALDRIG betalt → ubetalt af os selv');

/* ══ 3. Ukendt nummer er ikke det samme som betalt ═══════════════════════ */
assert(r.unknownNumbers === 1, `1 ukendt nummer (fik ${r.unknownNumbers})`);
assert(!r.changes.some(c => c.cf_id === 'B9999'), 'ukendt nummer 8888 markeres IKKE betalt');
assert(!r.changes.some(c => c.cf_id === 'B7000'), 'faktura uden e-conomic-nr røres ikke');

/* ══ 3b. Åbne fakturaer uden bon-kobling vises frem ══════════════════════ */
assert(r.unlinkedOpen.length === 0, 'begge åbne fakturaer er koblet til en bon → intet ukoblet');
UNPAID.push(inv('4132', { heading: 'DCU Rødovre', remainder: 7405, date: '2026-08-06' }));
const rU = await reconcile(db, { dryRun: true });
assert(rU.unlinkedOpen.length === 1, `1 åben faktura uden bon-kobling (fik ${rU.unlinkedOpen.length})`);
assert(rU.unlinkedOpen[0].heading === 'DCU Rødovre', 'overskriften følger med så den kan genkendes i hånden');
assert(rU.openInEconomic === 3, 'den tæller stadig med i e-conomics åbne total');
UNPAID.pop();

/* ══ 4. Skrivning + idempotens ═══════════════════════════════════════════ */
console.log('\n— Skrivning og idempotens —');
r = await reconcile(db, { dryRun: false });
assert(betalt('B4049').betalt === 1, 'B4049 står nu som betalt');
assert(betalt('B4049').betalt_dato != null, 'betalt_dato sat');
assert(betalt('B4081').betalt === 0, 'B4081 er stadig ubetalt');
const r2run = await reconcile(db, { dryRun: false });
assert(r2run.flipped === 0, `anden kørsel flipper intet (fik ${r2run.flipped})`);
assert(r2run.conflicts === 1, 'uenigheden består til den er håndteret i hånden');

/* ══ 5. Spejlet holder op med at lyve ════════════════════════════════════ */
console.log('\n— Spejlets restbeløb følger den fulde tilstand —');
assert(mirrorRow('4078').remainder === 0, 'betalt faktura: spejlets remainder nulstillet');
assert(mirrorRow('4095').remainder === 12128, `åben faktura: spejlet bærer aktuelt restbeløb (fik ${mirrorRow('4095').remainder})`);
assert(mirrorRow('4123').remainder === 1059, 'åben faktura: restbeløb opdateret fra 1111 → 1059');
assert(r.mirrorCleared >= 1, `spejl-rækker ryddet (fik ${r.mirrorCleared})`);

/* ══ 6. Betalingsdato fra bankposteringen når vi har en ══════════════════ */
console.log('\n— Betalingsdato —');
makeInvoice('B5000', { ecoNo: '4200' });
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4200', '2026-06-01', 1000, 0, '5000')`).run();
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb, matched_invoice_id)
            VALUES ('2026-06-20', 'FAKTURA 4200', 1000, 'B5000')`).run();
await reconcile(db, { dryRun: false });
assert(betalt('B5000').betalt_dato === '2026-06-20', `betalt_dato = bankposteringens dato (fik ${betalt('B5000').betalt_dato})`);

/* ══ 7. Nummer-kobling fra overskrift virker stadig (delta-aksen) ════════ */
console.log('\n— Delta-aksen: nye fakturaer kobles via overskriften —');
makeInvoice('B4200');
BOOKED = [inv('4300', { heading: '#B4200', remainder: 0, date: '2026-08-01' })];
r = await reconcile(db, { dryRun: false });
assert(r.numbered === 1, `1 fakturanr gemt (fik ${r.numbered})`);
const b4200 = db.prepare(`SELECT economic_number, betalt FROM cf_invoices WHERE id = 'B4200'`).get();
assert(b4200.economic_number === '4300', `nummer 4300 gemt på B4200 (fik ${b4200.economic_number})`);
assert(b4200.betalt === 1, 'ny faktura uden for den ubetalte liste → betalt i samme kørsel');
assert(r.newWatermark === '2026-08-01', `vandmærke rykket (fik ${r.newWatermark})`);
assert(db.prepare(`SELECT value FROM cf_meta WHERE key='economic_synced_at'`).get()?.value != null, 'synk-tidspunkt gemt');

/* ══ 8. Guard mod brudt paginering ═══════════════════════════════════════ */
console.log('\n— Guard: tom liste der burde have rækker —');
UNPAID = []; UNPAID_REPORTED = 14;             // e-conomic melder 14, leverer 0
let threw = false;
try { await reconcile(db, { dryRun: true }); } catch { threw = true; }
assert(threw, 'afbryder frem for at markere hele debitorbogen betalt');
UNPAID_REPORTED = null;
UNPAID = [];
r = await reconcile(db, { dryRun: true });
assert(r.openInEconomic === 0, 'ægte tom liste (alt betalt) er derimod en gyldig tilstand');

/* ══ 9. Fakturabeløbet er e-conomics, ikke bonens ════════════════════════ */
console.log('\n— Beløb: 1:1-koblet faktura får e-conomics bruttobeløb —');
// B7700 blev oprettet fra bonens total (3000) — e-conomic fakturerede 3300 (med levering).
// B7777 + B7778 deler ét nummer (samlefaktura) og må IKKE rettes: beløbet kan ikke fordeles.
makeInvoice('B7700', { ecoNo: '4500', beloeb: 3000 });
makeInvoice('B7777', { ecoNo: '4400', beloeb: 600 });
makeInvoice('B7778', { ecoNo: '4400', beloeb: 400 });
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4500', '2026-08-05', 3300, 3300, '#B7700')`).run();
db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
            VALUES ('4400', '2026-08-05', 1100, 1100, '#B7777 #B7778')`).run();
UNPAID = [inv('4500', { heading: '#B7700', remainder: 3300, gross: 3300 }),
          inv('4400', { heading: '#B7777 #B7778', remainder: 1100, gross: 1100 })];
BOOKED = [];
const bel = (id) => db.prepare(`SELECT beloeb FROM cf_invoices WHERE id = ?`).get(id).beloeb;
r = await reconcile(db, { dryRun: true });
assert(r.amountsCorrected === 1 && r.amountChanges[0].cf_id === 'B7700', `dry-run melder 1 rettelse på B7700 (fik ${r.amountsCorrected})`);
assert(bel('B7700') === 3000, 'dry-run skriver ikke');
r = await reconcile(db, { dryRun: false });
assert(bel('B7700') === 3300, `B7700 beløb rettet 3000 → 3300 (fik ${bel('B7700')})`);
assert(bel('B7777') === 600 && bel('B7778') === 400, 'samlefaktura: beløb urørt (kan ikke fordeles)');
assert(betalt('B7700').betalt === 0, 'stadig åben hos e-conomic → stadig ubetalt');
r = await reconcile(db, { dryRun: false });
assert(r.amountsCorrected === 0, `anden kørsel retter intet (fik ${r.amountsCorrected})`);

/* ══ 10. Den ubetalte liste kobler også numre ═══════════════════════════ */
console.log('\n— Kobling fra den ubetalte liste (hullet: bon faktureret i Bon EFTER scanningen) —');
// Faktura 4159 er bogført for længst (før vandmærket) med "#B4169" i overskriften.
// cf_invoice B4169 opstod først bagefter og har intet nummer. Delta-scanningen ser
// den aldrig igen — men den står på den ubetalte liste.
makeInvoice('B4169', { beloeb: 6475.5 });
db.prepare(`INSERT OR REPLACE INTO cf_meta (key, value) VALUES ('economic_booked_until', '2026-09-11')`).run();
UNPAID = [inv('4159', { heading: '#B4169', remainder: 6554.25, gross: 6554.25, date: '2026-08-24' })];
BOOKED = [];
r = await reconcile(db, { dryRun: false });
const b4169 = db.prepare(`SELECT economic_number, betalt, beloeb FROM cf_invoices WHERE id = 'B4169'`).get();
assert(b4169.economic_number === '4159', `nummer 4159 gemt på B4169 fra den ubetalte liste (fik ${b4169.economic_number})`);
assert(r.scanned === 0 && r.newWatermark === '2026-09-11', 'tæller ikke som scannet og rykker ikke vandmærket');
assert(!r.unlinkedOpen.some(u => u.booked_no === '4159'), 'står ikke længere som "åben uden kobling i Bon"');
assert(b4169.betalt === 0, 'åben hos e-conomic → stadig ubetalt');
assert(mirrorRow('4159')?.gross_amount === 6554.25, 'spejlet kender nu 4159 (bruttobeløb til bank-matchet)');
assert(b4169.beloeb === 6554.25, `beløbet rettet til e-conomics 6554,25 (fik ${b4169.beloeb})`);
// …og så kan bankposteringen "4159" kobles via nummeret og markere betalt
const { matchByEconomicNumber } = require('../services/cashflowReconcile');
db.prepare(`INSERT INTO cf_transactions (dato, tekst, beloeb) VALUES ('2026-09-10', '4159', 6554.25)`).run();
const mm = matchByEconomicNumber(db, { dryRun: false });
assert(mm.paid === 1 && betalt('B4169').betalt === 1, `bankposteringen "4159" kobler og markerer betalt (fik paid=${mm.paid})`);

console.log(`\n${pass} PASS · ${fail} FAIL\n`);

}

main().then(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(TMP + suffix)) fs.unlinkSync(TMP + suffix);
    process.exit(fail ? 1 : 0);
}).catch(err => {
    console.error('\nTesten kastede:', err);
    process.exit(1);
});
