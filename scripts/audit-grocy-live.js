// scripts/audit-grocy-live.js
// ============================================================
// LIVE data-audit af Grocy — går efter de fejlklasser der får bon-v2 til at
// regne eller skrive forkert. Read-only; rører intet.
//
// Adskiller sig fra scripts/grocy-audit/ (som kører på et frosset DB-dump og
// ser bredt på datakvalitet): her tjekkes kun det der har en KENDT konsekvens
// i koden, og hvert fund siger hvad konsekvensen er.
//
// Baggrund: #352/#358 viste at enheds-huller ikke er kosmetik — de skrev
// forkerte tal i lageret uden at nogen kunne se det.
//
// Kør:
//   node --env-file=.env scripts/audit-grocy-live.js            (grocy-hq)
//   node --env-file=.env scripts/audit-grocy-live.js --test     (grocytest)
// ============================================================

'use strict';

const TEST = process.argv.includes('--test');
const URL = TEST ? process.env.GROCY_TEST_URL : process.env.GROCY_HQ_URL;
const KEY = TEST ? process.env.GROCY_TEST_KEY : process.env.GROCY_HQ_KEY;
if (!URL || !KEY) { console.error('Mangler GROCY_*_URL / _KEY i .env'); process.exit(1); }

const g = async (p) => {
    const r = await fetch(`${URL}${p}`, { headers: { 'GROCY-API-KEY': KEY } });
    if (!r.ok) throw new Error(`${p} → ${r.status}`);
    return r.json();
};

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s) => `\x1b[32m${s}\x1b[0m`;

function section(n, title, konsekvens) {
    console.log(`\n${B(`${n}. ${title}`)}`);
    console.log(`   ${'\x1b[2m'}konsekvens: ${konsekvens}\x1b[0m`);
}
function list(rows, limit = 12) {
    rows.slice(0, limit).forEach(r => console.log(`     · ${r}`));
    if (rows.length > limit) console.log(`     … og ${rows.length - limit} mere`);
}
function verdict(n, label) {
    console.log(`   ${n === 0 ? GRN('✓ ingen') : (n > 10 ? RED(`⚠ ${n}`) : YEL(`⚠ ${n}`))} ${label}`);
}

(async () => {
    const [products, units, conversions, recipes, pos, nestings, stock] = await Promise.all([
        g('/objects/products'), g('/objects/quantity_units'), g('/objects/quantity_unit_conversions'),
        g('/objects/recipes'), g('/objects/recipes_pos'), g('/objects/recipes_nestings'), g('/stock'),
    ]);

    const qn = new Map(units.map(u => [Number(u.id), u.name]));
    const pm = new Map(products.map(p => [Number(p.id), p]));
    const active = products.filter(p => Number(p.active) !== 0);
    const inStock = new Set(stock.map(s => Number(s.product_id)));

    // Samme opslagsregler som services/quConvert.js findConversionFactor
    const factor = (pid, from, to) => {
        if (from === to) return 1;
        const f = conversions.find(c => Number(c.product_id) === pid && Number(c.from_qu_id) === from && Number(c.to_qu_id) === to);
        if (f) return parseFloat(f.factor) || 1;
        const r = conversions.find(c => Number(c.product_id) === pid && Number(c.from_qu_id) === to && Number(c.to_qu_id) === from);
        if (r) return 1 / (parseFloat(r.factor) || 1);
        const gf = conversions.find(c => !c.product_id && Number(c.from_qu_id) === from && Number(c.to_qu_id) === to);
        if (gf) return parseFloat(gf.factor) || 1;
        const gr = conversions.find(c => !c.product_id && Number(c.from_qu_id) === to && Number(c.to_qu_id) === from);
        if (gr) return 1 / (parseFloat(gr.factor) || 1);
        return null;
    };
    const gramQu = [...qn.entries()].find(([, n]) => /^(gram|g)$/i.test(n))?.[0] ?? null;

    console.log(B(`\nGrocy live-audit — ${TEST ? 'grocytest' : 'grocy-hq'}`));
    console.log(`${products.length} produkter (${active.length} aktive) · ${recipes.length} opskrifter · ${conversions.length} konverteringer`);

    // ── 1 ──────────────────────────────────────────────────────
    section(1, 'Købs-enhed uden konvertering til lager-enhed',
        'varemodtagelsen kan ikke lægge varen på lager (#358) — den fejler synligt');
    const missingBuy = active
        .filter(p => p.qu_id_purchase && p.qu_id_stock && Number(p.qu_id_purchase) !== Number(p.qu_id_stock))
        .filter(p => factor(Number(p.id), Number(p.qu_id_purchase), Number(p.qu_id_stock)) === null)
        .map(p => `${p.name}  (${qn.get(Number(p.qu_id_purchase))} → ${qn.get(Number(p.qu_id_stock))})${inStock.has(Number(p.id)) ? '  [har lager]' : ''}`);
    verdict(missingBuy.length, 'produkter mangler købs→lager-konvertering');
    list(missingBuy);

    // ── 2 ──────────────────────────────────────────────────────
    section(2, 'Opskrifts-råvarer der ikke kan vejes',
        'underopskrifters vægt bliver FOR LAV — varen udelades tavst af beregningen');
    // Vægten beregnes kun for blandinger, og emballage springes eksplicit over
    // i calcSubRecipeWeightGrams — derfor tæller kun ikke-emballage-linjer med.
    const usedInRecipes = new Set(
        pos.filter(l => (l.ingredient_group || '').toLowerCase() !== 'emballage')
           .map(p => Number(p.product_id))
    );
    const noWeight = [...usedInRecipes]
        .map(pid => pm.get(pid)).filter(Boolean)
        .filter(p => Number(p.active) !== 0)
        .filter(p => {
            const su = Number(p.qu_id_stock);
            if (gramQu === null) return false;
            return factor(Number(p.id), su, gramQu) === null;
        })
        .map(p => `${p.name}  (lager: ${qn.get(Number(p.qu_id_stock))} — ingen vej til gram)`);
    verdict(noWeight.length, 'råvarer i opskrifter kan ikke omregnes til vægt');
    list(noWeight);

    // ── 3 ──────────────────────────────────────────────────────
    section(3, 'Mistænkelige konverterings-faktorer',
        'faktor 1 mellem to FORSKELLIGE enheder er næsten altid en pladsholder');
    // 1 Liter = 1 Kilo er densitet ~1 for vandige væsker — bevidst og rimeligt.
    // Alt andet med faktor 1 mellem forskellige enheder er en pladsholder.
    const isDensity = (a, b) => {
        const s = new Set([String(qn.get(a)).toLowerCase(), String(qn.get(b)).toLowerCase()]);
        return s.has('liter') && s.has('kilo');
    };
    const flat = conversions.filter(c => c.product_id
        && Number(c.from_qu_id) !== Number(c.to_qu_id) && Number(c.factor) === 1);
    const density = new Set(flat.filter(c => isDensity(Number(c.from_qu_id), Number(c.to_qu_id)))
        .map(c => Number(c.product_id)));
    const seen = new Set();
    const suspicious = flat
        .filter(c => !isDensity(Number(c.from_qu_id), Number(c.to_qu_id)))
        .filter(c => { const k = Number(c.product_id); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(c => {
            const p = pm.get(Number(c.product_id));
            return `${p ? p.name : 'produkt ' + c.product_id}: 1 ${qn.get(Number(c.from_qu_id))} = 1 ${qn.get(Number(c.to_qu_id))}`;
        });
    verdict(suspicious.length, 'konverteringer med faktor 1 der IKKE er væske-densitet');
    list(suspicious);
    console.log(`   \x1b[2m(${density.size} produkter har 1 Liter = 1 Kilo — densitet, formentlig bevidst)\x1b[0m`);

    // ── 4 ──────────────────────────────────────────────────────
    section(4, 'Opskrifts-linjer der peger på slettede eller inaktive produkter',
        'råvaren forsvinder fra behov, indkøb og lagertræk');
    const deadPos = pos.filter(l => { const p = pm.get(Number(l.product_id)); return !p || Number(p.active) === 0; })
        .map(l => { const r = recipes.find(x => Number(x.id) === Number(l.recipe_id));
                    const p = pm.get(Number(l.product_id));
                    return `${r ? r.name : 'opskrift ' + l.recipe_id} → ${p ? p.name + ' (inaktiv)' : 'produkt ' + l.product_id + ' (findes ikke)'}`; });
    verdict(deadPos.length, 'opskrifts-linjer peger på et produkt der ikke kan bruges');
    list(deadPos);

    // ── 5 ──────────────────────────────────────────────────────
    section(5, 'recipeunit-userfield der ikke er en enhed',
        'produktions-udbytte og opskrift-visning bruger feltet som enhed (#360)');
    const badUnit = recipes
        .map(r => ({ r, u: (r.userfields && r.userfields.recipeunit) || '' }))
        .filter(x => x.u && !/^(antal|stk|kg|kilo|g|gram|l|liter|ml|portion|portioner)$/i.test(x.u.trim()))
        .map(x => `${x.r.name}: recipeunit = "${x.u}"`);
    verdict(badUnit.length, 'opskrifter har en recipeunit der ikke er en enhed');
    list(badUnit);

    // ── 6 ──────────────────────────────────────────────────────
    section(6, 'Cyklusser og dybde i opskriftstræet',
        'en cyklus vælter /ingredients; dyb nesting udstiller skalerings-fejl');
    const kids = new Map();
    nestings.forEach(n => {
        const k = Number(n.recipe_id);
        if (!kids.has(k)) kids.set(k, []);
        kids.get(k).push(Number(n.includes_recipe_id));
    });
    let cycles = 0, maxDepth = 0;
    for (const r of recipes) {
        (function walk(id, depth, path) {
            maxDepth = Math.max(maxDepth, depth);
            if (path.includes(id)) { cycles++; return; }
            for (const c of (kids.get(id) || [])) walk(c, depth + 1, [...path, id]);
        })(Number(r.id), 0, []);
    }
    verdict(cycles, 'cyklusser i recipes_nestings');
    console.log(`   ${GRN('·')} største nesting-dybde: ${maxDepth}`);

    // ── 7 ──────────────────────────────────────────────────────
    section(7, 'Salgbare opskrifter uden pris',
        'bon-linjen får 0 kr og forsvinder ud af omsætningen');
    const noPrice = recipes.filter(r => {
        const uf = r.userfields || {};
        if (String(uf.sellable) !== '1') return false;
        return !['SalespriceStore', 'SalespriceCatering', 'SalespriceFestival',
                 'SalespriceProduktion', 'SalespriceWaiste']
            .some(k => Number(uf[k]) > 0);
    }).map(r => r.name);
    verdict(noPrice.length, 'salgbare opskrifter uden nogen salgspris');
    list(noPrice);

    console.log(`\n${B('─'.repeat(60))}`);
    const total = missingBuy.length + noWeight.length + deadPos.length + cycles;
    console.log(total === 0
        ? GRN('Ingen fund med kendt konsekvens.')
        : `${total} fund med kendt konsekvens i koden. Punkt 3 og 5 er til vurdering, ikke nødvendigvis fejl.`);
})().catch(e => { console.error('FEJL:', e.message); process.exit(1); });
