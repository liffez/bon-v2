// scripts/backfill-economic-numbers.js
// ════════════════════════════════════════════════════════════════════════
// Pengestrøm §2.F.6: ENGANGS-backfill af e-conomics bogførte fakturanumre på
// cf_invoices + kobling af historiske bank-indbetalinger via nummeret.
//
// "⟳ Synk e-conomic"-knappen kører kun FREM fra vandmærket — den udfylder ikke
// numre på fakturaer bogført FØR vandmærket. Dette script henter ALLE bogførte
// fakturaer (fra --since, default 2024-01-01), gemmer bookedInvoiceNumber på de
// matchende cf_invoices, og kobler derefter umatchede bank-indbetalinger via
// fakturanummeret i bankteksten ("FAKTURA 3957" → economic_number=3957).
//
// KUN læsning fra e-conomic. Idempotent — kør igen, ingen ekstra ændringer.
//
//   node --experimental-sqlite scripts/backfill-economic-numbers.js            # dry-run
//   node --experimental-sqlite scripts/backfill-economic-numbers.js --apply
//   node --experimental-sqlite scripts/backfill-economic-numbers.js --apply --since=2023-01-01
// ════════════════════════════════════════════════════════════════════════
'use strict';
require('dotenv').config();
const path = require('path');
const { openDb } = require('../db/compat');
const economicAdapter = require('../services/economicAdapter');
const { reconcile, matchByEconomicNumber } = require('../services/cashflowReconcile');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sinceArg = (args.find(a => a.startsWith('--since=')) || '').split('=')[1] || '2024-01-01';

(async () => {
    if (!economicAdapter.isConfigured()) {
        console.error('✗ e-conomic er ikke konfigureret (tokens mangler i .env). Afbryder.');
        process.exit(1);
    }
    const dbPath = path.join(__dirname, '..', 'data', 'bon.db');
    const db = openDb(dbPath);

    console.log(`${apply ? '🔧 APPLY' : '🔍 DRY-RUN'} — backfill e-conomic-fakturanumre fra ${sinceArg}\n`);

    // reconcile gemmer economic_number (+ flipper betalt + rykker vandmærke)
    const r = await reconcile(db, { dryRun: !apply, since: sinceArg });
    console.log(`e-conomic bogførte fakturaer scannet : ${r.scanned}`);
    console.log(`  koblet til bons (via overskrift)   : ${r.matched}`);
    console.log(`  fakturanumre ${apply ? 'gemt' : 'ville gemmes'}              : ${r.numbered}`);
    console.log(`  betalt-status ${apply ? 'flippet' : 'ville flippes'}            : ${r.flipped}`);
    console.log(`  vandmærke → ${r.newWatermark}`);

    // kobl bank-indbetalinger via det gemte nummer
    const m = matchByEconomicNumber(db, { dryRun: !apply });
    console.log(`\nbank-indbetalinger ${apply ? 'koblet' : 'ville kobles'} via fakturanr : ${m.linked}`);

    if (!apply) console.log('\n(dry-run — intet skrevet. Kør med --apply for at gemme.)');
    db.close();
})().catch(e => { console.error('✗ Fejl:', e.message); process.exit(1); });
