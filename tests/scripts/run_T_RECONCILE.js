#!/usr/bin/env node
'use strict';
/**
 * tests/scripts/run_T_RECONCILE.js
 * ════════════════════════════════════════════════════════════
 * Hermetisk test for services/cashflowReconcile.js (Pengestrøm delta B).
 * Temp-DB via DB_PATH, e-conomic `/invoices/booked` STUBBET (ingen netværk).
 * Verificerer: match via bon-nr i overskrift, remainder=0=betalt, multi-bon,
 * beskrivende overskrift skippes, idempotens, vandmærke rykkes.
 *
 * Kør: node --experimental-sqlite tests/scripts/run_T_RECONCILE.js
 * ════════════════════════════════════════════════════════════
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `t_reconcile_${process.pid}.db`);
process.env.DB_PATH = TMP_DB;

const eco = require('../../services/economicAdapter');
// Stub: e-conomics bogførte fakturaer
const BOOKED = [
    { bookedInvoiceNumber: 5001, date: '2026-06-01', remainder: 0,  notes: { heading: '#B100' } },       // → bon 100 betalt
    { bookedInvoiceNumber: 5002, date: '2026-06-02', remainder: 50, notes: { heading: '#B200' } },       // remainder>0 → IKKE betalt
    { bookedInvoiceNumber: 5003, date: '2026-06-03', remainder: 0,  notes: { heading: '300 & 301' } },   // multi-bon → begge betalt
    { bookedInvoiceNumber: 5004, date: '2026-06-04', remainder: 0,  notes: { heading: 'Michelin' } },    // ingen nr → skip
    { bookedInvoiceNumber: 5005, date: '2026-06-05', remainder: 0,  notes: { heading: '#999' } },        // intet cf_invoice → skip
];
eco.isConfigured = () => true;
eco.rest = async (p) => p.includes('skippages=0') ? { collection: BOOKED, pagination: {} } : { collection: [], pagination: {} };

const { getDb } = require('../../db/database');
const { reconcile } = require('../../services/cashflowReconcile');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${x}`); } };

(async () => {
    const db = getDb();
    const ins = db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt) VALUES (?,?,?,?,?)`);
    ins.run('B100', 'A', 100, '2026-06-10', 0);
    ins.run('B200', 'B', 200, '2026-06-10', 0);
    ins.run('cafe-300', 'C', 300, '2026-06-10', 0);
    ins.run('B301', 'D', 301, '2026-06-10', 0);
    ins.run('B400', 'E', 400, '2026-06-10', 1);   // allerede betalt, ikke i nogen overskrift

    try {
        console.log('\n── Dry-run ──');
        let r = await reconcile(db, { dryRun: true, since: '2025-01-01' });
        ok('dry-run flipper 3 (B100, cafe-300, B301)', r.flipped === 3, `(flipped=${r.flipped})`);
        ok('dry-run matcher 4 bon-numre', r.matched === 4, `(matched=${r.matched})`);
        ok('dry-run skriver intet (B100 stadig betalt=0)', db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B100'`).get().betalt === 0);
        ok('dry-run vandmærke = seneste dato', r.newWatermark === '2026-06-05', `(${r.newWatermark})`);

        console.log('\n── Anvend ──');
        r = await reconcile(db, { dryRun: false, since: '2025-01-01' });
        ok('anvend flipper 3', r.flipped === 3);
        ok('B100 → betalt=1', db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B100'`).get().betalt === 1);
        ok('cafe-300 → betalt=1 (multi-bon)', db.prepare(`SELECT betalt FROM cf_invoices WHERE id='cafe-300'`).get().betalt === 1);
        ok('B301 → betalt=1 (multi-bon)', db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B301'`).get().betalt === 1);
        ok('B200 forbliver betalt=0 (remainder>0)', db.prepare(`SELECT betalt FROM cf_invoices WHERE id='B200'`).get().betalt === 0);
        ok('betalingstype sat til bank', db.prepare(`SELECT betalingstype FROM cf_invoices WHERE id='B100'`).get().betalingstype === 'bank');
        ok('vandmærke gemt i cf_meta', db.prepare(`SELECT value FROM cf_meta WHERE key='economic_booked_until'`).get().value === '2026-06-05');

        console.log('\n── Idempotens ──');
        r = await reconcile(db, { dryRun: false, since: '2025-01-01' });
        ok('anden kørsel flipper 0', r.flipped === 0, `(flipped=${r.flipped})`);
    } finally {
        try { db.close?.(); } catch (e) {}
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch (e) {} }
    }
    console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
