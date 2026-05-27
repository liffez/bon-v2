// scripts/diagnose-cashflow-amounts.js
//
// Diagnose: hvorfor er cf_invoices SUM så høj? Finder komma-fejl,
// dubletter eller fakturaer med urealistisk store beløb.
//
// Brug:
//   node --experimental-sqlite scripts/diagnose-cashflow-amounts.js
//
// Skriver kun — ændrer intet.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

const db = openDb(DB_PATH);
const fmt = n => (n ?? 0).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log('═══ CASHFLOW DIAGNOSE ═══\n');

// 1) Total i cf_invoices
const cfStats = db.prepare(`
    SELECT COUNT(*) AS cnt,
           COALESCE(SUM(beloeb), 0) AS total,
           COALESCE(MIN(beloeb), 0) AS min_b,
           COALESCE(MAX(beloeb), 0) AS max_b,
           COALESCE(AVG(beloeb), 0) AS avg_b
    FROM cf_invoices
`).get();
console.log('cf_invoices (ALLE):');
console.log(`  antal:   ${cfStats.cnt}`);
console.log(`  total:   ${fmt(cfStats.total)} kr`);
console.log(`  min:     ${fmt(cfStats.min_b)} kr`);
console.log(`  max:     ${fmt(cfStats.max_b)} kr`);
console.log(`  gns:     ${fmt(cfStats.avg_b)} kr`);

const cfUnpaid = db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(beloeb), 0) AS total FROM cf_invoices WHERE betalt = 0`).get();
console.log(`\ncf_invoices (UBETALT):  ${cfUnpaid.cnt} stk, ${fmt(cfUnpaid.total)} kr`);

const cfAuto = db.prepare(`SELECT COUNT(*) AS cnt FROM cf_invoices WHERE bon_id IS NOT NULL`).get();
const cfManual = db.prepare(`SELECT COUNT(*) AS cnt FROM cf_invoices WHERE bon_id IS NULL`).get();
console.log(`  heraf auto (bon_id): ${cfAuto.cnt}`);
console.log(`  heraf manuelt:       ${cfManual.cnt}`);

// 2) Sammenlign med bons-data direkte
const bonStats = db.prepare(`
    SELECT COUNT(*) AS cnt,
           COALESCE(SUM(b.total_price), 0) AS sum_price,
           COALESCE(SUM(b.total_with_delivery), 0) AS sum_with_delivery,
           COALESCE(SUM(COALESCE(b.total_with_delivery, b.total_price, 0)), 0) AS sum_coalesce
    FROM bons b
    JOIN status_definitions sd ON b.status_id = sd.id
    WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
      AND b.payment_type = 'invoice'
      AND COALESCE(b.is_offer, 0) = 0
      AND COALESCE(b.is_internal, 0) = 0
      AND COALESCE(b.total_price, 0) > 0
`).get();
console.log('\nbons (FAKTURERET/AFSLUTTET/BETALT + invoice + ikke offer/internal):');
console.log(`  antal:                  ${bonStats.cnt}`);
console.log(`  SUM total_price:        ${fmt(bonStats.sum_price)} kr`);
console.log(`  SUM total_with_delivery: ${fmt(bonStats.sum_with_delivery)} kr`);
console.log(`  SUM coalesce(twd,tp):   ${fmt(bonStats.sum_coalesce)} kr`);

// 3) Dubletter? Samme bon_id flere gange
const dupes = db.prepare(`
    SELECT bon_id, COUNT(*) AS n FROM cf_invoices
    WHERE bon_id IS NOT NULL GROUP BY bon_id HAVING n > 1
    ORDER BY n DESC LIMIT 10
`).all();
if (dupes.length > 0) {
    console.log(`\n⚠  DUBLETTER fundet — samme bon_id flere gange:`);
    for (const d of dupes) console.log(`    bon_id=${d.bon_id} har ${d.n} cf_invoices`);
} else {
    console.log('\n✓ Ingen dubletter (samme bon_id) i cf_invoices');
}

// 4) Top 20 største cf_invoices
console.log('\nTop 20 største cf_invoices:');
const top = db.prepare(`
    SELECT ci.id, ci.bon_id, ci.kunde, ci.beloeb, ci.forfald, ci.betalt,
           b.bon_number, b.total_price AS bon_total, b.total_with_delivery AS bon_twd
    FROM cf_invoices ci
    LEFT JOIN bons b ON b.id = ci.bon_id
    ORDER BY ci.beloeb DESC LIMIT 20
`).all();
console.log('  id'.padEnd(20) + ' bon#'.padEnd(8) + ' beloeb'.padStart(14) + ' bon.total'.padStart(14) + ' bon.twd'.padStart(14) + '  match?  kunde');
for (const r of top) {
    const match = r.bon_id && r.beloeb === (r.bon_twd ?? r.bon_total) ? '  ✓' : (r.bon_id ? ' ⚠ ' : '  —');
    console.log(
        '  ' + (r.id || '').padEnd(18) +
        ' ' + (r.bon_number || '-').toString().padEnd(7) +
        ' ' + fmt(r.beloeb).padStart(13) +
        ' ' + (r.bon_total != null ? fmt(r.bon_total) : '-').padStart(13) +
        ' ' + (r.bon_twd != null ? fmt(r.bon_twd) : '-').padStart(13) +
        ' ' + match.padEnd(5) +
        '  ' + (r.kunde || '').slice(0, 40)
    );
}

// 5) Distribution
console.log('\nFordeling (cf_invoices.beloeb):');
const buckets = [
    { label: '0–500',          where: 'beloeb < 500' },
    { label: '500–2.000',      where: 'beloeb >= 500 AND beloeb < 2000' },
    { label: '2.000–5.000',    where: 'beloeb >= 2000 AND beloeb < 5000' },
    { label: '5.000–10.000',   where: 'beloeb >= 5000 AND beloeb < 10000' },
    { label: '10.000–50.000',  where: 'beloeb >= 10000 AND beloeb < 50000' },
    { label: '> 50.000',       where: 'beloeb >= 50000' },
];
for (const b of buckets) {
    const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(beloeb),0) AS s FROM cf_invoices WHERE ${b.where}`).get();
    console.log(`  ${b.label.padEnd(18)} ${String(r.n).padStart(6)} stk   ${fmt(r.s).padStart(15)} kr`);
}

// 6) Auto-cf_invoices hvor beloeb afviger fra bonens total
const mismatch = db.prepare(`
    SELECT COUNT(*) AS n FROM cf_invoices ci
    JOIN bons b ON b.id = ci.bon_id
    WHERE ci.bon_id IS NOT NULL
      AND ABS(ci.beloeb - COALESCE(b.total_with_delivery, b.total_price, 0)) > 0.01
`).get();
console.log(`\nAuto-cf_invoices hvor beloeb ≠ bons.total_with_delivery (mismatch): ${mismatch.n}`);

// 7) Den helt røde flag: cf_invoices uden bon_id der har samme beløb som auto-cf_invoices
const orphanLargeCount = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(beloeb),0) AS s FROM cf_invoices WHERE bon_id IS NULL AND beloeb > 1000`).get();
console.log(`\nManuelt-oprettede cf_invoices > 1.000 kr: ${orphanLargeCount.n} stk, ${fmt(orphanLargeCount.s)} kr`);

// 8) Status-fordeling
console.log('\nBons-fordeling (FAKTURERET/AFSLUTTET/BETALT + invoice + ikke offer/internal):');
const statusBreakdown = db.prepare(`
    SELECT sd.code, COUNT(*) AS n, COALESCE(SUM(b.total_price), 0) AS s
    FROM bons b
    JOIN status_definitions sd ON b.status_id = sd.id
    WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
      AND b.payment_type = 'invoice'
      AND COALESCE(b.is_offer, 0) = 0
      AND COALESCE(b.is_internal, 0) = 0
      AND COALESCE(b.total_price, 0) > 0
    GROUP BY sd.code
`).all();
for (const r of statusBreakdown) {
    console.log(`  ${r.code.padEnd(12)} ${String(r.n).padStart(6)} stk   ${fmt(r.s).padStart(15)} kr`);
}

console.log('\n═══ FÆRDIG ═══');
