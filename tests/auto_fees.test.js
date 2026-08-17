// tests/auto_fees.test.js
// ============================================================
// Standardgebyrer på fakturaer (settings.auto_fee_rules) — miljøbidraget først.
//
// To påstande bæres af hver sin gruppe:
//
//  1. Reglen rammer det den skal og ikke andet: pax-grænsen, kun fakturaer,
//     kun én gang pr. bon, og prisen følger bonens priskategori.
//
//  2. Et gebyr må ikke kunne skjule en leveringspris. Miljøgebyret ligger i
//     Grocy-kategorien `x-Levering`, og "har bonen en x-Levering-linje?" er
//     præcis det spørgsmål recalcBonTotal + e-conomic bruger til at afgøre om
//     `bons.delivery_price` allerede er talt med. Uden undtagelsen ville et
//     gebyr på 36 kr lade en levering på 180 kr falde ud af både bonens total
//     og kundens faktura.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en kolonne
// der flytter sig får testen til at fejle i stedet for at bestå mod en kopi.
//
// Kør: node --experimental-sqlite --test tests/auto_fees.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const autoFees = require('../services/autoFees');
const { hasDeliveryLine, recalcBonTotal } = require('../db/helpers');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

/* ── Fixtures ──────────────────────────────────────────────── */

// Miljøgebyret som det ser ud i grocy-hq: kategori x-Levering, ingen ingredienser.
// Prisen her er 36,25 (= 29 + moms), altså den værdi opskrift 168 SKAL rettes til.
const FEE_RECIPE = {
    id: 168, name: 'Miljøgebyr', category: 'x-Levering', unit: 'antal',
    prices: { store: 36.25, catering: 36.25, festival: 36.25, produktion: 0, waiste: 0 },
    cost_price: 0, co2e: 0,
};
const DELIVERY_RECIPE = {
    id: 1, name: 'By-ekspressen leverer', category: 'x-Levering', unit: 'antal',
    prices: { store: 180, catering: 180, festival: 180, produktion: 0, waiste: 0 },
    cost_price: 144, co2e: 0,
};
const RECIPES = new Map([[168, FEE_RECIPE], [1, DELIVERY_RECIPE]]);

const RULE = { id: 'miljobidrag', recipe_id: 168, min_pax: 11, active: true };
const RULES = [RULE];

function bon(over = {}) {
    return {
        pax: 20, price_category_code: 'catering', payment_type: 'invoice',
        is_offer: 0, is_internal: 0, ...over,
    };
}

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    return db;
}

/** Bon-række direkte i DB — vi tester helperen, ikke bon-routen. */
function insertBon(db, { pax = 20, deliveryPrice = 0, paymentType = 'invoice', internal = 0 } = {}) {
    const catId = db.prepare("SELECT id FROM price_categories WHERE code='catering'").get()?.id ?? null;
    const statusId = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
    const r = db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, price_category_id,
                          order_date, delivery_date, delivery_type, pax,
                          delivery_price, payment_type, is_offer, is_internal, total_price)
        VALUES (?,?,1,?,date('now'),date('now'),'delivery',?,?,?,0,?,0)
    `).run(`T_FEE_${Math.random().toString(36).slice(2, 8)}`, statusId, catId,
           pax, deliveryPrice, paymentType, internal);
    return Number(r.lastInsertRowid);
}

function addLine(db, bonId, { recipeId, name, category, price, qty = 1 }) {
    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category,
                               quantity, unit, unit_price, line_total, sort_order, is_accessory)
        VALUES (?,?,?,?,?,'stk',?,?,1,0)
    `).run(bonId, recipeId, name, category, qty, price, qty * price);
}

test.beforeEach(() => {
    _testDb = createFreshDb();
    autoFees.invalidateFeeCache();
});

/* ══ 1. Hvornår rammer reglen? ══════════════════════════════ */

test('over 10 pax får gebyret', () => {
    const { fees } = autoFees.computeFees(bon({ pax: 11 }), RULES, RECIPES);
    assert.equal(fees.length, 1);
    assert.equal(fees[0].grocy_recipe_id, 168);
    assert.equal(fees[0].unit_price, 36.25);
    assert.equal(fees[0].quantity, 1, 'gebyret er ét fast beløb, ikke pr. pax');
});

test('præcis 10 pax får det IKKE — min_pax 11 betyder "over 10"', () => {
    assert.equal(autoFees.computeFees(bon({ pax: 10 }), RULES, RECIPES).fees.length, 0);
});

test('pax mangler helt → intet gebyr (vi gætter ikke)', () => {
    assert.equal(autoFees.computeFees(bon({ pax: null }), RULES, RECIPES).fees.length, 0);
});

test('slukket regel gør ingenting', () => {
    const off = [{ ...RULE, active: false }];
    assert.equal(autoFees.computeFees(bon(), off, RECIPES).fees.length, 0);
});

test('kun fakturaer — kontant, tilbud og interne bons springes over', () => {
    for (const over of [{ payment_type: 'cash' }, { is_offer: 1 }, { is_internal: 1 }]) {
        assert.equal(autoFees.computeFees(bon(over), RULES, RECIPES).fees.length, 0,
            `skulle ikke ramme ${JSON.stringify(over)}`);
    }
});

test('ligger gebyret der allerede, tilføjes det ikke igen', () => {
    const { fees, skipped } = autoFees.computeFees(bon(), RULES, RECIPES, new Set([168]));
    assert.equal(fees.length, 0);
    assert.equal(skipped[0].reason, 'already_on_bon');
});

test('pris 0 på priskategorien → sprunget over MED grund, ikke en tom linje', () => {
    const { fees, skipped } = autoFees.computeFees(
        bon({ price_category_code: 'produktion' }), RULES, RECIPES);
    assert.equal(fees.length, 0);
    assert.equal(skipped[0].reason, 'no_price');
    assert.equal(skipped[0].price_category, 'produktion');
});

test('opskrift findes ikke i Grocy → sprunget over MED grund', () => {
    const { fees, skipped } = autoFees.computeFees(bon(), RULES, new Map());
    assert.equal(fees.length, 0);
    assert.equal(skipped[0].reason, 'recipe_missing');
});

test('prisen følger bonens priskategori', () => {
    const split = new Map([[168, { ...FEE_RECIPE,
        prices: { store: 25, catering: 36.25, festival: 50, produktion: 0, waiste: 0 } }]]);
    const price = (code) =>
        autoFees.computeFees(bon({ price_category_code: code }), RULES, split).fees[0].unit_price;
    assert.equal(price('store'), 25);
    assert.equal(price('catering'), 36.25);
    assert.equal(price('festival'), 50);
});

/* ══ 2. Gebyret må ikke skjule leveringen ═══════════════════ */

test('gebyr i x-Levering tæller IKKE som en leveringslinje', () => {
    autoFees.getFeeRules(_testDb);   // varm cachen op mod migration 147's regel
    assert.equal(hasDeliveryLine([
        { category: 'x-Levering', grocy_recipe_id: 168 },
    ]), false, 'miljøgebyret er ikke en levering');
});

test('en rigtig leveringslinje tæller stadig', () => {
    assert.equal(hasDeliveryLine([{ category: 'x-Levering', grocy_recipe_id: 1 }]), true);
});

test('x-Levering-linje uden recipe-id tæller — v1-migreret levering', () => {
    assert.equal(hasDeliveryLine([{ category: 'x-Levering', grocy_recipe_id: null }]), true);
});

test('REGRESSION: gebyret må ikke æde delivery_price ud af totalen', () => {
    // Det nye logistik-system gemmer levering linjeløst på bons.delivery_price.
    const bonId = insertBon(_testDb, { deliveryPrice: 180 });
    addLine(_testDb, bonId, { recipeId: 42, name: 'Kyllingen', category: '01 Sandwich', price: 100, qty: 5 });

    assert.equal(recalcBonTotal(_testDb, bonId), 680, '500 mad + 180 levering');

    addLine(_testDb, bonId, { recipeId: 168, name: 'Miljøgebyr', category: 'x-Levering', price: 36.25 });
    autoFees.invalidateFeeCache();

    assert.equal(recalcBonTotal(_testDb, bonId), 716.25,
        'gebyret lægges TIL — leveringen på 180 kr skal stadig være med');
});

test('en rigtig leveringslinje undertrykker stadig delivery_price', () => {
    const bonId = insertBon(_testDb, { deliveryPrice: 180 });
    addLine(_testDb, bonId, { recipeId: 42, name: 'Kyllingen', category: '01 Sandwich', price: 100, qty: 5 });
    addLine(_testDb, bonId, { recipeId: 1, name: 'By-ekspressen leverer', category: 'x-Levering', price: 180 });
    assert.equal(recalcBonTotal(_testDb, bonId), 680, 'ikke 860 — leveringen må ikke tælles to gange');
});

/* ══ 3. Reglerne som de faktisk gemmes ══════════════════════ */

test('migration 147 seeder miljøbidraget SLUKKET', () => {
    const rules = autoFees.getFeeRules(_testDb);
    const rule = rules.find(r => r.id === 'miljobidrag');
    assert.ok(rule, 'reglen skal være seedet');
    assert.equal(rule.recipe_id, 168);
    assert.equal(rule.min_pax, 11);
    assert.equal(rule.active, false,
        'skal seedes slukket — Grocy-prisen er 29 (incl) og skal rettes til 36,25 først');
});

test('gebyr-opskriften kendes af hasDeliveryLine selv når reglen er slukket', () => {
    // Ellers ville et slukket gebyr på en gammel bon pludselig skjule leveringen.
    assert.ok(autoFees.getFeeRecipeIds(_testDb).has(168));
});

test('ødelagt JSON i settings vælter ingenting', () => {
    _testDb.prepare("UPDATE settings SET value='{ ikke json' WHERE key='auto_fee_rules'").run();
    autoFees.invalidateFeeCache();
    assert.deepEqual(autoFees.getFeeRules(_testDb), []);
});

test('regel uden recipe_id springes over i stedet for at vælte', () => {
    _testDb.prepare(`UPDATE settings SET value='[{"id":"x","active":1}]' WHERE key='auto_fee_rules'`).run();
    autoFees.invalidateFeeCache();
    assert.deepEqual(autoFees.getFeeRules(_testDb), []);
});
