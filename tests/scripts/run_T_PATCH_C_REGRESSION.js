#!/usr/bin/env node
/**
 * tests/scripts/run_T_PATCH_C_REGRESSION.js
 * ════════════════════════════════════════════════════════════
 * Regression-runner for Patch C — API consistency-fixes.
 *
 * Verificerer at de 4 fixes fra maj 2026 forbliver løste:
 *   #013 — Suppliers POST/PATCH afviser ugyldig integration_type med 400
 *   #014 — supplier_grocy_locations POST returnerer 409 ved duplikat
 *   #015 — Grocy duplikat product_barcode mappes til 409 (ikke 500)
 *   F28  — goods-receipts afviser ugyldig item.status med 400
 *
 * Strategi:
 *   - Login som seeded kitchen-user (PIN 1234) for at få session-cookie
 *   - Test-data markeres med 'T_PATCH_C test' i navne så cleanup virker
 *   - Cleanup sletter test-suppliers + test-koblinger + test-barcodes
 *
 * Usage:
 *   npm run test:run-patch-c
 *   node tests/scripts/run_T_PATCH_C_REGRESSION.js --verbose
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt
 *   - test:server kører
 *
 * Reference:
 *   - docs/archive/patches/PATCH_C_api_consistency_fixes.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs          = require('node:fs');
const path        = require('node:path');
const { openDb }  = require('../../db/compat');
const safetyCheck = require('./safety_check');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');

const args         = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

const TEST_PREFIX = 'T_PATCH_C';

let db;
let SESSION_COOKIE = null;
const results = [];

// Cleanup-tracking
const createdSupplierIds = [];
const createdBarcodeIds  = [];  // Grocy barcode-IDs
const createdLinks       = []; // {supplier_id, grocy_location_id}
const createdReceiptIds  = [];

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')      console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP') console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)           console.log(`  ✓ ${id}`);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (SESSION_COOKIE) opts.headers['Cookie'] = SESSION_COOKIE;
    if (body !== null) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res  = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

async function login() {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) throw new Error(`Login fejlede: status=${res.status}`);
    SESSION_COOKIE = res.headers.get('set-cookie')?.split(';')[0];
    if (!SESSION_COOKIE) throw new Error('Ingen set-cookie');
}

// ════════════════════════════════════════════════════════════
// SETUP
// ════════════════════════════════════════════════════════════

async function runSetup() {
    console.log('\n── Setup ──');

    try {
        await login();
        record(`${TEST_PREFIX}_SETUP_01`, 'SETUP', 'PASS');
    } catch (err) {
        record(`${TEST_PREFIX}_SETUP_01`, 'SETUP', 'FAIL', err.message);
        return false;
    }

    // Find en grocy_location_id der findes (til #014-test)
    const loc = db.prepare(`SELECT id FROM locations WHERE is_active = 1 LIMIT 1`).get();
    if (loc) {
        record(`${TEST_PREFIX}_SETUP_02`, 'SETUP', 'PASS');
        return loc.id;
    } else {
        record(`${TEST_PREFIX}_SETUP_02`, 'SETUP', 'FAIL', 'Ingen aktiv lokation');
        return false;
    }
}

// ════════════════════════════════════════════════════════════
// 01-02: #013 — integration_type validation
// ════════════════════════════════════════════════════════════

async function runIntegrationTypeCases() {
    console.log('\n── #013: integration_type validation ──');

    // 01: POST med ugyldig integration_type → 400
    {
        const r = await api('POST', '/api/purchasing/suppliers', {
            name: `${TEST_PREFIX}_bad_type`,
            integration_type: 'ftp',
        });
        if (r.status === 400 && r.body?.error?.includes('Ugyldig integration_type')) {
            record(`${TEST_PREFIX}_01`, '013', 'PASS',
                VERBOSE ? r.body.error : '');
        } else {
            record(`${TEST_PREFIX}_01`, '013', 'FAIL',
                `status=${r.status}, body=${r.raw?.slice(0,150)}`);
        }
    }

    // 02: POST uden integration_type → 201 (bagudkompatibel, defaulter til 'manual')
    {
        const r = await api('POST', '/api/purchasing/suppliers', {
            name: `${TEST_PREFIX}_no_type`,
        });
        if (r.status === 201 && r.body?.integration_type === 'manual') {
            createdSupplierIds.push(r.body.id);
            record(`${TEST_PREFIX}_02`, '013', 'PASS',
                VERBOSE ? `id=${r.body.id}, defaultede til manual` : '');
        } else {
            record(`${TEST_PREFIX}_02`, '013', 'FAIL',
                `status=${r.status}, type=${r.body?.integration_type}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 03: #014 — supplier_grocy_locations duplikat → 409
// ════════════════════════════════════════════════════════════

async function runDuplicateGrocyLocationCase(grocyLocId) {
    console.log('\n── #014: supplier_grocy_locations duplikat ──');

    // Først: opret en supplier vi kan koble til
    const supplierRes = await api('POST', '/api/purchasing/suppliers', {
        name: `${TEST_PREFIX}_for_link`,
        integration_type: 'manual',
    });
    if (supplierRes.status !== 201) {
        record(`${TEST_PREFIX}_03`, '014', 'FAIL',
            `Kunne ikke oprette supplier: ${supplierRes.status}`);
        return;
    }
    const supplierId = supplierRes.body.id;
    createdSupplierIds.push(supplierId);

    // Første kobling
    const first = await api('POST', '/api/purchasing/suppliers/grocy-locations', {
        supplier_id: supplierId,
        grocy_location_id: grocyLocId,
        display_name: `${TEST_PREFIX}_link`,
    });
    if (first.status !== 200 || !first.body?.ok) {
        record(`${TEST_PREFIX}_03`, '014', 'FAIL',
            `Første kobling fejlede: status=${first.status}`);
        return;
    }
    createdLinks.push({ supplier_id: supplierId, grocy_location_id: grocyLocId });

    // Anden kobling samme par → 409
    const second = await api('POST', '/api/purchasing/suppliers/grocy-locations', {
        supplier_id: supplierId,
        grocy_location_id: grocyLocId,
        display_name: `${TEST_PREFIX}_link_duplicate`,
    });
    // v2: 409 returnerer `existing` (hele rækken) — ikke `existing_id` (gammel form)
    const ex = second.body?.existing;
    if (second.status === 409
        && second.body?.error?.includes('eksisterer allerede')
        && ex
        && ex.supplier_id === supplierId
        && ex.grocy_location_id === grocyLocId) {
        record(`${TEST_PREFIX}_03`, '014', 'PASS',
            VERBOSE ? `existing=${JSON.stringify(ex)}` : '');
    } else {
        record(`${TEST_PREFIX}_03`, '014', 'FAIL',
            `status=${second.status}, body=${second.raw?.slice(0,200)}`);
    }
}

// ════════════════════════════════════════════════════════════
// PATCH-validation (C-2 — v1 missede dette endpoint)
// ════════════════════════════════════════════════════════════

async function runPatchEndpointCases() {
    console.log('\n── C-2: PATCH /suppliers/:id validation ──');

    // Opret en supplier vi kan patche
    const createRes = await api('POST', '/api/purchasing/suppliers', {
        name: `${TEST_PREFIX}_patch_target`,
        integration_type: 'manual',
    });
    if (createRes.status !== 201) {
        record(`${TEST_PREFIX}_07`, 'C-2', 'FAIL', `Setup-supplier kunne ikke oprettes: ${createRes.status}`);
        record(`${TEST_PREFIX}_08`, 'C-2', 'SKIP', '');
        return;
    }
    const supplierId = createRes.body.id;
    createdSupplierIds.push(supplierId);

    // 07 (C-2 hovedsag — regression): PATCH med ugyldig integration_type → 400
    {
        const r = await api('PATCH', `/api/purchasing/suppliers/${supplierId}`, {
            integration_type: 'ftp',
        });
        if (r.status === 400 && r.body?.error?.includes('Ugyldig integration_type')) {
            record(`${TEST_PREFIX}_07`, 'C-2', 'PASS',
                VERBOSE ? 'C-2 lukket: PATCH afviser ugyldig type' : '');
        } else {
            record(`${TEST_PREFIX}_07`, 'C-2', 'FAIL',
                `C-2 regression: status=${r.status}, body=${r.raw?.slice(0,200)}`);
        }
    }

    // 08 (C-2 sekundær): PATCH med tom name → 400 (i stedet for silent skip)
    {
        const r = await api('PATCH', `/api/purchasing/suppliers/${supplierId}`, {
            name: '',
        });
        if (r.status === 400 && r.body?.error?.toLowerCase().includes('navn')) {
            record(`${TEST_PREFIX}_08`, 'C-2', 'PASS');
        } else {
            record(`${TEST_PREFIX}_08`, 'C-2', 'FAIL',
                `status=${r.status}, body=${r.raw?.slice(0,200)}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// 04: #015 — duplikat product_barcode → 409 + code='BARCODE_DUPLICATE'
// ════════════════════════════════════════════════════════════

async function runDuplicateBarcodeCase() {
    console.log('\n── #015: product_barcode duplikat ──');

    // Brug pid=1 (Brød Rug fra T_INDKOB_pids.json) + unik test-barcode
    const testBarcode = `${TEST_PREFIX}-${Date.now()}`;
    const firstBody = { product_id: 1, barcode: testBarcode };

    const first = await api('POST', '/api/grocy/product-barcodes', firstBody);
    if (first.status !== 200) {
        record(`${TEST_PREFIX}_04`, '015', 'FAIL',
            `Første POST fejlede: status=${first.status}, body=${first.raw?.slice(0,150)}`);
        return;
    }

    // Grocy returnerer enten et id-objekt eller created_object_id-felt
    const barcodeId = first.body?.created_object_id || first.body?.id;
    if (barcodeId) createdBarcodeIds.push(barcodeId);

    // Anden gang samme barcode → 409 + BARCODE_DUPLICATE
    const second = await api('POST', '/api/grocy/product-barcodes', firstBody);
    if (second.status === 409
        && second.body?.code === 'BARCODE_DUPLICATE'
        && second.body?.error?.includes('eksisterer allerede')) {
        record(`${TEST_PREFIX}_04`, '015', 'PASS',
            VERBOSE ? `code=${second.body.code}` : '');
    } else {
        record(`${TEST_PREFIX}_04`, '015', 'FAIL',
            `status=${second.status}, body=${second.raw?.slice(0,200)}`);
    }
}

// ════════════════════════════════════════════════════════════
// 05-06: F28 — item.status enum-validation
// ════════════════════════════════════════════════════════════

async function runItemStatusCases() {
    console.log('\n── F28: item.status enum-validation ──');

    const baseReceipt = {
        supplier_name: `${TEST_PREFIX}_items`,
        received_by_name: 'Test',
    };

    // 05: status='xyz' → 400 med liste af tilladte
    {
        const r = await api('POST', '/api/goods-receipts', {
            ...baseReceipt,
            items: [{
                grocy_product_id: 999999,
                product_name: 'Bad status',
                received_quantity: 1,
                status: 'xyz',
            }],
        });
        if (r.status === 400
            && r.body?.error?.includes("status='xyz'")
            && r.body?.error?.includes('ok')
            && r.body?.error?.includes('wrong')) {
            record(`${TEST_PREFIX}_05`, 'F28', 'PASS',
                VERBOSE ? r.body.error : '');
        } else {
            record(`${TEST_PREFIX}_05`, 'F28', 'FAIL',
                `status=${r.status}, body=${r.raw?.slice(0,200)}`);
        }
    }

    // 06: status udeladt → 200 (defaulter til 'ok' i INSERT)
    {
        const r = await api('POST', '/api/goods-receipts', {
            ...baseReceipt,
            items: [{
                grocy_product_id: 999999,
                product_name: 'Default status',
                received_quantity: 0,
                // status mangler bevidst
            }],
        });
        if (r.status === 200 && r.body?.id) {
            createdReceiptIds.push(r.body.id);
            // Verificér at DB-row har status='ok' (default)
            const itemRow = db.prepare(
                `SELECT status FROM goods_receipt_items WHERE receipt_id = ? LIMIT 1`
            ).get(r.body.id);
            if (itemRow?.status === 'ok') {
                record(`${TEST_PREFIX}_06`, 'F28', 'PASS',
                    VERBOSE ? 'undefined → "ok" (default)' : '');
            } else {
                record(`${TEST_PREFIX}_06`, 'F28', 'FAIL',
                    `DB status='${itemRow?.status}' (forventede 'ok')`);
            }
        } else {
            record(`${TEST_PREFIX}_06`, 'F28', 'FAIL',
                `status=${r.status}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════

async function cleanup() {
    if (SKIP_CLEANUP) {
        console.log('\n[cleanup] SKIPPED');
        return;
    }

    console.log('\n── Cleanup ──');

    // Slet test-receipts
    if (createdReceiptIds.length > 0) {
        const ph = createdReceiptIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM goods_receipt_items WHERE receipt_id IN (${ph})`).run(...createdReceiptIds);
        db.prepare(`DELETE FROM goods_receipts WHERE id IN (${ph})`).run(...createdReceiptIds);
    }
    // Slet også alle T_PATCH_C-prefixede receipts (catch-all)
    db.prepare(`DELETE FROM goods_receipt_items WHERE receipt_id IN (SELECT id FROM goods_receipts WHERE supplier_name LIKE '${TEST_PREFIX}%')`).run();
    db.prepare(`DELETE FROM goods_receipts WHERE supplier_name LIKE '${TEST_PREFIX}%'`).run();

    // Slet test-koblinger
    for (const { supplier_id, grocy_location_id } of createdLinks) {
        try {
            db.prepare(`DELETE FROM supplier_grocy_locations WHERE supplier_id = ? AND grocy_location_id = ?`).run(supplier_id, grocy_location_id);
        } catch (err) { console.warn(`  ⚠ link cleanup: ${err.message}`); }
    }

    // Slet test-suppliers (hard delete — vi vil ikke have soft-deleted test-rows hænge)
    if (createdSupplierIds.length > 0) {
        const ph = createdSupplierIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM supplier_grocy_locations WHERE supplier_id IN (${ph})`).run(...createdSupplierIds);
        db.prepare(`DELETE FROM suppliers WHERE id IN (${ph})`).run(...createdSupplierIds);
    }
    // Catch-all for navne-prefix
    db.prepare(`DELETE FROM suppliers WHERE name LIKE '${TEST_PREFIX}%'`).run();

    // Slet test-barcodes fra Grocy
    for (const id of createdBarcodeIds) {
        try {
            await api('DELETE', `/api/grocy/product-barcodes/${id}`);
        } catch (err) { console.warn(`  ⚠ barcode cleanup ${id}: ${err.message}`); }
    }

    console.log(`  ✓ Slettet ${createdReceiptIds.length} receipts, ${createdSupplierIds.length} suppliers, ${createdBarcodeIds.length} barcodes`);
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_PATCH_C_REGRESSION_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    let md = `# T_PATCH_C_REGRESSION — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `## Patch-dækning\n\n`;
    md += `| Finding | Cases | Status |\n|---------|-------|--------|\n`;
    const map = {
        '#013 POST': ['01', '02'],
        '#013 PATCH (C-2)': ['07', '08'],
        '#014': ['03'],
        '#015': ['04'],
        'F28':  ['05', '06'],
    };
    for (const [f, ids] of Object.entries(map)) {
        const checkmark = ids.every(suffix => {
            const r = results.find(x => x.id === `${TEST_PREFIX}_${suffix}`);
            return r && r.status === 'PASS';
        }) ? '✓' : '✗';
        md += `| ${f} | ${ids.map(s => `${TEST_PREFIX}_${s}`).join(', ')} | ${checkmark} |\n`;
    }

    if (fails > 0) {
        md += `\n## Fejl\n\n| ID | Detalje |\n|----|---------|\n`;
        for (const f of results.filter(r => r.status === 'FAIL')) {
            md += `| ${f.id} | ${(f.detail || '').replace(/\|/g, '\\|')} |\n`;
        }
    }

    md += `\n## Alle cases\n\n| ID | Gruppe | Status | Note |\n|----|--------|--------|------|\n`;
    for (const r of results) {
        md += `| ${r.id} | ${r.group} | ${r.status} | ${(r.detail || '').replace(/\|/g, '\\|')} |\n`;
    }

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_PATCH_C_REGRESSION] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_PATCH_C_REGRESSION] Server: ${SERVER_URL}`);

    const grocyLocId = await runSetup();
    if (!grocyLocId) {
        db.close();
        const { fails } = writeReport();
        process.exit(fails > 0 ? 1 : 0);
    }

    try {
        await runIntegrationTypeCases();
        await runDuplicateGrocyLocationCase(grocyLocId);
        await runDuplicateBarcodeCase();
        await runItemStatusCases();
        await runPatchEndpointCases();
    } catch (err) {
        console.error('[run_T_PATCH_C_REGRESSION] FEJL:', err.message);
        if (err.stack) console.error(err.stack);
    }

    await cleanup();
    db.close();

    const { passes, fails, skips } = writeReport();
    console.log(`\n[run_T_PATCH_C_REGRESSION] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_PATCH_C_REGRESSION] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
