// scripts/audit-blend-batches.js
// ============================================================
// LÆS-KUN. Hvad laver Bon i én ombæring af hver `RR produktion Hurtig`-blanding,
// og hvad koster det af råvarer?
//
// Hvorfor den findes (#270):
// Konverteringen giver `recipeunitnumber` et nyt job. Før var det et udbytte til
// vægt-visning. Bagefter er det svaret på "hvor meget producerer Bon ad gangen,
// og hvor mange råvarer trækker den for det" — og batchen skal derfor være den
// mængde køkkenet FAKTISK laver i én ombæring. Er den forkert, laver Bon enten
// for lidt (og mellemproduktet går i minus) eller for meget (og der opstår
// lager der ikke findes, som næste bon bruger af).
//
// `audit:udbytte` fanger det ikke: den tjekker at en opskrift ikke giver mere ud
// end ind, ikke om batchen er realistisk.
//
// Rapporten er til at læse HØJT for køkkenet — én linje pr. blanding, der kan
// svares ja eller nej til.
//
//   node --env-file=.env scripts/audit-blend-batches.js
//   node --env-file=.env scripts/audit-blend-batches.js --instance test
//
// Går direkte på Grocys REST-API med GROCY_<INSTANS>_URL/_KEY. Ingen database,
// ingen adapter-cache — og dermed ingen vej til at skrive noget.
//
// Batch-tallet og råvarerne regnes med `yieldPerBatchStockOf` og
// `collectRecipeNeedsFlat` fra services/ingredientResolver — PRÆCIS de
// funktioner services/autoBatch.js bruger. En parallel udregning her ville
// kunne drive fra virkeligheden, og så beskrev rapporten noget andet end det
// Bon gør. (Samme fejlklasse som #349/#353.)
// ============================================================

'use strict';

const { yieldPerBatchStockOf, collectRecipeNeedsFlat } = require('../services/ingredientResolver');

const { HURTIG_GROUP, recipeGroupOf } = require('../services/ingredientResolver');
const { num: grocyNum } = require('../shared/grocy_num');

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const INSTANCE = (argOf('--instance') || 'hq').toUpperCase();

const URL = process.env[`GROCY_${INSTANCE}_URL`];
const KEY = process.env[`GROCY_${INSTANCE}_KEY`];
if (!URL || !KEY) {
    console.error(`\n✗ GROCY_${INSTANCE}_URL / _KEY er ikke indlæst. Kør med --env-file=.env fra projektroden.\n`);
    process.exit(1);
}

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;

async function get(path) {
    const res = await fetch(URL + path, { headers: { 'GROCY-API-KEY': KEY, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
}

// Tal som et menneske læser dem: 0,06 — ikke 0.06000000000000001.
function num(n) {
    const v = Math.round((Number(n) || 0) * 10000) / 10000;
    return String(v).replace('.', ',');
}

(async () => {
    const [recipes, allPos, nestings, products, units] = await Promise.all([
        get('/objects/recipes'), get('/objects/recipes_pos'), get('/objects/recipes_nestings'),
        get('/objects/products'), get('/objects/quantity_units'),
    ]);
    // Produkt-scopede QU-konverteringer ligger i samme tabel som de globale.
    const conversions = await get('/objects/quantity_unit_conversions');

    const rawRecipeMap = new Map(recipes.map(r => [Number(r.id), { ...r, id: Number(r.id) }]));
    const productMap   = new Map(products.map(p => [Number(p.id), p]));
    const unitMap      = new Map(units.map(u => [Number(u.id), u]));

    const posByRecipe = {}, nestingsByRecipe = {};
    for (const p of allPos)   (posByRecipe[p.recipe_id] ||= []).push(p);
    for (const n of nestings) (nestingsByRecipe[n.recipe_id] ||= []).push(n);

    // Hvem nester hvem — og hvilke af dem sælges? Rækkevidden er det der afgør
    // blast-radius ved konverteringen, og den er større end "antal menuer":
    // en produktionsopskrift kan selv være nestet videre (Æggesalat, #543).
    const nestedBy = new Map();
    for (const n of nestings) {
        const k = Number(n.includes_recipe_id);
        if (!nestedBy.has(k)) nestedBy.set(k, []);
        nestedBy.get(k).push(Number(n.recipe_id));
    }
    function reach(recipeId, seen = new Set()) {
        for (const parent of (nestedBy.get(recipeId) || [])) {
            if (seen.has(parent)) continue;
            seen.add(parent);
            reach(parent, seen);
        }
        return seen;
    }
    const sellable = (r) => String(r?.userfields?.sellable || '0') === '1';

    const unitName = (quId) => (unitMap.get(Number(quId)) || {}).name || `enhed ${quId}`;

    const blends = recipes
        .filter(r => recipeGroupOf(r) === HURTIG_GROUP)
        .map(r => ({ ...r, id: Number(r.id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'da'));

    console.log(`\n${B(`Batch-tjek · ${INSTANCE} · ${blends.length} opskrifter i "RR produktion Hurtig"`)}`);
    console.log(DIM('Læses højt for køkkenet: "laver vi rent faktisk så meget ad gangen?"\n'));

    const arbejdstrin = [], konverterede = [], mangler = [], klar = [];

    for (const r of blends) {
        const direkte = (posByRecipe[r.id] || []).length;
        const nest    = (nestingsByRecipe[r.id] || []).length;
        const brugtAf = reach(r.id);

        // Rene arbejdstrin: ingen råvarer og ingen der bruger dem. Røres ikke (§3).
        if (!direkte && !nest && brugtAf.size === 0) { arbejdstrin.push(r); continue; }

        const perServing = grocyNum(r.userfields?.recipeunitnumber);
        const base = parseInt(r.base_servings) || 1;
        const yUnit = String(r.userfields?.recipeunit || '').trim();

        // Produktet: allerede konverteret, eller det der ville blive oprettet.
        const produkt = r.product_id ? productMap.get(Number(r.product_id)) : null;

        // Udbytte pr. batch i LAGER-enhed. Er blandingen ikke konverteret endnu,
        // findes produktet ikke — så regner vi mod et tænkt produkt hvis lager-
        // enhed er udbytte-enheden (det konverteringen ville gøre i dag).
        let perBatch = null, perBatchUnit = yUnit, note = null;
        if (Number.isFinite(perServing) && perServing > 0) {
            if (produkt) {
                perBatch = yieldPerBatchStockOf(r, produkt, unitMap, conversions);
                perBatchUnit = unitName(produkt.qu_id_stock);
                if (perBatch == null) {
                    note = `udbyttet er i "${yUnit}", produktet lagerføres i ${perBatchUnit} `
                         + `— og der findes ingen omregning på produktet`;
                }
            } else {
                perBatch = perServing * base;
            }
        }

        const linje = `${B(r.name.padEnd(22))} ${DIM(`#${r.id}`)}`;

        if (!Number.isFinite(perServing) || perServing <= 0) {
            mangler.push(r);
            console.log(`${linje}  ${RED('mangler udbytte')} — udfyld recipeunitnumber i Grocy (#372)`);
            console.log(DIM(`  bruges af ${brugtAf.size} opskrift(er)\n`));
            continue;
        }

        // Råvarerne til ÉT batch — samme opslag og samme emballage-afgrænsning
        // som auto-batchen bruger til at afgøre "rækker råvarerne?".
        const needs = new Map();
        collectRecipeNeedsFlat(r.id, 1, posByRecipe, nestingsByRecipe, rawRecipeMap,
            (pid, amt) => needs.set(Number(pid), (needs.get(Number(pid)) || 0) + amt),
            new Set(), { skipEmballage: true });

        const status = produkt ? GRN('konverteret') : DIM('ikke konverteret');
        (produkt ? konverterede : klar).push(r);

        console.log(`${linje}  ${status}`);
        console.log(`  Bon laver ${B(`${num(perBatch)} ${perBatchUnit}`)} ad gangen og bruger:`);
        if (!needs.size) console.log(DIM('    (ingen råvarer)'));
        for (const [pid, amt] of [...needs.entries()].sort((a, b) => b[1] - a[1])) {
            const p = productMap.get(pid) || {};
            console.log(`    ${num(amt).padStart(9)} ${unitName(p.qu_id_stock).padEnd(6)} ${p.name || `#${pid}`}`);
        }
        const salgbare = [...brugtAf].filter(id => sellable(rawRecipeMap.get(id))).length;
        console.log(DIM(`  bruges af ${brugtAf.size} opskrift(er), heraf ${salgbare} salgbare`));
        if (note) console.log(`  ${YEL('⚠ ' + note)}`);
        console.log();
    }

    console.log(B('Sammenfatning'));
    console.log(`  ${klar.length} klar til konvertering · ${konverterede.length} allerede konverteret`
              + ` · ${mangler.length} mangler udbytte · ${arbejdstrin.length} rene arbejdstrin (røres ikke)`);
    if (arbejdstrin.length) console.log(DIM(`  arbejdstrin: ${arbejdstrin.map(r => r.name).join(', ')}`));
    console.log(DIM('\nEt nej til en batch-størrelse rettes i Grocy FØR konverteringen —'
                  + ' både udbyttet og opskriftens ingredienser skal beskrive den samme ombæring.\n'));
})().catch(err => { console.error(`\n✗ ${err.message}\n`); process.exit(1); });
