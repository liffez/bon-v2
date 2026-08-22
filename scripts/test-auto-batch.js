// scripts/test-auto-batch.js
// ============================================================
// Hurtig auto-batch ved LEVERET (#267).
//
// Bon regner, Grocy fører lageret. Grocys egen `POST /recipes/{id}/consume`
// blev afprøvet mod grocytest 22.08.2026 og duer ikke: den tager ingen
// parametre (mængden styres af `desired_servings`), forbruger delvise
// mængder — og lagde alligevel det fulde udbytte på lageret, 2 kg remoulade
// selvom relish stod på 0. Lager ud af ingenting, uden en fejlbesked.
//
// Den vigtigste assert i filen er grænsen: `RR Produktion` må ALDRIG
// auto-produceres. De laver personalet efter plan, og et automatisk træk
// ville fjerne råvarer for noget ingen har lavet.
//
// Kør:  node scripts/test-auto-batch.js
// ============================================================

'use strict';

const { planAutoBatches, affordableBatches, autoBatchNonce, runAutoBatches } = require('../services/autoBatch');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// ── Stamdata ────────────────────────────────────────────────
// 70 Remoulade laves af #10 (Hurtig, 1 kg pr. batch) af mayo + relish.
// 80 Gris     laves af #20 (RR Produktion) — personalet laver den.
const UNITS = [{ id: 4, name: 'Kilo' }, { id: 8, name: 'Antal' }];
const PRODUCTS = [
    { id: 70, name: 'Remoulade', qu_id_stock: 4 },
    { id: 80, name: 'Langtidsstegt gris', qu_id_stock: 4 },
    { id: 47, name: 'Mayonnaise', qu_id_stock: 4 },
    { id: 41, name: 'Relish', qu_id_stock: 4 },
    { id: 90, name: 'Svinekam', qu_id_stock: 4 },
    { id: 99, name: 'Serviet', qu_id_stock: 8 },
];
const productMap = new Map(PRODUCTS.map(p => [p.id, p]));
const unitMap = new Map(UNITS.map(u => [u.id, u]));

const RECIPES = [
    { id: 10, name: 'Remoulade', product_id: 70, base_servings: 1,
      userfields: { grupper: 'RR produktion Hurtig', recipeunit: 'kg', recipeunitnumber: '1' } },
    { id: 20, name: 'Langtids stegt Gris', product_id: 80, base_servings: 1,
      userfields: { grupper: 'RR Produktion', recipeunit: 'kg', recipeunitnumber: '1' } },
    { id: 30, name: 'Tahin dressing', product_id: 71, base_servings: 1,
      userfields: { grupper: 'RR produktion Hurtig', recipeunit: 'kg' } },   // intet yield-tal
];
const rawRecipeMap = new Map(RECIPES.map(r => [r.id, r]));
const posByRecipe = {
    10: [{ recipe_id: 10, product_id: 47, amount: 0.5 },
         { recipe_id: 10, product_id: 41, amount: 0.5 },
         { recipe_id: 10, product_id: 99, amount: 1, ingredient_group: 'Emballage' }],
    20: [{ recipe_id: 20, product_id: 90, amount: 1.2 }],
    30: [{ recipe_id: 30, product_id: 47, amount: 0.3 }],
};
const nestingsByRecipe = {};

const lager = (m) => (pid) => m[pid] || 0;
const plan = (needs, stockMap) => planAutoBatches({
    needs, rawRecipeMap, posByRecipe, nestingsByRecipe, productMap, unitMap,
    quConversions: [], effectiveStock: lager(stockMap),
});

// ─── G · grænsen mellem de to roller ───────────────────────────
console.log('\nG · Hvem laver varen?\n');
{
    const p = plan([{ product_id: 80, amount_stock: 5 }], { 80: 0, 90: 100 });
    ok(p.batches.length === 0, 'RR Produktion auto-produceres ALDRIG — heller ikke med råvarer på lager');
    ok(p.skipped.length === 0, 'og den nævnes ikke som "sprunget over" — den hører slet ikke til her');

    const h = plan([{ product_id: 70, amount_stock: 1 }], { 70: 0, 47: 10, 41: 10 });
    ok(h.batches.length === 1 && h.batches[0]?.recipe_id === 10, 'RR produktion Hurtig laves af Bon');
}

// ─── B · hele batches ──────────────────────────────────────────
console.log('\nB · Hele batches, aldrig en delmængde\n');
{
    const p = plan([{ product_id: 70, amount_stock: 0.03 }], { 70: 0, 47: 10, 41: 10 });
    const b = p.batches[0];
    ok(b.batches_made === 1, 'behov 0,03 kg → 1 helt batch');
    ok(near(b.produce_amount, 1), 'der lægges 1 kg på lageret, ikke 0,03');
    ok(near(b.consume.find(c => c.productId === 47)?.amount ?? -1, 0.5), 'og der trækkes råvarer til ét helt batch');

    const to = plan([{ product_id: 70, amount_stock: 1.2 }], { 70: 0, 47: 10, 41: 10 });
    ok(to.batches[0]?.batches_made === 2, 'shortfall på 1,2 batch → 2 batches');

    const delvis = plan([{ product_id: 70, amount_stock: 1.2 }], { 70: 0.5, 47: 10, 41: 10 });
    ok(delvis.batches[0]?.batches_made === 1, 'lager modregnes: 1,2 − 0,5 = 0,7 → 1 batch');

    ok(plan([{ product_id: 70, amount_stock: 1 }], { 70: 5, 47: 10, 41: 10 }).batches.length === 0,
       'er der dækning, produceres der ingenting');
}

// ─── R · når råvarerne ikke rækker ─────────────────────────────
console.log('\nR · Råvarerne rækker ikke\n');
{
    // Nok mayo til 2 batches, men kun relish til 1.
    const p = plan([{ product_id: 70, amount_stock: 2 }], { 70: 0, 47: 10, 41: 0.5 });
    const b = p.batches[0];
    ok(b.batches_needed === 2, 'der er brug for 2 batches');
    ok(b.batches_made === 1, 'men kun råvarer til 1 — der laves 1, ikke 1,5');
    ok(b.missing.length === 1 && b.missing[0]?.product_id === 41, 'relish rapporteres som manglende');
    ok(near(b.missing[0]?.shortfall ?? -1, 0.5), 'og med den mængde der mangler til BEGGE batches');

    const intet = plan([{ product_id: 70, amount_stock: 1 }], { 70: 0, 47: 0, 41: 0 });
    ok(intet.batches[0]?.batches_made === 0, 'ingen råvarer → 0 batches, ikke et halvt');
    ok(intet.batches[0]?.missing.length === 2, 'begge råvarer rapporteres');
    ok(intet.batches[0]?.consume.every(c => c.amount === 0), 'og der trækkes intet');

    ok(affordableBatches(new Map([[47, 0.5]]), lager({ 47: 1.4 })) === 2, '1,4 kg / 0,5 = 2 hele batches');
    ok(affordableBatches(new Map([[47, 0.5]]), lager({ 47: 0.4 })) === 0, '0,4 kg rækker ikke til ét');
}

// ─── E · emballage ─────────────────────────────────────────────
console.log('\nE · Emballage hører til menulinjen\n');
{
    const p = plan([{ product_id: 70, amount_stock: 1 }], { 70: 0, 47: 10, 41: 10, 99: 0 });
    const b = p.batches[0];
    ok(!b.consume.some(c => c.productId === 99), 'servietten trækkes ikke af en produktionsbatch');
    ok(b.batches_made === 1, 'og en manglende serviet blokerer ikke mayonnaisen');
}

// ─── U · ukendt udbytte ────────────────────────────────────────
console.log('\nU · Uden erklæret udbytte gættes der ikke\n');
{
    productMap.set(71, { id: 71, name: 'Tahin dressing', qu_id_stock: 4 });
    const p = plan([{ product_id: 71, amount_stock: 2 }], { 71: 0, 47: 10 });
    ok(p.batches.length === 0, 'der produceres intet');
    ok(p.skipped.length === 1 && p.skipped[0]?.reason === 'yield_unknown',
       'men det siges højt — "ét batch og håb" ville lægge en ukendt mængde på lageret');
    ok(p.skipped[0]?.recipe_name === 'Tahin dressing', 'med navn på den opskrift der mangler et felt i Grocy');
}

// ─── N · idempotens ────────────────────────────────────────────
console.log('\nN · Et gentaget træk må ikke producere igen\n');
{
    ok(autoBatchNonce(4183, 10) === 'auto:bon:4183:recipe:10', 'nonce er deterministisk, ikke tilfældig');
    ok(autoBatchNonce(4183, 10) === autoBatchNonce(4183, 10), 'samme bon + opskrift → samme nonce');
    ok(autoBatchNonce(4183, 10) !== autoBatchNonce(4184, 10), 'men to bons deler ikke nonce');
}

// ─── X · udførelsen ────────────────────────────────────────────
console.log('\nX · Hvad sker der faktisk?\n');
(async () => {
    const lavetDb = (kendteNonces = []) => {
        const rows = [];
        return {
            rows,
            prepare: (sql) => ({
                get: (n) => kendteNonces.includes(n) ? { id: 1 } : undefined,
                run: (...a) => { rows.push({ sql: sql.trim().slice(0, 40), a }); return { lastInsertRowid: rows.length }; },
            }),
        };
    };
    const lavetGrocy = (opts = {}) => {
        const kald = { produce: [], shopping: [] };
        return {
            kald,
            produceBatch: async (p) => {
                kald.produce.push(p);
                if (opts.fejl) throw new Error('Grocy nede');
                return { state: 'produced', produceTx: 'tx1', consumeTx: [] };
            },
            addToShoppingList: async (items) => { kald.shopping.push(...items); return []; },
        };
    };

    const p = plan([{ product_id: 70, amount_stock: 2 }], { 70: 0, 47: 10, 41: 0.5 });
    const db = lavetDb(), g = lavetGrocy();
    const logget = [];
    const r = await runAutoBatches(4183, p, {
        db, grocy: g, locationId: 1, userId: 7,
        unitCost: (pid) => ({ 47: 100, 41: 40 })[pid] || 0,
        logChange: (e) => logget.push(e),
    });

    ok(g.kald.produce.length === 1, 'ét produceBatch-kald');
    ok(near(g.kald.produce[0]?.produce?.amount ?? -1, 1), 'der lægges 1 kg på (ét batch), ikke 2');
    ok(near(g.kald.produce[0]?.consume?.find(c => c.productId === 47)?.amount ?? -1, 0.5),
       'og der trækkes råvarer til præcis dét ene batch');
    ok(near(g.kald.produce[0]?.produce?.price ?? -1, 70), 'kostpris: (0,5×100 + 0,5×40) / 1 kg = 70 kr/kg ex moms');
    ok(g.kald.shopping.length === 1 && g.kald.shopping[0].product_id === 41,
       'den manglende RÅVARE lægges på indkøbslisten — ikke mellemproduktet');
    ok(db.rows.some(x => /production_batches/.test(x.sql)), 'revisionsspor skrevet');
    ok(db.rows.filter(x => /production_batch_consumption/.test(x.sql)).length === 2, 'med begge råvarelinjer');
    ok(logget.length === 1 && logget[0].action === 'auto_batch', 'og en changelog-post på bonen');
    ok(r.shortages.length === 1, 'manglen rapporteres tilbage til kalderen');

    // Grænsen hele vejen igennem, ikke kun i planen: et RR Produktion-behov
    // må ALDRIG nå frem til et Grocy-kald. Issuet kræver denne assert eksplicit.
    const rrPlan = plan([{ product_id: 80, amount_stock: 5 }], { 80: 0, 90: 100 });
    const dbRR = lavetDb(), gRR = lavetGrocy();
    const rRR = await runAutoBatches(4183, rrPlan, {
        db: dbRR, grocy: gRR, locationId: 1, unitCost: () => 0, logChange: () => {},
    });
    ok(gRR.kald.produce.length === 0, 'RR Produktion: produceBatch kaldes ALDRIG');
    ok(gRR.kald.shopping.length === 0, 'og der lægges ikke råvarer til den på indkøbslisten');
    ok(dbRR.rows.length === 0, 'og der skrives intet spor');
    ok(rRR.produced.length === 0 && rRR.shortages.length === 0, 'den er slet ikke vores at røre');

    // Gentaget træk efter en fejl: nonce'en findes allerede.
    const db2 = lavetDb([autoBatchNonce(4183, 10)]), g2 = lavetGrocy();
    const r2 = await runAutoBatches(4183, p, {
        db: db2, grocy: g2, locationId: 1, unitCost: () => 0, logChange: () => {},
    });
    ok(g2.kald.produce.length === 0, 'gentagelse producerer IKKE igen — nonce-kollisionen er værnet');
    ok(r2.produced.length === 0, 'og rapporterer ærligt at intet blev lavet');

    // Grocy nede: leveringen må ikke vælte.
    const db3 = lavetDb(), g3 = lavetGrocy({ fejl: true });
    const r3 = await runAutoBatches(4183, p, {
        db: db3, grocy: g3, locationId: 1, unitCost: () => 0, logChange: () => {},
    });
    ok(r3.errors.length === 1, 'en Grocy-fejl rapporteres');
    ok(r3.produced.length === 0, 'intet påstås produceret');
    ok(!db3.rows.some(x => /production_batches/.test(x.sql)), 'og der skrives intet spor på noget der ikke skete');

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
