// scripts/test-production-yield.js
// ============================================================
// Udbyttet skal på lageret i LAGER-enhed — ikke i opskriftens fritekst-enhed.
//
// `POST /stock/products/{id}/add` læser altid lager-enhed. Feltet i UI'et var
// mærket med opskriftens `recipeunit`, et fritekst-userfield uden relation til
// produktets `qu_id_stock`, og tallet gik ukonverteret videre. 23 opskrifter i
// grocy-hq erklærer "kg": producerede man 20 portioner af én af dem, landede
// der 20 kg på lageret uanset hvad opskriften giver — og kostprisen blev
// kr/portion mærket som kr/kg (#360).
//
// Tre lag, fordi fejlen kan sidde i hvert:
//   Y  udbytte-reglen   (shared/recipe_yield.js — delt med browseren)
//   S  serverens værn   (services/production.js — nægter at gætte)
//   K  klientens felt   (shared/production_batch.js i en vm-sandkasse)
//
// Kør:  node scripts/test-production-yield.js
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const Y = require('../shared/recipe_yield');
const { resolveYieldToStock, buildBatchPlan } = require('../services/production');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// Grocy-lignende stamdata. `Remoulade` lagerføres i Kilo og erklærer sit
// udbytte i kg; `Falaffel` erklærer "antal" men lagerføres i Kilo.
const UNITS = [{ id: 4, name: 'Kilo' }, { id: 8, name: 'Antal' }, { id: 9, name: 'Liter' }];
const REM   = { id: 70, name: 'Remoulade', qu_id_stock: 4 };
const FAL   = { id: 71, name: 'Falaffel',  qu_id_stock: 4 };
const CONV  = [{ product_id: 71, from_qu_id: 8, to_qu_id: 4, factor: 0.025 }];  // 1 stk = 25 g

const R_REM = { id: 1, base_servings: 1, userfields: { recipeunit: 'kg',    recipeunitnumber: '1'  } };
const R_FAL = { id: 2, base_servings: 1, userfields: { recipeunit: 'antal', recipeunitnumber: '40' } };
const R_TOM = { id: 3, base_servings: 1, userfields: { recipeunit: 'kg' } };            // intet yield-tal
const R_KR  = { id: 4, base_servings: 1, userfields: { recipeunit: 'Kr', recipeunitnumber: '5' } };

// ─── Y · udbytte-reglen ────────────────────────────────────────
console.log('\nY · Hvad giver opskriften, i lager-enhed?\n');
{
    ok(Y.yieldInStockUnits(R_REM, REM, UNITS, []) === 1, 'Remoulade: 1 kg, samme enhed som lageret');
    ok(near(Y.yieldInStockUnits(R_FAL, FAL, UNITS, CONV), 1),
       'Falaffel: 40 stk × 25 g = 1 kg — konverteringen bruges, ikke ignoreres');
    ok(Y.yieldInStockUnits(R_FAL, FAL, UNITS, []) === null,
       'uden konvertering: null, ikke 40 (40 kg falaffel ville være absurd)');
    ok(Y.yieldInStockUnits(R_TOM, REM, UNITS, []) === null,
       'uden recipeunitnumber kan udbyttet ikke bestemmes');
    ok(Y.yieldInStockUnits(R_KR, REM, UNITS, []) === null,
       '"Kr" er ikke en enhed — feltet bruges til flere formål end enheder');

    // Skalering: base_servings er opskriftens EGET grundlag.
    const R4 = { id: 5, base_servings: 4, userfields: { recipeunit: 'kg', recipeunitnumber: '0.3' } };
    ok(near(Y.yieldInStockUnits(R4, REM, UNITS, []), 1.2), 'base_servings 4 × 0,3 kg = 1,2 kg for hele opskriften');
    ok(near(Y.plannedYieldStock(R4, REM, UNITS, [], 6), 1.8), '6 portioner af en 4-portioners opskrift = 1,8 kg');
    ok(near(Y.plannedYieldStock(R4, REM, UNITS, [], 4), 1.2), '4 portioner = opskriften som den står');
    ok(Y.plannedYieldStock(R_TOM, REM, UNITS, [], 6) === null, 'ukendt udbytte skalerer ikke til et gæt');
    ok(Y.stockUnitName(FAL, UNITS) === 'Kilo', 'lager-enhedens navn til visning');
}

// ─── S · serverens værn ────────────────────────────────────────
console.log('\nS · Nægter serveren at gætte enheden?\n');
{
    const kald = (o) => resolveYieldToStock({ units: UNITS, conversions: CONV, ...o });

    ok(kald({ product: REM, recipe: R_REM, amount: 20, quId: 4 }).amount === 20,
       'lager-enhed oplyst: tallet går uændret igennem');

    const f = kald({ product: FAL, recipe: R_FAL, amount: 40, quId: 8 });
    ok(near(f.amount, 1) && near(f.factor, 0.025), '40 stk → 1 kg');

    ok(kald({ product: FAL, recipe: R_FAL, amount: 40, quId: 9 }).error != null,
       'enhed uden omregning afvises — ingen skrivning til lageret');
    ok(/Ingen enhedsomregning/.test(kald({ product: FAL, recipe: R_FAL, amount: 40, quId: 9 }).error),
       'og fejlen siger hvad der skal oprettes i Grocy');

    // Cachet klient uden yield_qu_id: kun forsvarligt når der ikke ER en tvetydighed.
    ok(kald({ product: REM, recipe: R_REM, amount: 20, quId: null }).amount === 20,
       'ingen enhed oplyst, men opskrift og lager er enige → uændret');
    ok(kald({ product: FAL, recipe: R_FAL, amount: 40, quId: null }).error != null,
       'ingen enhed oplyst OG opskriften erklærer en anden → afvist, ikke gættet');

    ok(kald({ product: null, recipe: R_REM, amount: 20, quId: 4 }).error != null,
       'ukendt output-produkt kan ikke prissættes eller lagerføres');
    ok(kald({ product: { id: 9 }, recipe: R_REM, amount: 20, quId: 4 }).error != null,
       'produkt uden lager-enhed afvises');
}

// ─── S2 · kostprisen følger med ────────────────────────────────
console.log('\nS2 · Kr pr. enhed regnes på det omregnede udbytte\n');
{
    // 40 falafler koster 50 kr at lave. Regnes prisen på "40", bliver den
    // 1,25 kr/kg i stedet for 50 kr/kg — 40× for lav, mærket som kr/kg.
    const lines = [{ productId: 1, actualQty: 1, plannedQty: 1, fromQuId: 4, toQuId: 4 }];
    const costMap = { 1: 50 };
    const forkert = buildBatchPlan({ portions: 1, actualYield: 40, lines, conversions: [], costMap, requireYield: true });
    const rigtigt = buildBatchPlan({ portions: 1, actualYield: 1,  lines, conversions: [], costMap, requireYield: true });
    ok(near(rigtigt.pricePerUnit, 50), 'omregnet udbytte (1 kg) → 50 kr/kg');
    ok(near(forkert.pricePerUnit, 1.25), 'ikke-omregnet (40) ville give 1,25 kr/kg — 40× for lavt');
}

// ─── K · klientens felt ────────────────────────────────────────
console.log('\nK · Hvad står der i feltet?\n');
{
    // Browserkode kan ikke require'es. Filen køres i en sandkasse med de
    // globals den forventer, og dens egen `open()` kaldes — ikke en kopi.
    const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'production_batch.js'), 'utf8');
    // Stubbene skal kunne alt panelet rører ved under render+bind. Mangler én
    // metode, kaster testen i stedet for at fejle — og en stak-udskrift siger
    // ikke hvilken regel der blev brudt.
    const el = () => ({
        innerHTML: '', addEventListener() {}, removeEventListener() {},
        querySelectorAll: () => [],
        scrollIntoView() {}, focus() {}, appendChild() {}, setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {} }, style: {},
    });
    const ctx = {
        console, setTimeout, clearTimeout,
        document: { getElementById: () => null, querySelectorAll: () => [], createElement: el },
        window: { RecipeYield: Y },
    };
    ctx.window.window = ctx.window;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const PB = ctx.window.ProductionBatch;
    ok(PB && typeof PB.open === 'function', 'ProductionBatch.open findes');

    const aabn = (recipe, product, conversions) => {
        const mount = el();
        let html = '';
        Object.defineProperty(mount, 'innerHTML', { get: () => html, set: v => { html = v; } });
        // `_bind` slår elementer op efter render og hænger lyttere på dem;
        // returnerer stubben null, kaster den i stedet for at fejle rent.
        mount.querySelector = () => el();
        PB.open({
            recipe: { ...recipe, product_id: product.id, name: 'x', recipeUnit: (recipe.userfields || {}).recipeunit },
            ingredients: [], container: mount,
            productsMap: { [product.id]: product },
            quUnitsMap: { 4: 'Kilo', 8: 'Antal' },
            conversions,
        });
        return html;
    };

    const remHtml = aabn(R_REM, REM, []);
    ok(/id="pbYield" value="1"/.test(remHtml), 'Remoulade: feltet står på 1 (kg), ikke på antal portioner');
    ok(/pb-l-unit">Kilo</.test(remHtml), 'og er mærket med LAGER-enheden');

    const falHtml = aabn(R_FAL, FAL, CONV);
    ok(/id="pbYield" value="1"/.test(falHtml), 'Falaffel: 40 stk vises som 1 kg — ikke som 40');
    ok(/pb-l-unit">Kilo</.test(falHtml), 'og mærket Kilo, ikke "antal"');

    const tomHtml = aabn(R_TOM, REM, []);
    ok(/id="pbYield" value=""/.test(tomHtml), 'ukendt udbytte → tomt felt, intet gæt');
    ok(/pb-yield-hint/.test(tomHtml), 'og en linje der siger hvorfor');

    // Uden konvertering kan Falaffel ikke udledes — heller ikke her gættes der.
    const falUdenKonv = aabn(R_FAL, FAL, []);
    ok(/id="pbYield" value=""/.test(falUdenKonv), 'manglende omregning → tomt felt, ikke 40');
}

console.log(`\n${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
