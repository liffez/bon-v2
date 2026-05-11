/**
 * tests/scripts/helpers/grocy_mutation.js
 * ════════════════════════════════════════════════════════════
 * Delt mutation/restore-modul for test-runnere der skal manipulere
 * Grocy-state midlertidigt (min_stock, best_before, HverDag-interval)
 * og rulle tilbage til pre-test-state.
 *
 * Hver mutator returnerer en `restore`-funktion der genskaber den
 * præcise pre-test-state (snapshot-baseret rollback — ikke "set til 0").
 *
 * Bruges af T_INDKOB_LISTE_BULK_*-cases (manglende/udløbne/forfaldne
 * shopping-list-flows) og fremtidige tracks der har samme behov.
 *
 * Krav til opkalder:
 *   - `api(method, path, body)`-funktion der returnerer { status, body, raw }
 *   - Test-server kører på TEST_SERVER_URL
 *   - Grocy test-instans (safety_check har bekræftet "test" i URL)
 *
 * Eksempel:
 *   const mutation = require('./helpers/grocy_mutation');
 *   const restore = await mutation.setMinStock(api, pid, 999);
 *   // ... kør test ...
 *   await restore();
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const FLOAT_TOL = 0.01;

/**
 * Hent et produkts nuværende min_stock_amount + andre felter vi rører.
 * @returns {Promise<Object>} produkt-objekt fra Grocy
 */
async function _getProduct(api, pid) {
    const res = await api('GET', '/api/grocy/products');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`GET /api/grocy/products fejlede: ${res.status}`);
    }
    const p = res.body.find(p => parseInt(p.id) === pid);
    if (!p) throw new Error(`Product ${pid} ikke fundet på Grocy`);
    return p;
}

/**
 * Hent stock-entries for et produkt — én pr. (product_id, best_before_date).
 * @returns {Promise<Array>}
 */
async function _getStockEntries(api, pid) {
    const res = await api('GET', '/api/grocy/stock');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        throw new Error(`GET /api/grocy/stock fejlede: ${res.status}`);
    }
    return res.body.filter(s => parseInt(s.product_id) === pid);
}

/**
 * Sæt min_stock_amount på et produkt. Returnerer restore-funktion.
 *
 * @param {Function} api
 * @param {number} pid
 * @param {number} amount  Nyt min_stock_amount
 * @returns {Promise<Function>} async restore()
 */
async function setMinStock(api, pid, amount) {
    const p = await _getProduct(api, pid);
    const originalMin = p.min_stock_amount;

    // PUT /api/grocy/products/:id — opdaterer felter på selve produktet
    const r = await api('PUT', `/api/grocy/products/${pid}`, { min_stock_amount: amount });
    if (r.status !== 200) {
        throw new Error(`setMinStock pid=${pid} → ${amount} fejlede: status=${r.status}`);
    }

    return async function restoreMinStock() {
        const rr = await api('PUT', `/api/grocy/products/${pid}`, { min_stock_amount: originalMin });
        if (rr.status !== 200) {
            console.warn(`  ⚠ restoreMinStock pid=${pid} → ${originalMin}: status=${rr.status}`);
        }
    };
}

/**
 * Sæt best_before_date på en eksisterende stock-entry. Vælger entry'en med
 * højeste amount (typisk hovedlageret). Hvis intet entry findes, fejler.
 *
 * @param {Function} api
 * @param {number} pid
 * @param {string} bbDate  ISO 'YYYY-MM-DD'
 * @returns {Promise<Function>} async restore()
 */
async function setBestBefore(api, pid, bbDate) {
    const entries = await _getStockEntries(api, pid);
    if (entries.length === 0) {
        throw new Error(`setBestBefore pid=${pid}: ingen stock-entries — kan ikke sætte bb-dato`);
    }
    // Vælg entry med størst amount (eller første hvis lige)
    const target = entries.reduce((max, e) =>
        parseFloat(e.amount || 0) > parseFloat(max.amount || 0) ? e : max, entries[0]);
    const originalBB = target.best_before_date;
    const targetAmount = parseFloat(target.amount);

    // Grocy har ikke direkte "sæt bb på entry" — vi bruger setInventory der
    // tager amount + best_before_date og opretter/opdaterer accordingly.
    const r = await api('POST', `/api/grocy/stock/${pid}/inventory`, {
        amount: targetAmount,
        best_before_date: bbDate
    });
    if (r.status !== 200) {
        throw new Error(`setBestBefore pid=${pid} → ${bbDate} fejlede: status=${r.status} body=${r.raw ? r.raw.slice(0, 200) : ''}`);
    }

    return async function restoreBestBefore() {
        if (!originalBB) return; // Ingen oprindelig bb — intet at restore
        const rr = await api('POST', `/api/grocy/stock/${pid}/inventory`, {
            amount: targetAmount,
            best_before_date: originalBB
        });
        if (rr.status !== 200) {
            console.warn(`  ⚠ restoreBestBefore pid=${pid} → ${originalBB}: status=${rr.status}`);
        }
    };
}

/**
 * Sæt HverDag-interval + LastCheckedAt userfields på et produkt.
 * Bruges af bulk-overdue-flow.
 *
 * @param {Function} api
 * @param {number} pid
 * @param {number} intervalDays   HverDag-interval
 * @param {Date|string} lastCheckedAt  Date-objekt eller ISO-streng
 * @returns {Promise<Function>} async restore()
 */
async function setHverDag(api, pid, intervalDays, lastCheckedAt) {
    const p = await _getProduct(api, pid);
    const originalHverDag = (p.userfields && p.userfields.HverDag) || '';
    const originalLastChecked = (p.userfields && p.userfields.LastCheckedAt) || '';

    const lcISO = lastCheckedAt instanceof Date ? lastCheckedAt.toISOString() : String(lastCheckedAt);
    const r = await api('PUT', `/api/grocy/products/${pid}/userfields`, {
        HverDag: String(intervalDays),
        LastCheckedAt: lcISO
    });
    if (r.status !== 200) {
        throw new Error(`setHverDag pid=${pid} fejlede: status=${r.status}`);
    }

    return async function restoreHverDag() {
        const rr = await api('PUT', `/api/grocy/products/${pid}/userfields`, {
            HverDag: originalHverDag,
            LastCheckedAt: originalLastChecked
        });
        if (rr.status !== 200) {
            console.warn(`  ⚠ restoreHverDag pid=${pid}: status=${rr.status}`);
        }
    };
}

/**
 * Convenience: ISO-streng for "N dage siden" (UTC).
 */
function dateDaysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Convenience: 'YYYY-MM-DD' for "N dage fra nu" (UTC).
 */
function dateDaysFromNow(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

module.exports = {
    setMinStock,
    setBestBefore,
    setHverDag,
    dateDaysAgo,
    dateDaysFromNow,
    FLOAT_TOL,
};
