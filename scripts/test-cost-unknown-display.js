// scripts/test-cost-unknown-display.js
// ============================================================
// "Vi ved det ikke" må ikke se ud som et dækningsbidrag.
//
// Syv salgbare varer i drift har ingen kendt råvarepris — bl.a. `Øl alm`,
// `Vand m brus` og `Æblemost`, som vi køber og sælger videre. De viste 100 %
// dækningsbidrag, og det tal så fuldstændig ægte ud i Opskrifter & priser og
// i event-P&L'ens vareforbrug.
//
// Testen dækker tre lag, fordi fejlen kan sidde i hvert af dem:
//   D  klassifikationen  (services/recipeCostRefresh.classifyCachedCost)
//   R  visningen         (office/views/opskrifter.js — kørt i en sandkasse)
//   S  genberegningen    (services/recipeCostRefresh.refreshRecipeCosts)
//
// S er den vigtigste. Knappen "Opdater priser" og det natlige job regnede
// hver sin vej, og knappen skrev Grocys tal tilbage i cachen — så et enkelt
// klik rullede #517 tilbage uden at sige noget.
//
// Kør:  node scripts/test-cost-unknown-display.js
// ============================================================

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('vm');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kostukendt-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const { classifyCachedCost, refreshRecipeCosts } = require('../services/recipeCostRefresh');

// ─── D · klassifikationen ──────────────────────────────────────
console.log('\nD · Hvad betyder rækken i cachen?\n');
{
    const oel = classifyCachedCost({ cost_price_excl_moms: 0, cost_source: 'bon',
                                     missing_prices_json: '["Øl - Pilsner"]' });
    ok(oel.unknown === true, 'øl uden råvarepris: ukendt, ikke 0 kr');
    ok(oel.cost === null, 'og der er ingen kostpris at regne margin af');
    ok(oel.missing[0] === 'Øl - Pilsner', 'hvad der mangler følger med — ellers kan man ikke rette det');

    const intet = classifyCachedCost({ cost_price_excl_moms: 0, cost_source: 'ukendt' });
    ok(intet.unknown === true, 'kilden "ukendt" er nok i sig selv');

    const agurk = classifyCachedCost({ cost_price_excl_moms: 115.41, cost_source: 'bon',
                                       missing_prices_json: '["laurbærblade"]' });
    ok(agurk.unknown === false, 'ét manglende krydderi gør ikke 115 kr ubrugelig');
    ok(agurk.isMinimum === true, 'men tallet er en nedre grænse, ikke en sandhed');
    ok(agurk.cost === 115.41, 'og det vises stadig');

    const hel = classifyCachedCost({ cost_price_excl_moms: 16.74, cost_source: 'bon', missing_prices_json: null });
    ok(hel.unknown === false && hel.isMinimum === false, 'komplet beregning er hverken ukendt eller minimum');

    // En opskrift der lovligt koster 0 (fx en ren 0-kr emballagelinje) må ikke
    // fejlmærkes som ukendt — ellers forsvinder et rigtigt tal fra visningen.
    const gratis = classifyCachedCost({ cost_price_excl_moms: 0, cost_source: 'bon', missing_prices_json: null });
    ok(gratis.unknown === false, 'en komplet beregning der giver 0 kr er stadig et svar');

    ok(classifyCachedCost(null).unknown === false, 'ingen cache-række er ikke det samme som ukendt kostpris');
}

// ─── R · visningen ─────────────────────────────────────────────
console.log('\nR · Hvad står der på skærmen?\n');
{
    // Browserkode kan ikke require'es. Vi kører den rigtige fil i en sandkasse
    // og kalder dens egen rækkefunktion — ikke en kopi af den.
    const src = fs.readFileSync(path.join(__dirname, '..', 'office', 'views', 'opskrifter.js'), 'utf8');
    const ctx = { window: {}, document: { getElementById: () => null }, console, setTimeout, clearTimeout };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const rowHtml = ctx._opsRowHtml;
    ok(typeof rowHtml === 'function', '_opsRowHtml findes i filen');

    const basis = { grocy_recipe_id: 1, name: 'Øl alm', category: 'Drikke', is_active: 1, is_organic: 0,
                    sold_units: 12, revenue_excl_moms: 300, period_buckets: new Array(12).fill(0),
                    co2e_per_unit: 0, co2_total_period: 0, db_target_pct: 30 };

    // Bemærk `db_pct: 100`. Routen nulstiller det allerede, så hvis testen
    // også sendte null, ville den kun bevise routens arbejde og lade rækkens
    // egen spærring være utestet. Her får visningen det farlige tal serveret
    // — som en cachet browser mod en ældre server ville — og skal nægte det.
    const oelHtml = rowHtml({ ...basis, cost_price_excl_moms: 0, sales_price_excl_moms: 25,
        db_kr_excl_moms: 25, db_pct: 100, cost_unknown: true, cost_is_minimum: false,
        cost_missing_prices: ['Øl - Pilsner'], loss_making: false, under_target: false });
    ok(oelHtml.includes('ukendt'), 'øl-rækken siger "ukendt" i kostpris-kolonnen');
    ok(oelHtml.includes('ingen kostpris'), 'og bærer et mærke man kan se uden at læse tal');
    ok(!/100(,0)?\s*%/.test(oelHtml), 'og INTET dækningsbidrag på 100 % — selv når serveren sender et');
    ok(!/>\s*25,00\s*kr/.test(oelHtml), 'og ingen DB i kroner');
    ok(oelHtml.includes('Øl - Pilsner'), 'tooltip navngiver hvad der mangler');

    const agurkHtml = rowHtml({ ...basis, name: 'Agurksalat', cost_price_excl_moms: 115.41,
        sales_price_excl_moms: 150, db_kr_excl_moms: 34.59, db_pct: 23.06,
        cost_unknown: false, cost_is_minimum: true, cost_missing_prices: ['laurbærblade'],
        loss_making: false, under_target: true });
    ok(agurkHtml.includes('delvis kostpris'), 'delvist kendt kostpris mærkes, men skjules ikke');
    ok(agurkHtml.includes('23,1') || agurkHtml.includes('23,06'), 'dækningsbidraget vises stadig');
    ok(agurkHtml.includes('laurbærblade'), 'og det manglende krydderi er navngivet');
    ok(agurkHtml.includes('≤'), 'dækningsbidraget mærkes som et MAKSIMUM — kostprisen er jo et minimum');

    // Driftens værste af slagsen: kun emballagen er prissat, så 99 % ville se
    // fuldstændig ægte ud uden mærket.
    const oelSpecial = rowHtml({ ...basis, name: 'Øl -Special 0,5L', cost_price_excl_moms: 0.5,
        sales_price_excl_moms: 52, db_kr_excl_moms: 51.5, db_pct: 99.04,
        cost_unknown: false, cost_is_minimum: true, cost_missing_prices: ['Øl - Special'],
        loss_making: false, under_target: false });
    ok(oelSpecial.includes('≤'), 'Øl -Special: 99 % står som "højst 99 %", ikke som en kendsgerning');
    ok(oelSpecial.includes('delvis kostpris'), 'og rækken bærer mærket');

    // En produktionsopskrift har ingen salgspris — så er der intet
    // dækningsbidrag at sætte en øvre grænse på. "≤ —" siger ingenting.
    const udenSalg = rowHtml({ ...basis, name: 'Yoghurt dressing', cost_price_excl_moms: 10.38,
        sales_price_excl_moms: null, db_kr_excl_moms: null, db_pct: null,
        cost_unknown: false, cost_is_minimum: true, cost_missing_prices: ['vegansk yoghurt'],
        loss_making: false, under_target: false });
    ok(!udenSalg.includes('≤'), 'ingen salgspris → intet maks-mærke');
    ok(udenSalg.includes('delvis kostpris'), 'men kostprisen er stadig mærket som delvis');

    // Drill-down-panelet skal sige det SAMME som rækken det åbnes fra. Fanget
    // ved at klikke: panelet skrev "Kostpris i alt 0,00 kr" om en Æblemost,
    // mens rækken bag det sagde "ukendt". To svar på ét spørgsmål.
    const comp = ctx._opsCompBodyHtml;
    ok(typeof comp === 'function', '_opsCompBodyHtml findes');
    const basisPanel = { name: 'x', category: 'Drikke', unit: 'stk', base_servings: 1,
                         ingredients: [], sub_recipes: [] };

    const pUkendt = comp({ ...basisPanel, name: 'Æblemost', total_cost: 0,
        total_cost_source: 'bon', total_cost_missing: ['Æblemost'],
        ingredients: [{ product_id: 20, name: 'Æblemost', amount: 1, unit: 'Antal', cost: null }] });
    ok(pUkendt.includes('ukendt'), 'panelet siger "ukendt", ikke 0,00 kr');
    ok(/Ingen pris registreret/.test(pUkendt), 'og forklarer hvorfor');
    ok(pUkendt.includes('Æblemost'), 'med navn på det der mangler');

    const pMin = comp({ ...basisPanel, name: 'Æggesalaten slider', total_cost: 8.6,
        total_cost_source: 'bon', total_cost_missing: ['gurkemeje', 'karry'],
        ingredients: [{ product_id: 1, name: 'Æg', amount: 50, unit: 'g', cost: 8.6 }] });
    ok(pMin.includes('mindst'), 'delvis kendt total mærkes "mindst"');
    ok(pMin.includes('gurkemeje'), 'og navngiver de manglende');
    ok(!pMin.includes('ukendt'), 'men skjuler ikke tallet');

    // Forældre-varen `kål` har ingen egen pris; totalen bruger gennemsnittet af
    // Spidskål og Hvidkål. Stod linjen som "—" mens totalen indeholdt 9,63 kr,
    // så det ud som om husets største linje var gratis.
    const pArvet = comp({ ...basisPanel, name: 'Frisk Grønt', total_cost: 21.02,
        total_cost_source: 'bon', total_cost_missing: [],
        ingredients: [
            { product_id: 28, name: 'Spinat', amount: 100, unit: 'g', cost: 7.80 },
            { product_id: 199, name: 'kål', amount: 500, unit: 'g', cost: 9.63, cost_inherited: true },
            { product_id: 33, name: 'Rødkål - Rå', amount: 400, unit: 'g', cost: 3.60 },
        ] });
    ok(pArvet.includes('9,63'), 'kål har en pris på linjen, ikke "—"');
    ok(pArvet.includes('ops-inherited'), 'og linjen selv bærer arve-mærket (ikke bare fodnoten)');
    ok(/gennemsnit af en forældre-vares/.test(pArvet), 'med en forklaring under tabellen');

    const pHel = comp({ ...basisPanel, name: 'Kartoflen - Salat', total_cost: 16.74,
        total_cost_source: 'bon', total_cost_missing: [],
        ingredients: [{ product_id: 1, name: 'Spidskål', amount: 160, unit: 'g', cost: 3.84 }] });
    ok(pHel.includes('16,74') && !pHel.includes('ukendt') && !pHel.includes('mindst') && !pHel.includes('~'),
       'komplet total står uden forbehold');

    const helHtml = rowHtml({ ...basis, name: 'Kartoflen - Salat', cost_price_excl_moms: 16.74,
        sales_price_excl_moms: 70.4, db_kr_excl_moms: 53.66, db_pct: 76.2,
        cost_unknown: false, cost_is_minimum: false, cost_missing_prices: [],
        loss_making: false, under_target: false });
    ok(!helHtml.includes('ukendt') && !helHtml.includes('delvis kostpris') && !helHtml.includes('≤'),
       'en komplet række bærer ingen forbehold');
}

// ─── A · arve-reglen ───────────────────────────────────────────
console.log('\nA · Forældre-vare uden egen pris\n');
{
    const { parentPriceFromChildren } = require('../services/recipeCost');
    const produkter = [
        { id: 199, name: 'kål' },
        { id: 27, name: 'Spidskål', parent_product_id: 199 },
        { id: 67, name: 'Hvidkål', parent_product_id: 199 },
        { id: 50, name: 'Enlig far' },
        { id: 51, name: 'Barn uden pris', parent_product_id: 50 },
    ];
    const pris = { '27': 24, '67': 14.5 };
    const slaaOp = id => pris[id] ?? null;

    ok(parentPriceFromChildren(produkter, 199, slaaOp) === 19.25,
       'kål arver 19,25 — gennemsnittet af Spidskål 24,00 og Hvidkål 14,50');
    ok(parentPriceFromChildren(produkter, 50, slaaOp) === null,
       'ingen børn med pris → null, ikke 0 (0 ville se ud som gratis)');
    ok(parentPriceFromChildren(produkter, 27, slaaOp) === null,
       'en vare uden børn arver ikke noget');
    // Kun børn MED pris tæller — ellers ville et prisløst barn trække snittet ned.
    const blandet = [...produkter, { id: 68, name: 'Grønkål', parent_product_id: 199 }];
    ok(parentPriceFromChildren(blandet, 199, slaaOp) === 19.25,
       'et barn uden pris trækker ikke gennemsnittet ned');
}

// ─── S · genberegningen ────────────────────────────────────────
console.log('\nS · Skriver knappen og natjobbet det samme?\n');
(async () => {
    const { getDb } = require('../db/database');
    const db = getDb();
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('default_grocy_location_id','1')`).run();
    db.prepare(`UPDATE locations SET grocy_api_url='https://eksempel/api', grocy_api_key='n' WHERE id=1`).run();
    db.prepare(`DELETE FROM recipe_cost_cache`).run();

    // Én rigtig vare (Spidskål, 24 kr/kg) og én uden pris (øl).
    const SVAR = {
        '/objects/recipes': [
            { id: 1, name: 'Kålsalat', base_servings: 1, desired_servings: 4,
              userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
            { id: 2, name: 'Øl alm', base_servings: 1,
              userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
        ],
        '/objects/recipes_pos': [
            { id: 1, recipe_id: 1, product_id: 10, amount: 0.5, qu_id: 1 },
            { id: 2, recipe_id: 2, product_id: 20, amount: 1, qu_id: 2 },
        ],
        '/objects/recipes_nestings': [],
        '/objects/products': [
            { id: 10, name: 'Spidskål', qu_id_stock: 1, qu_id_purchase: 1 },
            { id: 20, name: 'Øl - Pilsner', qu_id_stock: 2, qu_id_purchase: 2 },
        ],
        '/objects/quantity_units': [{ id: 1, name: 'Kilo' }, { id: 2, name: 'Antal' }],
        '/objects/quantity_unit_conversions': [],
        // Grocys eget tal er 4× for højt (desired_servings) — hvis det skriges
        // ind i cachen igen, fanger asserten det.
        '/recipes/fulfillment': [{ recipe_id: 1, costs: 48 }, { recipe_id: 2, costs: 0 }],
        '/objects/stock': [{ product_id: 10, amount: 5, price: 24, purchased_date: '2026-08-05' }],
    };
    globalThis.fetch = async (url) => {
        // Stien matches EKSAKT (uden query). `includes` ville lade
        // `/objects/recipes_pos` matche `/objects/recipes` og returnere
        // opskrifterne som ingredienser — en stub der lyver om sig selv.
        const sti = String(url).split('?')[0];
        const n = Object.keys(SVAR).find(k => sti.endsWith(k));
        if (n) return { ok: true, status: 200, json: async () => SVAR[n] };
        // Enkeltopslag for varer uden lager: øllen har ingen prishistorik.
        if (/\/stock\/products\/\d+$/.test(sti)) return { ok: true, status: 200, json: async () => ({}) };
        throw new Error('uventet kald: ' + url);
    };

    const out = await refreshRecipeCosts(db);
    const raekker = db.prepare(`SELECT * FROM recipe_cost_cache ORDER BY grocy_recipe_id`).all();
    const kaal = raekker.find(r => r.grocy_recipe_id === 1) || {};
    const oel = raekker.find(r => r.grocy_recipe_id === 2) || {};

    ok(Math.abs(kaal.cost_price_excl_moms - 12) < 0.005,
       `0,5 kg × 24 = 12 kr — ikke Grocys 48 (fik ${kaal.cost_price_excl_moms})`);
    ok(kaal.cost_source === 'bon', 'og kilden er "bon", ikke "grocy"');
    ok(!kaal.missing_prices_json, 'intet mangler på den');

    ok(oel.cost_price_excl_moms === 0, 'øllen kan ikke prissættes');
    ok(oel.missing_prices_json && JSON.parse(oel.missing_prices_json).includes('Øl - Pilsner'),
       'og den manglende vare skrives ned, så visningen kan sige hvad der mangler');
    ok(classifyCachedCost(oel).unknown === true, 'hele vejen igennem: øllen ender som "ukendt"');

    ok(out.sources?.bon >= 1, 'kvitteringen tæller kilderne, så en tilbagerulning ville kunne ses');
    ok(out.incomplete === 1, 'og hvor mange der mangler en pris');

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})();
