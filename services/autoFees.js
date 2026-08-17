/**
 * autoFees — standardgebyrer der lægges automatisk på en bon ved fakturering.
 *
 * Første bruger er miljøbidraget, men reglen er generel: en regel udpeger en
 * Grocy-opskrift + en betingelse (pt. minimum pax). Opskriften er fortsat
 * priskilden — reglen siger kun HVORNÅR den skal med. Samme mønster som
 * unit_count_extra_recipes (113) og economic_amount_line_recipes (144).
 *
 * TIDSPUNKT: gebyret lægges på når bonen træder ind i faktureringskøen
 * (status → LEVERET), ikke når e-conomic-kladden bygges. Grunden er at ikke
 * alle fakturaer går gennem kladden — nogle tastes i hånden i e-conomic. Sker
 * det i selve kladde-trykket, ville de manuelle fakturaer aldrig få gebyret,
 * og bonens total ville afvige fra den faktura kunden får. Ved LEVERET er pax
 * endeligt og ingen faktura er lavet endnu, så begge veje ser samme total.
 *
 * Kaldes desuden lige før e-conomic-kladden bygges som sikkerhedsnet — funktionen
 * er idempotent, så bons der allerede var leveret da reglen blev tændt fanges dér.
 */

const { getDb } = require('../db/database');

const CACHE_MS = 60_000;
let _rulesCache = null;
let _rulesCacheAt = 0;

/**
 * Læs + validér reglerne fra settings.auto_fee_rules.
 *
 * Ugyldige rækker springes over i stedet for at kaste: en tastefejl i et
 * JSON-felt må aldrig kunne blokere et status-skift ude i køkkenet.
 */
function getFeeRules(db = getDb()) {
    const now = Date.now();
    if (_rulesCache && now - _rulesCacheAt < CACHE_MS) return _rulesCache;

    let parsed = [];
    try {
        const raw = db.prepare(`SELECT value FROM settings WHERE key = 'auto_fee_rules'`).get()?.value;
        const arr = JSON.parse(raw || '[]');
        if (Array.isArray(arr)) parsed = arr;
    } catch (err) {
        console.error('[autoFees] auto_fee_rules kunne ikke læses:', err.message);
        parsed = [];
    }

    _rulesCache = parsed.filter(isValidRule).map(r => ({
        id:        String(r.id),
        recipe_id: Number(r.recipe_id),
        // min_pax betyder "gælder fra og med" — "over 10 pax" er min_pax 11.
        min_pax:   r.min_pax == null ? null : Number(r.min_pax),
        active:    Number(r.active) === 1,
    }));
    _rulesCacheAt = now;
    return _rulesCache;
}

function isValidRule(r) {
    return r
        && typeof r === 'object'
        && String(r.id ?? '').trim() !== ''
        && Number.isInteger(Number(r.recipe_id))
        && Number(r.recipe_id) > 0
        && (r.min_pax == null || (Number.isFinite(Number(r.min_pax)) && Number(r.min_pax) >= 0));
}

/**
 * Recipe-id'er der er gebyrer — AKTIVE SOM INAKTIVE.
 *
 * Bruges af hasDeliveryLine() i db/helpers.js. At også inaktive tælles med er
 * bevidst: slukker man reglen, ligger gebyr-linjerne der stadig på gamle bons,
 * og de må ikke pludselig begynde at skjule leveringsprisen.
 */
function getFeeRecipeIds(db = getDb()) {
    return new Set(getFeeRules(db).map(r => r.recipe_id));
}

/** Ryd cachen — kaldes fra PATCH /api/settings/:key så en ændring virker straks. */
function invalidateFeeCache() {
    _rulesCache = null;
    _rulesCacheAt = 0;
}

/* ══════════════════════════════════════════════════════════════
   BEREGNING (ren funktion — testbar uden DB og uden Grocy)
   ══════════════════════════════════════════════════════════════ */

/**
 * Hvilke gebyrer mangler denne bon?
 *
 * @param {object} bon      { pax, price_category_code, payment_type, is_offer, is_internal }
 * @param {Array}  rules    fra getFeeRules()
 * @param {Map}    recipes  recipe_id → { id, name, category, unit, prices, cost_price }
 * @param {Set}    present  recipe_id'er der allerede ligger som linje på bonen
 * @returns {{fees: Array, skipped: Array}}
 *   fees[]    linjer klar til indsættelse
 *   skipped[] { rule_id, reason } — så en manglende pris kan VISES i stedet for
 *             at forsvinde i stilhed. Præcis den slags tavse bivirkning der
 *             tidligere lod fakturaer stå usendte (#319).
 */
function computeFees(bon, rules, recipes, present = new Set()) {
    const fees = [];
    const skipped = [];

    if (!isInvoiceBon(bon)) return { fees, skipped };

    for (const rule of rules) {
        if (!rule.active) continue;

        if (rule.min_pax != null && !(Number(bon.pax) >= rule.min_pax)) continue;

        if (present.has(rule.recipe_id)) {
            skipped.push({ rule_id: rule.id, recipe_id: rule.recipe_id, reason: 'already_on_bon' });
            continue;
        }

        const recipe = recipes.get(rule.recipe_id);
        if (!recipe) {
            skipped.push({ rule_id: rule.id, recipe_id: rule.recipe_id, reason: 'recipe_missing' });
            continue;
        }

        // Prisen følger bonens priskategori, som enhver anden vare. Findes koden
        // ikke, falder vi tilbage på 'catering' — createBon's egen default.
        const code  = bon.price_category_code || 'catering';
        const price = Number(recipe.prices?.[code] ?? recipe.prices?.catering ?? 0);

        // Et gebyr til 0 kr er ikke et gebyr. Sandsynligvis mangler prisen på
        // netop den priskategori i Grocy — sig det, tilføj ikke en tom linje.
        if (!(price > 0)) {
            skipped.push({
                rule_id: rule.id, recipe_id: rule.recipe_id,
                reason: 'no_price', price_category: code,
            });
            continue;
        }

        fees.push({
            rule_id:         rule.id,
            grocy_recipe_id: recipe.id,
            product_name:    recipe.name,
            category:        recipe.category ?? null,
            quantity:        1,
            unit:            recipe.unit || 'stk',
            unit_price:      price,          // INCL moms, som alle andre bon_lines (§6b)
            cost_price:      recipe.cost_price ?? null,
            co2e:            recipe.co2e ?? null,
        });
    }

    return { fees, skipped };
}

/**
 * Er bonen en faktura? Spejler faktureringskøens egen definition
 * (routes/invoices.js `/queue`) minus status, plus interne bons.
 *
 * Interne bons kan godt have payment_type='invoice' (6 stk i drift) — men de er
 * hus-til-hus og skal ikke have et miljøbidrag.
 */
function isInvoiceBon(bon) {
    return bon
        && bon.payment_type === 'invoice'
        && !Number(bon.is_offer)
        && !Number(bon.is_internal);
}

/* ══════════════════════════════════════════════════════════════
   ANVENDELSE
   ══════════════════════════════════════════════════════════════ */

/**
 * Læg de manglende gebyrer på bonen som rigtige bon_lines.
 *
 * Idempotent: en opskrift der allerede ligger på bonen tilføjes ikke igen —
 * heller ikke hvis den blev lagt på i hånden. Kan derfor kaldes flere gange
 * (LEVERET, og igen før e-conomic-kladden) uden at dublere.
 *
 * Fejler ALDRIG opad: er Grocy nede, tilføjes intet, og sikkerhedsnettet før
 * kladden fanger bonen senere. Et status-skift må ikke vælte fordi et gebyr
 * ikke kunne slås op.
 *
 * @returns {Promise<{added: Array, skipped: Array, error: string|null}>}
 */
async function applyAutoFees(db, bonId, opts = {}) {
    const empty = { added: [], skipped: [], error: null };
    try {
        const rules = getFeeRules(db);
        if (!rules.some(r => r.active)) return empty;

        const bon = db.prepare(`
            SELECT b.id, b.pax, b.payment_type, b.is_offer, b.is_internal, pc.code AS price_category_code
              FROM bons b
              LEFT JOIN price_categories pc ON pc.id = b.price_category_id
             WHERE b.id = ?
        `).get(bonId);
        if (!bon || !isInvoiceBon(bon)) return empty;

        const recipes = await loadRecipeMap();
        const present = new Set(
            db.prepare(`SELECT DISTINCT grocy_recipe_id FROM bon_lines
                         WHERE bon_id = ? AND grocy_recipe_id IS NOT NULL`)
              .all(bonId).map(r => Number(r.grocy_recipe_id))
        );

        const { fees, skipped } = computeFees(bon, rules, recipes, present);
        if (!fees.length) return { added: [], skipped, error: null };

        const added = [];
        for (const fee of fees) added.push(insertFeeLine(db, bonId, fee, opts.userId ?? null));

        // Totalerne skal med samme vej som enhver anden linje-ændring.
        const { recalcBonTotalUnits, recalcBonTotal } = require('../db/helpers');
        recalcBonTotalUnits(db, bonId);
        recalcBonTotal(db, bonId, { logIfChanged: false });

        return { added, skipped, error: null };
    } catch (err) {
        console.error(`[autoFees] bon ${bonId}:`, err.message);
        return { added: [], skipped: [], error: err.message };
    }
}

function insertFeeLine(db, bonId, fee, userId) {
    const maxSort = db.prepare(
        `SELECT COALESCE(MAX(sort_order), 0) AS mx FROM bon_lines WHERE bon_id = ?`
    ).get(bonId).mx;

    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                               cost_price, unit_price, line_total, sort_order, is_accessory, co2e)
        VALUES (?,?,?,?,?,?,?,?,?,?,0,?)
    `).run(
        bonId, fee.grocy_recipe_id, fee.product_name, fee.category,
        fee.quantity, fee.unit, fee.cost_price, fee.unit_price,
        fee.quantity * fee.unit_price, maxSort + 1, fee.co2e
    );

    // Changelog nævner reglen ved navn — ellers ser linjen ud til at komme af
    // sig selv, og den næste der undrer sig har intet at søge efter.
    require('../db/helpers').logChange({
        entityType: 'bon', entityId: bonId,
        action: 'update', fieldName: 'bon_lines',
        oldValue: null,
        newValue: `tilføjet: ${fee.quantity}x ${fee.product_name}`,
        notes: `Standardgebyr (regel: ${fee.rule_id})`,
        userId,
    });

    return fee;
}

/** Grocy-opskrifter som Map. Cachet i adapteren, så kaldet er billigt. */
async function loadRecipeMap() {
    const grocy = require('./grocyAdapter');
    const list = await grocy.getRecipes();
    return new Map(list.map(r => [Number(r.id), r]));
}

module.exports = {
    getFeeRules,
    getFeeRecipeIds,
    invalidateFeeCache,
    computeFees,
    isInvoiceBon,
    applyAutoFees,
};
