/**
 * services/itemPriceBackfill.js
 * ════════════════════════════════════════════════════════════
 * Auto-backfill af Grocy Salesprice*-userfields → item_prices.
 *
 * Kører automatisk første gang `GET /api/recipes/overview` rammes
 * (gated af settings.recipe_prices_backfilled).
 *
 * Konvertering: Grocy Salesprice* er INCL moms (per BON_V2_PRINCIPPER.md §6b).
 * item_prices.price er EX moms → konverter via Moms.inclToExcl.
 *
 * Spec: docs/CLAUDE_OPSKRIFTER.md
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');
const { inclToExcl } = require('../db/helpers');
const grocyAdapter = require('./grocyAdapter');

// Map Grocy userfield-navn → price_category_code
const USERFIELD_TO_CATEGORY = {
    SalespriceStore:      'store',
    SalespriceCatering:   'catering',
    SalespriceFestival:   'festival',
    SalespriceProduktion: 'produktion',
    SalespriceWaiste:     'waiste',
};

/**
 * Tjekker settings-flag og kører backfill hvis ikke gjort.
 * Idempotent — kalder backfill maks én gang per setting-flag-reset.
 *
 * @param {object} [opts]
 * @param {number} [opts.userId] - For changelog (typisk system-user 0)
 * @returns {Promise<{skipped: boolean, inserted: number, recipes_scanned: number}>}
 */
async function backfillIfNeeded(opts = {}) {
    const db = getDb();
    const flag = db.prepare(
        `SELECT value FROM settings WHERE key = 'recipe_prices_backfilled'`
    ).get();

    if (flag && flag.value === '1') {
        return { skipped: true, inserted: 0, recipes_scanned: 0 };
    }

    const result = await runBackfill({ force: 0, userId: opts.userId });

    db.prepare(
        `UPDATE settings SET value = '1', updated_at = CURRENT_TIMESTAMP
         WHERE key = 'recipe_prices_backfilled'`
    ).run();

    return { skipped: false, ...result };
}

/**
 * Kører backfill mod Grocy. force-modes:
 *   0 → INSERT OR IGNORE (manuel ændrede priser bevares)
 *   1 → INSERT OR IGNORE (samme som 0 — nulstil flag selvfølgelig først)
 *   2 → INSERT OR REPLACE (overskriver manuelle ændringer — admin warning)
 *
 * @returns {Promise<{inserted: number, replaced: number, recipes_scanned: number, errors: array}>}
 */
async function runBackfill(opts = {}) {
    const db = getDb();
    const force = opts.force || 0;
    const userId = opts.userId || null;

    // Hent price_categories så vi kan mappe code → id
    const catRows = db.prepare(`SELECT id, code FROM price_categories`).all();
    const codeToId = {};
    for (const r of catRows) codeToId[r.code] = r.id;

    // Hent alle recipes inkl. userfields fra Grocy
    const rawRecipes = await grocyAdapter.getRecipesRaw();

    let inserted = 0;
    let replaced = 0;
    const errors = [];

    // Brug INSERT OR IGNORE som default — INSERT OR REPLACE kun ved force=2
    const sql = force === 2
        ? `INSERT OR REPLACE INTO item_prices
           (item_type, item_id, price_category_id, price, updated_at, updated_by_user_id)
           VALUES ('recipe', ?, ?, ?, CURRENT_TIMESTAMP, ?)`
        : `INSERT OR IGNORE INTO item_prices
           (item_type, item_id, price_category_id, price, updated_at, updated_by_user_id)
           VALUES ('recipe', ?, ?, ?, CURRENT_TIMESTAMP, ?)`;

    const stmt = db.prepare(sql);

    for (const recipe of rawRecipes) {
        const uf = recipe.userfields || {};
        for (const [userfield, categoryCode] of Object.entries(USERFIELD_TO_CATEGORY)) {
            const raw = uf[userfield];
            if (raw === undefined || raw === null || raw === '') continue;

            const inclMoms = parseFloat(raw);
            if (!Number.isFinite(inclMoms) || inclMoms <= 0) continue;

            const categoryId = codeToId[categoryCode];
            if (!categoryId) {
                errors.push({ recipe_id: recipe.id, userfield, error: `Unknown price_category: ${categoryCode}` });
                continue;
            }

            const priceExcl = round2(inclToExcl(inclMoms));
            try {
                const info = stmt.run(recipe.id, categoryId, priceExcl, userId);
                if (info.changes > 0) {
                    if (force === 2) replaced++;
                    else inserted++;
                }
            } catch (err) {
                errors.push({ recipe_id: recipe.id, userfield, error: err.message });
            }
        }
    }

    return {
        inserted,
        replaced,
        recipes_scanned: rawRecipes.length,
        errors,
    };
}

function round2(n) {
    return Math.round((n ?? 0) * 100) / 100;
}

module.exports = {
    backfillIfNeeded,
    runBackfill,
    USERFIELD_TO_CATEGORY,
};
