#!/usr/bin/env node
/**
 * tests/scripts/reset_shopping_list.js
 * ════════════════════════════════════════════════════════════
 * Recovery-helper: tømmer list_id=1 på grocytest hvis en tidligere
 * test-kørsel crashede under cleanup og efterlod skæv state.
 *
 * Bruges NÅR det er nødvendigt — IKKE som del af normal test-flow.
 * Hver T_INDKOB_LISTE-case snapshotter+restorer selv pr. case.
 *
 * Usage:
 *   npm run test:reset-shopping-list
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/reset_shopping_list.js
 *   node tests/scripts/reset_shopping_list.js --dry-run    (vis hvad der ville slettes, gør intet)
 *
 * Sikkerhed: safety_check kører først. Hvis GROCY_API_URL ikke indeholder
 * "test", afvises kørslen.
 *
 * Reference: tests/specs/T_INDKOB_LISTE.md §7
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const safetyCheck = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const args   = process.argv.slice(2);
const DRY    = args.includes('--dry-run');
const LIST_ID = 1;

async function api(method, pathPart) {
    const res  = await fetch(`${SERVER_URL}${pathPart}`, { method });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

async function main() {
    try {
        safetyCheck({ skipDb: true });
    } catch (err) {
        console.error('[reset_shopping_list] safety-check fejlede:', err.message);
        process.exit(2);
    }

    console.log(`[reset_shopping_list] Mål: ${process.env.GROCY_API_URL}  list_id=${LIST_ID}`);
    if (DRY) console.log('[reset_shopping_list] DRY-RUN — ingen ændringer foretages');

    const res = await api('GET', '/api/grocy/shopping-list');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        console.error(`[reset_shopping_list] GET shopping-list fejlede: ${res.status}`);
        process.exit(1);
    }
    const entries = res.body.filter(e => parseInt(e.shopping_list_id) === LIST_ID);
    console.log(`[reset_shopping_list] Fandt ${entries.length} entries på list_id=${LIST_ID}`);

    if (DRY) {
        for (const e of entries.slice(0, 10)) {
            console.log(`  pid=${e.product_id} amount=${e.amount} note=${(e.note || '').slice(0, 40)}`);
        }
        if (entries.length > 10) console.log(`  ... og ${entries.length - 10} mere`);
        return;
    }

    let cleared = 0;
    for (const e of entries) {
        const r = await api('DELETE', `/api/grocy/shopping-list/${e.id}`);
        if (r.status >= 200 && r.status < 300) cleared++;
        else console.warn(`  ⚠ DELETE id=${e.id} status=${r.status}`);
    }
    console.log(`[reset_shopping_list] Slettede ${cleared}/${entries.length} entries`);
}

main().catch(err => {
    console.error('[reset_shopping_list] uventet fejl:', err);
    process.exit(1);
});
