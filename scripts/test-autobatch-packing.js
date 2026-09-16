// scripts/test-autobatch-packing.js
// ============================================================
// To tavse fejl på consume-stien, med samme rod: de to sider var uenige om
// hvor meget bonen har brug for.
//
//   1) Auto-batchen (#267) regnede behovet UDEN pakke-justeringer, mens selve
//      trækket regnede det MED. Tog køkkenet 2,5 kg Frisk Grønt med i stedet
//      for de beregnede 0,9, producerede Bon til 0,9 og trak 2,5. Forskellen
//      forsvandt ned i mellemproduktet, som gik i minus — og det opdages først
//      ved næste optælling.
//
//      Latent indtil nu, fordi Remoulade er den eneste konverterede blanding
//      og ingen har lagt en buffer på den. #270 gør det live på Frisk Grønt,
//      som sidder i 28 retter OG har buffer-mekanikken i event-prep.
//
//   2) Mangler der et mellemprodukt, lagde trækket MELLEMPRODUKTET på
//      indkøbslisten. "Remoulade" står ikke i noget katalog — den laves.
//      Spec §4.4 siger eksplicit at det er RÅVARERNE der skal på listen, og
//      auto-batchen gør det allerede rigtigt; trækket lagde produktet oveni.
//
// Grocy-adapteren stubbes i require-cachen før db/helpers loades — samme
// mønster som test-consume-hardening.js.
//
// GRÆNSE: fejl (1) måles hele vejen gennem `autoConsumeBonInventory`, altså
// den rigtige kodevej. Fejl (2) måles på REGLEN (`planShortfall`) plus den
// kilde reglen fodres med (`buildProducerIndex`) — ikke gennem `consumeRecipes`
// selv, hvis `addShoppingListProduct` er en modul-lokal closure der ikke kan
// gribes udefra. Den ene linje der binder de to sammen er derfor ikke dækket;
// slår den fejl, falder vi tilbage til den gamle adfærd (alt kan købes), hvilket
// er dokumenteret og logges.
//
//   node --experimental-sqlite scripts/test-autobatch-packing.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-autobatch-packing-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const near  = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

// ── Verden: Remoulade er konverteret (produkt 70), som i drift ─────────────
const UNITS    = [{ id: 4, name: 'Kilo' }];
const PRODUCTS = [
    { id: 70, name: 'Remoulade',   qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 47, name: 'Mayonaise',   qu_id_stock: 4, qu_id_purchase: 4 },
    { id: 41, name: 'Relish',      qu_id_stock: 4, qu_id_purchase: 4 },
];
const RECIPES_RAW = [
    // Menuen peger på PRODUKTET — efter konverteringen.
    { id: 100, name: 'Fisken', product_id: null, base_servings: 1, userfields: {} },
    // Produktionsopskriften der laver det.
    { id: 10,  name: 'Remoulade', product_id: 70, base_servings: 1,
      userfields: { grupper: 'RR produktion Hurtig', recipeunit: 'kg', recipeunitnumber: '1' } },
];
const POS = [
    { id: 1, recipe_id: 100, product_id: 70, amount: 0.007 },
    { id: 2, recipe_id: 10,  product_id: 47, amount: 0.5 },
    { id: 3, recipe_id: 10,  product_id: 41, amount: 0.5 },
];

const stub = {
    stock: { 70: 0, 47: 10, 41: 10 },
    produce: [],
    shopping: [],
};

const grocyPath = require.resolve('../services/grocyAdapter');
const realGrocy = require(grocyPath);
require.cache[grocyPath].exports = {
    ...realGrocy,
    getRecipesRawMap: async () => new Map(RECIPES_RAW.map(r => [r.id, r])),
    getRecipes:       async () => RECIPES_RAW.map(r => ({ id: r.id, unit_number: 1, cost_price: 0 })),
    getAllRecipesPos: async () => POS,
    getRecipeNestings: async () => [],
    getProducts:      async () => PRODUCTS,
    getQuantityUnits: async () => UNITS,
    getQuantityUnitConversions: async () => [],
    getStock:         async () => Object.entries(stub.stock)
                          .map(([pid, amount]) => ({ product_id: Number(pid), amount })),
    // Auto-batchen læser FRISKT lager siden #589 — beslutningen om hvor meget
    // der trækkes må ikke bygge på et cachet tal. Stubben har intet cache-lag,
    // så de to er samme svar her; den skal bare findes, ellers falder kaldet
    // igennem til den rigtige adapter og prøver at ringe til Grocy.
    getStockFresh:    async () => Object.entries(stub.stock)
                          .map(([pid, amount]) => ({ product_id: Number(pid), amount })),
    produceBatch:     async (p) => { stub.produce.push(p); return { state: 'produced' }; },
    addToShoppingList: async (items) => { stub.shopping.push(...items); return []; },
    // Selve trækket er ikke det der testes her — auto-batchen er.
    consumeRecipes:   async () => [{ product_id: 70, product_name: 'Remoulade', success: true, amount: 1 }],
};

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);
const { getDb } = require('../db/database');
const helpers = require('../db/helpers');
const { getStatusId, getDefaultLocationId } = helpers;
const db = getDb();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let counter = 7100;
function mkBon({ override = null, extra = null } = {}) {
    const id = counter++;
    db.prepare(`
        INSERT INTO bons (id, bon_number, status_id, location_id, order_date, delivery_date,
                          inventory_deducted, is_offer, total_price, created_at, updated_at)
        VALUES (?, ?, ?, ?, date('now'), date('now'), 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, 'B' + id, getStatusId('LEVERET'), getDefaultLocationId());
    db.prepare(`
        INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, quantity, unit_price, line_total)
        VALUES (?, 100, 'Fisken', 10, 0, 0)
    `).run(id);
    if (override != null) {
        db.prepare(`INSERT INTO prep_packing_overrides (bon_id, product_id, packed_amount, updated_at)
                    VALUES (?, 70, ?, CURRENT_TIMESTAMP)`).run(id, override);
    }
    if (extra != null) {
        db.prepare(`INSERT INTO prep_packing_extras (bon_id, product_id, amount, updated_at)
                    VALUES (?, 70, ?, CURRENT_TIMESTAMP)`).run(id, extra);
    }
    return id;
}
const producedKg = () => stub.produce.reduce((s, p) => s + (p.produce?.amount || 0), 0);

async function main() {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('inventory_auto_deduct', '1')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

    /* ═══ 1 · Auto-batchen skal se den mængde der rent faktisk trækkes ═══ */
    head('Buffer — auto-batchen og trækket skal være enige om behovet');

    // Referencen: uden buffer er behovet 10 × 0,007 = 0,07 kg → ét batch.
    stub.produce = [];
    helpers.autoConsumeBonInventory(mkBon());
    await sleep(120);
    check(near(producedKg(), 1), 'uden buffer: behov 0,07 kg → 1 batch (1 kg) — referencen');

    // Køkkenet pakkede 2,5 kg. Trækket tager 2,5; auto-batchen skal derfor
    // også regne med 2,5, ellers går mellemproduktet i minus.
    stub.produce = [];
    helpers.autoConsumeBonInventory(mkBon({ override: 2.5 }));
    await sleep(120);
    check(near(producedKg(), 3),
        'override 2,5 kg → 3 batches (var 1 før fixet: auto-batchen så ikke bufferen)');

    // Ekstra-varer lægges OVENI opskriftens forbrug.
    stub.produce = [];
    helpers.autoConsumeBonInventory(mkBon({ extra: 1.5 }));
    await sleep(120);
    check(near(producedKg(), 2),
        'extra 1,5 kg oveni 0,07 → 2 batches (var 1 før fixet)');

    // Og råvarerne skal følge med — ellers produceres der af ingenting.
    stub.produce = [];
    helpers.autoConsumeBonInventory(mkBon({ override: 2.5 }));
    await sleep(120);
    const mayo = stub.produce[0]?.consume?.find(c => c.productId === 47);
    check(near(mayo?.amount, 1.5), 'og der trækkes råvarer til alle 3 batches (0,5 × 3 mayo)');

    /* ═══ 2 · Et mellemprodukt kan ikke købes ═══ */
    head('Indkøbsliste — mellemproduktet laves, det købes ikke');

    const { planShortfall } = require('../services/grocyAdapter');
    check(typeof planShortfall === 'function', 'planShortfall er eksporteret som ren funktion');

    if (typeof planShortfall === 'function') {
        const produceret = new Set([70]);          // Remoulade laves af en opskrift
        const remoulade  = { product_id: 70, purchase_factor: 1 };
        const mayonaise  = { product_id: 47, purchase_factor: 1 };

        const r1 = planShortfall(remoulade, 0.9, produceret);
        check(r1 && r1.action === 'produce',
            'mangler et mellemprodukt → det havner IKKE på indkøbslisten');
        check(r1 && r1.reason === 'produceret_mellemprodukt',
            'og grunden siges højt, så manglen ikke bare forsvinder');

        const r2 = planShortfall(mayonaise, 0.9, produceret);
        check(r2 && r2.action === 'buy', 'en almindelig råvare skal stadig købes');
        check(r2 && r2.amountPurchase === 1, 'oprundet til hel indkøbsenhed (0,9 → 1)');

        const r3 = planShortfall({ product_id: 47, purchase_factor: 6 }, 0.9, produceret);
        check(r3 && r3.amountPurchase === 6, 'purchase_factor respekteres (0,9 × 6 → 6)');

        check(planShortfall(mayonaise, 0, produceret) === null, 'ingen mangel → ingen handling');
        check(planShortfall(mayonaise, 0.0001, produceret) === null,
            'og en mangel under tolerancen tæller ikke som en mangel');

        // Reglen er kun så god som det sæt den får. `consumeRecipes` bygger det
        // med buildProducerIndex over Grocys opskrifter — hvis DET led er
        // forkert, er reglen ligegyldig. Så vi måler kilden, ikke kun reglen.
        const { buildProducerIndex } = require('../services/ingredientResolver');
        const index = buildProducerIndex(new Map(RECIPES_RAW.map(r => [r.id, r])));
        check(index.has(70), 'buildProducerIndex finder mellemproduktet (kilden til sættet)');
        check(!index.has(47), 'og en almindelig råvare står ikke i det');
    } else {
        bad('planShortfall mangler — resten af gruppen kan ikke køres');
        fail += 5;
    }

    console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
    process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
