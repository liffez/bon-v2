#!/usr/bin/env node
/**
 * tests/scripts/run_T_STOCK.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_STOCK-tracken.
 *
 * Tester direkte stock-mutation (setInventory, addToStock) +
 * userfield-CRUD (HverDag/LastCheckedAt/LastCheckedUnit) +
 * enhedstest af status-funktionerne i shared/inventory_check.js
 * og shared/stock_overview.js.
 *
 * Per-case cleanup: snapshot stock + userfields før hver case,
 * restore umiddelbart efter. End-of-run verification mod
 * initial baseline pr. testprodukt.
 *
 * Usage:
 *   npm run test:run-stock
 *   node tests/scripts/run_T_STOCK.js --verbose
 *   node tests/scripts/run_T_STOCK.js --skip-cleanup   (debugging — efterlader skæv state)
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt med opdateret seed_planning.sql
 *   - test:server kører på port fra PORT env
 *   - Grocy test-instans tilgængelig
 *   - shared/inventory_check.js + shared/stock_overview.js har CommonJS-export-guard
 *
 * Reference: tests/specs/T_STOCK.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

// Importér status-funktioner direkte fra produktionsfilerne (via export-guard).
// Hvis disse imports fejler, mangler export-guarden — testen vil rapportere SETUP-fejl.
const invCheck    = require('../../shared/inventory_check');
const stockOvw    = require('../../shared/stock_overview');

const SERVER_URL  = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR  = path.resolve(__dirname, '..', 'reports');

const args = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

// Test-produkter — disjoint fra T_INVENTORY's recipe-driven consume.
// Alle stk-baserede (qu_stock=8/10), Lager varer / Drikkevarer.
const TEST_PRODUCTS = {
    AFFALDSPOSER:    { pid:  87, name: 'Affaldsposer'        },
    BAGEPAPIR:       { pid:  89, name: 'Bagepapir'           },
    ENGANGSHANDSKER: { pid:  95, name: 'Engangshandsker - L' },
    CAVA:            { pid: 205, name: 'Cava'                },
};

const FLOAT_TOL = 0.01;

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

let db;
const results  = [];
const baseline = {};  // pid → { amount, best_before_date, userfields } — initial snapshot

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')       console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP')  console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)            console.log(`  ✓ ${id}`);
}

let SESSION_COOKIE = null;

// Siden #316 (global auth-gate på /api) skal runneren logge ind som enhver
// anden klient — uden session svarer alt 401. Samme mønster som de øvrige
// tracks (fx run_T_OPSKRIFTER.js).
async function login() {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) throw new Error(`Login fejlede: ${res.status}`);
    SESSION_COOKIE = res.headers.get('set-cookie')?.split(';')[0];
    if (!SESSION_COOKIE) throw new Error('Ingen set-cookie modtaget');
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
    if (SESSION_COOKIE) opts.headers['Cookie'] = SESSION_COOKIE;
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res  = await fetch(`${SERVER_URL}${pathPart}`, opts);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

function approxEq(a, b, tol = FLOAT_TOL) {
    return Math.abs(a - b) <= tol;
}

function isoDaysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dateDaysFromNow(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════
// Grocy snapshot helpers
// ════════════════════════════════════════════════════════════

/**
 * Henter alle stock-entries og returnerer den der matcher pid.
 * Grocy returnerer én entry pr. (product_id, best_before_date) — vi tager den med
 * højeste amount eller første hvis kun én.
 */
async function getStockEntry(pid) {
    const res = await api('GET', '/api/grocy/stock');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`GET /api/grocy/stock fejlede: ${res.status}`);
    }
    const entries = res.body.filter(s => parseInt(s.product_id) === pid);
    if (entries.length === 0) {
        return { product_id: pid, amount: 0, best_before_date: null };
    }
    // Aggregér amount hvis flere entries (forskellige best_before)
    const totalAmount = entries.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    return {
        product_id: pid,
        amount: totalAmount,
        best_before_date: entries[0].best_before_date,
        entries  // til debug
    };
}

async function getProductUserfields(pid) {
    const res = await api('GET', '/api/grocy/products');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`GET /api/grocy/products fejlede: ${res.status}`);
    }
    const p = res.body.find(p => parseInt(p.id) === pid);
    if (!p) throw new Error(`Product ${pid} ikke fundet`);
    return p.userfields || {};
}

async function snapshotProduct(pid) {
    const [stock, uf] = await Promise.all([
        getStockEntry(pid),
        getProductUserfields(pid)
    ]);
    return {
        amount: stock.amount,
        best_before_date: stock.best_before_date,
        userfields: { ...uf }
    };
}

/**
 * Restore et produkt til snapshot-tilstand.
 * - Stock: sæt via setInventory (eksakt amount + best_before_date)
 * - Userfields: PUT alle felter (eller tom string for felter ikke i snapshot)
 */
async function restoreProduct(pid, snap) {
    const errors = [];

    // Restore stock (kun hvis amount ≠ 0 — Grocy fjerner entries ved 0)
    try {
        const current = await getStockEntry(pid);
        if (!approxEq(current.amount, snap.amount)) {
            const payload = { amount: snap.amount };
            if (snap.best_before_date) {
                payload.best_before_date = snap.best_before_date;
            }
            const r = await api('POST', `/api/grocy/stock/${pid}/inventory`, payload);
            if (r.status !== 200) {
                errors.push(`stock restore pid=${pid}: status=${r.status} body=${r.raw.slice(0,200)}`);
            }
        }
    } catch (err) {
        errors.push(`stock restore pid=${pid}: ${err.message}`);
    }

    // Restore userfields — kun de felter T_STOCK rører
    const fields = ['HverDag', 'LastCheckedAt', 'LastCheckedUnit'];
    const payload = {};
    let needRestore = false;
    try {
        const current = await getProductUserfields(pid);
        for (const f of fields) {
            const want = snap.userfields[f] !== undefined ? snap.userfields[f] : '';
            const have = current[f] !== undefined ? current[f] : '';
            if (String(want) !== String(have)) {
                payload[f] = want;
                needRestore = true;
            }
        }
        if (needRestore) {
            const r = await api('PUT', `/api/grocy/products/${pid}/userfields`, payload);
            if (r.status !== 200) {
                errors.push(`userfields restore pid=${pid}: status=${r.status} body=${r.raw.slice(0,200)}`);
            }
        }
    } catch (err) {
        errors.push(`userfields restore pid=${pid}: ${err.message}`);
    }

    return errors;
}

// ════════════════════════════════════════════════════════════
// SETUP-cases
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── SETUP ─────────────────────────');

    // T_STOCK_SETUP_01 — testprodukter eksisterer
    try {
        const res = await api('GET', '/api/grocy/products');
        if (res.status !== 200 || !Array.isArray(res.body)) {
            record('T_STOCK_SETUP_01', 'SETUP', 'FAIL', `GET products → status=${res.status}`);
            return false;
        }
        const missing = [];
        for (const key of Object.keys(TEST_PRODUCTS)) {
            const tp = TEST_PRODUCTS[key];
            const p = res.body.find(p => parseInt(p.id) === tp.pid);
            if (!p) {
                missing.push(`pid=${tp.pid}(${tp.name})`);
            } else if (p.active !== 1) {
                missing.push(`pid=${tp.pid}(${tp.name}): active=${p.active}`);
            }
        }
        if (missing.length > 0) {
            record('T_STOCK_SETUP_01', 'SETUP', 'FAIL', `mangler: ${missing.join(', ')}`);
            return false;
        }
        record('T_STOCK_SETUP_01', 'SETUP', 'PASS');
    } catch (err) {
        record('T_STOCK_SETUP_01', 'SETUP', 'FAIL', err.message);
        return false;
    }

    // T_STOCK_SETUP_02 — inventory_check export-guard
    if (typeof invCheck._icParseIntervalDays === 'function'
        && typeof invCheck._icComputeCheckStatus === 'function') {
        record('T_STOCK_SETUP_02', 'SETUP', 'PASS');
    } else {
        record('T_STOCK_SETUP_02', 'SETUP', 'FAIL',
            `inventory_check exports: ${JSON.stringify(Object.keys(invCheck))}`);
        return false;
    }

    // T_STOCK_SETUP_03 — stock_overview export-guard
    if (typeof stockOvw._soRecalcStatus === 'function') {
        record('T_STOCK_SETUP_03', 'SETUP', 'PASS');
    } else {
        record('T_STOCK_SETUP_03', 'SETUP', 'FAIL',
            `stock_overview exports: ${JSON.stringify(Object.keys(stockOvw))}`);
        return false;
    }

    // T_STOCK_SETUP_04 — stock endpoint + pid=87 har amount ≥ 0
    try {
        const stock = await getStockEntry(TEST_PRODUCTS.AFFALDSPOSER.pid);
        if (stock.amount >= 0) {
            record('T_STOCK_SETUP_04', 'SETUP', 'PASS',
                `pid=87 amount=${stock.amount}`);
        } else {
            record('T_STOCK_SETUP_04', 'SETUP', 'FAIL',
                `pid=87 amount=${stock.amount} (negativ?)`);
            return false;
        }
    } catch (err) {
        record('T_STOCK_SETUP_04', 'SETUP', 'FAIL', err.message);
        return false;
    }

    return true;
}

// ════════════════════════════════════════════════════════════
// Initial baseline-snapshot (alle 4 testprodukter)
// ════════════════════════════════════════════════════════════

async function captureBaselines() {
    for (const key of Object.keys(TEST_PRODUCTS)) {
        const tp = TEST_PRODUCTS[key];
        baseline[tp.pid] = await snapshotProduct(tp.pid);
        if (VERBOSE) {
            console.log(`  baseline pid=${tp.pid} ${tp.name}: amount=${baseline[tp.pid].amount}, bb=${baseline[tp.pid].best_before_date}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// setInventory-cases (INV)
// ════════════════════════════════════════════════════════════

async function runInventoryCases() {
    console.log('\n── INV (setInventory) ─────────────');

    // T_STOCK_INV_01 — øg stock
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        const target = before.amount + 5;
        const r = await api('POST', `/api/grocy/stock/${pid}/inventory`, { amount: target });
        if (r.status !== 200) {
            record('T_STOCK_INV_01', 'INV', 'FAIL', `setInventory status=${r.status}`);
        } else {
            const after = await snapshotProduct(pid);
            if (approxEq(after.amount, target)) {
                record('T_STOCK_INV_01', 'INV', 'PASS',
                    `${before.amount} → ${after.amount} (target ${target})`);
            } else {
                record('T_STOCK_INV_01', 'INV', 'FAIL',
                    `forventet ${target}, fik ${after.amount}`);
            }
        }
        // Per-case restore (selvom næste case kører på samme pid og laver ny snapshot,
        // restorer vi for hygiene)
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ INV_01 restore: ${errs.join('; ')}`);
        }
    }

    // T_STOCK_INV_02 — sænk stock
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        const target = Math.max(0.5, before.amount - 3); // undgå 0 (Grocy fjerner entry)
        const r = await api('POST', `/api/grocy/stock/${pid}/inventory`, { amount: target });
        if (r.status !== 200) {
            record('T_STOCK_INV_02', 'INV', 'FAIL', `setInventory status=${r.status}`);
        } else {
            const after = await snapshotProduct(pid);
            if (approxEq(after.amount, target)) {
                record('T_STOCK_INV_02', 'INV', 'PASS',
                    `${before.amount} → ${after.amount} (target ${target})`);
            } else {
                record('T_STOCK_INV_02', 'INV', 'FAIL',
                    `forventet ${target}, fik ${after.amount}`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ INV_02 restore: ${errs.join('; ')}`);
        }
    }

    // T_STOCK_INV_03 — sæt amount + best_before_date
    {
        const pid = TEST_PRODUCTS.BAGEPAPIR.pid;
        const before = await snapshotProduct(pid);
        const targetAmount = before.amount + 2;
        const targetBB = dateDaysFromNow(365 * 4); // ca 4 år frem, men ikke sentinel
        const r = await api('POST', `/api/grocy/stock/${pid}/inventory`,
            { amount: targetAmount, best_before_date: targetBB });
        if (r.status !== 200) {
            record('T_STOCK_INV_03', 'INV', 'FAIL', `setInventory status=${r.status}`);
        } else {
            const after = await snapshotProduct(pid);
            const amountOk = approxEq(after.amount, targetAmount);
            // best_before_date kan være på en separat entry — tjek alle entries
            const fullStock = await api('GET', '/api/grocy/stock');
            const myEntries = fullStock.body.filter(e => parseInt(e.product_id) === pid);
            const bbFound = myEntries.some(e => e.best_before_date === targetBB);
            if (amountOk && bbFound) {
                record('T_STOCK_INV_03', 'INV', 'PASS',
                    `amount=${after.amount}, bb=${targetBB} på entry`);
            } else {
                record('T_STOCK_INV_03', 'INV', 'FAIL',
                    `amount=${after.amount} (target ${targetAmount}), bbFound=${bbFound}, entries=${myEntries.length}`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ INV_03 restore: ${errs.join('; ')}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// addToStock-case (ADD)
// ════════════════════════════════════════════════════════════

async function runAddCases() {
    console.log('\n── ADD (addToStock) ─────────────');

    // T_STOCK_ADD_01 — additivt læg-til
    {
        const pid = TEST_PRODUCTS.ENGANGSHANDSKER.pid;
        const before = await snapshotProduct(pid);
        const addAmount = 10;
        const r = await api('POST', `/api/grocy/stock/${pid}/add`, { amount: addAmount });
        if (r.status !== 200) {
            record('T_STOCK_ADD_01', 'ADD', 'FAIL', `addToStock status=${r.status} body=${r.raw.slice(0,200)}`);
        } else {
            const after = await snapshotProduct(pid);
            const expected = before.amount + addAmount;
            if (approxEq(after.amount, expected)) {
                record('T_STOCK_ADD_01', 'ADD', 'PASS',
                    `${before.amount} + ${addAmount} = ${after.amount}`);
            } else {
                record('T_STOCK_ADD_01', 'ADD', 'FAIL',
                    `forventet ${expected}, fik ${after.amount}`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ ADD_01 restore: ${errs.join('; ')}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Userfield-CRUD (UF)
// ════════════════════════════════════════════════════════════

async function runUserfieldCases() {
    console.log('\n── UF (userfields) ─────────────');

    // T_STOCK_UF_01 — PUT HverDag
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        const r = await api('PUT', `/api/grocy/products/${pid}/userfields`, { HverDag: '7' });
        if (r.status !== 200) {
            record('T_STOCK_UF_01', 'UF', 'FAIL', `PUT status=${r.status}`);
        } else {
            const uf = await getProductUserfields(pid);
            if (String(uf.HverDag) === '7') {
                record('T_STOCK_UF_01', 'UF', 'PASS', `HverDag=${uf.HverDag}`);
            } else {
                record('T_STOCK_UF_01', 'UF', 'FAIL',
                    `forventet HverDag='7', fik '${uf.HverDag}'`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ UF_01 restore: ${errs.join('; ')}`);
        }
    }

    // T_STOCK_UF_02 — PUT LastCheckedAt + LastCheckedUnit
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        const isoNow = new Date().toISOString();
        const r = await api('PUT', `/api/grocy/products/${pid}/userfields`, {
            LastCheckedAt: isoNow,
            LastCheckedUnit: 'KØL-1'
        });
        if (r.status !== 200) {
            record('T_STOCK_UF_02', 'UF', 'FAIL', `PUT status=${r.status}`);
        } else {
            const uf = await getProductUserfields(pid);
            if (uf.LastCheckedAt === isoNow && uf.LastCheckedUnit === 'KØL-1') {
                record('T_STOCK_UF_02', 'UF', 'PASS');
            } else {
                record('T_STOCK_UF_02', 'UF', 'FAIL',
                    `LastCheckedAt='${uf.LastCheckedAt}' (forv. '${isoNow}'), LastCheckedUnit='${uf.LastCheckedUnit}' (forv. 'KØL-1')`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ UF_02 restore: ${errs.join('; ')}`);
        }
    }

    // T_STOCK_UF_03 — isolation: skriv på pid=205, verificer pid=87 uændret
    {
        const pidA = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const pidB = TEST_PRODUCTS.CAVA.pid;
        const beforeA = await snapshotProduct(pidA);
        const beforeB = await snapshotProduct(pidB);

        // Først sæt pid=87 til en kendt værdi
        await api('PUT', `/api/grocy/products/${pidA}/userfields`, { HverDag: '5' });
        const ufBeforeBOp = await getProductUserfields(pidA);

        // Nu skriv på pid=205
        const r = await api('PUT', `/api/grocy/products/${pidB}/userfields`, { HverDag: '14' });
        if (r.status !== 200) {
            record('T_STOCK_UF_03', 'UF', 'FAIL', `PUT pid=205 status=${r.status}`);
        } else {
            const ufA = await getProductUserfields(pidA);
            const ufB = await getProductUserfields(pidB);
            const isolation = String(ufA.HverDag) === '5' && String(ufB.HverDag) === '14';
            if (isolation) {
                record('T_STOCK_UF_03', 'UF', 'PASS',
                    `pid=87 bevarer HverDag=5, pid=205 har HverDag=14`);
            } else {
                record('T_STOCK_UF_03', 'UF', 'FAIL',
                    `pid=87 HverDag=${ufA.HverDag} (forv. 5), pid=205 HverDag=${ufB.HverDag} (forv. 14)`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errsA = await restoreProduct(pidA, beforeA);
            const errsB = await restoreProduct(pidB, beforeB);
            const allErrs = [...errsA, ...errsB];
            if (allErrs.length > 0) console.warn(`  ⚠ UF_03 restore: ${allErrs.join('; ')}`);
        }
    }

    // T_STOCK_UF_04 — observation: hvad gør Grocy med null/tom for HverDag?
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        // Først sæt til '7'
        await api('PUT', `/api/grocy/products/${pid}/userfields`, { HverDag: '7' });
        const ufSet = await getProductUserfields(pid);
        // Forsøg at "rydde" med tom streng
        const r1 = await api('PUT', `/api/grocy/products/${pid}/userfields`, { HverDag: '' });
        const ufAfterEmpty = await getProductUserfields(pid);
        // Forsøg med null
        await api('PUT', `/api/grocy/products/${pid}/userfields`, { HverDag: '7' }); // reset
        const r2 = await api('PUT', `/api/grocy/products/${pid}/userfields`, { HverDag: null });
        const ufAfterNull = await getProductUserfields(pid);

        const obs = {
            after_set:    JSON.stringify(ufSet.HverDag),
            after_empty:  JSON.stringify(ufAfterEmpty.HverDag),
            after_null:   JSON.stringify(ufAfterNull.HverDag),
            status_empty: r1.status,
            status_null:  r2.status
        };
        record('T_STOCK_UF_04', 'UF', 'PASS',
            `Observation: set='7'→${obs.after_set}, PUT ''→${obs.after_empty} (status ${obs.status_empty}), PUT null→${obs.after_null} (status ${obs.status_null})`);

        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ UF_04 restore: ${errs.join('; ')}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Enhedstest — _icComputeCheckStatus (HVERDAG)
// ════════════════════════════════════════════════════════════

function runHverdagUnitCases() {
    console.log('\n── HVERDAG (_icComputeCheckStatus) ─');

    const now = new Date('2026-05-11T12:00:00Z');
    const fn = invCheck._icComputeCheckStatus;

    function assertStatus(id, intervalDays, lastChecked, expectedStatus, extraCheck) {
        try {
            const result = fn(intervalDays, lastChecked, now);
            if (result.status !== expectedStatus) {
                record(id, 'HVERDAG', 'FAIL',
                    `forventet status='${expectedStatus}', fik '${result.status}' (ratio=${result.ratio}, daysSince=${result.daysSince})`);
                return;
            }
            if (extraCheck) {
                const err = extraCheck(result);
                if (err) {
                    record(id, 'HVERDAG', 'FAIL', err);
                    return;
                }
            }
            record(id, 'HVERDAG', 'PASS',
                `status='${result.status}', daysSince=${result.daysSince}`);
        } catch (err) {
            record(id, 'HVERDAG', 'FAIL', err.message);
        }
    }

    // T_STOCK_HVERDAG_01 — intervalDays=null → neutral
    assertStatus('T_STOCK_HVERDAG_01', null, null, 'neutral',
        r => r.daysSince !== null ? `forventet daysSince=null, fik ${r.daysSince}` : null);

    // T_STOCK_HVERDAG_02 — intervalDays=7, lastChecked=null → overdue, daysSince=Infinity
    assertStatus('T_STOCK_HVERDAG_02', 7, null, 'overdue',
        r => r.daysSince !== Infinity ? `forventet daysSince=Infinity, fik ${r.daysSince}` : null);

    // T_STOCK_HVERDAG_03 — 7 dage interval, 10 dage siden → overdue
    {
        const lc = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
        assertStatus('T_STOCK_HVERDAG_03', 7, lc, 'overdue',
            r => r.daysSince !== 10 ? `forventet daysSince=10, fik ${r.daysSince}` : null);
    }

    // T_STOCK_HVERDAG_04 — 7 dage interval, 6 dage siden → soon (ratio 6/7 > 0.8)
    {
        const lc = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        assertStatus('T_STOCK_HVERDAG_04', 7, lc, 'soon',
            r => r.daysSince !== 6 ? `forventet daysSince=6, fik ${r.daysSince}` : null);
    }

    // T_STOCK_HVERDAG_05 — 7 dage interval, 2 dage siden → ok
    {
        const lc = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        assertStatus('T_STOCK_HVERDAG_05', 7, lc, 'ok',
            r => r.daysSince !== 2 ? `forventet daysSince=2, fik ${r.daysSince}` : null);
    }

    // T_STOCK_HVERDAG_06 — 7 dage interval, 0 dage siden → ok
    {
        const lc = new Date(now.getTime());
        assertStatus('T_STOCK_HVERDAG_06', 7, lc, 'ok',
            r => r.daysSince !== 0 ? `forventet daysSince=0, fik ${r.daysSince}` : null);
    }
}

// ════════════════════════════════════════════════════════════
// Enhedstest — _icParseIntervalDays (PARSE)
// ════════════════════════════════════════════════════════════

function runParseUnitCases() {
    console.log('\n── PARSE (_icParseIntervalDays) ─');

    const fn = invCheck._icParseIntervalDays;

    function assertParse(id, uf, expected) {
        try {
            const got = fn(uf);
            if (got === expected) {
                record(id, 'PARSE', 'PASS', `input=${JSON.stringify(uf)} → ${got}`);
            } else {
                record(id, 'PARSE', 'FAIL',
                    `input=${JSON.stringify(uf)} → forv. ${expected}, fik ${got}`);
            }
        } catch (err) {
            record(id, 'PARSE', 'FAIL', err.message);
        }
    }

    assertParse('T_STOCK_PARSE_01', {},                   null);
    assertParse('T_STOCK_PARSE_02', { HverDag: '' },      null);
    assertParse('T_STOCK_PARSE_03', { HverDag: '7' },     7);
    assertParse('T_STOCK_PARSE_04', { HverDag: 'abc' },   null);
    assertParse('T_STOCK_PARSE_05', { HverDag: '-3' },    null);
}

// ════════════════════════════════════════════════════════════
// Enhedstest — _soRecalcStatus (EXPIRY)
// ════════════════════════════════════════════════════════════

function runExpiryUnitCases() {
    console.log('\n── EXPIRY (_soRecalcStatus) ─');

    const fn = stockOvw._soRecalcStatus;

    function assertExpiry(id, item, expectedStatus) {
        try {
            const copy = { ...item };
            fn(copy);
            if (copy.status === expectedStatus) {
                record(id, 'EXPIRY', 'PASS',
                    `status='${copy.status}', daysUntilExpiry=${copy.daysUntilExpiry}`);
            } else {
                record(id, 'EXPIRY', 'FAIL',
                    `forv. status='${expectedStatus}', fik '${copy.status}' (input=${JSON.stringify(item)})`);
            }
        } catch (err) {
            record(id, 'EXPIRY', 'FAIL', err.message);
        }
    }

    assertExpiry('T_STOCK_EXPIRY_01', {
        amount: 5, best_before_date: dateDaysFromNow(-2), min_stock_amount: 0
    }, 'expired');

    assertExpiry('T_STOCK_EXPIRY_02', {
        amount: 5, best_before_date: dateDaysFromNow(3), min_stock_amount: 0
    }, 'duesoon');

    assertExpiry('T_STOCK_EXPIRY_03', {
        amount: 5, best_before_date: dateDaysFromNow(30), min_stock_amount: 0
    }, 'ok');

    assertExpiry('T_STOCK_EXPIRY_04', {
        amount: 2, best_before_date: dateDaysFromNow(30), min_stock_amount: 5
    }, 'low');

    assertExpiry('T_STOCK_EXPIRY_05', {
        amount: 0, best_before_date: '2999-12-31', min_stock_amount: 0
    }, 'low');

    assertExpiry('T_STOCK_EXPIRY_06', {
        amount: 5, best_before_date: '2999-12-31', min_stock_amount: 0
    }, 'ok');
}

// ════════════════════════════════════════════════════════════
// Integration — PUT userfield → GET tilbage → status-funktion
// ════════════════════════════════════════════════════════════

async function runIntegrationCases() {
    console.log('\n── INTEGR (end-to-end) ─────────');

    // T_STOCK_INTEGR_01 — PUT HverDag + LastCheckedAt for 10 dage siden,
    // GET tilbage, fodre ind i _icComputeCheckStatus → forventet 'overdue'
    {
        const pid = TEST_PRODUCTS.AFFALDSPOSER.pid;
        const before = await snapshotProduct(pid);
        const lastCheckedISO = isoDaysAgo(10);

        const r = await api('PUT', `/api/grocy/products/${pid}/userfields`, {
            HverDag: '7',
            LastCheckedAt: lastCheckedISO
        });
        if (r.status !== 200) {
            record('T_STOCK_INTEGR_01', 'INTEGR', 'FAIL', `PUT status=${r.status}`);
        } else {
            const uf = await getProductUserfields(pid);
            const interval = invCheck._icParseIntervalDays(uf);
            const lc = uf.LastCheckedAt ? new Date(uf.LastCheckedAt) : null;
            const result = invCheck._icComputeCheckStatus(interval, lc, new Date());
            if (result.status === 'overdue' && interval === 7) {
                record('T_STOCK_INTEGR_01', 'INTEGR', 'PASS',
                    `Grocy→adapter→funktion: HverDag=${uf.HverDag}, LastCheckedAt set, status='overdue'`);
            } else {
                record('T_STOCK_INTEGR_01', 'INTEGR', 'FAIL',
                    `forventet overdue+interval=7, fik status='${result.status}', interval=${interval}`);
            }
        }
        if (!SKIP_CLEANUP) {
            const errs = await restoreProduct(pid, before);
            if (errs.length > 0) console.warn(`  ⚠ INTEGR_01 restore: ${errs.join('; ')}`);
        }
    }
}

// ════════════════════════════════════════════════════════════
// Final cleanup verification
// ════════════════════════════════════════════════════════════

async function finalCleanupVerify() {
    console.log('\n── FINAL CLEANUP VERIFY ────────');
    if (SKIP_CLEANUP) {
        console.log('  (sprunget pga --skip-cleanup)');
        return;
    }

    const cleanupErrors = [];

    for (const key of Object.keys(TEST_PRODUCTS)) {
        const tp = TEST_PRODUCTS[key];
        const current = await snapshotProduct(tp.pid);
        const base = baseline[tp.pid];

        if (!approxEq(current.amount, base.amount)) {
            cleanupErrors.push(`pid=${tp.pid} (${tp.name}): amount=${current.amount}, baseline=${base.amount}`);
        }

        for (const f of ['HverDag', 'LastCheckedAt', 'LastCheckedUnit']) {
            const want = base.userfields[f] !== undefined ? String(base.userfields[f]) : '';
            const have = current.userfields[f] !== undefined ? String(current.userfields[f]) : '';
            if (want !== have) {
                cleanupErrors.push(`pid=${tp.pid}.${f}: '${have}', baseline='${want}'`);
            }
        }
    }

    if (cleanupErrors.length === 0) {
        record('T_STOCK_CLEANUP_01', 'CLEANUP', 'PASS',
            `${Object.keys(TEST_PRODUCTS).length} produkter restored til baseline`);
    } else {
        record('T_STOCK_CLEANUP_01', 'CLEANUP', 'FAIL',
            `Manuel restore nødvendig: ${cleanupErrors.slice(0, 5).join('; ')}`);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_STOCK_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','INV','ADD','UF','HVERDAG','PARSE','EXPIRY','INTEGR','CLEANUP'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass: inGroup.filter(r => r.status === 'PASS').length,
            fail: inGroup.filter(r => r.status === 'FAIL').length,
            skip: inGroup.filter(r => r.status === 'SKIP').length,
        };
    }

    let md = `# T_STOCK — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
    md += `**Miljø:** ${SERVER_URL} · DB: ${process.env.DB_PATH} · Grocy: ${process.env.GROCY_API_URL}\n\n`;
    md += `## Resumé\n\n`;
    md += `**${passes} PASS · ${fails} FAIL · ${skips} SKIP · total ${results.length}**\n\n`;
    md += `| Gruppe | PASS | FAIL | SKIP |\n|--------|-----:|-----:|-----:|\n`;
    for (const g of groups) {
        if (byGroup[g].pass + byGroup[g].fail + byGroup[g].skip === 0) continue;
        md += `| ${g} | ${byGroup[g].pass} | ${byGroup[g].fail} | ${byGroup[g].skip} |\n`;
    }

    if (fails > 0) {
        md += `\n## Fejl\n\n| ID | Detalje |\n|----|---------|\n`;
        for (const f of results.filter(r => r.status === 'FAIL')) {
            md += `| ${f.id} | ${f.detail.replace(/\|/g, '\\|')} |\n`;
        }
    }

    md += `\n## Alle cases\n\n| ID | Gruppe | Status | Note |\n|----|--------|--------|------|\n`;
    for (const r of results) {
        md += `| ${r.id} | ${r.group} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |\n`;
    }

    fs.writeFileSync(reportPath, md);
    console.log(`\n[run_T_STOCK] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_STOCK] Server: ${SERVER_URL}`);
    console.log(`[run_T_STOCK] Grocy:  ${process.env.GROCY_API_URL}`);
    if (SKIP_CLEANUP) console.log(`[run_T_STOCK] WARNING: --skip-cleanup`);

    await login();

    // Verificér at server svarer
    try {
        const r = await api('GET', '/api/grocy/stock');
        if (r.status !== 200) {
            console.error(`[run_T_STOCK] Server svarer ${r.status} på /api/grocy/stock`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_STOCK] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    // Setup — bryd hvis fejler
    const setupOk = await runSetupCases();
    if (!setupOk) {
        console.error('[run_T_STOCK] Setup fejlede — bryder');
        db.close();
        const { fails } = writeReport();
        process.exit(1);
    }

    // Baseline-snapshot for alle 4 testprodukter (cleanup-fundament)
    await captureBaselines();

    // Stock-mutation
    await runInventoryCases();
    await runAddCases();

    // Userfields
    await runUserfieldCases();

    // Enhedstests (ingen Grocy-kald)
    runHverdagUnitCases();
    runParseUnitCases();
    runExpiryUnitCases();

    // Integration
    await runIntegrationCases();

    // Verify alt er restoreret
    await finalCleanupVerify();

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_STOCK] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_STOCK] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
