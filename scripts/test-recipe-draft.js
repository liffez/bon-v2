// scripts/test-recipe-draft.js
// ============================================================
// Kan en UGEMT opskrift-kladde regnes med de motorer der allerede findes?
//
// Det er hele påstanden bag `/api/opskrifter/beregn` (designer-spec §13): at
// `recipeCost.computeAll` og `co2Engine.computeAll` tager rene arrays og
// derfor kan fodres en kladde — så editoren ikke får sit eget regnestykke.
//
// Ækvivalenstesten er beviset: bygger man en kladde af en GEMT opskrifts egne
// rækker, skal kladde-vejen give nøjagtig de samme tal som motorerne giver for
// opskriften direkte. Gør den ikke det, er påstanden falsk, og editoren ville
// vise ét tal mens Opskrifter & priser viste et andet (#360's fejlklasse).
//
// Kører uden Grocy og uden DB: fixturen er et read-only udtræk fra grocy-hq.
//
// Kør:  node scripts/test-recipe-draft.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };
const nær = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps;

const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

const draftLag = require('../services/recipeDraft');
const recipeCost = require('../services/recipeCost');
const co2Engine = require('../services/co2Engine');

// ── Grocy-data som motorerne forventer ────────────────────────
// Fixturen har ingen priser og ingen varegrupper. Priserne sættes syntetisk
// (kr pr. lager-enhed) — testen måler ÆKVIVALENS, ikke absolutte kroner.
// Gruppe 3 gøres til emballage, så R7.5 kan efterprøves.
function grocyData(over) {
    const priceByProduct = new Map();
    // Nøglen er en STRENG — det er sådan recipeCost slår op (String(product.id)).
    SNAP.products.forEach((p, i) => { if (i % 5 !== 4) priceByProduct.set(String(p.id), 10 + (p.id % 17)); });
    return Object.assign({
        recipes: SNAP.recipes,
        pos: SNAP.recipes_pos,
        nestings: SNAP.recipes_nestings,
        products: SNAP.products,
        units: SNAP.quantity_units,
        conversions: SNAP.quantity_unit_conversions,
        groups: [{ id: 1, name: 'Kolonial' }, { id: 2, name: 'Grønt' },
                 { id: 3, name: 'Emballage' }, { id: 4, name: 'Kød' },
                 { id: 5, name: 'Mejeri' }, { id: 8, name: 'Diverse' },
                 { id: 9, name: 'Frost' }, { id: 11, name: 'Drikke' }, { id: 14, name: 'Bageri' }],
        priceByProduct,
        priceDetailByProduct: new Map(),
    }, over || {});
}

(async () => {

// ── §1 Ækvivalens: kladde af en gemt opskrift === motoren direkte ──
console.log('\n── §1 Kladde-vejen og motoren skal være enige ────────────');
{
    const g = grocyData();
    const kostDirekte = recipeCost.computeAll(g);
    const co2Direkte = co2Engine.computeAll(g);

    // Hele fixturen, ikke en håndplukket opskrift: en enkelt kunne være enig
    // ved et tilfælde. Nestings, producerede varer og manglende priser er alle
    // repræsenteret i de 17.
    const uenige = [];
    for (const r of SNAP.recipes) {
        const kladde = draftLag.draftFromSaved(r.id, g);
        const res = await draftLag.computeDraft(kladde, g);
        const k = kostDirekte.get(r.id), c = co2Direkte.get(r.id);
        const kostEns = (res.cost.total == null && k == null) || nær(res.cost.total, k.cost, 1e-9);
        const co2Ens = (res.co2.total == null && c == null) || nær(res.co2.total, c.total, 1e-9);
        const flagEns = res.cost.complete === (k ? k.complete : false)
                     && res.co2.complete === (c ? c.complete : false);
        if (!kostEns || !co2Ens || !flagEns) {
            uenige.push(`#${r.id} ${r.name}: kost ${res.cost.total} mod ${k && k.cost}` +
                        ` · co2 ${res.co2.total} mod ${c && c.total}` +
                        ` · complete ${res.cost.complete}/${res.co2.complete}`);
        }
    }
    ok(SNAP.recipes.length >= 15, `målt på ${SNAP.recipes.length} opskrifter`);
    ok(uenige.length === 0, 'kladde-vejen giver samme tal som motorerne: ' + (uenige[0] || 'alle enige'));

    // Kontrolprøve: er der overhovedet tal at være enige OM?
    const medTal = SNAP.recipes.filter(r => (kostDirekte.get(r.id) || {}).cost > 0).length;
    ok(medTal >= 10, `${medTal} opskrifter har en kostpris > 0 — ellers måler §1 ingenting`);
}

// ── §2 Sentinel-reglerne ──────────────────────────────────────
console.log('\n── §2 Kladden må hverken fordobles eller kapre en vare ────');
{
    const g = grocyData();
    const direkte = recipeCost.computeAll(g);

    // En redigeret kladde ERSTATTER sine rækker — den lægges ikke ved siden af.
    const kladde = draftLag.draftFromSaved(110, g);   // Chili Mayo
    const uændret = await draftLag.computeDraft(kladde, g);
    ok(nær(uændret.cost.total, direkte.get(110).cost), 'uændret kladde = opskriftens egen kostpris');

    const dobbelt = JSON.parse(JSON.stringify(kladde));
    dobbelt.lines = dobbelt.lines.concat(dobbelt.lines);   // hver linje to gange
    const res2 = await draftLag.computeDraft(dobbelt, g);
    ok(res2.cost.total > uændret.cost.total * 1.9,
        `dobbelte linjer fordobler kostprisen (${res2.cost.total} mod ${uændret.cost.total})`);

    // En NY kladde der erklærer at den producerer Chili Mayo må ikke overtage
    // varens pris for resten af beregningen (#558: laveste id vinder).
    const brugerMayo = SNAP.recipes.find(r =>
        SNAP.recipes_pos.some(p => p.recipe_id === r.id && p.product_id === 34) && r.id !== 110);
    ok(!!brugerMayo, 'fixturen har en opskrift der bruger Chili Mayo som vare');
    const førKost = direkte.get(brugerMayo.id).cost;

    const nyKladde = {
        recipe_id: null, name: 'ZZT ny mayo', base_servings: 1,
        yield: { amount: 1, unit: 'kg', product_id: 34 },
        lines: [{ product_id: 1, amount: 99 }],           // dyr og helt anderledes
    };
    const byg = draftLag.buildInputs(nyKladde, g);
    ok(byg.draftId > Math.max(...SNAP.recipes.map(r => r.id)),
        `ny kladde får et HØJERE id end alle eksisterende (${byg.draftId})`);
    const medNy = recipeCost.computeAll(byg.data);
    ok(nær(medNy.get(brugerMayo.id).cost, førKost),
        `"${brugerMayo.name}" påvirkes ikke af en ny kladde der erklærer samme vare`);

    // Og modsat: FJERNER man varen fra opskriften, skal den holde op med at
    // være varens producent med det samme. Blev den gamle række liggende ved
    // siden af kladden, ville den blive ved med at sætte prisen — usynligt,
    // fordi computeAll nøgler på id og bare overskriver sin egen udgang.
    const udenVare = draftLag.draftFromSaved(110, g);
    udenVare.yield.product_id = null;
    const byg2 = draftLag.buildInputs(udenVare, g);
    ok(byg2.data.recipes.filter(r => Number(r.id) === 110).length === 1,
        'kladden findes præcis ÉN gang i opskrift-listen');
    const producenter = byg2.data.recipes.filter(r => Number(r.product_id) === 34);
    ok(producenter.length === 0,
        'opskrift 110 producerer ikke længere Chili Mayo: ' + JSON.stringify(producenter.map(r => r.name)));
    const efter = recipeCost.computeAll(byg2.data);
    ok(!nær(efter.get(brugerMayo.id).cost, førKost),
        `"${brugerMayo.name}" skifter kostpris når Chili Mayo mister sin producent ` +
        `(${efter.get(brugerMayo.id).cost} mod ${førKost})`);
}

// ── §3 Uafklarede linjer og ≥-reglen ──────────────────────────
console.log('\n── §3 Ukendt er ikke nul (I3) ────────────────────────────');
{
    const g = grocyData();
    const grund = {
        recipe_id: null, name: 'ZZT ny', base_servings: 1,
        yield: { amount: 1, unit: 'kg' },
        lines: [{ product_id: 1, amount: 0.5 }],
    };
    const uden = await draftLag.computeDraft(grund, g);
    ok(uden.cost.complete === true, 'kladde med kendte priser er komplet');

    const medNyVare = JSON.parse(JSON.stringify(grund));
    medNyVare.lines.push({ amount: 0.2, new_product: { key: 'a', name: 'Chiliolie', qu_id_stock: 4 } });
    const r1 = await draftLag.computeDraft(medNyVare, g);
    ok(r1.cost.complete === false, 'ny vare uden pris gør kostprisen til et mindstetal');
    ok(r1.cost.missing.includes('Chiliolie'), 'varen navngives som manglende: ' + JSON.stringify(r1.cost.missing));
    ok(nær(r1.cost.total, uden.cost.total), 'mindstetallet er de kendte linjer — ikke nul');

    const medPris = JSON.parse(JSON.stringify(medNyVare));
    medPris.lines[1].new_product.price_per_unit = 100;
    const r2 = await draftLag.computeDraft(medPris, g);
    ok(r2.cost.complete === true, 'ny vare MED pris gør beregningen komplet');
    ok(nær(r2.cost.total, uden.cost.total + 20), `prisen indgår (${r2.cost.total} = ${uden.cost.total} + 0,2×100)`);

    const udenEnhed = JSON.parse(JSON.stringify(grund));
    udenEnhed.lines.push({ amount: 1, new_product: { key: 'b', name: 'Uden enhed' } });
    const r3 = await draftLag.computeDraft(udenEnhed, g);
    ok(r3.unresolved.length === 1 && r3.unresolved[0].blocks_save === true,
        'ny vare uden lagerenhed markeres som blokerende for gem (R8.4)');
    ok(r1.unresolved[0].blocks_save === false, 'ny vare MED enhed blokerer ikke');
}

// ── §4 Vægt: emballage på varegruppe, nesting på udbytte ──────
console.log('\n── §4 Madvægt, emballage og nestings ─────────────────────');
{
    const g = grocyData();
    const kiloVare = SNAP.products.find(p => p.qu_id_stock === 4 && p.product_group_id !== 3);
    const embVare = SNAP.products.find(p => p.product_group_id === 3);
    ok(!!kiloVare && !!embVare, 'fixturen har både en madvare og en emballagevare');

    const k = {
        recipe_id: null, name: 'ZZT vægt', base_servings: 1,
        yield: { amount: 1, unit: 'kg' },
        lines: [
            { product_id: kiloVare.id, amount: 2, section: 'Fyld' },
            { product_id: embVare.id, amount: 1, section: 'Fyld' },   // SEKTION siger ikke emballage
        ],
    };
    const res = await draftLag.computeDraft(k, g);
    ok(res.weight.food_g > 0 && res.weight.packaging_g > 0,
        `mad ${res.weight.food_g} g og emballage ${res.weight.packaging_g} g holdes adskilt`);
    ok(res.weight.food_g < res.weight.batch_g,
        'emballagen tæller i batchvægten, ikke i madvægten (R7.5)');

    // Målvægt-procenten
    const medMål = Object.assign({}, k, { target_weight_g: res.weight.food_g / 2 });
    const res2 = await draftLag.computeDraft(medMål, g);
    ok(nær(res2.target_weight_pct, 200, 0.2), `målvægt-bjælken regner mad ÷ mål (${res2.target_weight_pct} %)`);

    // Nesting vejer sit udbytte. Chili Mayo: 1 portion = 1,1 kg.
    const nest = {
        recipe_id: null, name: 'ZZT nest', base_servings: 1,
        yield: { amount: 1, unit: 'kg' },
        lines: [{ includes_recipe_id: 110, servings: 2 }],
    };
    const rn = await draftLag.computeDraft(nest, g);
    ok(nær(rn.weight.food_g, 2200, 0.01),
        `2 portioner Chili Mayo vejer 2.200 g — udbyttet, ikke råvaresummen (fik ${rn.weight.food_g})`);

    const udenUdbytte = { recipe_id: null, name: 'ZZT nest 2', base_servings: 1,
        yield: { amount: 1, unit: 'kg' },
        lines: [{ includes_recipe_id: 77, servings: 1 }] };   // slider-boks, intet udbytte
    const ru = await draftLag.computeDraft(udenUdbytte, g);
    ok(ru.weight.complete === false, 'nesting uden bestemmeligt udbytte gør vægten til et mindstetal');
}

// ── §5 Pr. portion ────────────────────────────────────────────
console.log('\n── §5 Pr. portion — sanity-checket i overblikket ─────────');
{
    const g = grocyData();
    const kiloVare = SNAP.products.find(p => p.qu_id_stock === 4 && p.product_group_id !== 3);
    const k = {
        recipe_id: null, name: 'ZZT portioner', base_servings: 30,
        yield: { amount: 1, unit: 'stk' },
        lines: [{ product_id: kiloVare.id, amount: 1 }],
    };
    const res = await draftLag.computeDraft(k, g);
    ok(nær(res.per_serving.weight_g, res.weight.food_g / 30, 0.01),
        `1 kg på 30 portioner = ${res.per_serving.weight_g} g pr. portion`);
    ok(nær(res.per_serving.cost, res.cost.total / 30, 1e-9), 'kostprisen deles med portionerne');
}

// ── §6 Ruten ──────────────────────────────────────────────────
// Den ÆGTE router mountes og rammes over HTTP. Grocy stubbes på adapteren, så
// intet netværk og ingen DB er i spil — men kodestien er routens egen.
console.log('\n── §6 POST /api/opskrifter/beregn ────────────────────────');
{
    const g = grocyData();
    const grocyAdapter = require('../services/grocyAdapter');
    grocyAdapter.getRecipesRaw = async () => g.recipes;
    grocyAdapter.getAllRecipesPos = async () => g.pos;
    grocyAdapter.getRecipeNestings = async () => g.nestings;
    grocyAdapter.getProducts = async () => g.products;
    grocyAdapter.getQuantityUnits = async () => g.units;
    grocyAdapter.getQuantityUnitConversions = async () => g.conversions;
    grocyAdapter.getProductGroups = async () => g.groups;
    grocyAdapter.getProductUnitCostDetails = async () => {
        const m = new Map();
        for (const [pid, kr] of g.priceByProduct) m.set(pid, { cost: kr, source: 'test' });
        return m;
    };

// ── Linje for linje: gram, kostpris, CO₂e ──────────────────────
// Editorens tabel viser én række pr. linje. Kommer de tal fra et regnestykke
// der LIGNER motorernes, driver de fra hinanden — og en tabel hvis linjer ikke
// lægger sammen til overskriften er værre end ingen tabel.
console.log('\n── §N Linjer: gram, kostpris, CO₂e ─────────────────────');
{
    const g = grocyData();
    const k = SNAP.recipes.find(r => r.name === 'Kartoflen slider');
    const o = await draftLag.computeDraft(draftLag.draftFromSaved(k.id, g), g);

    ok(Array.isArray(o.lines) && o.lines.length === 9, `kladden giver én række pr. linje (${o.lines.length})`);
    ok(o.lines.every(l => l.line_id != null && l.name && l.kind),
        'hver række bærer sit eget line_id, navn og art — to linjer med samme vare kan ikke smelte sammen');

    const sumKost = o.lines.reduce((a, l) => a + (l.cost || 0), 0);
    ok(nær(sumKost, o.cost.total), `kostpriserne lægger sammen til totalen (${sumKost.toFixed(4)} = ${o.cost.total.toFixed(4)})`);
    const sumCo2 = o.lines.reduce((a, l) => a + (l.co2e || 0), 0);
    ok(nær(sumCo2, o.co2.total, 1e-9), `CO₂e lægger sammen til totalen (${sumCo2.toFixed(6)})`);
    const sumVægt = o.lines.reduce((a, l) => a + (l.weight_g || 0), 0);
    ok(nær(sumVægt, o.weight.food_g + o.weight.packaging_g, 1e-6),
        'gram lægger sammen til mad + emballage — de to holdes adskilt i totalen, men tabellen viser begge');

    ok(o.lines.some(l => l.cost_source === 'recipe' && l.producer_recipe_id),
        'en vare vi selv laver får sin pris fra OPSKRIFTEN, og rækken siger hvilken (#558)');
    ok(o.lines.some(l => l.cost_source === 'purchase'), 'en købt vare får sin pris fra købet');
    const mangler = o.lines.find(l => l.missing_cost);
    ok(mangler && mangler.cost === null,
        'en vare uden kendt pris står som «—» og er mærket — ikke som 0 kr');

    // Kontrolprøve: summerne er ikke trivielt sande.
    ok(o.cost.total > 0 && o.co2.total > 0 && o.weight.food_g > 0,
        'kontrol: der ER tal at lægge sammen — ellers ville alle tre asserts bestå af 0 = 0');
}

// ── Halvfabrikat: udbyttet, og de to slags «ved ikke» ───────────────
console.log('\n── §N Halvfabrikat på en linje ────────────────────────');
{
    const g = grocyData();
    const b = SNAP.recipes.find(r => /Boks/.test(r.name));
    const o = await draftLag.computeDraft(draftLag.draftFromSaved(b.id, g), g);
    const sub = o.lines.filter(l => l.kind === 'sub_recipe');

    ok(sub.length === 3, `de tre halvfabrikater står som hver sin linje (${sub.length})`);
    ok(sub.every(l => l.includes_recipe_id && l.servings > 0 && l.name),
        'hver bærer sin opskrift, sit portionstal og sit navn — nok til at tegne rækken uden et opslag mere');

    // §B12: enheden ved mængden kommer HERFRA (B5). Opskriften siger selv hvad
    // én portion er; er det «1 antal», sender vi «antal», og browseren skriver
    // «stk» i stedet for det abstrakte «portion».
    const RY = require('../shared/recipe_yield');
    const førstePU = RY.portionUnit(SNAP.recipes.find(r => Number(r.id) === Number(sub[0].includes_recipe_id)));
    ok(førstePU.exact === true && førstePU.unit,
       'fixturens halvfabrikater har «1 portion er 1 ' + førstePU.unit + '»');
    ok(sub.every(l => l.unit === førstePU.unit),
       'og linjen bærer den enhed: ' + sub.map(l => l.unit).join(' · '));
    ok(sub.every(l => l.portion_per === 1),
       'forholdet står med, så browseren kan se AT det er 1:1');

    // Er forholdet ikke 1:1, sendes ingen enhed — «2» med etiketten «stk»
    // ville påstå 2 stk hvor der er 6. Vi lyver hellere ikke ved at tie.
    const skæv = grocyData({
        recipes: SNAP.recipes.map(r => Number(r.id) === Number(sub[0].includes_recipe_id)
            ? { ...r, userfields: { ...(r.userfields || {}), recipeunitnumber: '3' } } : r),
    });
    const oSkæv = await draftLag.computeDraft(draftLag.draftFromSaved(b.id, skæv), skæv);
    const linjeSkæv = oSkæv.lines.find(l => l.kind === 'sub_recipe'
        && Number(l.includes_recipe_id) === Number(sub[0].includes_recipe_id));
    ok(linjeSkæv && linjeSkæv.unit === null && linjeSkæv.portion_per === 3,
       '«1 portion er 3 antal» → ingen enhed, men forholdet siges (' + (linjeSkæv && linjeSkæv.portion_per) + ')');
    // Boksen har OGSÅ en egen linje (servietter) — halvfabrikaterne er ikke
    // hele totalen, og de to slags linjer skal lægges sammen på lige fod.
    const egne = o.lines.filter(l => l.kind === 'product');
    ok(egne.length > 0 && sub.length > 0, 'boksen har både egne linjer og halvfabrikater');
    ok(nær([...egne, ...sub].reduce((a, l) => a + (l.cost || 0), 0), o.cost.total),
        'egne linjer OG halvfabrikater lægger tilsammen op til totalen');
    ok(!nær(sub.reduce((a, l) => a + (l.cost || 0), 0), o.cost.total),
        'kontrol: halvfabrikaterne alene rækker IKKE — ellers målte asserten ovenfor ingenting');

    // De to slags «ved ikke» er uafhængige, og det skal de være: en opskrift
    // uden erklæret udbytte kan ikke vejes, men den kan udmærket prisslættes.
    ok(sub.every(l => l.weight_g === null),
        'uden et erklæret udbytte er vægten ukendt — null, ikke 0 (yield-modellen)');
    ok(o.weight.complete === false && o.weight.missing.length === 3,
        'og de nævnes ved navn, så man kan se HVAD der mangler i Grocy (#372)');
    ok(o.cost.total > 0 && sub.every(l => l.cost != null),
        'kontrol: kostprisen er kendt alligevel — de to slags «ved ikke» blandes ikke sammen');
}

// ── Linjernes tal gælder HOLDET, ikke portionen ───────────────────
// `co2Engine` regner pr. portion, `recipeCost` og vægten pr. hold. Tabellen
// viser ét tal pr. linje, og de tre skal betyde det SAMME — ellers står gram
// og kroner for hele holdet ved siden af en CO₂-værdi for én portion.
// Fixturen har kun én opskrift med base_servings > 1, så det måles syntetisk.
console.log('\n── §N Linjernes tal gælder hele holdet ──────────────────');
{
    const g = {
        recipes: [], pos: [], nestings: [],
        products: [
            // co2e_per_kg + en kilo-enhed: både vægt og CO₂ kan regnes.
            { id: 7001, name: 'Mælk', qu_id_stock: 2, product_group_id: 5,
              userfields: { co2e_per_kg: '1.2' } },
            // Ingen vej til kilo — vægten er ukendt, og det skal den have lov at være.
            { id: 7002, name: 'Stykvare', qu_id_stock: 3, product_group_id: 5, userfields: {} },
        ],
        units: [{ id: 2, name: 'Kilo', name_short: 'kg' }, { id: 3, name: 'Antal', name_short: 'stk' }],
        conversions: [],
        groups: [{ id: 5, name: 'Mejeri' }],
        priceByProduct: new Map([['7001', 8], ['7002', 4]]),
        priceDetailByProduct: new Map(),
    };
    const kladde = {
        name: 'ZZT hold', base_servings: 4,
        yield: { amount: 0.5, unit: 'kg' },
        lines: [{ product_id: 7001, amount: 2 }, { product_id: 7002, amount: 3 }],
    };
    const o = await draftLag.computeDraft(kladde, g);

    ok(o.servings === 4, 'kladden har fire portioner');
    ok(nær(o.cost.total, 2 * 8 + 3 * 4), 'kostprisen er hele holdets (28 kr), ikke én portions');
    ok(nær(o.lines.reduce((a, l) => a + (l.cost || 0), 0), o.cost.total),
        'og linjernes kostpriser lægger sammen til den');
    ok(nær(o.co2.total, 2 * 1.2, 1e-9), 'CO₂-totalen er også hele holdets (2,4 kg)');
    ok(nær(o.lines.reduce((a, l) => a + (l.co2e || 0), 0), o.co2.total, 1e-9),
        'linjernes CO₂e lægger sammen til HOLDETS total — ikke til en fjerdedel af den');
    ok(!nær(o.co2.total, o.co2.per_serving),
        'kontrol: hold og portion ER forskellige her — ellers målte asserten ovenfor ingenting');

    const stk = o.lines.find(l => l.product_id === 7002);
    ok(stk && stk.weight_g === null,
        'en vare uden vej til kilo har ukendt vægt — null, ikke 0');
    ok(stk && stk.cost === 12, 'men dens kostpris er kendt — de to slags «ved ikke» er uafhængige');
    ok(o.weight.complete === false && o.weight.missing.includes('Stykvare'),
        'og vægten nævner varen ved navn i stedet for tavst at regne uden den');
    const mælk = o.lines.find(l => l.product_id === 7001);
    ok(mælk && nær(mælk.weight_g, 2000), 'kontrol: den vare der KAN vejes, vejes (2 kg = 2000 g)');
}

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/opskrifter', require('../routes/opskrifter'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const post = (b) => fetch(base + '/api/opskrifter/beregn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

    let r = await post({ name: 'ZZT rute', base_servings: 1, yield: { amount: 1, unit: 'kg' },
        lines: [{ product_id: 1, amount: 0.5 }] });
    let j = await r.json();
    ok(r.status === 200 && j.cost.total > 0, `beregner en kladde over HTTP (${r.status}, ${j.cost && j.cost.total})`);
    ok(j.cost.complete === true && Array.isArray(j.cost.missing), 'svaret bærer complete-flag og manglende-liste');

    r = await post({ name: 'ZZT rute 2', lines: 'ikke et array' });
    ok(r.status === 400, 'en krop uden `lines` afvises med 400, ikke en 500 fra motoren');

    // /editor returnerer PRÆCIS det format /beregn tager imod (§13).
    r = await fetch(base + '/api/opskrifter/110/editor');
    j = await r.json();
    ok(r.status === 200 && j.draft && j.overview, 'editor-tilstand for en gemt opskrift');
    const igen = await post(j.draft);
    const j2 = await igen.json();
    ok(nær(j2.cost.total, j.overview.cost.total),
        'kladden fra /editor kan sendes uændret til /beregn og give samme tal');

    r = await fetch(base + '/api/opskrifter/999999/editor');
    ok(r.status === 404, 'ukendt opskrift → 404');

    srv.close();
}


// ── §9 En ny vare må ikke falde tavst ud af beregningen ────────────
// Nøglen til en ny vare dannes ét sted og slås op et andet. Faldt de fra
// hinanden, forsvandt linjen UDEN en fejl — og totalen blev for lille.
// Det er samme fejlklasse som #305/#319: handlingen ser ud til at lykkes,
// og ingen kan se hvad der mangler.
console.log('\n── §9 En ny vare forsvinder ikke ────────────────────────');
{
    const g = grocyData();
    const nyVare = (navn) => ({ new_product: { name: navn, qu_id_stock: 2 }, amount: 1 });
    const kendt = SNAP.recipes_pos[0].product_id;

    // Uden eksplicit `key` — det almindelige tilfælde fra editoren.
    const efterAndre = await draftLag.computeDraft({
        recipe_id: null, name: 'x', base_servings: 1, yield: {},
        lines: [{ product_id: kendt, amount: 1 }, { product_id: kendt, amount: 1 }, nyVare('Yuzu')],
    }, g);
    ok(efterAndre.lines.length === 3,
       `en ny vare som 3. linje kommer med (fik ${efterAndre.lines.length} af 3)`);
    ok(efterAndre.lines.some(l => l.name === 'Yuzu'), 'og den har sit navn');

    // To nye varer med en kendt imellem — indekserne springer.
    const blandet = await draftLag.computeDraft({
        recipe_id: null, name: 'x', base_servings: 1, yield: {},
        lines: [nyVare('A'), { product_id: kendt, amount: 1 }, nyVare('B')],
    }, g);
    ok(blandet.lines.length === 3, 'to nye varer med en kendt imellem: alle tre med');
    ok(blandet.lines.filter(l => /^[AB]$/.test(l.name)).length === 2, 'begge nye varer er der');

    // Hver ny vare får sit EGET produkt — ellers ville to linjer dele pris.
    const toEgne = await draftLag.computeDraft({
        recipe_id: null, name: 'x', base_servings: 1, yield: {},
        lines: [
            { new_product: { name: 'A', qu_id_stock: 2, price_per_unit: 10 }, amount: 1 },
            { new_product: { name: 'B', qu_id_stock: 2, price_per_unit: 99 }, amount: 1 },
        ],
    }, g);
    const priser = toEgne.lines.map(l => l.cost).sort((a, b) => a - b);
    ok(priser.length === 2 && priser[0] === 10 && priser[1] === 99,
       'to nye varer beholder hver sin pris (' + priser.join(' / ') + ')');

    // En delt `key` er brugerens eget valg — samme vare på to linjer.
    const delt = await draftLag.computeDraft({
        recipe_id: null, name: 'x', base_servings: 1, yield: {},
        lines: [{ new_product: { key: 'n1', name: 'A', qu_id_stock: 2 }, amount: 1 },
                { new_product: { key: 'n1', name: 'A', qu_id_stock: 2 }, amount: 2 }],
    }, g);
    ok(delt.lines.length === 2, 'en delt key giver stadig to LINJER, ikke én');
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('\x1b[31mtesten væltede:\x1b[0m', e); process.exit(1); });
