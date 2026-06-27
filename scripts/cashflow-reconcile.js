#!/usr/bin/env node
/**
 * scripts/cashflow-reconcile.js
 * ════════════════════════════════════════════════════════════════════════
 * Nightly e-conomic-afstemning (Pengestrøm delta B). Læser e-conomics bogførte
 * fakturaer → markér cf_invoices betalt via bon-nr i overskriften + ryk vandmærke.
 *
 * Cron (deploy):
 *   0 4 * * *  cd /home/leif/bon-v2 && node --experimental-sqlite scripts/cashflow-reconcile.js >> logs/reconcile.log 2>&1
 *
 * Kør én gang manuelt for fuld første-afstemning (kan tage et øjeblik — scanner
 * hele bagkataloget indtil vandmærket er sat):
 *   node --experimental-sqlite scripts/cashflow-reconcile.js
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config({ quiet: true });
const eco = require('../services/economicAdapter');
const { getDb } = require('../db/database');
const { reconcile } = require('../services/cashflowReconcile');

(async () => {
    const stamp = new Date().toISOString();
    if (!eco.isConfigured()) { console.log(`[${stamp}] cashflow-reconcile: e-conomic ikke konfigureret — springer over`); process.exit(0); }
    try {
        const r = await reconcile(getDb(), { dryRun: false });
        console.log(`[${stamp}] cashflow-reconcile: scannet ${r.scanned} · matchet ${r.matched} · markeret betalt ${r.flipped} · vandmærke → ${r.newWatermark}`);
        process.exit(0);
    } catch (e) {
        console.error(`[${stamp}] cashflow-reconcile FEJL: ${e.message}`);
        process.exit(1);
    }
})();
