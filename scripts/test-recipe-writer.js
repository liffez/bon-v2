// scripts/test-recipe-writer.js
// ============================================================
// Den fælles writer: designer og import skriver samme vej (designer-spec §12,
// importspec §4.5).
//
// Grocy stubbes, fordi de interessante tilfælde ikke kan fremprovokeres mod en
// rigtig instans: "vare 2 af 3 fejler", "POST svarer 200 men varen kan ikke
// læses tilbage", "fortrydelsen fejler selv". Det er netop dem der afgør om en
// halv skrivning efterlader rod.
//
// Dækker T1, T4, T6, T12 og T18 fra designer-specens §16.
//
// Kør:  node scripts/test-recipe-writer.js
// ============================================================
'use strict';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const grocy = require('../services/grocyAdapter');
const { writeRecipe, WriterError } = require('../services/recipeWriter');

// ── falsk Grocy ───────────────────────────────────────────────
// Registrerer hver skrivning og kan sættes til at fejle på et bestemt kald.
function fakeGrocy(fejl) {
    const st = { products: [{ id: 1, name: 'Brød Rug', qu_id_stock: 4 },
                            { id: 2, name: 'Mayonaise', qu_id_stock: 4 }],
                 recipes: [], pos: [], nestings: [] };
    const skrivninger = [];
    let næste = 100;
    const maaskeFejl = (navn, arg) => {
        if (fejl && fejl.on === navn && (fejl.when == null || fejl.when(arg))) {
            throw new Error(fejl.message || ('stub-fejl i ' + navn));
        }
    };
    const org = {};
    const stub = {
        createProduct: async (b) => { skrivninger.push(['createProduct', b.name]); maaskeFejl('createProduct', b);
            const id = ++næste; st.products.push(Object.assign({ id }, b)); return { created_object_id: id }; },
        deleteProduct: async (id) => { skrivninger.push(['deleteProduct', id]); maaskeFejl('deleteProduct', id);
            st.products = st.products.filter(p => p.id !== id); return { ok: true }; },
        getProductFresh: async (id) => { maaskeFejl('getProductFresh', id);
            return st.products.find(p => Number(p.id) === Number(id)) || null; },
        updateProductUserfields: async (id, f) => { skrivninger.push(['productUserfields', id, f]); maaskeFejl('updateProductUserfields', id); return { ok: true }; },
        createRecipe: async (b) => { skrivninger.push(['createRecipe', b.name]); maaskeFejl('createRecipe', b);
            const id = ++næste; st.recipes.push(Object.assign({ id }, b)); return { created_object_id: id }; },
        deleteRecipe: async (id) => { skrivninger.push(['deleteRecipe', id]); maaskeFejl('deleteRecipe', id);
            st.recipes = st.recipes.filter(r => r.id !== id); return { ok: true }; },
        updateRecipe: async (id, b) => { skrivninger.push(['updateRecipe', id, b]); maaskeFejl('updateRecipe', id); return { ok: true }; },
        updateRecipeUserfields: async (id, f) => { skrivninger.push(['recipeUserfields', id, f]); maaskeFejl('updateRecipeUserfields', id); return { ok: true }; },
        createRecipePos: async (b) => { skrivninger.push(['createPos', b.product_id, b.amount]); maaskeFejl('createRecipePos', b); return { created_object_id: ++næste }; },
        updateRecipePos: async (id, b) => { skrivninger.push(['updatePos', id, b]); maaskeFejl('updateRecipePos', id); return { ok: true }; },
        deleteRecipePos: async (id) => { skrivninger.push(['deletePos', id]); maaskeFejl('deleteRecipePos', id); return { ok: true }; },
        createRecipeNesting: async (b) => { skrivninger.push(['createNest', b.includes_recipe_id]); maaskeFejl('createRecipeNesting', b); return { created_object_id: ++næste }; },
        updateRecipeNesting: async (id, b) => { skrivninger.push(['updateNest', id, b]); maaskeFejl('updateRecipeNesting', id); return { ok: true }; },
        deleteRecipeNesting: async (id) => { skrivninger.push(['deleteNest', id]); maaskeFejl('deleteRecipeNesting', id); return { ok: true }; },
        invalidateAllRecipeCosts: () => { skrivninger.push(['cacheAll']); },
    };
    for (const k of Object.keys(stub)) { org[k] = grocy[k]; grocy[k] = stub[k]; }
    return { st, skrivninger, gendan: () => { for (const k of Object.keys(org)) grocy[k] = org[k]; } };
}

const gemt = () => ({
    recipe_id: 7, name: 'Chili Mayo', group: 'RR produktion Hurtig',
    base_servings: 1, description: '1. Rør det hele',
    yield: { amount: 1.1, unit: 'kg', product_id: 34 },
    lines: [
        { id: 11, product_id: 1, amount: 1, section: 'Base', note: null },
        { id: 12, product_id: 2, amount: 0.1, section: 'Base', note: null },
    ],
});
const klon = o => JSON.parse(JSON.stringify(o));

(async () => {

// ── T1 ────────────────────────────────────────────────────────
console.log('\n── T1 Gem uden ændringer skriver INTET (I4) ──────────────');
{
    const g = fakeGrocy();
    const o = gemt();
    const r = await writeRecipe(klon(o), o);
    ok(g.skrivninger.length === 0, 'ingen skrivninger: ' + JSON.stringify(g.skrivninger));
    ok(r.wrote === false && r.changeCount === 0, 'svaret siger at der ikke blev skrevet');
    g.gendan();
}

console.log('\n── Én ændring skriver ÉN ting ────────────────────────────');
{
    const g = fakeGrocy();
    const o = gemt(); const d = klon(o);
    d.lines[1].amount = 0.2;
    const r = await writeRecipe(d, o);
    ok(r.changeCount === 1, 'planen tæller én ændring, fik ' + r.changeCount);
    ok(g.skrivninger.length === 1 && g.skrivninger[0][0] === 'updatePos',
        'kun linjen skrives: ' + JSON.stringify(g.skrivninger));
    ok(g.skrivninger[0][2].amount === 0.2 && !('product_id' in g.skrivninger[0][2]),
        'kun mængden i kroppen: ' + JSON.stringify(g.skrivninger[0][2]));
    g.gendan();
}

console.log('\n── Udbyttet skrives ikke ud fra base_servings (#680) ─────');
{
    const g = fakeGrocy();
    const o = gemt(); const d = klon(o);
    d.base_servings = 4;
    await writeRecipe(d, o);
    const uf = g.skrivninger.filter(w => w[0] === 'recipeUserfields');
    ok(uf.length === 0, 'et ændret portionsantal rører ikke udbyttet: ' + JSON.stringify(uf));
    ok(g.skrivninger.some(w => w[0] === 'updateRecipe' && w[2].base_servings === 4), 'portionsantallet skrives');
    g.gendan();
}

// ── T4 ────────────────────────────────────────────────────────
console.log('\n── T4 Ny vare uden lagerenhed blokerer gem (R8.4) ────────');
{
    const g = fakeGrocy();
    const o = gemt(); const d = klon(o);
    d.lines.push({ amount: 0.05, new_product: { key: 'a', name: 'Chiliolie' } });
    let fejlet = null;
    try { await writeRecipe(d, o); } catch (e) { fejlet = e; }
    ok(fejlet instanceof WriterError && fejlet.code === 'missing_unit', 'afvises som brugerfejl, ikke serverfejl');
    // Optional chaining: en assert der KASTER er et dårligere signal end en der
    // fejler — så ligner en fanget fejl et brudt testscript.
    ok(fejlet && fejlet.details && fejlet.details[0] && fejlet.details[0].name === 'Chiliolie',
        'linjen navngives: ' + JSON.stringify(fejlet && fejlet.details));
    ok(g.skrivninger.length === 0, 'INTET blev skrevet — fejlen koster ingenting');
    g.gendan();
}

// ── Ny vare ad den gode vej ───────────────────────────────────
console.log('\n── Ny vare oprettes først, verificeres, og linjen peger på den ──');
{
    const g = fakeGrocy();
    const o = gemt(); const d = klon(o);
    d.lines.push({ amount: 0.05, section: 'Base',
        new_product: { key: 'a', name: 'Chiliolie', qu_id_stock: 4, co2e_per_unit: 3.2 } });
    const r = await writeRecipe(d, o);
    const rk = g.skrivninger.map(w => w[0]);
    ok(rk.indexOf('createProduct') < rk.indexOf('createPos'), 'varen oprettes FØR linjen: ' + rk.join(' → '));
    ok(r.createdProducts.length === 1 && r.createdProducts[0].name === 'Chiliolie', 'den oprettede vare logges');
    const pos = g.skrivninger.find(w => w[0] === 'createPos');
    ok(pos[1] === r.createdProducts[0].id, 'linjen peger på den nye vares id');
    ok(g.skrivninger.some(w => w[0] === 'productUserfields' && w[2].co2e_per_kg === '3.2'),
        'CO₂ lander på VAREN, ikke på opskriften');
    g.gendan();
}

// ── T6 + T18 ──────────────────────────────────────────────────
console.log('\n── T18 Vare 2 af 3 fejler → vare 1 fortrydes, intet gemmes ──');
{
    const g = fakeGrocy({ on: 'createProduct', when: b => b.name === 'Vare 2' });
    const o = gemt(); const d = klon(o);
    ['Vare 1', 'Vare 2', 'Vare 3'].forEach((n, i) =>
        d.lines.push({ amount: 1, new_product: { key: 'k' + i, name: n, qu_id_stock: 4 } }));
    let fejlet = null;
    try { await writeRecipe(d, o); } catch (e) { fejlet = e; }
    ok(!!fejlet, 'gem fejler');
    ok(g.skrivninger.some(w => w[0] === 'deleteProduct'), 'vare 1 fortrydes');
    ok(fejlet && fejlet.rolledBack === 1, 'svaret siger hvor mange der blev fortrudt: ' + (fejlet && fejlet.rolledBack));
    ok(!g.skrivninger.some(w => ['updateRecipe', 'createRecipe', 'createPos', 'recipeUserfields'].includes(w[0])),
        'opskriften røres IKKE: ' + JSON.stringify(g.skrivninger.map(w => w[0])));
    ok(g.st.products.filter(p => String(p.name).startsWith('Vare')).length === 0,
        'ingen af de nye varer står tilbage i Grocy');
    g.gendan();
}

console.log('\n── T6 En vare der ikke kan læses tilbage tæller som fejl ──');
{
    const g = fakeGrocy({ on: 'getProductFresh', when: id => id > 100 });
    const o = gemt(); const d = klon(o);
    d.lines.push({ amount: 1, new_product: { key: 'a', name: 'Spøgelse', qu_id_stock: 4 } });
    let fejlet = null;
    try { await writeRecipe(d, o); } catch (e) { fejlet = e; }
    ok(!!fejlet, 'et POST der svarer 200 er ikke bevis nok');
    ok(!g.skrivninger.some(w => w[0] === 'createPos'), 'ingen linje peger på den uverificerede vare');
    g.gendan();
}

console.log('\n── Fortrydelsen kan selv fejle — og det siges højt ───────');
{
    const g = fakeGrocy({ on: 'createRecipePos', message: 'linjen røg' });
    const o = gemt(); const d = klon(o);
    d.lines.push({ amount: 1, new_product: { key: 'a', name: 'Chiliolie', qu_id_stock: 4 } });
    // Lad varen oprette sig, men gør sletningen umulig.
    const orgDel = grocy.deleteProduct;
    grocy.deleteProduct = async () => { throw new Error('Grocy nægter'); };
    let fejlet = null;
    try { await writeRecipe(d, o); } catch (e) { fejlet = e; }
    grocy.deleteProduct = orgDel;
    ok(!!fejlet, 'gem fejler');
    ok(fejlet && fejlet.orphans && fejlet.orphans.length === 1
        && fejlet.orphans[0].name === 'Chiliolie',
        'den forældreløse vare navngives frem for at blive slugt: ' + JSON.stringify(fejlet && fejlet.orphans));
    ok(fejlet && fejlet.rolledBack === 0, 'og der loves ikke en fortrydelse der ikke skete');
    g.gendan();
}

// ── T12 ───────────────────────────────────────────────────────
console.log('\n── T12 En NY opskrift: samme vej, og den ryddes ved fejl ──');
{
    const g = fakeGrocy();
    const d = { recipe_id: null, name: 'ZZT ny', group: '02 Salat', base_servings: 1,
        yield: { amount: 1, unit: 'stk' },
        lines: [{ product_id: 1, amount: 0.2, section: 'Brød' },
                { includes_recipe_id: 9, servings: 2 }] };
    const r = await writeRecipe(d, null);
    const rk = g.skrivninger.map(w => w[0]);
    ok(r.recipeId > 0 && rk.includes('createRecipe'), 'opskriften oprettes');
    ok(rk.indexOf('createRecipe') < rk.indexOf('createPos'), 'linjer efter opskriften: ' + rk.join(' → '));
    ok(rk.includes('createNest'), 'nestings oprettes også');
    g.gendan();

    const g2 = fakeGrocy({ on: 'createRecipeNesting' });
    let fejlet = null;
    try { await writeRecipe(d, null); } catch (e) { fejlet = e; }
    ok(!!fejlet && g2.skrivninger.some(w => w[0] === 'deleteRecipe'),
        'fejler noget efter oprettelsen, ryddes den nye opskrift med');
    ok(g2.st.recipes.length === 0, 'ingen halv opskrift står tilbage');
    g2.gendan();
}

console.log('\n── En ændret produceret vare rydder HELE kostpris-cachen ──');
{
    const g = fakeGrocy();
    const o = gemt(); const d = klon(o);
    d.yield.product_id = null;
    await writeRecipe(d, o);
    ok(g.skrivninger.some(w => w[0] === 'cacheAll'),
        'cachen ryddes bredt — varens pris skifter for alle der bruger den (#558)');
    g.gendan();

    const g2 = fakeGrocy();
    const d2 = klon(gemt()); d2.name = 'Nyt navn';
    await writeRecipe(d2, gemt());
    ok(!g2.skrivninger.some(w => w[0] === 'cacheAll'), 'en ren navneændring rydder ikke alt');
    g2.gendan();
}

// ── Ruterne ───────────────────────────────────────────────────
console.log('\n── POST /api/opskrifter/:id/gem og /ny ───────────────────');
{
    const o = gemt();
    const g = fakeGrocy();
    // Det `loadGrocy` og lokations-opslaget skal bruge.
    const orgL = grocy.getLocations, orgR = grocy.getRecipesRaw, orgP = grocy.getAllRecipesPos,
          orgN = grocy.getRecipeNestings, orgPr = grocy.getProducts, orgU = grocy.getQuantityUnits,
          orgC = grocy.getQuantityUnitConversions, orgG = grocy.getProductGroups,
          orgD = grocy.getProductUnitCostDetails;
    grocy.getLocations = async () => [{ id: 3, name: 'Køl' }];
    grocy.getRecipesRaw = async () => [{ id: 7, name: o.name, base_servings: 1, product_id: 34,
        description: o.description, userfields: { grupper: o.group, recipeunit: 'kg', recipeunitnumber: '1.1' } }];
    grocy.getAllRecipesPos = async () => o.lines.filter(l => l.product_id)
        .map(l => ({ id: l.id, recipe_id: 7, product_id: l.product_id, amount: l.amount,
                     ingredient_group: l.section, note: null }));
    grocy.getRecipeNestings = async () => [];
    grocy.getProducts = async () => g.st.products;
    grocy.getQuantityUnits = async () => [{ id: 4, name: 'Kilo' }];
    grocy.getQuantityUnitConversions = async () => [];
    grocy.getProductGroups = async () => [];
    grocy.getProductUnitCostDetails = async () => new Map();

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/opskrifter', require('../routes/opskrifter'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (sti, b) => fetch(base + sti, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    let r = await post('/api/opskrifter/7/gem', klon(o));
    let j = await r.json();
    ok(r.status === 200 && j.wrote === false && j.change_count === 0,
        `uændret gem over HTTP skriver intet (${r.status}, ${JSON.stringify(j)})`);
    ok(g.skrivninger.length === 0, 'og der gik ingen skrivninger til Grocy');

    const d = klon(o); d.lines[0].amount = 2;
    r = await post('/api/opskrifter/7/gem', d);
    j = await r.json();
    ok(r.status === 200 && j.change_count === 1, 'én ændring gemmes og tælles');

    const blokeret = klon(o);
    blokeret.lines.push({ amount: 1, new_product: { key: 'x', name: 'Uden enhed' } });
    r = await post('/api/opskrifter/7/gem', blokeret);
    j = await r.json();
    ok(r.status === 400 && j.code === 'missing_unit',
        'manglende lagerenhed er 400 — brugerens fejl, ikke serverens');
    ok(Array.isArray(j.details) && j.details[0] && j.details[0].name === 'Uden enhed',
        'svaret peger på linjen: ' + JSON.stringify(j.details));
    ok(Array.isArray(j.orphans) && j.orphans.length === 0, 'og der er intet at rydde op i');

    r = await post('/api/opskrifter/999999/gem', klon(o));
    ok(r.status === 404, 'ukendt opskrift → 404');

    r = await post('/api/opskrifter/ny', { name: 'ZZT rute-ny', base_servings: 1,
        yield: { amount: 1, unit: 'stk' }, lines: [{ product_id: 1, amount: 1 }] });
    j = await r.json();
    ok(r.status === 200 && j.recipe_id > 0, 'ny opskrift oprettes over HTTP');

    r = await post('/api/opskrifter/ny', { name: 'ZZT uden linjer' });
    ok(r.status === 400, 'en krop uden `lines` afvises');

    srv.close();
    grocy.getLocations = orgL; grocy.getRecipesRaw = orgR; grocy.getAllRecipesPos = orgP;
    grocy.getRecipeNestings = orgN; grocy.getProducts = orgPr; grocy.getQuantityUnits = orgU;
    grocy.getQuantityUnitConversions = orgC; grocy.getProductGroups = orgG;
    grocy.getProductUnitCostDetails = orgD;
    g.gendan();
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('\x1b[31mtesten væltede:\x1b[0m', e); process.exit(1); });
