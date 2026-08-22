// tests/pos_finance.test.js
// ============================================================
// Gebyret pr. salgsdag og udbetalingens sammensætning — rene funktioner.
// Ingen database, intet netværk.
//
// Fire ting er MÅLT mod produktionskontoen 22. august 2026 og er det testene
// hviler på (migration 154's hoved har detaljerne):
//   1. gebyret ligger pr. betaling — ikke pr. udbetaling
//   2. nøglen til købet er payments[].uuid, ikke købets eget uuid (0 % match)
//   3. gebyret bogføres samtidig med betalingen (484/484 inden for 5 sek)
//   4. udbetalingen fejer saldoen: 4 af 4 stemte til øren
//
// Kør: node --test tests/pos_finance.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { paymentUuidIndex, attributeLedger, suggestBankMatch } = require('../services/posFinance');
const { normalizeFinanceTx } = require('../services/zettleAdapter');

const FIX = p => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zettle', p), 'utf8'));
const LEDGER = FIX('finance_ledger.json').transactions.map(normalizeFinanceTx);

// pos_purchases-rækker som databasen leverer dem
const purchaseRows = () => [
    ...FIX('purchases_festival.json').purchases,
    ...FIX('purchases_synthetic.json').purchases,
].map(p => ({
    purchase_uuid: p.purchaseUUID,
    business_date: p.timestamp.slice(0, 10) === '2026-08-16' ? '2026-08-15' : p.timestamp.slice(0, 10),
    raw_json: JSON.stringify(p),
}));

/* ══════════════════════════════════════════════════════════
   NØGLEN
   ══════════════════════════════════════════════════════════ */

test('betalings-uuid er nøglen til købet — ikke købets eget uuid', () => {
    const rows = purchaseRows();
    const idx = paymentUuidIndex(rows);
    // Målt: købets uuid matcher 0 % af hovedbogens poster.
    for (const r of rows) assert.equal(idx.has(r.purchase_uuid), false);
    // Betalingens uuid matcher.
    assert.ok(idx.has('7f0572e9-b461-036e-0636-96cffe98882d'));
    assert.equal(idx.get('7f0572e9-b461-036e-0636-96cffe98882d').business_date, '2026-08-14');
});

test('et køb med flere betalinger giver flere nøgler til samme dag', () => {
    const idx = paymentUuidIndex([{
        purchase_uuid: 'p1', business_date: '2026-08-14',
        raw_json: JSON.stringify({ payments: [{ uuid: 'a' }, { uuid: 'b' }] }),
    }]);
    assert.equal(idx.get('a').business_date, '2026-08-14');
    assert.equal(idx.get('b').business_date, '2026-08-14');
});

test('ulæselig payload springes over frem for at vælte fordelingen', () => {
    const idx = paymentUuidIndex([
        { purchase_uuid: 'x', business_date: '2026-08-14', raw_json: '{ ikke json' },
        { purchase_uuid: 'y', business_date: '2026-08-14', raw_json: JSON.stringify({ payments: [{ uuid: 'c' }] }) },
    ]);
    assert.equal(idx.size, 1);
    assert.ok(idx.has('c'));
});

/* ══════════════════════════════════════════════════════════
   FORDELINGEN
   ══════════════════════════════════════════════════════════ */

test('gebyret lander på den dag købet hører til', () => {
    const { days } = attributeLedger(LEDGER, paymentUuidIndex(purchaseRows()));
    const d14 = days.find(d => d.business_date === '2026-08-14');
    assert.equal(d14.card_gross_incl, 65);
    assert.equal(d14.fee_incl, -1.3);
    const d15 = days.find(d => d.business_date === '2026-08-15');
    assert.equal(d15.card_gross_incl, 80);
    assert.equal(d15.fee_incl, -1.6);
});

test('gebyret følger købets FORRETNINGSDAG, ikke hovedbogens dato', () => {
    // Købet ligger 2026-08-15T15:00 og hører til den 15. Havde det ligget efter
    // midnat, ville det have hørt til dagen før (§6.1) — og gebyret med det.
    const rows = purchaseRows();
    const flyttet = rows.map(r => r.purchase_uuid === '66666666-6666-6666-6666-666666666666'
        ? { ...r, business_date: '2026-08-14' } : r);
    const { days } = attributeLedger(LEDGER, paymentUuidIndex(flyttet));
    assert.equal(days.find(d => d.business_date === '2026-08-14').fee_incl, -2.9,
        'begge gebyrer lander på den dag købene hører til');
    assert.equal(days.some(d => d.business_date === '2026-08-15'), false);
});

test('udbetalingen fejer saldoen — og sammensætningen går op', () => {
    const { payouts } = attributeLedger(LEDGER, paymentUuidIndex(purchaseRows()));
    assert.equal(payouts.length, 1);
    const p = payouts[0];
    assert.equal(p.amount_incl, 142.10, 'positivt: det er hvad der lander i banken');
    assert.equal(p.gross_incl, 145);
    assert.equal(p.fee_incl, -2.9);
    assert.equal(p.partial, false, '145 − 2,90 = 142,10 ⇒ intet uforklaret');
    assert.deepEqual(p.covered.map(c => c.business_date), ['2026-08-14', '2026-08-15']);
});

test('poster efter sidste udbetaling hører til ingen udbetaling endnu', () => {
    const { rows, payouts } = attributeLedger(LEDGER, paymentUuidIndex(purchaseRows()));
    assert.equal(payouts.length, 1);
    const efter = rows.filter(r => r.occurred_at.startsWith('2026-08-18'));
    assert.equal(efter.length, 2);
    for (const r of efter) assert.equal(r.payout_uuid, null, 'de står stadig på Zettle-kontoen');
});

test('en udbetaling der fejer en balance fra før vinduet markeres partial', () => {
    // Uden hele historikken kan regnestykket ikke gå op — så siger vi det,
    // frem for at fordele et beløb vi ikke kan gøre rede for.
    const kun = LEDGER.filter(t => t.tx_type === 'PAYOUT');
    const { payouts } = attributeLedger(kun, new Map());
    assert.equal(payouts[0].partial, true);
    assert.equal(payouts[0].gross_incl, 0);
});

test('en post uden kendt køb tælles med i udbetalingen, men ikke på nogen dag', () => {
    // Er købet ikke hentet endnu, må gebyret ikke lande på en tilfældig dag.
    const { days, payouts } = attributeLedger(LEDGER, new Map());
    assert.equal(days.length, 0);
    assert.equal(payouts[0].covered.length, 0);
    assert.equal(payouts[0].gross_incl, 145, 'beløbet er stadig gjort op');
    assert.equal(payouts[0].partial, false);
});

test('rækkefølgen er ligegyldig — hovedbogen sorteres selv', () => {
    const blandet = [...LEDGER].reverse();
    const a = attributeLedger(LEDGER, paymentUuidIndex(purchaseRows()));
    const b = attributeLedger(blandet, paymentUuidIndex(purchaseRows()));
    assert.deepEqual(b.payouts, a.payouts);
    assert.deepEqual(b.days.sort((x, y) => x.business_date.localeCompare(y.business_date)),
                     a.days.sort((x, y) => x.business_date.localeCompare(y.business_date)));
});

test('tom hovedbog giver tomt resultat, ikke en fejl', () => {
    const r = attributeLedger([], new Map());
    assert.deepEqual([r.rows, r.payouts, r.days], [[], [], []]);
});

/* ══════════════════════════════════════════════════════════
   BANK-FORSLAG
   ══════════════════════════════════════════════════════════ */

const TX = [
    { id: 1, dato: '2026-08-19', tekst: 'ZETTLE AB', beloeb: 142.10 },
    { id: 2, dato: '2026-08-18', tekst: 'ZETTLE AB', beloeb: 142.10 },
    { id: 3, dato: '2026-08-19', tekst: 'ANDEN INDBETALING', beloeb: 500.00 },
    { id: 4, dato: '2026-08-10', tekst: 'FOR TIDLIG', beloeb: 142.10 },
    { id: 5, dato: '2026-09-30', tekst: 'FOR SEN', beloeb: 142.10 },
];
const PAYOUT = { occurred_at: '2026-08-17T09:08:11.682+0000', amount_incl: 142.10 };

test('bank-forslag: beløbet skal ramme, og datoen skal ligge EFTER udbetalingen', () => {
    const c = suggestBankMatch(PAYOUT, TX);
    assert.deepEqual(c.map(x => x.id), [2, 1], 'nærmeste dag først');
    assert.equal(c.some(x => x.id === 3), false, 'forkert beløb');
    assert.equal(c.some(x => x.id === 4), false, 'pengene kan ikke være i banken før de blev sendt');
    assert.equal(c.some(x => x.id === 5), false, 'for langt bagefter');
});

test('bank-forslag: ingen kandidater er et gyldigt svar', () => {
    assert.deepEqual(suggestBankMatch({ occurred_at: '2026-08-17T09:00:00Z', amount_incl: 9999 }, TX), []);
});
