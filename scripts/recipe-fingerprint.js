// scripts/recipe-fingerprint.js
// ============================================================
// Fingeraftryk af hvad en opskrift KOSTER — målt gennem de samme kodeveje
// Bon selv bruger.
//
// Formål: gaten i #269. Når en `RR produktion Hurtig`-blanding laves om til et
// rigtigt produkt (#268), tilføjes der et BOM-niveau: menu → mellemprodukt →
// råvarer. Al oprulning skal bæres ét led længere UDEN at dobbelt-tælle
// (produktet PLUS dets råvarer) og uden at tabe leddet.
//
// Det er den eneste fejl i hele epic'en der er TAVS: tallene bliver ved med at
// se rigtige ud. Derfor måles de før og efter i stedet for at blive vurderet.
//
//   node --env-file=.env scripts/recipe-fingerprint.js --uses "Remoulade" --out foer.json
//   ... konvertér i Grocy ...
//   node --env-file=.env scripts/recipe-fingerprint.js --uses "Remoulade" --out efter.json
//   node scripts/recipe-fingerprint.js --diff foer.json efter.json
//
// Resultatet skrives til en FIL, ikke til stdout: første kørsel mod en frisk
// database logger migrationer på stdout, og en omdirigeret `>` ville lægge dem
// ind i JSON'en. Et måleværktøj må ikke kunne ødelægges af sin egen opstartsstøj.
//
// READ-ONLY mod Grocy. Rører hverken Grocy eller databasen.
//
// Flag:
//   --uses <navn>     menuer der (direkte eller via nesting) bruger denne opskrift
//   --recipes 1,2,3   eksplicit liste i stedet for --uses
//   --qty N           mængde pr. menu-linje (default 10)
//   --diff a.json b.json
//
// HVILKEN Grocy måles der mod? Den databasen peger på
// (`settings.default_grocy_location_id`) — samme opslag som appen selv bruger.
// Instansens navn skrives ind i fingeraftrykket, og `--diff` nægter at
// sammenligne to filer fra hver sin instans. Man kan altså ikke komme til at
// måle "før" på test og "efter" på produktion.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ── Diff-tilstand kræver hverken Grocy eller .env ──
if (process.argv.includes('--diff')) {
    const i = process.argv.indexOf('--diff');
    const a = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    const b = JSON.parse(fs.readFileSync(process.argv[i + 2], 'utf8'));
    process.exit(diff(a, b) ? 1 : 0);
}

const QTY = parseFloat(argOf('--qty')) || 10;

const grocy = require(path.join(__dirname, '..', 'services', 'grocyAdapter'));
const engine = require(path.join(__dirname, '..', 'services', 'co2Engine'));

function argOf(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : null;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

(async () => {
    const [rawMap, pos, nestings, products, units, conversions, recipes] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
        grocy.getRecipes(),
    ]);
    const rawList = [...rawMap.values()];

    // ── Hvilke menuer skal måles? ──
    let ids = (argOf('--recipes') || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    const usesName = argOf('--uses');
    if (!ids.length && usesName) {
        const target = rawList.filter(r => String(r.name || '').toLowerCase().includes(usesName.toLowerCase()));
        if (!target.length) { console.error(`Ingen opskrift matcher "${usesName}"`); process.exit(1); }
        const targetIds = new Set(target.map(r => Number(r.id)));
        const targetProducts = new Set(target.map(r => Number(r.product_id)).filter(Boolean));
        const hit = new Set();
        // Både nesting-vejen (før konvertering) og produkt-vejen (efter), så
        // det samme sæt menuer måles på begge sider af springet.
        for (const n of nestings) if (targetIds.has(Number(n.includes_recipe_id))) hit.add(Number(n.recipe_id));
        for (const p of pos)      if (targetProducts.has(Number(p.product_id)))    hit.add(Number(p.recipe_id));
        ids = [...hit].filter(id => !targetIds.has(id)).sort((a, b) => a - b);
    }
    if (!ids.length) { console.error('Angiv --uses <navn> eller --recipes 1,2,3'); process.exit(1); }

    const { resolveIngredients, resolveConsumeItems, expandProducedToRaw } =
        require(path.join(__dirname, '..', 'services', 'ingredientResolver'));
    const co2 = engine.computeAll({ recipes: rawList, pos, nestings, products, conversions, units });
    const costById = new Map(recipes.map(r => [Number(r.id), r.cost_price]));
    const nameById = new Map(rawList.map(r => [Number(r.id), r.name]));

    const out = { instance: grocy.getGrocyConfig().locationName, qty: QTY, recipes: {} };

    for (const id of ids) {
        const line = [{ grocy_recipe_id: id, quantity: QTY }];
        const [{ production, raw }, consume] = await Promise.all([
            resolveIngredients(line),
            resolveConsumeItems(line),
        ]);
        // Det tal der SKAL være uændret: hvad der i sidste ende forlader
        // råvarelageret, når producerede mellemprodukter er foldet tilbage.
        const eq = await expandProducedToRaw(consume);
        const c = co2.get(id) || co2.get(String(id)) || {};
        const nameOf = (pid) => (products.find(p => Number(p.id) === Number(pid)) || {}).name || `#${pid}`;

        out.recipes[id] = {
            name: nameById.get(id) || String(id),
            // Kostpris og CO₂ pr. portion — de to tal en konvertering lettest
            // kommer til at flytte uden at nogen opdager det.
            cost_price:      r4(costById.get(id)),
            co2e_per_serving: r4(c.co2e_per_serving),
            co2_complete:     !!c.complete,
            // DEN EGENTLIGE INVARIANT. `consume` ændrer sig med vilje ved en
            // konvertering (menuen trækker fremover produktet). Det der ikke må
            // ændre sig, er hvad der til sidst går ud af råvarelageret — og
            // dobbelt-tælling eller et tabt led viser sig præcis her.
            raw_equivalent: Object.fromEntries([...eq.raw.entries()]
                .map(([pid, amt]) => [nameOf(pid), r4(amt)])
                .sort((a, b) => a[0].localeCompare(b[0], 'da'))),
            // Producerede varer hvis udbytte ikke kunne bestemmes — de er IKKE
            // foldet ud, og så er ækvivalenten ovenfor ufuldstændig på netop dem.
            // Siges højt frem for at pynte på regnskabet.
            raw_equivalent_ufuldstaendig: eq.unexpanded
                .map(u => `${u.product_name} (${u.recipe_name})`).sort(),
            // Hvad LEVERET ville trække lige nu. Ændrer form ved konvertering.
            consume: Object.fromEntries(consume
                .map(i => [i.product_name, r4(i.amount_stock)])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'da'))),
            // Råvare-niveauet (Råvarer-fanen, planlægning, indkøb)
            raw: Object.fromEntries(raw.ingredients
                .map(i => [i.product_name, r4(i.needed_stock)])
                .sort((a, b) => a[0].localeCompare(b[0], 'da'))),
            // Produktions-niveauet: direkte varer + underopskrifter som rækker.
            // Her ÆNDRER formen sig med vilje ved en konvertering — en blanding
            // flytter fra `sub_recipes` til `production`. Derfor står de hver
            // for sig, så en forventet formændring ikke drukner de uventede.
            production: Object.fromEntries(production.ingredients
                .map(i => [i.product_name, r4(i.needed_stock)])
                .sort((a, b) => a[0].localeCompare(b[0], 'da'))),
            sub_recipes: Object.fromEntries((production.sub_recipes || [])
                .map(s => [s.recipe_name, { vaegt_g: r2(s.weight_grams), yield: s.yield_amount == null ? null : r4(s.yield_amount) }])
                .sort((a, b) => a[0].localeCompare(b[0], 'da'))),
        };
    }

    const dest = argOf('--out');
    if (!dest) {
        console.error('Angiv --out <fil>. Fingeraftrykket skrives til en fil, ikke til stdout.');
        process.exit(1);
    }
    fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
    console.log(`Fingeraftryk skrevet: ${dest}  (${out.instance}, ${Object.keys(out.recipes).length} menuer, ${QTY} stk pr. linje)`);
})();

// ── Diff ──────────────────────────────────────────────────────
function diff(a, b) {
    let problems = 0;
    const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };
    // Et "før" fra test mod et "efter" fra produktion ville sammenligne to
    // forskellige verdener og melde grønt eller rødt uden dækning.
    if (a.instance !== b.instance) {
        console.error(`\n${C.red}Filerne er målt mod hver sin Grocy: "${a.instance}" mod "${b.instance}". Afbryder.${C.off}\n`);
        return true;
    }
    if (a.qty !== b.qty) {
        console.error(`\n${C.red}Filerne bruger forskellig mængde pr. linje (${a.qty} mod ${b.qty}). Afbryder.${C.off}\n`);
        return true;
    }
    const ids = [...new Set([...Object.keys(a.recipes), ...Object.keys(b.recipes)])].sort();

    console.log(`\nFingeraftryk mod ${a.instance}  ·  ${ids.length} menuer  ·  ${a.qty} stk pr. linje\n`);

    for (const id of ids) {
        const x = a.recipes[id], y = b.recipes[id];
        if (!x || !y) { console.log(`${C.red}✗${C.off} ${id}: findes kun på den ene side`); problems++; continue; }
        const lines = [];

        for (const [k, fmt] of [['cost_price', 'kostpris'], ['co2e_per_serving', 'CO₂/portion']]) {
            if (x[k] !== y[k]) { lines.push(`${C.red}${fmt}: ${x[k]} → ${y[k]}${C.off}`); problems++; }
        }
        if (x.co2_complete !== y.co2_complete) {
            lines.push(`${C.red}CO₂-dækning: ${x.co2_complete} → ${y.co2_complete}${C.off}`); problems++;
        }

        // Den hårde: hvad der til sidst forlader råvarelageret.
        for (const d of mapDiff(x.raw_equivalent, y.raw_equivalent)) {
            lines.push(`${C.red}råvare-ækvivalent: ${d}${C.off}`); problems++;
        }
        // Bliver ækvivalenten pludselig ufuldstændig, er sammenligningen ovenfor
        // ikke længere dækkende — og så er grønt ikke et svar.
        const u1 = (x.raw_equivalent_ufuldstaendig || []).join('|');
        const u2 = (y.raw_equivalent_ufuldstaendig || []).join('|');
        if (u1 !== u2) {
            lines.push(`${C.red}ufuldstændig udfoldning: [${u1}] → [${u2}]${C.off}`); problems++;
        }
        // consume, raw, production og sub_recipes MÅ ændre form — det er hele
        // pointen med konverteringen. Vises som information, tælles ikke med.
        for (const key of ['consume', 'raw', 'production', 'sub_recipes']) {
            for (const d of mapDiff(x[key], y[key])) lines.push(`${C.dim}${key}: ${d}${C.off}`);
        }

        if (!lines.length) console.log(`${C.grn}✓${C.off} ${id} ${x.name} ${C.dim}— uændret${C.off}`);
        else {
            console.log(`${C.yel}●${C.off} ${id} ${x.name}`);
            lines.forEach(l => console.log('    ' + l));
        }
    }

    console.log(problems
        ? `\n${C.red}${problems} tal flyttede sig et sted hvor de ikke måtte.${C.off} Gaten er RØD.\n`
        : `\n${C.grn}Råvare-ækvivalent, kostpris og CO₂ er uændrede — kun kilden har flyttet sig.${C.off} Gaten er GRØN.\n`);
    return problems > 0;
}

function mapDiff(o1 = {}, o2 = {}) {
    const out = [];
    for (const k of [...new Set([...Object.keys(o1), ...Object.keys(o2)])].sort()) {
        const v1 = o1[k], v2 = o2[k];
        const s1 = JSON.stringify(v1), s2 = JSON.stringify(v2);
        if (s1 === s2) continue;
        if (v1 === undefined)      out.push(`+ ${k} = ${s2}`);
        else if (v2 === undefined) out.push(`− ${k} (var ${s1})`);
        else                       out.push(`~ ${k}: ${s1} → ${s2}`);
    }
    return out;
}
