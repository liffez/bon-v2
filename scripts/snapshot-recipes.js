#!/usr/bin/env node
/**
 * scripts/snapshot-recipes.js — READ-ONLY udtræk af opskrifter fra Grocy
 * ════════════════════════════════════════════════════════════
 * Laver det datasæt opskrift-designerens gem-test kører på
 * (tests/recipe_designer_save.test.js). Kun GET — scriptet skriver aldrig
 * til Grocy.
 *
 * En opskrifts felter ligger flere steder, og alle skal med for at et
 * fingeraftryk betyder noget:
 *   /objects/recipes              — opskriften inkl. userfields
 *   /objects/recipes_pos          — ingredienslinjer
 *   /objects/recipes_nestings     — underopskrifter
 *   /objects/userfields           — feltdefinitioner (preset-lister: grupper, recipeunit)
 *   /objects/products + quantity_units + quantity_unit_conversions
 *                                 — det designeren skal bruge for at rendere linjerne
 *
 * Brug:
 *   node scripts/snapshot-recipes.js --out <fil>                 # alle opskrifter
 *   node scripts/snapshot-recipes.js --out <fil> --ids 110,98    # kun disse + deres underopskrifter
 *   --instance hq|test   (default hq; læser GROCY_HQ_* / GROCY_TEST_* fra .env)
 *
 * Med --ids tages kun de produkter/konverteringer med som opskrifterne bruger,
 * så en fixture i repoet ikke bærer hele varekataloget.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv() {
    for (const p of [path.join(process.cwd(), '.env'), path.join(__dirname, '..', '.env')]) {
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
            if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        return;
    }
}

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
    loadEnv();
    const out = arg('out');
    if (!out) { console.error('Brug: --out <fil> [--ids 1,2,3] [--instance hq|test]'); process.exit(2); }
    const inst = (arg('instance') || 'hq').toUpperCase();
    const base = String(process.env['GROCY_' + inst + '_URL'] || '').replace(/\/$/, '');
    const key = process.env['GROCY_' + inst + '_KEY'];
    if (!base || !key) { console.error('Mangler GROCY_' + inst + '_URL/KEY i .env'); process.exit(2); }

    const get = async p => {
        const r = await fetch(base + p, { headers: { 'GROCY-API-KEY': key, Accept: 'application/json' } });
        if (!r.ok) throw new Error('GET ' + p + ' → HTTP ' + r.status);
        return r.json();
    };

    const [recipes, pos, nestings, ufDefs, products, qus, convs] = await Promise.all([
        get('/objects/recipes'), get('/objects/recipes_pos'), get('/objects/recipes_nestings'),
        get('/objects/userfields'), get('/objects/products'), get('/objects/quantity_units'),
        get('/objects/quantity_unit_conversions'),
    ]);

    let keep = null;
    const idsArg = arg('ids');
    if (idsArg) {
        keep = new Set();
        const queue = idsArg.split(',').map(x => parseInt(x, 10)).filter(Boolean);
        while (queue.length) {                       // opskrifterne + deres underopskrifter, rekursivt
            const id = queue.pop();
            if (keep.has(id)) continue;
            keep.add(id);
            nestings.filter(n => n.recipe_id == id).forEach(n => queue.push(parseInt(n.includes_recipe_id, 10)));
        }
    }

    const R = keep ? recipes.filter(r => keep.has(r.id)) : recipes;
    const P = keep ? pos.filter(p => keep.has(p.recipe_id)) : pos;
    const N = keep ? nestings.filter(n => keep.has(n.recipe_id)) : nestings;
    const pids = new Set(P.map(p => p.product_id));
    R.forEach(r => { if (r.product_id) pids.add(r.product_id); });
    const PR = (keep ? products.filter(p => pids.has(p.id)) : products)
        .map(p => { const c = { ...p }; delete c.description; delete c.picture_file_name; return c; });
    const CV = keep ? convs.filter(c => c.product_id == null || pids.has(c.product_id)) : convs;

    const snap = {
        taken_at: new Date().toISOString(),   // utc-ok: tidsstempel på et udtræk
        instance: inst.toLowerCase(),
        recipes: R, recipes_pos: P, recipes_nestings: N,
        userfields: ufDefs.filter(d => d.entity === 'recipes'),
        products: PR, quantity_units: qus, quantity_unit_conversions: CV,
    };
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(snap, null, 1) + '\n');
    console.log(`Skrev ${out}: ${R.length} opskrifter, ${P.length} linjer, ${N.length} nestings, ${PR.length} varer`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
