// scripts/grocy-snapshot.js
// ============================================================
// Strukturelt øjebliksbillede af en Grocy-instans — og en diff.
//
// `recipe-fingerprint.js` måler TALLENE (hvad koster retten i råvarer, CO₂ og
// kroner). Den her måler STRUKTUREN: hvilke produkter, opskrifter, ingrediens-
// linjer og nestings der findes, og hvad de indeholder.
//
// De to svarer på hver sit spørgsmål:
//   fingerprint → "flyttede et tal sig et sted hvor det ikke måtte?"
//   snapshot    → "blev der ændret noget ANDET end det jeg bad om?"
//
// Det sidste er værd at have når man skriver til en instans flere mennesker og
// testspor deler. En konvertering skal røre præcis de rækker den lovede — og
// hvis nogen redigerer i Grocy samtidig, skal det kunne ses frem for at blive
// opdaget en uge senere.
//
//   node --env-file=.env scripts/grocy-snapshot.js --out foer.json
//   ... konvertér ...
//   node --env-file=.env scripts/grocy-snapshot.js --out efter.json
//   node scripts/grocy-snapshot.js --diff foer.json efter.json
//
// READ-ONLY. Rører hverken Grocy eller databasen.
// Instansen bestemmes af databasen (`settings.default_grocy_location_id`),
// og navnet skrives ind i filen — to snapshots fra hver sin instans afvises.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

if (process.argv.includes('--diff')) {
    const i = process.argv.indexOf('--diff');
    const a = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    const b = JSON.parse(fs.readFileSync(process.argv[i + 2], 'utf8'));
    process.exit(diff(a, b) ? 1 : 0);
}

const grocy = require(path.join(__dirname, '..', 'services', 'grocyAdapter'));
const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };

// Kun de felter en konvertering kan røre. Tager vi ALT med, drukner signalet i
// `row_created_timestamp` og andet støj der ændrer sig af sig selv.
const SHAPE = {
    products:    (p) => [p.name, p.active, p.qu_id_stock, p.qu_id_purchase, p.location_id, p.product_group_id].join('|'),
    recipes:     (r) => [r.name, r.base_servings, r.product_id || ''].join('|'),
    recipes_pos: (p) => [p.recipe_id, p.product_id, p.amount, p.qu_id, p.ingredient_group || ''].join('|'),
    nestings:    (n) => [n.recipe_id, n.includes_recipe_id, n.servings].join('|'),
    conversions: (c) => [c.product_id || '', c.from_qu_id, c.to_qu_id, c.factor].join('|'),
};

(async () => {
    const dest = argOf('--out');
    if (!dest) { console.error('Angiv --out <fil>'); process.exit(1); }

    const cfg = grocy.getGrocyConfig();
    const [products, recipes, pos, nestings, conversions] = await Promise.all([
        grocy.getProducts(), grocy.getRecipesRawMap(), grocy.getAllRecipesPos(),
        grocy.getRecipeNestings(), grocy.getQuantityUnitConversions(),
    ]);

    const snap = { instance: cfg.locationName, tables: {} };
    const put = (table, rows, idOf) => {
        snap.tables[table] = {};
        for (const r of rows) snap.tables[table][String(idOf(r))] = SHAPE[table](r);
    };
    put('products',    products,                 r => r.id);
    put('recipes',     [...recipes.entries()].map(([id, r]) => ({ ...r, id: r.id ?? id })), r => r.id);
    put('recipes_pos', pos,                      r => r.id);
    put('nestings',    nestings,                 r => r.id);
    put('conversions', conversions,              r => r.id);

    fs.writeFileSync(dest, JSON.stringify(snap, null, 1) + '\n');
    const n = Object.entries(snap.tables).map(([k, v]) => `${Object.keys(v).length} ${k}`).join(' · ');
    console.log(`Snapshot skrevet: ${dest}  (${snap.instance})\n  ${n}`);
})();

function diff(a, b) {
    const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };
    if (a.instance !== b.instance) {
        console.error(`\n${C.red}Snapshots er taget mod hver sin Grocy: "${a.instance}" mod "${b.instance}". Afbryder.${C.off}\n`);
        return true;
    }
    console.log(`\nStruktur-diff mod ${a.instance}\n`);
    let changes = 0;

    for (const table of Object.keys(a.tables)) {
        const x = a.tables[table] || {}, y = b.tables[table] || {};
        const added   = Object.keys(y).filter(k => !(k in x));
        const removed = Object.keys(x).filter(k => !(k in y));
        const edited  = Object.keys(x).filter(k => k in y && x[k] !== y[k]);
        if (!added.length && !removed.length && !edited.length) {
            console.log(`${C.grn}✓${C.off} ${table.padEnd(12)} ${C.dim}uændret (${Object.keys(x).length} rækker)${C.off}`);
            continue;
        }
        console.log(`${C.yel}●${C.off} ${table}`);
        added.forEach(k   => { console.log(`    ${C.grn}+ ${k}${C.off}  ${y[k]}`); changes++; });
        removed.forEach(k => { console.log(`    ${C.red}− ${k}${C.off}  ${x[k]}`); changes++; });
        edited.forEach(k  => { console.log(`    ${C.yel}~ ${k}${C.off}  ${x[k]}\n      ${C.dim}→${C.off} ${y[k]}`); changes++; });
    }

    console.log(changes
        ? `\n${changes} række${changes === 1 ? '' : 'r'} ændret. Sammenhold med hvad konverteringen lovede.\n`
        : `\n${C.grn}Ingen strukturelle ændringer.${C.off}\n`);
    return false;   // en diff er information, ikke en fejl — derfor altid exit 0
}
