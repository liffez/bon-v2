// scripts/test-recipe-breakdown.js
// ============================================================
// Kostpris LINJE FOR LINJE — `recipeCost.breakdownRecipe` (designer-spec §13).
//
// Reglen fandtes to steder: totalen i `recipeCost.compute`, og panelets linjer
// ude i `routes/recipes_overview.js`. To kopier af den samme beslutning driver
// fra hinanden — og de VAR drevet fra hinanden: for et gode vi selv laver
// brugte panelet LAGERPRISEN mens totalen brugte opskriftens kostpris (#558).
// Rødløg - Sylt er #558's eget eksempel: 34,99 mod råvarernes 17,81.
//
// Testen gør to ting:
//   1. holder invarianten — summen af linjerne ER totalen;
//   2. måler udtrækket mod den GAMLE formel linje for linje, så det er
//      dokumenteret præcis hvilke tal der flytter sig, og hvorfor.
//
// Kører uden Grocy og uden DB: fixturen er et read-only udtræk fra grocy-hq.
//
// Kør:  node scripts/test-recipe-breakdown.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const nær = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

const rc = require('../services/recipeCost');
const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

// Fixturen har ingen priser. De sættes syntetisk (kr pr. lager-enhed) — testen
// måler ÆKVIVALENS og struktur, ikke absolutte kroner. Hver femte vare er
// bevidst UDEN pris, så `missing` også bliver ramt.
const priceByProduct = new Map();
SNAP.products.forEach((p, i) => { if (i % 5 !== 4) priceByProduct.set(String(p.id), 10 + (p.id % 17)); });

const DATA = {
    recipes: SNAP.recipes, pos: SNAP.recipes_pos, nestings: SNAP.recipes_nestings,
    products: SNAP.products, units: SNAP.quantity_units,
    conversions: SNAP.quantity_unit_conversions,
    priceByProduct, priceDetailByProduct: new Map(),
};
const posFor = (id) => SNAP.recipes_pos.filter(p => p.recipe_id === id);
const navn = (id) => (SNAP.recipes.find(r => r.id === id) || {}).name;
const pNavn = (pid) => (SNAP.products.find(p => String(p.id) === String(pid)) || {}).name || ('#' + pid);

// ── §1 Invarianten: linjerne ER totalen ───────────────────────
console.log('\n── §1 Summen af linjerne er totalen ──────────────────────');
{
    const alle = rc.computeAll(DATA);
    let værst = 0, hvor = '';
    let medLinjer = 0;
    for (const r of SNAP.recipes) {
        const b = rc.breakdownRecipe(r.id, DATA);
        const sum = [...b.ingredients, ...b.sub_recipes].reduce((a, x) => a + (x.cost || 0), 0);
        const afv = Math.abs(sum - b.total);
        if (afv > værst) { værst = afv; hvor = r.name; }
        if (b.ingredients.length) medLinjer++;
        if (!nær(b.total, alle.get(r.id).cost)) {
            ok(false, `«${r.name}» — breakdownens total er ikke computeAll's`);
        }
    }
    ok(medLinjer >= 10, `${medLinjer} opskrifter i fixturen har linjer at måle på`);
    ok(værst === 0,
        `summen af linjerne rammer totalen PRÆCIST på alle ${SNAP.recipes.length} opskrifter (værst: ${værst}${hvor ? ' — ' + hvor : ''})`);
    ok(SNAP.recipes.every(r => nær(rc.breakdownRecipe(r.id, DATA).total, alle.get(r.id).cost)),
        'og totalen er den SAMME som tabelrækkens — panelet og rækken kan ikke sige hver sit');

    // Kontrolprøve: invarianten er ikke trivielt sand. Fjernes én linjes bidrag,
    // holder den ikke længere.
    const b = rc.breakdownRecipe(SNAP.recipes.find(r => posFor(r.id).length > 2).id, DATA);
    const uden = [...b.ingredients.slice(1), ...b.sub_recipes].reduce((a, x) => a + (x.cost || 0), 0);
    ok(!nær(uden, b.total), 'kontrol: mangler én linje, går summen IKKE op — testen måler noget');
}

// ── §2 Ækvivalens mod den gamle formel, linje for linje ───────
console.log('\n── §2 Hvad flyttede sig i forhold til den gamle rute? ────');
{
    // Den gamle formel i routes/recipes_overview.js, ord for ord:
    //   const unitCost = unitCostOf(pris);          // ← ALTID lagerprisen
    //   cost: unitCost != null ? r2(amountStock * unitCost) : null
    const gammel = (pos) => {
        const uc = priceByProduct.get(String(pos.product_id));
        const amount = parseFloat(pos.amount) || 0;
        return (uc != null && uc > 0 && amount > 0) ? amount * uc : null;
    };

    let ens = 0;
    const flyttet = [];
    for (const r of SNAP.recipes) {
        const b = rc.breakdownRecipe(r.id, DATA);
        for (const pos of posFor(r.id)) {
            const ny = (b.ingredients.find(i => String(i.product_id) === String(pos.product_id)) || {}).cost ?? null;
            const g = gammel(pos);
            if (nær(ny ?? -1, g ?? -1)) { ens++; continue; }
            flyttet.push({ opskrift: r.name, produkt: pNavn(pos.product_id), g, ny });
        }
    }

    ok(ens > 0 && flyttet.length > 0,
        `${ens} linjer er UÆNDREDE, ${flyttet.length} har flyttet sig — og de flyttede er dem #558 handler om`);
    // Målt mod grocy-hq: 93 linjer skifter tal, 6 går fra «—» TIL et tal
    // (panelet viste intet mens totalen havde beløbet — et produceret gode uden
    // købspris). `Én` retning må aldrig forekomme: ingen linje må MISTE sin pris.
    ok(flyttet.every(f => f.ny != null),
        'ingen linje mister sin pris — ændringen kan kun gøre panelet mere komplet');
    ok(flyttet.every(f => f.g != null),
        'i fixturen skifter alle ni bare ophav; i drift vinder 6 linjer desuden en pris de ikke havde');

    // Præcis de linjer hvor varen laves af en ANDEN opskrift, og intet andet.
    const { index } = rc.buildProducedByIndex(SNAP.recipes);
    const forventet = [];
    for (const r of SNAP.recipes) {
        for (const pos of posFor(r.id)) {
            const prod = index.get(String(pos.product_id));
            if (prod && Number(prod.id) !== Number(r.id)) forventet.push(r.name + ' / ' + pNavn(pos.product_id));
        }
    }
    const faktisk = flyttet.map(f => f.opskrift + ' / ' + f.produkt);
    ok(JSON.stringify([...faktisk].sort()) === JSON.stringify([...forventet].sort()),
        `netop de ${forventet.length} linjer hvor varen laves af en anden opskrift har flyttet sig — ikke én mere`);

    // Og det NYE tal er producentens kostpris pr. lager-enhed, ikke lagerprisen.
    const kartoflen = SNAP.recipes.find(r => r.name === 'Kartoflen slider');
    if (kartoflen) {
        const b = rc.breakdownRecipe(kartoflen.id, DATA);
        const linje = b.ingredients.find(i => /Rødløg - Sylt$/.test(i.name));
        ok(linje && linje.source === 'recipe' && linje.producer_recipe_id != null,
            'Rødløg - Sylt i «Kartoflen slider» får sin pris fra OPSKRIFTEN, ikke fra lageret');
        if (linje) {
            const prod = rc.breakdownRecipe(linje.producer_recipe_id, DATA);
            ok(prod.yield_amount > 0 && nær(linje.unit_cost, prod.total / prod.yield_amount),
                'og prisen er producentens kostpris delt med dens udbytte — samme regnestykke som totalen bruger');
            ok(linje.unit_cost !== priceByProduct.get(String(linje.product_id)),
                'kontrol: det er et ANDET tal end lagerprisen — ellers målte asserten ingenting');
        }
    } else ok(false, '«Kartoflen slider» findes ikke i fixturen');

    console.log('     \x1b[2m' + flyttet.slice(0, 3).map(f =>
        `${f.opskrift} / ${f.produkt}: ${f.g.toFixed(2)} → ${f.ny.toFixed(2)}`).join('\n     ') + '\x1b[0m');
}

// ── §3 Underopskrifter ────────────────────────────────────────
console.log('\n── §3 Underopskrifter ────────────────────────────────────');
{
    const med = SNAP.recipes.filter(r => SNAP.recipes_nestings.some(n => n.recipe_id === r.id));
    ok(med.length > 0, `${med.length} opskrifter i fixturen har underopskrifter`);
    for (const r of med) {
        const b = rc.breakdownRecipe(r.id, DATA);
        const n = SNAP.recipes_nestings.filter(x => x.recipe_id === r.id);
        if (b.sub_recipes.length !== n.length) { ok(false, `«${r.name}» — ${n.length} nestings, ${b.sub_recipes.length} rækker`); continue; }
        // Bidraget er underopskriftens kostpris skaleret: servings / base_servings.
        const galt = b.sub_recipes.find(sr => {
            const sub = rc.breakdownRecipe(sr.recipe_id, DATA);
            return !nær(sr.cost, sub.total * (sr.servings / sr.base_servings));
        });
        ok(!galt, `«${r.name}» — hver underopskrift bidrager med sin kostpris skaleret efter portioner`);
    }
    const énMed = med[0] && rc.breakdownRecipe(med[0].id, DATA);
    ok(énMed && énMed.sub_recipes.every(s => s.name && s.base_servings > 0),
        'underopskrifterne bærer navn og base_servings, så panelet kan vise dem uden et opslag mere');
}

// ── §4 Manglende pris gør linjen til «—», ikke til 0 ──────────
console.log('\n── §4 Manglende pris ─────────────────────────────────────');
{
    let fundet = null;
    for (const r of SNAP.recipes) {
        const b = rc.breakdownRecipe(r.id, DATA);
        const m = b.ingredients.find(i => i.missing);
        if (m) { fundet = { b, m, navn: r.name }; break; }
    }
    ok(fundet, 'fixturen har mindst én linje uden pris at måle på');
    if (fundet) {
        ok(fundet.m.cost === null && fundet.m.unit_cost === null,
            'en vare uden kendt pris giver «—», ikke 0 — 0 ville være en påstand om at den er gratis');
        ok(fundet.b.complete === false && fundet.b.missing.includes(fundet.m.name),
            'og opskriften er IKKE komplet: kostprisen er et minimum (I3), og varen nævnes ved navn');
        ok([...fundet.b.ingredients, ...fundet.b.sub_recipes]
            .reduce((a, x) => a + (x.cost || 0), 0) === fundet.b.total,
            'summen går stadig op — den manglende linje tæller som ingenting i begge ender');
    }

    const nul = rc.breakdownRecipe(SNAP.recipes[0].id, DATA);
    ok(nul.ingredients.every(i => i.cost === null || i.cost > 0),
        'ingen linje står med en kostpris på præcis 0 uden grund');
}

// ── §5 productIdsFor: prisopslaget skal dække hele regnestykket ──
console.log('\n── §5 Hvilke priser skal panelet hente? ──────────────────');
{
    const k = SNAP.recipes.find(r => r.name === 'Kartoflen slider');
    const direkte = [...new Set(posFor(k.id).map(p => String(p.product_id)))];
    const alle = rc.productIdsFor(k.id, DATA);

    ok(alle.length > direkte.length,
        `lukningen er større end de direkte linjer (${direkte.length} → ${alle.length}) — underopskrifter og producenter tæller med`);
    ok(direkte.every(d => alle.includes(d)), 'alle direkte ingredienser er med');

    // Selve pointen: hentes KUN de direkte, kan et produceret gode ikke prissættes.
    const kunDirekte = new Map([...priceByProduct].filter(([pid]) => direkte.includes(pid)));
    const halv = rc.breakdownRecipe(k.id, { ...DATA, priceByProduct: kunDirekte });
    const hel = rc.breakdownRecipe(k.id, DATA);
    ok(!nær(halv.total, hel.total),
        'kontrol: med kun de direkte priser bliver kostprisen et ANDET tal — derfor findes productIdsFor');
    const faldt = halv.ingredients.find(i => i.producer_recipe_id && i.source === 'purchase');
    ok(faldt != null,
        'og årsagen er synlig: producent-opskriften kan ikke regnes, så linjen falder tilbage på lagerprisen');
    ok((halv.warnings || []).some(w => w.kind === 'produced_recipe_cost_unavailable'),
        'faldet siges højt som en advarsel — det ligner ellers en helt almindelig købt vare');

    // Cykler må ikke hænge opslaget.
    const cyklisk = {
        ...DATA,
        recipes: [{ id: 9001, name: 'A', product_id: 501, base_servings: 1 },
                  { id: 9002, name: 'B', product_id: 502, base_servings: 1 }],
        pos: [{ recipe_id: 9001, product_id: 502, amount: 1 },
              { recipe_id: 9002, product_id: 501, amount: 1 }],
        nestings: [],
        products: [{ id: 501, name: 'A-vare' }, { id: 502, name: 'B-vare' }],
    };
    let hang = false;
    const t0 = Date.now();
    try { rc.productIdsFor(9001, cyklisk); } catch { hang = true; }
    ok(!hang && Date.now() - t0 < 1000, 'to opskrifter der producerer hinandens råvare hænger ikke opslaget');
}

// ── §6 Syntetiske tilfælde fixturen ikke har ──────────────────────
// Fixturen er ægte drift, og drift er ikke fuldstændig: den har ingen linjer
// med mængde 0, og `servings` er lig `base_servings` i alle seks nestings —
// så skaleringen er usynlig dér. Målt, ikke antaget.
console.log('\n── §6 Skalering, nul-linjer og lukning ───────────────────');
{
    const SY = {
        recipes: [
            // Producerer vare 9001: 4 portioner à 0,5 kg = 2 kg udbytte.
            { id: 8001, name: 'Base', base_servings: 4, product_id: 9001,
              userfields: { recipeunit: 'kg', recipeunitnumber: '0.5' } },
            { id: 8002, name: 'Bruger', base_servings: 1, product_id: null, userfields: {} },
            { id: 8003, name: 'KunNest', base_servings: 1, product_id: null, userfields: {} },
        ],
        pos: [
            { id: 1, recipe_id: 8001, product_id: 9002, amount: 3 },    // 3 × 10 = 30 kr
            { id: 2, recipe_id: 8002, product_id: 9003, amount: 0 },    // mængde 0
            { id: 3, recipe_id: 8002, product_id: 9001, amount: 1 },    // produceret gode
            { id: 4, recipe_id: 8003, product_id: 9004, amount: 2 },    // KUN nåelig via nesting
        ],
        nestings: [
            { id: 11, recipe_id: 8002, includes_recipe_id: 8001, servings: 2 },  // 2 af 4 = halvdelen
            { id: 12, recipe_id: 8002, includes_recipe_id: 8003, servings: 1 },
        ],
        products: [
            { id: 9001, name: 'Halvfabrikat', qu_id_stock: 2 },
            { id: 9002, name: 'Råvare', qu_id_stock: 2 },
            { id: 9003, name: 'Nul-vare', qu_id_stock: 2 },
            { id: 9004, name: 'Dyb råvare', qu_id_stock: 2 },
        ],
        units: [{ id: 2, name: 'Kilo', name_short: 'kg' }],
        conversions: [],
        priceByProduct: new Map([['9002', 10], ['9003', 10], ['9004', 5], ['9001', 99]]),
        priceDetailByProduct: new Map(),
    };

    const base = rc.breakdownRecipe(8001, SY);
    ok(nær(base.total, 30) && nær(base.yield_amount, 2),
        'syntetisk «Base»: 30 kr for 4 portioner, udbytte 2 kg');

    const b = rc.breakdownRecipe(8002, SY);

    // Skalering: 2 af 4 portioner = halvdelen af de 30 kr.
    const nest = b.sub_recipes.find(x => x.recipe_id === 8001);
    ok(nest && nær(nest.cost, 15),
        'en underopskrift taget med 2 af 4 portioner bidrager med HALVDELEN (15 af 30 kr)');
    ok(nest && nest.servings === 2 && nest.base_servings === 4,
        'og rækken bærer begge tal, så skaleringen kan ses på skærmen');

    // Mængde 0: ingen pris, ikke 0 kr.
    const nul = b.ingredients.find(i => i.product_id === 9003);
    ok(nul && nul.cost === null,
        'en linje med mængde 0 bidrager med «—», ikke med 0 kr — 0 kr ville påstå at varen er gratis');
    ok(nul && nul.unit_cost === 10,
        'men prisen PR. ENHED står der stadig — den er kendt, mængden er bare ikke sat endnu');

    // Produceret gode: 30 kr / 2 kg = 15 kr/kg, ikke lagerprisen på 99.
    const hf = b.ingredients.find(i => i.product_id === 9001);
    ok(hf && nær(hf.unit_cost, 15) && hf.source === 'recipe',
        'det producerede gode koster opskriftens 15 kr/kg — ikke lagerprisens 99 (#558)');

    ok(nær(b.total, 15 + 15 + 10), 'totalen er 40 kr: 15 (nesting) + 15 (halvfabrikat) + 10 (KunNest)');
    ok(nær([...b.ingredients, ...b.sub_recipes].reduce((a, x) => a + (x.cost || 0), 0), b.total),
        'og linjerne lægger sammen til den');

    // Lukningen: 9004 kan KUN nås gennem en nesting.
    const ids = rc.productIdsFor(8002, SY);
    ok(ids.includes('9004'),
        'prisopslaget når ned gennem en underopskrift — «Dyb råvare» findes kun dér');
    ok(ids.includes('9002'), 'og gennem producent-opskriften bag et halvfabrikat');
    ok(!ids.includes('8001'), 'kontrol: det er PRODUKT-id\'er, ikke opskrift-id\'er');
}

// ── §7 Ruten: panelet får sine tal fra breakdownRecipe ─────────────
// At funktionen er rigtig beviser ikke at RUTEN bruger den. Her rammes
// `/api/recipes/:id/composition` for alvor, med Grocy stubbet — og svarets
// form måles, for det er den frontenden tegner efter.
console.log('\n── §7 /composition bruger den delte regel ───────────────');
(async () => {
    const grocy = require('../services/grocyAdapter');
    // Mindst én vare skal have et ARVET ophav (`parent_avg`), ellers kan
    // asserten om at flaget IKKE sættes på en opskriftspris ikke måle noget.
    // Det producerede gode får det, for det er dér forvekslingen ville ske.
    const rødløgId = String((SNAP.products.find(p => /^Rødløg - Sylt$/.test(p.name)) || {}).id);
    const detaljer = new Map([...priceByProduct].map(([pid, c]) =>
        [pid, { cost: c, source: pid === rødløgId ? 'parent_avg' : 'purchase' }]));
    const org = {};
    const stub = {
        getRecipesRawMap: async () => new Map(SNAP.recipes.map(r => [r.id, r])),
        getAllRecipesPos: async () => SNAP.recipes_pos,
        getRecipeNestings: async () => SNAP.recipes_nestings,
        getProducts: async () => SNAP.products,
        getQuantityUnits: async () => SNAP.quantity_units,
        getQuantityUnitConversions: async () => SNAP.quantity_unit_conversions,
        getRecipeFulfillment: async () => [],
        getProductDetails: async (pid) => ({ stock_amount: 0, product: { id: pid } }),
        getProductUnitCostDetails: async (_c, opts) => {
            // Ruten SKAL bede om lukningen, ikke kun de direkte linjer — ellers
            // kan et produceret gode ikke prislægges. Måles nedenfor.
            stub._spurgtOm = (opts && opts.productIds) || null;
            const ud = new Map();
            for (const pid of (stub._spurgtOm || [...detaljer.keys()])) {
                if (detaljer.has(String(pid))) ud.set(String(pid), detaljer.get(String(pid)));
            }
            return ud;
        },
        readRecipeCostCache: () => new Map(),
    };
    for (const k of Object.keys(stub)) { if (typeof grocy[k] === 'function') { org[k] = grocy[k]; grocy[k] = stub[k]; } }

    const express = require('express');
    const app = express();
    app.use(express.json());
    // Ruten står bag requireAuth() (#316). Sessionen lægges på her, så testen
    // måler kompositionen og ikke auth-gaten, som har sine egne tests.
    app.use((req, _res, next) => { req.session = { userId: 1, role: 'admin' }; next(); });
    app.use('/api/recipes', require('../routes/recipes_overview'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;

    const k = SNAP.recipes.find(r => r.name === 'Kartoflen slider');
    const r = await fetch(`${base}/api/recipes/${k.id}/composition`);
    const j = await r.json();

    ok(r.status === 200, `ruten svarer 200 (${r.status})`);
    ok(Array.isArray(j.ingredients) && j.ingredients.length === posFor(k.id).length,
        `én række pr. ingrediens (${(j.ingredients || []).length})`);
    ok((j.ingredients || []).length > 0 && j.ingredients.every(i =>
        'product_id' in i && 'name' in i && 'amount' in i && 'unit' in i &&
        'stock' in i && 'in_stock' in i && 'cost' in i && 'producing_recipe_id' in i),
        'svarets form er uændret — frontenden tegner efter de samme felter som før');

    const bd = rc.breakdownRecipe(k.id, DATA);
    const rødløg = (j.ingredients || []).find(i => /Rødløg - Sylt$/.test(i.name));
    const bdR = bd.ingredients.find(i => /Rødløg - Sylt$/.test(i.name));
    ok(rødløg && bdR && nær(rødløg.cost, Math.round(bdR.cost * 100) / 100),
        'et produceret godes linje viser breakdownRecipe\'s tal — ikke rutens gamle lagerpris');
    ok(rødløg && rødløg.cost_from_recipe === true,
        'og rækken siger at prisen kommer fra opskriften, så tallet kan forklares');
    ok(rødløg && !rødløg.cost_inherited && !rødløg.cost_estimated,
        'arvet/overslag sættes ikke på en pris der slet ikke kommer fra et køb');

    ok(nær(j.total_cost_computed, Math.round(bd.total * 100) / 100),
        'det genberegnede tal er med i svaret, så en forældet cache kan ses');

    const direkte = new Set(posFor(k.id).map(p => String(p.product_id)));
    ok(stub._spurgtOm && stub._spurgtOm.length > direkte.size,
        `ruten henter priser for HELE lukningen (${(stub._spurgtOm || []).length} mod ${direkte.size} direkte)`);

    // Kartoflen slider har ingen nestings — uden en boks køres sub-grenen aldrig.
    const boks = SNAP.recipes.find(x => /Boks/.test(x.name));
    const r2s = await fetch(`${base}/api/recipes/${boks.id}/composition`);
    const j2 = await r2s.json();
    const bd2 = rc.breakdownRecipe(boks.id, DATA);
    ok((j2.sub_recipes || []).length === bd2.sub_recipes.length && j2.sub_recipes.length > 0,
        `en boks viser sine ${(j2.sub_recipes || []).length} halvfabrikater`);
    ok(j2.sub_recipes.every(sr => {
        const b3 = bd2.sub_recipes.find(x => Number(x.recipe_id) === Number(sr.recipe_id));
        return b3 && nær(sr.cost, Math.round(b3.cost * 100) / 100);
    }), 'og deres bidrag er breakdownRecipe\'s tal — ruten regner dem ikke selv');
    ok(j2.sub_recipes.every(sr => sr.name && sr.unit && 'category' in sr),
        'svarets form for underopskrifter er uændret');

    srv.close();
    for (const k2 of Object.keys(org)) grocy[k2] = org[k2];

    console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\x1b[31mtesten væltede:\x1b[0m', e); process.exit(1); });
