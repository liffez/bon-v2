// scripts/convert-blend-to-product.js
// ============================================================
// Konvertér én `RR produktion Hurtig`-blanding til et rigtigt produkt (#268).
//
// FØR:  menu  ──nesting──>  blanding  ──>  råvarer
// EFTER: menu ──recipes_pos──> PRODUKT  <──produces── blanding ──> råvarer
//
// Efter springet er mellemproduktet tælleligt ved optælling, og råvarerne
// forbruges præcis én gang — i produktionen.
//
// Alt hvad scriptet gør, gemmes i en tilstandsfil, og `--rollback` lægger det
// hele tilbage. Det er hele grunden til at det er et script og ikke klik i
// Grocy: en manuel konvertering af 26 menuer kan ikke fortrydes.
//
//   # 1. mål før
//   node --env-file=.env scripts/recipe-fingerprint.js --uses Remoulade --out foer.json
//   # 2. se hvad der ville ske
//   node --env-file=.env scripts/convert-blend-to-product.js --recipe Remoulade --state remo.json
//   # 3. gør det
//   node --env-file=.env scripts/convert-blend-to-product.js --recipe Remoulade --state remo.json --apply
//   # 4. mål efter og sammenlign
//   node --env-file=.env scripts/recipe-fingerprint.js --uses Remoulade --out efter.json
//   node scripts/recipe-fingerprint.js --diff foer.json efter.json
//   # 5. fortryd
//   node --env-file=.env scripts/convert-blend-to-product.js --rollback --state remo.json --apply
//
// Dry-run er default. `--apply` skriver.
//
// Instansen bestemmes af databasen (`settings.default_grocy_location_id`) —
// samme opslag som appen. Peger den et andet sted end Test, kræves `--confirm-hq`.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const APPLY    = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback');
const CONFIRM  = process.argv.includes('--confirm-hq');
const STATE    = argOf('--state');

function argOf(f) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; }
function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

if (!STATE) die('Angiv --state <fil>. Uden en tilstandsfil kan konverteringen ikke fortrydes.');

const grocy = require(path.join(__dirname, '..', 'services', 'grocyAdapter'));

// Samme fritekst→enhed-oversættelse som resolveren bruger. `recipeunit` er
// fritekst ("kg"), Grocys enheder hedder "Kilo".
const UNIT_ALIASES = { kg: 'kilo', kilo: 'kilo', kilogram: 'kilo', g: 'gram', gram: 'gram',
                       l: 'liter', liter: 'liter', ml: 'ml',
                       stk: 'antal', 'stk.': 'antal', styk: 'antal', antal: 'antal' };
const norm = (s) => { const n = String(s || '').trim().toLowerCase(); return UNIT_ALIASES[n] || n; };

(async () => {
    const cfg = grocy.getGrocyConfig();
    console.log(`\nGrocy-instans: \x1b[1m${cfg.locationName}\x1b[0m  ·  ${APPLY ? '\x1b[31mSKRIVER\x1b[0m' : 'dry-run'}`);
    if (String(cfg.locationName).toLowerCase() !== 'test' && !CONFIRM) {
        die(`Instansen er "${cfg.locationName}", ikke Test. Tilføj --confirm-hq hvis det er med vilje.`);
    }

    if (ROLLBACK) return rollback(cfg);

    const recipeArg = argOf('--recipe');
    if (!recipeArg) die('Angiv --recipe <id eller navn>');
    if (fs.existsSync(STATE)) die(`${STATE} findes allerede. Kør --rollback først, eller vælg et andet navn.`);

    const [rawMap, allPos, nestings, products, units, conversions] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
    ]);
    const rawList = [...rawMap.entries()].map(([id, r]) => ({ ...r, id: r.id ?? id }));

    // ── Find blandingen ──
    const byId = rawList.find(r => String(r.id) === String(recipeArg));
    const byName = rawList.filter(r => String(r.name || '').toLowerCase().includes(String(recipeArg).toLowerCase()));
    const recipe = byId || (byName.length === 1 ? byName[0] : null);
    if (!recipe) {
        if (byName.length > 1) die(`"${recipeArg}" matcher flere: ${byName.map(r => `${r.id} ${r.name}`).join(', ')}`);
        die(`Ingen opskrift matcher "${recipeArg}"`);
    }
    if (recipe.product_id && String(recipe.product_id) !== '0') {
        const p = products.find(x => Number(x.id) === Number(recipe.product_id));
        die(`${recipe.id} "${recipe.name}" producerer allerede "${p ? p.name : recipe.product_id}". Intet at konvertere.`);
    }

    // ── Udbyttet SKAL være erklæret ──
    // Uden det kan menu-mængderne ikke regnes, og gaten kan ikke folde
    // produktet tilbage til råvarer. Vi opfinder ikke et udbytte.
    const uf = recipe.userfields || {};
    const perServing = parseFloat(uf.recipeunitnumber);
    const base = parseFloat(recipe.base_servings) || 1;
    if (!Number.isFinite(perServing) || perServing <= 0) {
        die(`"${recipe.name}" mangler userfield recipeunitnumber. Udfyld udbyttet i Grocy først (jf. #372) — ellers`
            + ' kan hverken menu-mængderne eller gatens tilbage-foldning regnes.');
    }
    const yieldUnit = units.find(u => norm(u.name) === norm(uf.recipeunit));
    if (!yieldUnit) die(`"${recipe.name}" har recipeunit "${uf.recipeunit}", som ikke svarer til nogen Grocy-enhed.`);

    // ── Menuerne der nester den ──
    const hits = nestings.filter(n => Number(n.includes_recipe_id) === Number(recipe.id));
    if (!hits.length) die(`Ingen opskrift nester "${recipe.name}". Intet at flytte.`);

    // ── Skabelon: et eksisterende produceret produkt, så lokation og gruppe
    //    ikke skal gættes ──
    const producedIds = new Set(rawList.map(r => Number(r.product_id)).filter(Boolean));
    const template = products.find(p => producedIds.has(Number(p.id)) && String(p.active) !== '0');
    if (!template) die('Fandt intet eksisterende produceret produkt at kopiere lokation/gruppe fra.');

    const newProduct = {
        name: recipe.name,
        location_id:      template.location_id,
        qu_id_purchase:   yieldUnit.id,
        qu_id_stock:      yieldUnit.id,
        product_group_id: template.product_group_id,
        active: 1,
    };

    console.log(`\nBlanding:  ${recipe.id} "${recipe.name}"  (base_servings ${base})`);
    console.log(`Udbytte:   ${perServing} ${yieldUnit.name} pr. portion  →  ${perServing * base} ${yieldUnit.name} pr. batch`);
    console.log(`Nyt produkt: "${newProduct.name}" · lager-enhed ${yieldUnit.name} · gruppe ${template.product_group_id ?? '—'} (fra "${template.name}")`);
    console.log(`\n${hits.length} menu${hits.length === 1 ? '' : 'er'} flyttes fra nesting til produktlinje:\n`);

    const plan = hits.map(n => {
        const menu = rawMap.get(Number(n.includes_recipe_id) === Number(recipe.id) ? Number(n.recipe_id) : null)
                  || rawMap.get(Number(n.recipe_id)) || {};
        const servings = parseFloat(n.servings) || 0;
        // Udbyttet er PR PORTION, og nesting-servings tælles i portioner.
        // Derfor: mængde = servings × udbytte/portion. Samme fortolkning som
        // resolveren bruger, ellers ville regnestykket skride ved springet.
        const amount = servings * perServing;
        return { nesting: n, menu_id: Number(n.recipe_id), menu_name: menu.name || `#${n.recipe_id}`, servings, amount };
    }).sort((a, b) => a.menu_id - b.menu_id);

    for (const p of plan) {
        console.log(`  ${String(p.menu_id).padStart(4)} ${p.menu_name.padEnd(28).slice(0, 28)}  nesting ${p.servings} portioner  →  ${round(p.amount)} ${yieldUnit.name}`);
    }

    if (!APPLY) {
        console.log(`\nDry-run — intet skrevet. Tilføj --apply for at gøre det.\n`);
        console.log(`Husk at måle FØR:  node --env-file=.env scripts/recipe-fingerprint.js --uses "${recipe.name}" --out foer.json\n`);
        return;
    }

    // ── Skriv ──
    const state = {
        instance: cfg.locationName,
        recipe_id: Number(recipe.id),
        recipe_name: recipe.name,
        recipe_had_product_id: recipe.product_id || null,
        created_product_id: null,
        created_pos: [],
        removed_nestings: [],
        at: new Date().toISOString(),   // utc-ok: tidsstempel i en tilstandsfil
    };
    // Tilstandsfilen skrives FØR hvert skridt, ikke til sidst. Går noget galt
    // midtvejs, skal --rollback stadig kunne rydde op efter det der NÅEDE at ske.
    const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
    save();

    try {
        const created = await grocy.createProduct(newProduct);
        state.created_product_id = Number(created.created_object_id);
        save();
        console.log(`\n✓ produkt oprettet: ${state.created_product_id}`);

        await grocy.updateRecipe(recipe.id, { product_id: state.created_product_id });
        console.log(`✓ "${recipe.name}" producerer nu produktet`);

        for (const p of plan) {
            const pos = await grocy.createRecipePos({
                recipe_id: p.menu_id,
                product_id: state.created_product_id,
                amount: p.amount,
                qu_id: yieldUnit.id,
                ingredient_group: '',
            });
            state.created_pos.push({ id: Number(pos.created_object_id), recipe_id: p.menu_id, amount: p.amount });
            save();

            // Nestingen fjernes FØRST når produktlinjen står der. Rækkefølgen
            // betyder noget: fejler vi imellem, er råvarerne talt to gange
            // (synligt i gaten) frem for tabt (usynligt).
            await grocy.deleteRecipeNesting(p.nesting.id);
            state.removed_nestings.push({
                id: Number(p.nesting.id), recipe_id: p.menu_id,
                includes_recipe_id: Number(recipe.id), servings: p.servings,
            });
            save();
            console.log(`✓ ${p.menu_name}: nesting → produktlinje ${round(p.amount)} ${yieldUnit.name}`);
        }
    } catch (err) {
        console.error(`\n✗ Afbrudt: ${err.message}`);
        console.error(`  Tilstanden er gemt i ${STATE} — kør --rollback --apply for at rydde op.\n`);
        process.exit(1);
    }

    console.log(`\nFærdig. Tilstand: ${STATE}`);
    console.log(`Mål efter:  node --env-file=.env scripts/recipe-fingerprint.js --uses "${recipe.name}" --out efter.json`);
    console.log(`Sammenlign: node scripts/recipe-fingerprint.js --diff foer.json efter.json\n`);
})();

async function rollback(cfg) {
    if (!fs.existsSync(STATE)) die(`${STATE} findes ikke.`);
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.instance !== cfg.locationName) {
        die(`Tilstanden blev skrevet mod "${state.instance}", men databasen peger på "${cfg.locationName}".`);
    }

    console.log(`\nRuller tilbage: ${state.recipe_id} "${state.recipe_name}"`);
    console.log(`  ${state.created_pos.length} produktlinjer slettes · ${state.removed_nestings.length} nestings genskabes · produkt ${state.created_product_id}`);
    if (!APPLY) { console.log('\nDry-run — intet skrevet. Tilføj --apply.\n'); return; }

    for (const n of state.removed_nestings) {
        await grocy.createRecipeNesting({
            recipe_id: n.recipe_id, includes_recipe_id: n.includes_recipe_id, servings: n.servings,
        });
        console.log(`✓ nesting genskabt på ${n.recipe_id} (${n.servings} portioner)`);
    }
    for (const p of state.created_pos) {
        await grocy.deleteRecipePos(p.id);
        console.log(`✓ produktlinje ${p.id} slettet fra ${p.recipe_id}`);
    }
    await grocy.updateRecipe(state.recipe_id, { product_id: state.recipe_had_product_id || null });
    console.log(`✓ "${state.recipe_name}" producerer ikke længere et produkt`);

    if (state.created_product_id) {
        // Har nogen nået at producere ind i produktet, må det IKKE slettes —
        // så ville lagerhistorikken forsvinde med det. Deaktivér i stedet og
        // sig det højt.
        const stock = await grocy.getStock();
        const has = stock.some(s => Number(s.product_id) === Number(state.created_product_id) && parseFloat(s.amount) !== 0);
        if (has) {
            await grocy.updateProduct(state.created_product_id, { active: 0 });
            console.log(`⚠ produkt ${state.created_product_id} har lager — deaktiveret i stedet for slettet`);
        } else {
            await grocy.deleteProduct(state.created_product_id);
            console.log(`✓ produkt ${state.created_product_id} slettet`);
        }
    }

    fs.renameSync(STATE, STATE + '.rulledtilbage');
    console.log(`\nTilbage til udgangspunktet. Tilstandsfilen er omdøbt til ${STATE}.rulledtilbage\n`);
}

function round(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
