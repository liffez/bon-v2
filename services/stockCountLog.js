/**
 * services/stockCountLog.js
 * ════════════════════════════════════════════════════════════
 * Optællingen som objekt (#673, spec §14.4).
 *
 * Reglerne bor her, så de to veje ind — lagerkaldet for varer der blev
 * rettet, og det samlede kald for resten — skriver linjerne ens:
 *
 *   * Faktoren er SERVERENS (resolveToStockAmount), aldrig klientens.
 *   * Hver linje har et udfald. At vi talte ER sket; det der ikke må logges,
 *     er at lageret blev rettet når det ikke blev.
 *   * Et nyt forsøg erstatter varens linjer i optællingen i stedet for at
 *     lægge nye til (efter en delvis Grocy-fejl trykker man Gem igen).
 *   * Kun åbne optællinger kan få linjer.
 *
 * Grocy-data (produkter + omregninger) sendes ind af kalderen, så servicen
 * ikke selv taler med Grocy og kan testes uden.
 * ════════════════════════════════════════════════════════════
 */

const { resolveToStockAmount } = require('./quConvert');
const { transaction } = require('../db/compat');

const OUTCOMES = ['corrected', 'unchanged', 'kept_stock', 'failed'];

// En åben optælling ældre end dette er forladt, ikke i gang. Den må ikke
// advare andre for evigt.
const OPEN_WINDOW_HOURS = 12;

function activeSiteLocationId(db) {
    try {
        const r = db.prepare("SELECT value FROM settings WHERE key = 'default_grocy_location_id'").get();
        const id = r ? parseInt(r.value) : NaN;
        return Number.isFinite(id) ? id : null;
    } catch (e) { return null; }
}

// Findes enheden og hører den til lokationen? Ellers slås den op på navnet.
// En forkert id fra en gammel browser-session må ikke pege på en andens enhed.
function resolvePhysicalUnitId(db, grocyLocationId, id, name) {
    const n = parseInt(id);
    if (Number.isFinite(n)) {
        const hit = db.prepare('SELECT id FROM physical_units WHERE id = ? AND grocy_location_id = ?')
            .get(n, grocyLocationId);
        if (hit) return hit.id;
    }
    if (name) {
        const byName = db.prepare(
            'SELECT id FROM physical_units WHERE grocy_location_id = ? AND name = ? ORDER BY archived_at IS NULL DESC, id DESC LIMIT 1'
        ).get(grocyLocationId, name);
        if (byName) return byName.id;
    }
    return null;
}

function getCount(db, id) {
    return db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(parseInt(id)) || null;
}

function createCount(db, { grocyLocationId, physicalUnitId, physicalUnitName, userId }) {
    const loc = parseInt(grocyLocationId);
    if (!Number.isFinite(loc) || loc <= 0) throw Object.assign(new Error('grocy_location_id påkrævet'), { status: 400 });
    const unitId = resolvePhysicalUnitId(db, loc, physicalUnitId, physicalUnitName);
    const r = db.prepare(`
        INSERT INTO stock_counts (site_location_id, grocy_location_id, current_physical_unit_id, user_id)
        VALUES (?, ?, ?, ?)
    `).run(activeSiteLocationId(db), loc, unitId, userId || null);
    return getCount(db, r.lastInsertRowid);
}

// Andre åbne optællinger på samme lokation, startet inden for vinduet.
// Tidssammenligningen sker i SQLite, så begge sider har samme format (UTC).
function openOthers(db, { grocyLocationId, excludeId, hours = OPEN_WINDOW_HOURS }) {
    const loc = parseInt(grocyLocationId);
    if (!Number.isFinite(loc)) return [];
    const site = activeSiteLocationId(db);
    return db.prepare(`
        SELECT c.id, c.started_at, c.user_id, u.name AS user_name,
               c.current_physical_unit_id AS physical_unit_id, pu.name AS physical_unit_name
        FROM stock_counts c
        LEFT JOIN users u ON u.id = c.user_id
        LEFT JOIN physical_units pu ON pu.id = c.current_physical_unit_id
        WHERE c.status = 'open'
          AND c.grocy_location_id = ?
          AND (c.site_location_id IS ? OR c.site_location_id IS NULL OR ? IS NULL)
          AND c.id != ?
          AND c.started_at >= datetime('now', ?)
        ORDER BY c.started_at
    `).all(loc, site, site, parseInt(excludeId) || 0, '-' + Number(hours) + ' hours');
}

function setCurrentUnit(db, countId, { physicalUnitId, physicalUnitName }) {
    const c = getCount(db, countId);
    if (!c) return null;
    if (c.status !== 'open') return c;
    const unitId = resolvePhysicalUnitId(db, c.grocy_location_id, physicalUnitId, physicalUnitName);
    db.prepare('UPDATE stock_counts SET current_physical_unit_id = ? WHERE id = ?').run(unitId, c.id);
    return getCount(db, c.id);
}

function closeCount(db, countId, status) {
    const c = getCount(db, countId);
    if (!c) return null;
    if (c.status !== 'open') return c;   // idempotent: en lukket optælling forbliver lukket
    db.prepare("UPDATE stock_counts SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, c.id);
    return getCount(db, c.id);
}

// Posterne for én linje omregnet med serverens faktor.
// Kaster ved en post der ikke kan omregnes — så logges varen ikke halvt.
function convertEntries(product, entries, conversions) {
    const out = [];
    let sum = 0;
    for (const e of entries) {
        const quId = parseInt(e && e.qu_id);
        const qty = Number(e && e.qty);
        if (!Number.isFinite(quId) || quId <= 0) throw new Error('post uden qu_id');
        if (!Number.isFinite(qty) || qty <= 0) continue;   // tomt felt = ingen post
        const r = resolveToStockAmount({ product, amount: qty, quId, conversions });
        if (r.error) throw new Error(r.error);
        out.push({ qu_id: quId, qty, factor_used: r.factor });
        sum += r.amount;
    }
    return { entries: out, sum: Math.round(sum * 1e6) / 1e6 };
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Skriv én vares linjer i en optælling.
 *
 * item: { product_id, product_name?, expected_qty?, outcome,
 *         lines: [{ physical_unit_id?, physical_unit_name, stock_qty,
 *                   sort_index?, entries? }] }
 *
 * Varens gamle linjer i optællingen slettes først — også en fysisk enhed
 * brugeren har fjernet tællingen fra, så den ikke står tilbage som en måling.
 */
function logProduct(db, { count, item, products, conversions }) {
    const productId = parseInt(item && item.product_id);
    if (!Number.isFinite(productId)) throw new Error('product_id mangler');
    if (!OUTCOMES.includes(item.outcome)) throw new Error('ukendt udfald: ' + item.outcome);
    const lines = Array.isArray(item.lines) ? item.lines : [];
    if (!lines.length) throw new Error('ingen linjer for produkt ' + productId);

    const product = (products || []).find(p => parseInt(p.id) === productId) || null;
    const expected = Number.isFinite(Number(item.expected_qty)) && item.expected_qty !== null && item.expected_qty !== ''
        ? Number(item.expected_qty) : null;

    // Omregn alt FØR der skrives noget.
    const prepared = lines.map(l => {
        const name = String(l.physical_unit_name || '').trim();
        if (!name) throw new Error('linje uden fysisk enhed');
        let entries = [];
        let stockQty = Number(l.stock_qty);
        if (Array.isArray(l.entries) && l.entries.length) {
            if (!product) throw new Error('produkt ' + productId + ' findes ikke i Grocy');
            const conv = convertEntries(product, l.entries, conversions);
            entries = conv.entries;
            stockQty = conv.sum;
        }
        if (!Number.isFinite(stockQty)) throw new Error('linje uden mængde');
        const sortIndex = parseInt(l.sort_index);
        return {
            name, entries, stockQty,
            unitId: resolvePhysicalUnitId(db, count.grocy_location_id, l.physical_unit_id, name),
            sortIndex: Number.isFinite(sortIndex) ? sortIndex : null,
        };
    });

    // Afvigelse pr. linje giver kun mening når varen er talt ét sted:
    // Grocy kender ikke fordelingen mellem KØL-1 og KØL-2.
    let deviation = null;
    if (prepared.length === 1 && expected !== null && expected > 0) {
        deviation = round2((prepared[0].stockQty - expected) / expected * 100);
    }

    const insLine = db.prepare(`
        INSERT INTO stock_count_lines
          (count_id, product_id, product_name, physical_unit_id, physical_unit_name,
           stock_qty, expected_qty, deviation_pct, sort_index, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insEntry = db.prepare('INSERT INTO stock_count_entries (line_id, qu_id, qty, factor_used) VALUES (?, ?, ?, ?)');
    const productName = item.product_name || (product && product.name) || null;

    transaction(db, () => {
        const old = db.prepare('SELECT id FROM stock_count_lines WHERE count_id = ? AND product_id = ?').all(count.id, productId);
        for (const o of old) db.prepare('DELETE FROM stock_count_entries WHERE line_id = ?').run(o.id);
        db.prepare('DELETE FROM stock_count_lines WHERE count_id = ? AND product_id = ?').run(count.id, productId);
        for (const p of prepared) {
            const r = insLine.run(count.id, productId, productName, p.unitId, p.name,
                p.stockQty, expected, deviation, p.sortIndex, item.outcome);
            for (const e of p.entries) insEntry.run(r.lastInsertRowid, e.qu_id, e.qty, e.factor_used);
        }
    });
    return prepared.length;
}

/**
 * Skriv flere varer. En fejl på én vare stopper ikke de andre — men den
 * siges i svaret (errors), aldrig slugt.
 */
function logProducts(db, { countId, items, products, conversions }) {
    const count = getCount(db, countId);
    if (!count) return { logged: 0, errors: [{ product_id: null, error: 'optællingen findes ikke' }] };
    if (count.status !== 'open') {
        return { logged: 0, errors: [{ product_id: null, error: 'optællingen er lukket (' + count.status + ')' }] };
    }
    let logged = 0;
    const errors = [];
    for (const item of items || []) {
        try { logged += logProduct(db, { count, item, products, conversions }); }
        catch (err) { errors.push({ product_id: item && item.product_id, error: err.message }); }
    }
    return { logged, errors };
}

module.exports = {
    OUTCOMES, OPEN_WINDOW_HOURS,
    activeSiteLocationId, resolvePhysicalUnitId,
    getCount, createCount, openOthers, setCurrentUnit, closeCount,
    convertEntries, logProduct, logProducts,
};
