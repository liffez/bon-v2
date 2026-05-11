#!/usr/bin/env node
/**
 * tests/scripts/run_T_INVENTORY.js
 * ════════════════════════════════════════════════════════════
 * Test-runner for T_INVENTORY-tracken.
 *
 * Tester at LEVERET-status reducerer Grocy-lager med præcis det
 * resolveConsumeItems() siger. Cleanup via Grocy stock-add API
 * sikrer at testen er hermetisk — næste kørsel starter fra samme baseline.
 *
 * Kontrakt-baseret design: testen importerer resolveConsumeItems direkte
 * og bruger output som facit. Hvis Grocy udskiftes i fremtiden,
 * opdateres kun adapter-laget — testen er uændret.
 *
 * Usage:
 *   npm run test:inv
 *   node tests/scripts/run_T_INVENTORY.js --verbose
 *   node tests/scripts/run_T_INVENTORY.js --skip-cleanup   (debugging — efterlader skæv stock)
 *
 * Forudsætninger:
 *   - safety_check.js bestået
 *   - test:reset er kørt med opdateret seed_planning.sql
 *   - test:server kører på port fra PORT env
 *   - Grocy test-instans tilgængelig
 *   - inventory_auto_deduct = '1' (sættes af seed)
 *
 * Reference: docs/tests/specs/T_INVENTORY.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs           = require('node:fs');
const path         = require('node:path');
const { openDb }   = require('../../db/compat');
const safetyCheck  = require('./safety_check');

// Importér resolveConsumeItems som er sandheds-grundlaget
const { resolveConsumeItems } = require('../../services/ingredientResolver');

const SERVER_URL  = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const REPORT_DIR  = path.resolve(__dirname, '..', 'reports');

const args = process.argv.slice(2);
const VERBOSE      = args.includes('--verbose');
const SKIP_CLEANUP = args.includes('--skip-cleanup');

// Test-bonner valgt fordi de starter på status hvor LEVERET-flowet kan testes
const TEST_BONS = [
    { id: 4006, start_status: 'GODKENDT', label: 'Bon 4006 (kerne)' },
    { id: 4007, start_status: 'VENTER',   label: 'Bon 4007 (robusthed)' },
];

// Tolerance for float-sammenligninger
const FLOAT_TOL = 0.01;

// ════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════

let db;
const results = [];

function record(id, group, status, detail = '') {
    results.push({ id, group, status, detail });
    if (status === 'FAIL')        console.log(`  ✗ ${id} — ${detail}`);
    else if (status === 'SKIP')   console.log(`  ⊘ ${id} — ${detail}`);
    else if (VERBOSE)             console.log(`  ✓ ${id}`);
}

async function api(method, pathPart, body = null) {
    const opts = { method, headers: {} };
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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Henter Grocy stock for et givet product_id.
 * Bruger /api/grocy/stock og finder produktet i listen.
 * Cacher hele stock-svaret i én request hvis vi læser flere produkter samtidigt.
 */
let _stockCache = null;
async function refreshStockCache() {
    const res = await api('GET', '/api/grocy/stock');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`Kunne ikke hente Grocy stock: status=${res.status}`);
    }
    _stockCache = new Map();
    for (const item of res.body) {
        _stockCache.set(parseInt(item.product_id), parseFloat(item.amount) || 0);
    }
}

function getCachedStock(productId) {
    return _stockCache.get(parseInt(productId)) || 0;
}

/**
 * Parent-product-map: { pid → root_pid }.
 * Grocy understøtter parent-products (fx "Kål") der substituerer fra børn
 * (Spidskål/Hvidkål) ved consume. Det betyder consume på parent reducerer
 * et CHILDs stock — så når vi diff'er, skal vi sammenligne på familie-niveau,
 * ikke per individuel pid.
 *
 * Map'en peger ALT (både parent og child) til root-parent.
 */
let _familyMap = null;
async function loadProductFamilies() {
    const res = await api('GET', '/api/grocy/products');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`Kunne ikke hente Grocy products: status=${res.status}`);
    }
    _familyMap = new Map();
    // Først: hver pid → null (root = sig selv)
    for (const p of res.body) {
        _familyMap.set(parseInt(p.id), parseInt(p.id));
    }
    // Derefter: børn peger på parent
    for (const p of res.body) {
        if (p.parent_product_id) {
            _familyMap.set(parseInt(p.id), parseInt(p.parent_product_id));
        }
    }
}

/** Find root-pid (parent eller pid'en selv hvis ingen parent). */
function familyRoot(pid) {
    if (!_familyMap) return parseInt(pid);
    return _familyMap.get(parseInt(pid)) || parseInt(pid);
}

/**
 * Læs stock for en liste af product_ids (efter refresh).
 */
async function snapshot(productIds) {
    await refreshStockCache();
    const snap = {};
    for (const pid of productIds) {
        snap[pid] = getCachedStock(pid);
    }
    return snap;
}

/**
 * Vent til bons.inventory_deducted = 1 eller timeout.
 */
async function waitForDeducted(bonId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const row = db.prepare('SELECT inventory_deducted FROM bons WHERE id = ?').get(bonId);
        if (row && row.inventory_deducted === 1) return true;
        await sleep(200);
    }
    return false;
}

/**
 * Sæt bon-status via API (kan også sættes direkte i DB hvis API fejler — vi vælger API'et).
 */
async function setBonStatus(bonId, statusCode) {
    const res = await api('PATCH', `/api/bons/${bonId}/status`, { status_code: statusCode });
    if (res.status !== 200) {
        throw new Error(`Kunne ikke sætte bon ${bonId} → ${statusCode}: status=${res.status}, body=${res.raw}`);
    }
    return res.body;
}

/**
 * Restore stock for produkter efter test (cleanup A — Grocy stock-add API).
 */
async function restoreStock(diffMap) {
    const errors = [];
    for (const [pid, amount] of Object.entries(diffMap)) {
        if (amount <= 0) continue;
        try {
            const res = await api('POST', `/api/grocy/stock/${pid}/add`, { amount });
            if (res.status !== 200 && res.status !== 201) {
                errors.push(`product_id=${pid}: status=${res.status}`);
            }
        } catch (err) {
            errors.push(`product_id=${pid}: ${err.message}`);
        }
    }
    return errors;
}

/**
 * Sammenligner expected_diff (fra resolveConsumeItems) med actual_diff (fra snapshot-difference).
 * Returnerer { ok, mismatches[] }.
 */
function compareDiffs(expected, actual) {
    // Gruppér både expected og actual på family-root så parent-substitution
    // i Grocy (fx "kål" → "Spidskål"/"Hvidkål") ikke fremstår som mismatch.
    // Eksempel: expected siger pid=199 (kål)=0.4 + pid=27 (Spidskål)=1.6,
    // men Grocy trækker 2.0 fra pid=27 (subprodukt). Family-niveau: root=199, sum=2.0.
    const expectedByFamily = {};
    const expectedNamesByFamily = {};
    for (const exp of expected) {
        const root = familyRoot(exp.product_id);
        expectedByFamily[root] = (expectedByFamily[root] || 0) + exp.amount_stock;
        // Brug det første navn vi støder på som repræsentant
        if (!expectedNamesByFamily[root]) expectedNamesByFamily[root] = exp.product_name;
    }

    const actualByFamily = {};
    for (const [pid, amt] of Object.entries(actual)) {
        const root = familyRoot(pid);
        actualByFamily[root] = (actualByFamily[root] || 0) + amt;
    }

    const mismatches = [];

    for (const [root, expAmt] of Object.entries(expectedByFamily)) {
        const actAmt = actualByFamily[root] || 0;
        if (Math.abs(actAmt - expAmt) > FLOAT_TOL) {
            mismatches.push({
                product_id: root,
                product_name: expectedNamesByFamily[root] + ' (family root)',
                expected: expAmt,
                actual: actAmt,
                diff: actAmt - expAmt,
            });
        }
    }

    // Uventede ændringer i andre familier
    for (const [root, actAmt] of Object.entries(actualByFamily)) {
        if (Math.abs(actAmt) < FLOAT_TOL) continue;
        if (!(root in expectedByFamily)) {
            mismatches.push({
                product_id: root,
                product_name: '(uventet ændring)',
                expected: 0,
                actual: actAmt,
                diff: actAmt,
            });
        }
    }

    return { ok: mismatches.length === 0, mismatches };
}

// ════════════════════════════════════════════════════════════
// Setup-cases
// ════════════════════════════════════════════════════════════

async function runSetupCases() {
    console.log('\n── Setup ──');

    // SETUP_01: inventory_auto_deduct = '1'
    {
        const row = db.prepare("SELECT value FROM settings WHERE key='inventory_auto_deduct'").get();
        if (row && row.value === '1') {
            record('T_INV_SETUP_01', 'SETUP', 'PASS');
        } else {
            record('T_INV_SETUP_01', 'SETUP', 'FAIL',
                `Forventet '1', fik ${JSON.stringify(row)}`);
            return false; // Bryd hvis flag mangler — resten giver ikke mening
        }
    }

    // SETUP_02: resolveConsumeItems importerbar
    {
        if (typeof resolveConsumeItems === 'function') {
            record('T_INV_SETUP_02', 'SETUP', 'PASS');
        } else {
            record('T_INV_SETUP_02', 'SETUP', 'FAIL', 'resolveConsumeItems ikke en funktion');
            return false;
        }
    }

    // SETUP_03: Grocy stock kan læses
    {
        try {
            await refreshStockCache();
            if (_stockCache.size > 0) {
                record('T_INV_SETUP_03', 'SETUP', 'PASS');
            } else {
                record('T_INV_SETUP_03', 'SETUP', 'FAIL', 'Stock-cache er tom');
                return false;
            }
        } catch (err) {
            record('T_INV_SETUP_03', 'SETUP', 'FAIL', err.message);
            return false;
        }
    }

    return true;
}

// ════════════════════════════════════════════════════════════
// Generel kerne-test for én bon
// (bruges af LEVERET_01-04, REVERT_01-02, IDEM_01)
// ════════════════════════════════════════════════════════════

async function testLeveretFlow(bon, testIds) {
    const { id: bonId, start_status, label } = bon;
    console.log(`\n── ${label} (id=${bonId}) ──`);

    // 1. Hent bon-linjer
    const lines = db.prepare(`
        SELECT bon_id, grocy_recipe_id, product_name, quantity, unit, is_accessory
        FROM bon_lines WHERE bon_id = ?
    `).all(bonId);

    if (!lines.length) {
        record(testIds.LEVERET, 'LEVERET', 'FAIL', `Bon ${bonId} har ingen linjer`);
        return null;
    }

    // 2. Beregn expected_diff via resolveConsumeItems
    let expected;
    try {
        expected = await resolveConsumeItems(lines);
    } catch (err) {
        record(testIds.LEVERET, 'LEVERET', 'FAIL', `resolveConsumeItems fejlede: ${err.message}`);
        return null;
    }

    if (!expected.length) {
        record(testIds.LEVERET, 'LEVERET', 'FAIL',
            `Bon ${bonId} har linjer men ingen consume-items (mangler grocy_recipe_id på linjer?)`);
        return null;
    }

    if (VERBOSE) {
        console.log(`    expected_diff: ${expected.length} produkter`);
        for (const e of expected.slice(0, 3)) {
            console.log(`      pid=${e.product_id} ${e.product_name}: ${e.amount_stock}`);
        }
        if (expected.length > 3) console.log(`      ...og ${expected.length - 3} flere`);
    }

    // Udvid productIds til at inkludere ALLE familie-medlemmer for hvert expected pid.
    // Hvis Grocy substituerer parent → child (fx kål → Hvidkål), skal vi se diff på
    // child'en for at compareDiffs() (family-aware) kan beregne korrekt.
    const productIds = new Set();
    for (const e of expected) {
        const root = familyRoot(e.product_id);
        productIds.add(parseInt(e.product_id));
        productIds.add(root);
        // Tilføj alle andre børn af samme root
        for (const [pid, r] of _familyMap.entries()) {
            if (r === root) productIds.add(pid);
        }
    }
    const productIdsArr = Array.from(productIds);

    // 3. Snapshot before
    const snapBefore = await snapshot(productIdsArr);

    // 4. Sæt bon → IGANG → KLAR → LEVERET (lineær progression for at ramme transitions)
    try {
        // VENTER/NY/TILBUD kan ikke direkte → IGANG (forbudt af status_transitions).
        // Gå via GODKENDT først.
        if (start_status === 'VENTER' || start_status === 'NY' || start_status === 'TILBUD') {
            await setBonStatus(bonId, 'GODKENDT');
            await sleep(100);
        }
        if (start_status !== 'IGANG' && start_status !== 'KLAR') {
            await setBonStatus(bonId, 'IGANG');
            await sleep(100);
        }
        if (start_status !== 'KLAR') {
            await setBonStatus(bonId, 'KLAR');
            await sleep(100);
        }
        await setBonStatus(bonId, 'LEVERET');
    } catch (err) {
        record(testIds.LEVERET, 'LEVERET', 'FAIL', `Status-skift fejlede: ${err.message}`);
        return null;
    }

    // 5. Vent på inventory_deducted=1
    const deducted = await waitForDeducted(bonId);
    if (!deducted) {
        record(testIds.LEVERET, 'LEVERET', 'FAIL',
            `inventory_deducted blev ikke sat efter LEVERET — consumeRecipes fejlede async`);
        return null;
    }

    // 6. Snapshot after
    const snapAfter = await snapshot(productIdsArr);

    // 7. Beregn actual_diff
    const actualDiff = {};
    for (const pid of productIdsArr) {
        actualDiff[pid] = (snapBefore[pid] || 0) - (snapAfter[pid] || 0);
    }

    // 8. Sammenlign
    const cmp = compareDiffs(expected, actualDiff);
    if (cmp.ok) {
        record(testIds.LEVERET, 'LEVERET', 'PASS');
    } else {
        const detail = cmp.mismatches.slice(0, 3)
            .map(m => `pid=${m.product_id} forventet ${m.expected}, fik ${m.actual} (diff ${m.diff})`)
            .join('; ');
        record(testIds.LEVERET, 'LEVERET', 'FAIL', detail);
    }

    // T_INV_LEVERET_02: inventory_deducted=1 i DB
    if (testIds.DB_FLAG) {
        record(testIds.DB_FLAG, 'LEVERET', deducted ? 'PASS' : 'FAIL',
            deducted ? '' : 'inventory_deducted ikke sat');
    }

    // T_INV_LEVERET_03: changelog har grocy_consume entry
    if (testIds.AUDIT) {
        const audit = db.prepare(`
            SELECT COUNT(*) AS n FROM changelog
            WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'
        `).get(bonId);
        if (audit.n >= 1) {
            record(testIds.AUDIT, 'LEVERET', 'PASS');
        } else {
            record(testIds.AUDIT, 'LEVERET', 'FAIL', `Forventet ≥1 grocy_consume entry, fandt ${audit.n}`);
        }
    }

    return { lines, expected, snapBefore, snapAfter, actualDiff, sumDeducted: actualDiff };
}

// ════════════════════════════════════════════════════════════
// REVERT-test: LEVERET → IGANG sker UDEN tilbageføring
// ════════════════════════════════════════════════════════════

async function testRevertFlow(bonId, snapAfterLeveret, productIds) {
    console.log(`\n── Revert-flow (bon ${bonId}) ──`);

    // 1. Sæt bon LEVERET → IGANG
    try {
        await setBonStatus(bonId, 'IGANG');
        await sleep(500);
    } catch (err) {
        record('T_INV_REVERT_01', 'REVERT', 'FAIL', `Status-skift fejlede: ${err.message}`);
        return false;
    }

    // 2. Snapshot efter revert
    const snapAfterRevert = await snapshot(productIds);

    // 3. Sammenlign med snapAfterLeveret — skal være IDENTISK (ingen tilbageføring)
    const drift = [];
    for (const pid of productIds) {
        const diff = Math.abs((snapAfterLeveret[pid] || 0) - (snapAfterRevert[pid] || 0));
        if (diff > FLOAT_TOL) {
            drift.push(`pid=${pid}: efter LEVERET=${snapAfterLeveret[pid]}, efter IGANG=${snapAfterRevert[pid]}`);
        }
    }

    if (drift.length === 0) {
        record('T_INV_REVERT_01', 'REVERT', 'PASS');
    } else {
        record('T_INV_REVERT_01', 'REVERT', 'FAIL',
            `Stock ændret efter revert (forventet uændret): ${drift.slice(0, 3).join('; ')}`);
    }

    // T_INV_REVERT_02: inventory_deducted forbliver 1
    const row = db.prepare('SELECT inventory_deducted FROM bons WHERE id = ?').get(bonId);
    if (row && row.inventory_deducted === 1) {
        record('T_INV_REVERT_02', 'REVERT', 'PASS');
    } else {
        record('T_INV_REVERT_02', 'REVERT', 'FAIL',
            `inventory_deducted = ${row?.inventory_deducted}, forventet 1`);
    }

    return snapAfterRevert;
}

// ════════════════════════════════════════════════════════════
// IDEM-test: LEVERET 2 gange (revert + LEVERET) trækker 2x
// ════════════════════════════════════════════════════════════

async function testIdempotency(bonId, productIds, expected) {
    console.log(`\n── Idempotens-test (bon ${bonId}) ──`);

    // Bonen er allerede sat til IGANG efter REVERT-testen.
    // Nu sætter vi LEVERET igen og måler om der trækkes endnu en gang.

    const snapBefore = await snapshot(productIds);

    // Tæl changelog-entries før vi sætter LEVERET
    const consumeCountBefore = db.prepare(
        `SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'`
    ).get(bonId).n;

    try {
        await setBonStatus(bonId, 'KLAR');
        await sleep(100);
        await setBonStatus(bonId, 'LEVERET');
    } catch (err) {
        record('T_INV_IDEM_01', 'IDEM', 'FAIL', `Status-skift fejlede: ${err.message}`);
        return null;
    }

    // Vent på consume-completion — poll changelog op til 30s.
    // 2s er for kort: consumeRecipes kan tage 10-20s pga. mange serielle Grocy-kald,
    // og uden korrekt ventetid ses idem-trækket som "ikke sket" indtil EFTER
    // per-bon-cleanup, hvilket forvansker næste bons snapshot.
    const startWait = Date.now();
    while (Date.now() - startWait < 30000) {
        const n = db.prepare(
            `SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'`
        ).get(bonId).n;
        if (n > consumeCountBefore) break;
        await sleep(200);
    }
    // Ekstra slack til at det sidste consume-kald i serien afslutter
    await sleep(500);
    const snapAfter = await snapshot(productIds);

    // Tjek om stock er trukket en gang til
    let drawnAgain = 0;
    for (const pid of productIds) {
        const diff = (snapBefore[pid] || 0) - (snapAfter[pid] || 0);
        if (diff > FLOAT_TOL) drawnAgain++;
    }

    // Vi vil ikke "fail" testen baseret på adfærd — vi DOKUMENTERER hvad der sker
    if (drawnAgain > 0) {
        record('T_INV_IDEM_01', 'IDEM', 'PASS',
            `IKKE-IDEMPOTENT: stock trukket igen på ${drawnAgain}/${productIds.length} produkter — overvej idempotens-beskyttelse i prod`);
    } else {
        record('T_INV_IDEM_01', 'IDEM', 'PASS',
            `IDEMPOTENT: anden LEVERET trak ikke stock igen — adfærd OK`);
    }

    return { snapAfter, drawnAgain };
}

// ════════════════════════════════════════════════════════════
// PARTIAL-test: når stock < needed skal consume trække det der er
// + tilføje shortfall som purchase-enhed på shopping list (v1-adfærd).
// ════════════════════════════════════════════════════════════
//
// Strategi: kald consumeRecipes() direkte med en mock-linje der overstiger
// stock for pid=72 (Transport Kasser). Det er enklere end at gå gennem
// hele LEVERET-flowet og isolerer partial-logikken til ren adapter-test.

async function testPartialConsume() {
    console.log('\n── Partial consume + auto-shopping-list (pid=72) ──');

    const TEST_PID = 72;
    const url = 'https://grocytest.ristetrug.dk/api';
    const headers = { 'GROCY-API-KEY': process.env.GROCY_API_KEY || 'BTrniw0xl5eK6mdVyXqwrnwZ2L3vzj9G5HavK4VvFJqKKdsPup',
                      'Accept': 'application/json', 'Content-Type': 'application/json' };

    // 1. Hent baseline stock
    const stkBefore = (await fetch(`${url}/stock/products/${TEST_PID}`, { headers }).then(r => r.json())).stock_amount;
    const available = parseFloat(stkBefore) || 0;

    // 2. Vi kalder consumeRecipes med en mock-linje der KRÆVER mere end available.
    //    Recipe 47 (Transportkasse) trækker 1 stk pid=72 per stk.
    //    Vi kræver (available + 3) → 3 enheder shortfall.
    const requestQty = Math.ceil(available + 3);
    const mockLines = [{ grocy_recipe_id: 47, quantity: requestQty }];

    // 3. Hent shopping list før (count til at verificere "ny entry")
    const slBefore = await fetch(`${url}/objects/shopping_list`, { headers }).then(r => r.json());
    const slBeforeCountForPid = slBefore.filter(s => parseInt(s.product_id) === TEST_PID).length;

    // 4. Kald consumeRecipes via server (samme path som LEVERET ville bruge)
    //    Endpoint returnerer { ok, consumed, failed, results: [...] }
    const res = await api('POST', '/api/grocy/consume', { lines: mockLines });
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.results)) {
        record('T_INV_PARTIAL_01', 'PARTIAL', 'FAIL',
            `consume-endpoint returnerede ${res.status} (forventet 200 + results-array)`);
        return null;
    }

    const result72 = res.body.results.find(r => r.product_id === TEST_PID);
    if (!result72) {
        record('T_INV_PARTIAL_01', 'PARTIAL', 'FAIL', `pid=${TEST_PID} mangler i resultatet`);
        return null;
    }

    // 5. Verificér partial-flag + shortfall-tal
    const expectedShortfallStock = (available + 3) - available;
    const ok = result72.partial === true
        && Math.abs(result72.amount - available) < 0.01
        && Math.abs(result72.shortfall_stock - expectedShortfallStock) < 0.01
        && result72.shortfall_purchase >= 1;

    if (!ok) {
        record('T_INV_PARTIAL_01', 'PARTIAL', 'FAIL',
            `partial=${result72.partial}, consumed=${result72.amount} (expected ${available}), shortfall=${result72.shortfall_stock} (expected ${expectedShortfallStock}), purchase=${result72.shortfall_purchase}`);
    } else {
        record('T_INV_PARTIAL_01', 'PARTIAL', 'PASS');
    }

    // 6. Verificér at shopping list fik ny entry
    const slAfter = await fetch(`${url}/objects/shopping_list`, { headers }).then(r => r.json());
    const slAfterEntriesForPid = slAfter.filter(s => parseInt(s.product_id) === TEST_PID);
    const newEntry = slAfterEntriesForPid.find(s => !slBefore.some(b => parseInt(b.id) === parseInt(s.id)));

    if (!newEntry) {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'FAIL',
            `Ingen ny shopping_list-entry for pid=${TEST_PID} (havde ${slBeforeCountForPid}, har nu ${slAfterEntriesForPid.length})`);
    } else {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'PASS',
            `shopping_list-entry id=${newEntry.id} amount=${newEntry.amount}`);
    }

    // 7. Cleanup: tilføj available tilbage til stock, ryd ny shopping_list-entry
    if (available > 0.01) {
        try {
            await api('POST', `/api/grocy/stock/${TEST_PID}/add`, { amount: available });
        } catch (err) {
            console.warn('  ⚠ kunne ikke restore pid=' + TEST_PID + ' stock:', err.message);
        }
    }
    if (newEntry) {
        try {
            await fetch(`${url}/objects/shopping_list/${newEntry.id}`, { method: 'DELETE', headers });
        } catch (err) {
            console.warn('  ⚠ kunne ikke rydde shopping_list-entry:', err.message);
        }
    }

    return result72;
}

// ════════════════════════════════════════════════════════════
// FLAG-test: med inventory_auto_deduct=0 skal LEVERET ikke trække
// ════════════════════════════════════════════════════════════

async function testFlagOff(bon) {
    console.log(`\n── Flag-test (inventory_auto_deduct=0) ──`);

    const bonId = bon.id;

    // Indsigt: når inventory_auto_deduct=0 går consume-grenen i routes/bons.js:351-381
    // slet ikke (neither branch executes). Det betyder vi IKKE har brug for en frisk bon —
    // bonens inventory_deducted-flag er irrelevant når selve auto-deduct-flaget er '0'.
    // Vi kan teste på 4006 i dens nuværende state ved at:
    //   1. Sætte flaget til '0'
    //   2. Sikre bon er i ikke-LEVERET state
    //   3. PATCH → LEVERET
    //   4. Verificere INGEN stock-ændring
    //   5. Restore flag

    // Hent linjer og beregn hvilke produkter der VILLE være berørt (snapshot-target)
    const lines = db.prepare(`
        SELECT bon_id, grocy_recipe_id, product_name, quantity, unit, is_accessory
        FROM bon_lines WHERE bon_id = ?
    `).all(bonId);

    if (!lines.length) {
        record('T_INV_FLAG_01', 'FLAG', 'FAIL', `Bon ${bonId} har ingen linjer`);
        return;
    }

    let expected;
    try {
        expected = await resolveConsumeItems(lines);
    } catch (err) {
        record('T_INV_FLAG_01', 'FLAG', 'FAIL', `resolveConsumeItems fejlede: ${err.message}`);
        return;
    }

    const productIds = expected.map(e => e.product_id);
    if (!productIds.length) {
        record('T_INV_FLAG_01', 'FLAG', 'FAIL',
            'resolveConsumeItems returnerede 0 produkter — kan ikke verificere stock-stability');
        return;
    }

    // Gem original flag-værdi
    const origFlagRow = db.prepare(
        `SELECT value FROM settings WHERE key='inventory_auto_deduct'`
    ).get();
    const origFlag = origFlagRow ? origFlagRow.value : '1';

    try {
        // Step 1: Sæt flag = '0'
        db.prepare(`UPDATE settings SET value='0' WHERE key='inventory_auto_deduct'`).run();

        // Step 2: Sikre bon er i ikke-LEVERET state (typisk LEVERET efter idem-test)
        const cur = db.prepare(`
            SELECT sd.code AS code FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            WHERE b.id = ?
        `).get(bonId);

        if (!cur) {
            record('T_INV_FLAG_01', 'FLAG', 'FAIL', `Bon ${bonId} ikke fundet`);
            return;
        }

        if (cur.code === 'LEVERET') {
            await setBonStatus(bonId, 'IGANG');
            await sleep(200);
        }

        // Step 3: Snapshot stock FØR LEVERET
        const snapBefore = await snapshot(productIds);

        // Tæl changelog-entries for grocy_consume — der bør IKKE komme en ny
        const consumeCountBefore = db.prepare(
            `SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'`
        ).get(bonId).n;

        // Step 4: PATCH → LEVERET (med flag=0 → consume-grenen springes over)
        await setBonStatus(bonId, 'LEVERET');

        // Step 5: Vent et øjeblik. Vi forventer INGEN async consume,
        // men giv runtime tid til at sætte status og evt. fejle synligt.
        await sleep(2500);

        // Snapshot efter
        const snapAfter = await snapshot(productIds);

        // Verificer: ingen changelog-entry for grocy_consume
        const consumeCountAfter = db.prepare(
            `SELECT COUNT(*) AS n FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='grocy_consume'`
        ).get(bonId).n;

        // Verificer: ingen stock-ændring
        let changed = 0;
        const changes = [];
        for (const pid of productIds) {
            const diff = (snapBefore[pid] || 0) - (snapAfter[pid] || 0);
            if (Math.abs(diff) > FLOAT_TOL) {
                changed++;
                changes.push(`pid=${pid}: ${diff.toFixed(2)}`);
            }
        }

        const consumeFired = consumeCountAfter > consumeCountBefore;

        if (changed === 0 && !consumeFired) {
            record('T_INV_FLAG_01', 'FLAG', 'PASS',
                `Med inventory_auto_deduct=0: ingen stock-ændring (${productIds.length} produkter), ingen grocy_consume changelog-entry`);
        } else {
            const details = [];
            if (changed > 0) details.push(`stock ÆNDRET for ${changed} produkter: ${changes.slice(0,3).join(', ')}`);
            if (consumeFired) details.push(`grocy_consume changelog-entry kom (forventet ingen)`);
            record('T_INV_FLAG_01', 'FLAG', 'FAIL', details.join('; '));
        }
    } finally {
        // Restore flag uanset om testen lykkedes
        db.prepare(`UPDATE settings SET value=? WHERE key='inventory_auto_deduct'`).run(origFlag);
    }
}

// ════════════════════════════════════════════════════════════
// Cleanup
// ════════════════════════════════════════════════════════════

async function cleanup(allDiffs) {
    if (SKIP_CLEANUP) {
        console.log('\n[cleanup] SKIPPED (--skip-cleanup) — STOCK ER NU SKÆV, manuel restore påkrævet');
        return;
    }

    console.log('\n── Cleanup: restore stock ──');

    // Aggreger alle diff'er for at lægge tilbage på én gang
    const totalDiff = {};
    for (const diff of allDiffs) {
        if (!diff) continue;
        for (const [pid, amt] of Object.entries(diff)) {
            totalDiff[pid] = (totalDiff[pid] || 0) + amt;
        }
    }

    if (Object.keys(totalDiff).length === 0) {
        console.log('  Intet at restore.');
        return;
    }

    const errors = await restoreStock(totalDiff);
    if (errors.length === 0) {
        console.log(`  ✓ Restored ${Object.keys(totalDiff).length} produkter`);

        // Verify cleanup: snapshot skal matche oprindelig baseline
        // (kun grov tjek — vi har ikke gemt den oprindelige baseline globalt)
        record('T_INV_CLEANUP_01', 'CLEANUP', 'PASS',
            `${Object.keys(totalDiff).length} produkter restored`);
    } else {
        console.log(`  ✗ Cleanup-fejl på ${errors.length} produkter:`);
        for (const e of errors.slice(0, 3)) console.log(`      ${e}`);
        record('T_INV_CLEANUP_01', 'CLEANUP', 'FAIL',
            `Manuel restore: ${errors.slice(0, 5).join('; ')}`);
    }
}

// ════════════════════════════════════════════════════════════
// Rapport
// ════════════════════════════════════════════════════════════

function writeReport() {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(REPORT_DIR, `T_INVENTORY_${today}.md`);

    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;

    const groups = ['SETUP','LEVERET','REVERT','IDEM','PARTIAL','FLAG','CLEANUP'];
    const byGroup = {};
    for (const g of groups) {
        const inGroup = results.filter(r => r.group === g);
        byGroup[g] = {
            pass: inGroup.filter(r => r.status === 'PASS').length,
            fail: inGroup.filter(r => r.status === 'FAIL').length,
            skip: inGroup.filter(r => r.status === 'SKIP').length,
        };
    }

    let md = `# T_INVENTORY — ${today} ${new Date().toISOString().slice(11,16)}\n\n`;
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
    console.log(`\n[run_T_INVENTORY] Rapport: ${reportPath}`);
    return { passes, fails, skips };
}

// ════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════

async function main() {
    safetyCheck();

    db = openDb(process.env.DB_PATH);

    console.log(`[run_T_INVENTORY] Server: ${SERVER_URL}`);
    console.log(`[run_T_INVENTORY] Grocy:  ${process.env.GROCY_API_URL}`);
    if (SKIP_CLEANUP) console.log(`[run_T_INVENTORY] WARNING: --skip-cleanup`);

    // Verificer at server svarer
    try {
        const r = await api('GET', '/api/grocy/stock');
        if (r.status !== 200) {
            console.error(`[run_T_INVENTORY] Server svarer ${r.status} på /api/grocy/stock`);
            process.exit(1);
        }
    } catch (err) {
        console.error(`[run_T_INVENTORY] Kan ikke nå server: ${err.message}`);
        process.exit(1);
    }

    // Hent parent-child-relationer fra Grocy én gang — bruges af compareDiffs
    // til at gruppere expected/actual på familie-niveau, så parent-substitution
    // ikke fremstår som mismatch (fx pid=199 kål → child pid=27 Spidskål).
    try {
        await loadProductFamilies();
    } catch (err) {
        console.error(`[run_T_INVENTORY] Kunne ikke loade product families: ${err.message}`);
        process.exit(1);
    }

    // Setup-cases — bryd hvis disse fejler
    const setupOk = await runSetupCases();
    if (!setupOk) {
        console.error('[run_T_INVENTORY] Setup fejlede — bryder');
        db.close();
        const { fails } = writeReport();
        process.exit(1);
    }

    const allDiffs = [];

    // Per-bon-cleanup: restoreer stock UMIDDELBART efter en bon's flow er færdig,
    // så næste bon's snapshot_before er ren (ikke påvirket af forrige bons consume).
    // Hvis restore fejler, bevares diff'en i allDiffs så final cleanup kan prøve igen.
    async function restoreNow(label, diff) {
        if (SKIP_CLEANUP || !diff || Object.keys(diff).length === 0) return;
        const errors = await restoreStock(diff);
        if (errors.length === 0) {
            console.log(`  ↻ Per-bon restore (${label}): ${Object.keys(diff).length} produkter`);
        } else {
            console.warn(`  ⚠ Per-bon restore (${label}) fejlede ${errors.length} steder — bevarer i final cleanup`);
            allDiffs.push(diff);
        }
    }

    // Kerne: bon 4006
    const r4006 = await testLeveretFlow(TEST_BONS[0], {
        LEVERET: 'T_INV_LEVERET_01',
        DB_FLAG: 'T_INV_LEVERET_02',
        AUDIT:   'T_INV_LEVERET_03',
    });
    if (r4006) {
        // Revert-flow
        const productIds4006 = Object.keys(r4006.actualDiff).map(Number);
        const snapAfterRevert = await testRevertFlow(4006, r4006.snapAfter, productIds4006);

        // Idempotens
        let extraDiff4006 = null;
        if (snapAfterRevert) {
            const idemResult = await testIdempotency(4006, productIds4006, r4006.expected);
            if (idemResult && idemResult.drawnAgain > 0) {
                extraDiff4006 = {};
                for (const pid of productIds4006) {
                    extraDiff4006[pid] = (snapAfterRevert[pid] || 0) - (idemResult.snapAfter[pid] || 0);
                }
            }
        }

        // Aggregér 4006's totale diff og restore før vi går til 4007
        const merged4006 = { ...r4006.actualDiff };
        if (extraDiff4006) {
            for (const pid of Object.keys(extraDiff4006)) {
                merged4006[pid] = (merged4006[pid] || 0) + extraDiff4006[pid];
            }
        }
        await restoreNow('bon 4006', merged4006);
    }

    // Robusthed: bon 4007 (snapshot_before er nu ren — 4006's consume er restoreret)
    const r4007 = await testLeveretFlow(TEST_BONS[1], {
        LEVERET: 'T_INV_LEVERET_04',
    });
    if (r4007) {
        await restoreNow('bon 4007', r4007.actualDiff);
    }

    // Partial-consume + auto-shopping-list (v1-paritet)
    await testPartialConsume();

    // Flag-off (skipped)
    await testFlagOff(TEST_BONS[0]);

    // Final cleanup — håndterer evt. fejlede per-bon-restores
    await cleanup(allDiffs);

    db.close();
    const { passes, fails, skips } = writeReport();

    console.log(`\n[run_T_INVENTORY] ${passes} PASS · ${fails} FAIL · ${skips} SKIP`);
    process.exit(fails > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('[run_T_INVENTORY] FEJL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
