// scripts/test-consume-policy.js
// ============================================================
// Produktionspolitik på consume-siden (#329).
//
// Issuets to rækker, som kode:
//
//   on_demand (`RR produktion Hurtig`)  → produktet ELLER råvarerne
//   to_stock  (`RR Produktion`)         → KUN produktet, aldrig råvarerne
//
// `to_stock`-rækken er det der låses fast her. Råvarerne bag en planlagt
// vare blev trukket dengang personalet producerede den; trak menuen dem
// igen, ville de være væk to gange i Grocy og én gang i virkeligheden — og
// varen ville aldrig blive trukket, så en reel mangel ville være usynlig.
//
// Hurtig-rækken er bevidst UÆNDRET: er opskriften stadig nestet, trækkes
// dens råvarer som hidtil. Det er også testet, så en senere ændring dér er
// en beslutning og ikke et uheld.
//
// Bruger den RIGTIGE resolver og mocker Grocy-data på adapteren (samme
// mønster som test-recipe-factor.js) — ingen server, ingen Grocy.
//
// Kør:  node --experimental-sqlite scripts/test-consume-policy.js
// ============================================================

'use strict';

const grocy = require('../services/grocyAdapter');
const {
    resolveConsumeItems, productionTypeOf, buildProductionPolicy, recipeGroupOf, HURTIG_GROUP,
} = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const near  = (a, b) => Math.abs(a - b) < 1e-9;

// Kald en assert gennem en wrapper der FANGER: en assert der kaster er et
// dårligere signal end en der fejler rødt (samme lære som #481).
function safe(fn, m) {
    try { check(!!fn(), m); } catch (e) { bad(`${m}  [kastede: ${e.message}]`); }
}

// ── Fixtur ──────────────────────────────────────────────────────────────
//
// Menu 1 "Grisen på Rug" nester TO underopskrifter:
//   · 28 "Langtids stegt Gris"  → produkt 125, gruppe `RR Produktion`  (to_stock)
//   · 13 "Løvstikke Mayo"       → INTET produkt, gruppe Hurtig         (nesting)
// Menu 2 "Falaflen" nester:
//   · 98 "Tahin dressing"       → produkt 300, gruppe Hurtig           (on_demand)
//
// Råvarerne har hver sit id, så det kan aflæses PRÆCIST hvad der blev trukket.
const P = { GRIS_RAA: 200, SALT: 201, MAYO: 202, LOEVSTIKKE: 203, TAHINI: 204,
            BROED: 205, GRIS_PROD: 125, TAHIN_PROD: 300 };

const RECIPES_RAW = new Map([
    [1,  { id: 1,  name: 'Grisen på Rug', base_servings: 1 }],
    [2,  { id: 2,  name: 'Falaflen',      base_servings: 1 }],
    [28, { id: 28, name: 'Langtids stegt Gris', base_servings: 1, product_id: P.GRIS_PROD,
           userfields: { grupper: 'RR Produktion', recipeunit: 'Kilo', recipeunitnumber: '1' } }],
    [13, { id: 13, name: 'Løvstikke Mayo', base_servings: 1,
           userfields: { grupper: 'RR produktion Hurtig' } }],
    [98, { id: 98, name: 'Tahin dressing', base_servings: 1, product_id: P.TAHIN_PROD,
           userfields: { grupper: 'RR produktion Hurtig', recipeunit: 'Kilo', recipeunitnumber: '1' } }],
]);

function install({ grisYield = '1' } = {}) {
    const raw = new Map([...RECIPES_RAW.entries()].map(([k, v]) => [k, { ...v }]));
    raw.get(28).userfields = { ...raw.get(28).userfields, recipeunitnumber: grisYield };

    grocy.getRecipes = async () => [
        { id: 1, name: 'Grisen på Rug', unit_number: 1 },
        { id: 2, name: 'Falaflen',      unit_number: 1 },
    ];
    grocy.getRecipesRawMap = async () => raw;
    grocy.getAllRecipesPos = async () => ([
        { recipe_id: 1,  product_id: P.BROED,      amount: 0.12 },  // direkte på menuen
        { recipe_id: 28, product_id: P.GRIS_RAA,   amount: 1.12 },  // råvarer bag grisen
        { recipe_id: 28, product_id: P.SALT,       amount: 0.01 },
        { recipe_id: 13, product_id: P.MAYO,       amount: 0.30 },  // råvarer bag mayoen
        { recipe_id: 13, product_id: P.LOEVSTIKKE, amount: 0.009 },
        { recipe_id: 98, product_id: P.TAHINI,     amount: 0.50 },  // råvarer bag tahin
    ]);
    grocy.getRecipeNestings = async () => ([
        { recipe_id: 1, includes_recipe_id: 28, servings: 0.25 },
        { recipe_id: 1, includes_recipe_id: 13, servings: 1 },
        { recipe_id: 2, includes_recipe_id: 98, servings: 0.5 },
    ]);
    grocy.getProducts = async () => Object.values(P).map(id => ({
        id, name: `Produkt ${id}`, qu_id_stock: 4, qu_id_purchase: 4,
    }));
    grocy.getQuantityUnitConversions = async () => [];
    grocy.getQuantityUnits = async () => ([{ id: 4, name: 'Kilo', name_short: 'kg' }]);
    return raw;
}

const byPid = (items) => new Map(items.map(i => [i.product_id, i.amount_stock]));

(async () => {

// ══════════════════════════════════════════════════════════════
head('1 · Politikken er én definition, aflæst af gruppen');
// ══════════════════════════════════════════════════════════════
{
    const raw = install();
    safe(() => productionTypeOf(raw.get(28)) === 'to_stock',
        'RR Produktion med et produkt → to_stock');
    safe(() => productionTypeOf(raw.get(98)) === 'on_demand',
        'RR produktion Hurtig med et produkt → on_demand');
    safe(() => productionTypeOf(raw.get(13)) === null,
        'Hurtig UDEN produkt har ingen politik — der er ingen vare at trække');
    safe(() => recipeGroupOf({ userfields: { grupper: '  RR Produktion Hurtig ' } }) === HURTIG_GROUP,
        'gruppenavnet normaliseres (mellemrum, store bogstaver)');

    const pol = buildProductionPolicy(raw);
    safe(() => pol.get(P.GRIS_PROD) === 'to_stock' && pol.get(P.TAHIN_PROD) === 'on_demand',
        'politikken slås op på PRODUKTET, ikke på opskriften');

    // Falaffel har tre producenter i drift. Er bare én af dem Hurtig, kan Bon
    // lave varen — og så er dét muligheden der afgør hvad trækket må gøre.
    const flere = new Map([
        [51, { id: 51, name: 'A', product_id: 900, userfields: { grupper: 'RR Produktion' } }],
        [52, { id: 52, name: 'B', product_id: 900, userfields: { grupper: 'RR produktion Hurtig' } }],
    ]);
    safe(() => buildProductionPolicy(flere).get(900) === 'on_demand',
        'flere producenter: én Hurtig er nok til at varen er on_demand');
}

// ══════════════════════════════════════════════════════════════
head('2 · to_stock: træk VAREN, aldrig dens råvarer');
// ══════════════════════════════════════════════════════════════
{
    install();
    const m = byPid(await resolveConsumeItems([{ grocy_recipe_id: 1, quantity: 10 }]));

    safe(() => near(m.get(P.GRIS_PROD), 2.5),
        'grisen trækkes som VARE: 10 × 0,25 = 2,5 kg');
    safe(() => !m.has(P.GRIS_RAA) && !m.has(P.SALT),
        'og dens råvarer trækkes IKKE — de gik med da personalet stegte den');

    // Kontrolprøven: den nestede Hurtig-blanding er uberørt.
    safe(() => near(m.get(P.MAYO), 3) && near(m.get(P.LOEVSTIKKE), 0.09),
        'Hurtig-blandingen trækker stadig sine råvarer (uændret adfærd)');
    safe(() => near(m.get(P.BROED), 1.2),
        'menuens egne råvarer er urørte');
}

// ══════════════════════════════════════════════════════════════
head('3 · on_demand: uændret — nestet betyder stadig råvarer');
// ══════════════════════════════════════════════════════════════
{
    install();
    const m = byPid(await resolveConsumeItems([{ grocy_recipe_id: 2, quantity: 10 }]));

    safe(() => near(m.get(P.TAHINI), 2.5),
        'tahin-dressingen trækker sine råvarer: 10 × 0,5 × 0,5 = 2,5');
    safe(() => !m.has(P.TAHIN_PROD),
        'og IKKE varen — først når menuen er rewired til en produktlinje');
}

// ══════════════════════════════════════════════════════════════
head('4 · Uden erklæret udbytte gætter vi ikke — vi siger det højt');
// ══════════════════════════════════════════════════════════════
{
    install({ grisYield: '' });          // recipeunitnumber tom → udbytte ukendt
    const warnings = [];
    const real = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    let m;
    try { m = byPid(await resolveConsumeItems([{ grocy_recipe_id: 1, quantity: 10 }])); }
    finally { console.warn = real; }

    safe(() => !m.has(P.GRIS_PROD),
        'uden udbytte kan behovet ikke udtrykkes i varens enhed');
    safe(() => near(m.get(P.GRIS_RAA), 2.8) && near(m.get(P.SALT), 0.025),
        'så vi falder tilbage til råvarerne — et tavst NUL ville gøre '
      + 'råvarelageret for højt uden at nogen kunne se hvorfor');
    safe(() => warnings.some(w => /udbytte|recipeunit/i.test(w)),
        'og det siges højt, med feltet der mangler i Grocy');
}

// ══════════════════════════════════════════════════════════════
head('5 · Vagten gælder også i dybden');
// ══════════════════════════════════════════════════════════════
{
    // Grisen nestes ind i en mellemopskrift, som nestes i menuen. Rekursionen
    // må ikke kunne smutte uden om politikken på vej ned.
    const raw = install();
    raw.set(70, { id: 70, name: 'Grise-topping', base_servings: 1 });
    grocy.getRecipesRawMap = async () => raw;
    grocy.getRecipeNestings = async () => ([
        { recipe_id: 1,  includes_recipe_id: 70, servings: 1 },
        { recipe_id: 70, includes_recipe_id: 28, servings: 0.25 },
    ]);
    const m = byPid(await resolveConsumeItems([{ grocy_recipe_id: 1, quantity: 10 }]));
    safe(() => near(m.get(P.GRIS_PROD), 2.5) && !m.has(P.GRIS_RAA),
        'to_stock i dybde 2 trækker stadig varen, ikke råvarerne');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
