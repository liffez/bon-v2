// scripts/test-invoice-guard.js
// ============================================================
// Regressions-test for fakturavagtens SKÆRINGSDATO (#319).
//
// Baggrund: skæringsdatoen er det eneste der holder vagten brugbar. Sættes den
// for tidligt — eller forsvinder den helt — lyser vagten på hele v1-historikken,
// og så holder man op med at se den. Målt på driftsdata: 2026-06-27 giver 1 bon,
// 2026-01-01 giver 267, ingen grænse giver 2.762 helt tilbage til 2022.
// Præcis den død beskriver migration 130 selv.
//
// Testen dækker de to værn der blev bygget bagefter:
//   1. getGuardFromDate() falder tilbage på GUARD_DEFAULT_FROM_DATE når
//      settingen mangler, er tom eller er vrøvl — fravær af konfiguration må
//      ikke betyde "vurdér alt".
//   2. isValidGuardDate() afviser alt der ikke er en ægte YYYY-MM-DD, så
//      PATCH /api/settings/invoice_guard_from_date ikke kan tømme feltet.
//      Den er samtidig det der gør datoen sikker at interpolere direkte i SQL.
//
// Bruger en isoleret temp-DB med kun de tabeller vagten rører — ingen migrations,
// ingen Grocy, ingen server. Kan køres hvor som helst.
//
// Kør:
//   node --experimental-sqlite scripts/test-invoice-guard.js
// ============================================================

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../db/compat');
const guard = require('../services/invoiceGuard');

// e-conomic er ikke konfigureret i testmiljøet, og vagten er med vilje inaktiv
// uden den. Vi tester derfor missingInvoiceSQL med isConfigured() stubbet, så
// selve dato-leddet kommer under test frem for gate'en foran det.
const eco = require('../services/economicAdapter');
eco.isConfigured = () => true;

let pass = 0, fail = 0;
function t(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FEJL ${name}\n         fik ${JSON.stringify(actual)}, ventede ${JSON.stringify(expected)}`); }
}

// ── Temp-DB med kun det vagten rører ─────────────────────────
const tmp = path.join(os.tmpdir(), `bon-guard-test-${process.pid}.db`);
const db = openDb(tmp);
db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE status_definitions (id INTEGER PRIMARY KEY, code TEXT, label TEXT);
    CREATE TABLE cf_invoices (id INTEGER PRIMARY KEY, bon_id INTEGER, economic_number TEXT);
    CREATE TABLE bons (
        id INTEGER PRIMARY KEY, bon_number TEXT, status_id INTEGER,
        payment_type TEXT, delivery_date TEXT, economic_draft_number TEXT,
        is_offer INTEGER DEFAULT 0, is_internal INTEGER DEFAULT 0
    );
    INSERT INTO status_definitions (id, code) VALUES (1,'FAKTURERET'), (2,'AFSLUTTET'), (3,'LEVERET');
`);

function setGuard(v) {
    if (v === null) db.prepare(`DELETE FROM settings WHERE key='invoice_guard_from_date'`).run();
    else db.prepare(`INSERT INTO settings (key,value) VALUES ('invoice_guard_from_date',?)
                     ON CONFLICT(key) DO UPDATE SET value=?`).run(v, v);
    guard.invalidateGuardCache();
}

function addBon(o) {
    db.prepare(`INSERT INTO bons (id, bon_number, status_id, payment_type, delivery_date,
                                  economic_draft_number, is_offer, is_internal)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(o.id, o.bon_number, o.status_id, o.payment_type ?? 'invoice', o.delivery_date,
           o.economic_draft_number ?? null, o.is_offer ?? 0, o.is_internal ?? 0);
}

// ── 1. isValidGuardDate ──────────────────────────────────────
console.log('\n── isValidGuardDate ──');
t('gyldig ISO',             guard.isValidGuardDate('2026-06-27'), true);
t('skudårsdag findes',      guard.isValidGuardDate('2028-02-29'), true);
t('tom streng afvises',     guard.isValidGuardDate(''), false);
t('null afvises',           guard.isValidGuardDate(null), false);
t('undefined afvises',      guard.isValidGuardDate(undefined), false);
t('tal afvises',            guard.isValidGuardDate(20260627), false);
t('dansk format afvises',   guard.isValidGuardDate('27-06-2026'), false);
t('ISO m. tid afvises',     guard.isValidGuardDate('2026-06-27T00:00'), false);
t('31. februar afvises',    guard.isValidGuardDate('2026-02-31'), false);
t('måned 13 afvises',       guard.isValidGuardDate('2026-13-01'), false);
t('29/2 i ikke-skudår',     guard.isValidGuardDate('2026-02-29'), false);
t('citationstegn afvises',  guard.isValidGuardDate("2026-01-01' OR '1'='1"), false);

// ── 2. Faldskærmen ───────────────────────────────────────────
console.log('\n── getGuardFromDate: faldskærm ──');
setGuard('2026-06-27');
t('gyldig værdi bruges som den er', guard.getGuardFromDate(db), '2026-06-27');
setGuard('2027-03-01');
t('en anden gyldig værdi respekteres', guard.getGuardFromDate(db), '2027-03-01');
setGuard('');
t('tom → faldskærm',           guard.getGuardFromDate(db), guard.GUARD_DEFAULT_FROM_DATE);
setGuard('ikke-en-dato');
t('vrøvl → faldskærm',         guard.getGuardFromDate(db), guard.GUARD_DEFAULT_FROM_DATE);
setGuard('2026-02-31');
t('umulig dato → faldskærm',   guard.getGuardFromDate(db), guard.GUARD_DEFAULT_FROM_DATE);
setGuard(null);
t('nøgle mangler → faldskærm', guard.getGuardFromDate(db), guard.GUARD_DEFAULT_FROM_DATE);

// ── 3. Reglen på ægte bons ───────────────────────────────────
// Én gammel v1-bon (betalt for længst, aldrig haft e-conomic-nummer) og én ny
// efter skæringsdatoen. Kun den nye må lyse.
addBon({ id: 1, bon_number: 'cafe-3184', status_id: 1, delivery_date: '2026-01-05' });
addBon({ id: 2, bon_number: 'B4200',     status_id: 1, delivery_date: '2026-07-01' });

console.log('\n── bonMissingInvoice: skæringsdatoen ──');
setGuard('2026-06-27');
t('gammel v1-bon springes over', guard.bonMissingInvoice(db, 1).reason, 'before_guard_date');
t('gammel v1-bon lyser ikke',    guard.bonMissingInvoice(db, 1).missing, false);
t('ny bon fanges',               guard.bonMissingInvoice(db, 2).missing, true);

setGuard('');   // faldskærmen skal give SAMME svar som den eksplicitte dato
t('tom setting: gammel bon lyser stadig ikke', guard.bonMissingInvoice(db, 1).missing, false);
t('tom setting: ny bon fanges stadig',         guard.bonMissingInvoice(db, 2).missing, true);

// ── 4. Samme svar i SQL-stien som i JS-stien ─────────────────
// De to ansigter må aldrig kunne divergere — det er hele grunden til at reglen
// bor ét sted.
console.log('\n── missingInvoiceSQL: samme regel som bonMissingInvoice ──');
function sqlFlag(bonId) {
    const expr = guard.missingInvoiceSQL(db, 'b', 'sd');
    return db.prepare(`SELECT ${expr} AS f FROM bons b
                       JOIN status_definitions sd ON b.status_id = sd.id
                       WHERE b.id = ?`).get(bonId).f;
}
setGuard('2026-06-27');
t('SQL: gammel bon = 0', sqlFlag(1), 0);
t('SQL: ny bon = 1',     sqlFlag(2), 1);
setGuard('');
t('SQL under faldskærm: gammel bon = 0', sqlFlag(1), 0);
t('SQL under faldskærm: ny bon = 1',     sqlFlag(2), 1);

// Vrøvl i settingen må ikke kunne slippe ind i SQL'en.
setGuard("2026-01-01' OR '1'='1");
t('SQL overlever vrøvl i settingen (bruger faldskærm)', sqlFlag(1), 0);

// ── 5. De øvrige filtre er upåvirkede ────────────────────────
console.log('\n── øvrige filtre ──');
setGuard('2026-06-27');
addBon({ id: 3, bon_number: 'B4201', status_id: 1, delivery_date: '2026-07-01', payment_type: 'cash' });
addBon({ id: 4, bon_number: 'T4202', status_id: 1, delivery_date: '2026-07-01', is_offer: 1 });
addBon({ id: 5, bon_number: 'B4203', status_id: 1, delivery_date: '2026-07-01', is_internal: 1 });
addBon({ id: 6, bon_number: 'B4204', status_id: 1, delivery_date: '2026-07-01', economic_draft_number: '9001' });
addBon({ id: 7, bon_number: 'B4205', status_id: 3, delivery_date: '2026-07-01' }); // LEVERET
addBon({ id: 8, bon_number: 'B4206', status_id: 2, delivery_date: '2026-07-01' }); // AFSLUTTET
db.prepare(`INSERT INTO cf_invoices (bon_id, economic_number) VALUES (9, '4091')`).run();
addBon({ id: 9, bon_number: 'B4207', status_id: 1, delivery_date: '2026-07-01' });

t('kontant springes over',   guard.bonMissingInvoice(db, 3).reason, 'payment_type_not_invoice');
t('tilbud springes over',    guard.bonMissingInvoice(db, 4).reason, 'offer_or_internal');
t('intern bon springes over', guard.bonMissingInvoice(db, 5).reason, 'offer_or_internal');
t('kladde findes',           guard.bonMissingInvoice(db, 6).reason, 'draft_exists');
t('LEVERET er ikke vagtet',  sqlFlag(7), 0);
t('AFSLUTTET er vagtet',     guard.bonMissingInvoice(db, 8).missing, true);
t('bogført faktura findes',  guard.bonMissingInvoice(db, 9).reason, 'booked_invoice_exists');

// ── Oprydning ────────────────────────────────────────────────
db.close();
for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmp + suffix); } catch { /* fandtes ikke */ }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail === 0 ? 0 : 1);
