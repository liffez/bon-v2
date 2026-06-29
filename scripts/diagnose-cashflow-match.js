// scripts/diagnose-cashflow-match.js  — READ-ONLY diagnose. Skriver INTET.
// ════════════════════════════════════════════════════════════════════════
// Svarer på: (1) hvor står bon-nummeret i e-conomics bogførte fakturaer
// (overskrift/note/reference)? (2) er e-conomic-fakturanumrene gemt på cf_invoices?
// (3) for de umatchede "faktura"-indbetalinger: matcher nummeret en gemt economic_number?
//
//   node --experimental-sqlite scripts/diagnose-cashflow-match.js
// ════════════════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();
const path = require('path');
const { openDb } = require('../db/compat');
const economicAdapter = require('../services/economicAdapter');
const { fetchBookedSince } = require('../services/cashflowReconcile');

const digits = (s) => String(s || '').replace(/\D/g, '');

(async () => {
    const db = openDb(path.join(__dirname, '..', 'data', 'bon.db'));

    // ── 1) cf_invoices.economic_number-dækning ────────────────────────────
    const totalInv = db.prepare('SELECT COUNT(*) c FROM cf_invoices').get().c;
    const withNo = db.prepare("SELECT COUNT(*) c FROM cf_invoices WHERE economic_number IS NOT NULL AND economic_number != ''").get().c;
    console.log('═══ 1. cf_invoices ═══');
    console.log(`  i alt: ${totalInv}  ·  med gemt economic_number: ${withNo}  (${Math.round(withNo/totalInv*100)}%)`);
    console.log('  (er denne ~0%, er backfill ikke kørt ELLER reconcile gemmer ikke numre)\n');

    // ── 2) umatchede "faktura"-indbetalinger: nummer gemt eller ej? ────────
    const FAKTURA_RE = /faktur|fakt|fak[\s.\-]|fa\.?nr|faknr|invoice/i;
    const unmatched = db.prepare(`SELECT tekst, dato, beloeb FROM cf_transactions t
        WHERE t.matched_invoice_id IS NULL AND t.beloeb > 0 AND t.ignored = 0
          AND ABS(t.beloeb - COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0)) >= 0.01`).all();
    const fakturaTx = unmatched.filter(t => FAKTURA_RE.test(t.tekst) || /^\s*\d{3,6}\s*$/.test(t.tekst));
    const ecoNos = new Set(db.prepare("SELECT economic_number FROM cf_invoices WHERE economic_number IS NOT NULL").all().map(r => digits(r.economic_number)));
    let storedHit = 0, noStored = 0;
    for (const t of fakturaTx) {
        const nums = (t.tekst.match(/\d{3,6}/g) || []).map(digits);
        if (nums.some(n => ecoNos.has(n))) storedHit++; else noStored++;
    }
    console.log('═══ 2. Umatchede "faktura"-indbetalinger ═══');
    console.log(`  i alt med fakturanr i tekst: ${fakturaTx.length}`);
    console.log(`    nummer FINDES som gemt economic_number: ${storedHit}  (burde være koblet — tjek amount-tolerance)`);
    console.log(`    nummer findes IKKE som economic_number: ${noStored}  (e-conomic-faktura ikke bundet til bon → numret aldrig gemt)\n`);

    // ── 3) e-conomic booked: HVOR står bon-nummeret? ──────────────────────
    console.log('═══ 3. e-conomic bogførte fakturaer — felt-dump (15 nyeste) ═══');
    if (!economicAdapter.isConfigured()) {
        console.log('  ⚠ e-conomic ikke konfigureret (tokens mangler) — springer over.');
    } else {
        const booked = (await fetchBookedSince(null)).slice(-15);
        console.log('  nr      | dato       | brutto   | heading                  | textLine1                | reference');
        for (const inv of booked) {
            const f = (v, n) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n).padEnd(n);
            console.log('  ' +
                f(inv.bookedInvoiceNumber, 7) + ' | ' +
                f(inv.date, 10) + ' | ' +
                String(Math.round(inv.grossAmount ?? inv.netAmount ?? 0)).padStart(8) + ' | ' +
                f(inv.notes?.heading, 24) + ' | ' +
                f(inv.notes?.textLine1, 24) + ' | ' +
                f(inv.references?.other, 16));
        }
        console.log('\n  → Kig efter hvor bon-nummeret (fx 4111 / cafe-2650 / #B4013) står:');
        console.log('    heading, textLine1 eller reference. Det fortæller hvilket felt reconcile skal læse.');
    }
    db.close();
})().catch(e => { console.error('✗ Fejl:', e.message); process.exit(1); });
