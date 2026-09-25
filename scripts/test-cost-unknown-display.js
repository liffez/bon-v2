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

    // ── Advarsler (#557/#558): prisen ER kendt, den ser bare forkert ud ──
    // Den vigtige assert er den negative: en advaret række må IKKE arve
    // "delvis kostpris" eller "≤". Så ville et komplet tal blive fremstillet
    // som et minimum, og det er en anden — og forkert — besked.
    const advaret = rowHtml({ ...basis, name: 'Fisken', cost_price_excl_moms: 30.35,
        sales_price_excl_moms: 94, db_kr_excl_moms: 63.65, db_pct: 67.7,
        cost_unknown: false, cost_is_minimum: false, cost_missing_prices: [],
        cost_price_warnings: [{ kind: 'produced_stock_price_differs', product: 'Remoulade',
            text: 'Remoulade: lagerprisen 43,47 kr afviger -38 % fra hvad opskriften koster at lave (70,15 kr). Opskriften er brugt.' }],
        loss_making: false, under_target: false });
    ok(advaret.includes('pris?'), 'en advaret række bærer et mærke');
    ok(advaret.includes('Remoulade'), 'og tooltip navngiver varen');
    ok(advaret.includes('>30 kr<'), 'kostprisen vises som det komplette tal den er');
    ok(!advaret.includes('delvis kostpris') && !advaret.includes('≤') && !advaret.includes('ukendt'),
       'og den arver IKKE forbeholdene fra "mangler pris"');

    const toAdvarsler = rowHtml({ ...basis, name: 'Grisen', cost_price_excl_moms: 12,
        sales_price_excl_moms: 94, db_kr_excl_moms: 82, db_pct: 87,
        cost_unknown: false, cost_is_minimum: false, cost_missing_prices: [],
        cost_price_warnings: [{ product: 'A', text: 'A: …' }, { product: 'B', text: 'B: …' }],
        loss_making: false, under_target: false });
    ok(toAdvarsler.includes('pris? 2'), 'flere advarsler tælles på mærket');

    // En klient mod en ældre server får ingen `text`. "undefined" i en tooltip
    // er værre end en generisk sætning.
    const udenTekst = rowHtml({ ...basis, name: 'Uden tekst', cost_price_excl_moms: 12,
        sales_price_excl_moms: 94, db_kr_excl_moms: 82, db_pct: 87,
        cost_unknown: false, cost_is_minimum: false, cost_missing_prices: [],
        cost_price_warnings: [{ kind: 'last_vs_avg', product: 'Mayonaise' }],
        loss_making: false, under_target: false });
    ok(!udenTekst.includes('undefined'), 'en advarsel uden tekst viser ikke "undefined"');
    ok(udenTekst.includes('Mayonaise'), 'men navngiver stadig varen');

    const pAdvaret = comp({ ...basisPanel, name: 'Fisken', total_cost: 30.35,
        total_cost_source: 'bon', total_cost_missing: [],
        total_cost_warnings: [{ product: 'Remoulade', text: 'Remoulade: lagerprisen afviger.' }],
        ingredients: [{ product_id: 20, name: 'Remoulade', amount: 350, unit: 'g', cost: 24.5 }] });
    ok(pAdvaret.includes('Remoulade: lagerprisen afviger.'), 'panelet forklarer advarslen');
    ok(!pAdvaret.includes('mindst') && !pAdvaret.includes('ukendt'),
       'og totalen står uden forbehold — den er komplet');
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
            // Produceret gode + retten der bruger det (#558).
            { id: 3, name: 'Remoulade', base_servings: 1, product_id: 30,
              userfields: { recipeunit: 'kg', recipeunitnumber: '1' } },
            { id: 4, name: 'Fisken', base_servings: 1,
              userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
            // Forælder-vare: `kål` har ingen egen pris — kun børnene har.
            { id: 5, name: 'Kålblanding', base_servings: 1,
              userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
        ],
        '/objects/recipes_pos': [
            { id: 1, recipe_id: 1, product_id: 10, amount: 0.5, qu_id: 1 },
            { id: 2, recipe_id: 2, product_id: 20, amount: 1, qu_id: 2 },
            { id: 3, recipe_id: 3, product_id: 40, amount: 1, qu_id: 1 },
            { id: 4, recipe_id: 4, product_id: 30, amount: 1, qu_id: 1 },
            { id: 5, recipe_id: 5, product_id: 50, amount: 2, qu_id: 1 },
        ],
        '/objects/recipes_nestings': [],
        '/objects/products': [
            { id: 10, name: 'Spidskål', qu_id_stock: 1, qu_id_purchase: 1 },
            { id: 20, name: 'Øl - Pilsner', qu_id_stock: 2, qu_id_purchase: 2 },
            { id: 30, name: 'Remoulade', qu_id_stock: 1, qu_id_purchase: 1 },
            { id: 40, name: 'Mayonaise', qu_id_stock: 1, qu_id_purchase: 1 },
            // Grocy ruller børnenes LAGER op på forælderen, men ikke deres pris.
            { id: 50, name: 'kål', qu_id_stock: 1, qu_id_purchase: 1 },
            { id: 51, name: 'Spidskål-barn', parent_product_id: 50, qu_id_stock: 1, qu_id_purchase: 1 },
            { id: 52, name: 'Hvidkål-barn',  parent_product_id: 50, qu_id_stock: 1, qu_id_purchase: 1 },
        ],
        '/objects/quantity_units': [{ id: 1, name: 'Kilo' }, { id: 2, name: 'Antal' }],
        '/objects/quantity_unit_conversions': [],
        // Grocys eget tal er 4× for højt (desired_servings) — hvis det skriges
        // ind i cachen igen, fanger asserten det.
        '/recipes/fulfillment': [{ recipe_id: 1, costs: 48 }, { recipe_id: 2, costs: 0 }],
        // En lagerpost bærer prisen på DET køb — altså seneste køb, 40. Bruges
        // den som kilde (den gamle bulk-genvej), koster kålsalaten 20 i stedet
        // for 12, og asserten nedenfor fanger det.
        '/objects/stock': [{ product_id: 10, amount: 5, price: 40, purchased_date: '2026-08-05' }],
    };
    // Købshistorikken er kilden efter #557: et mængdevægtet snit over de
    // seneste 90 dage. Spidskål er købt 4 kg til 20 og senest 1 kg til 40 —
    // snittet er 24, og nødkøbet ligger 67 % derfra, så det advares der om
    // uden at flytte prisen.
    //
    // Datoerne regnes ud fra i dag. En fast dato ville rådne: testen ville
    // bestå i dag og tavst begynde at måle fallback-grenen om tre måneder.
    const { offsetISO } = require('../db/helpers');
    //
    // Den første postering ligger UDEN FOR vinduet og er af den slags Grocy
    // nægter at fortryde (Chilli Pulver-typen, prisen ganget med tusind). Den
    // ligger her med vilje: glemmer adapteren at sende vinduets startdato med,
    // koster kålsalaten 404 kr i stedet for 12, og asserten nedenfor fanger det.
    const KOEB = {
        10: [
            { price: 40000, amount: 0.1, purchased_date: offsetISO(-200) },
            { price: 20,    amount: 4,   purchased_date: offsetISO(-40)  },
            { price: 40,    amount: 1,   purchased_date: offsetISO(-5)   },
        ],
        51: [{ price: 24, amount: 1, purchased_date: offsetISO(-10) }],
        52: [{ price: 14, amount: 1, purchased_date: offsetISO(-10) }],
    };
    // Varer uden købshistorik falder tilbage på Grocys egne tal (trin 3).
    // Remoulade bærer en pris på 60 som er et optællings-artefakt, mens
    // opskriften koster 100.
    const PRODUKT_PRIS = {
        20: {},                                   // øllen har ingen prishistorik
        30: { last_price: 60, avg_price: 60 },
        40: { last_price: 100, avg_price: 100 },
    };
    // Gemmes FØR stubben, så HTTP-kaldet til vores egen route nedenfor ikke
    // også løber ind i Grocy-attrappen.
    function logRaekker() {
        // Det samlede opslag (#695): alle tilgange, ikke ét kald pr. produkt.
        let id = 1;
        const ud = [];
        for (const [pid, rows] of Object.entries(KOEB)) {
            for (const r of rows) ud.push({ id: id++, product_id: Number(pid), transaction_type: 'purchase', undone: 0, ...r });
        }
        // Trin 3 for varer uden køb: den nyeste tilgang med pris (optælling).
        for (const [pid, g] of Object.entries(PRODUKT_PRIS)) {
            if (g.last_price > 0) ud.push({ id: 1000 + Number(pid), product_id: Number(pid),
                transaction_type: 'inventory-correction', undone: 0, amount: 1, price: g.last_price,
                purchased_date: offsetISO(-3) });
        }
        return ud.sort((a, b) => b.id - a.id);
    }
    const logOpslag = [];
    const rigtigFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        // Stien matches EKSAKT (uden query). `includes` ville lade
        // `/objects/recipes_pos` matche `/objects/recipes` og returnere
        // opskrifterne som ingredienser — en stub der lyver om sig selv.
        const sti = String(url).split('?')[0];
        // Købsposteringerne spørges pr. produkt, så produkt-id'et står i
        // query'en og ikke i stien.
        if (sti.endsWith('/objects/stock_log')) {
            logOpslag.push(String(url));
            return { ok: true, status: 200, json: async () => logRaekker() };
        }
        const n = Object.keys(SVAR).find(k => sti.endsWith(k));
        if (n) return { ok: true, status: 200, json: async () => SVAR[n] };
        // `/stock/products/:id` spørges ikke længere (#695) — trin 3 læser loggen.
        if (/\/stock\/products\/\d+$/.test(sti)) throw new Error('uventet enkeltopslag: ' + url);
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

    // ── #557: gennemsnittet er ankeret, hele vejen til cachen ──
    // Havde seneste køb vundet, ville kålsalaten koste 0,5 × 40 = 20 kr.
    // Asserten på 12 kr ovenfor er altså også testen af prisreglen.
    const kaalAdv = kaal.price_warnings_json ? JSON.parse(kaal.price_warnings_json) : [];
    ok(kaalAdv.some(w => w.kind === 'last_vs_avg' && String(w.product_id) === '10'),
       'enkeltkøbet langt fra gennemsnittet skrives ned som en advarsel');
    ok(classifyCachedCost(kaal).warnings.length === 1,
       'og visningen kan læse den');
    ok(classifyCachedCost(kaal).isMinimum === false && classifyCachedCost(kaal).unknown === false,
       'en advarsel gør hverken kostprisen ukendt eller til et minimum');

    // ── #558: lagerprisen på et produceret gode taber til opskriften ──
    const fisken = raekker.find(r => r.grocy_recipe_id === 4) || {};
    ok(Math.abs(fisken.cost_price_excl_moms - 100) < 0.005,
       `opskriftens 100 kr bruges, ikke lagerprisens 60 (fik ${fisken.cost_price_excl_moms})`);
    const fiskAdv = fisken.price_warnings_json ? JSON.parse(fisken.price_warnings_json) : [];
    ok(fiskAdv.some(w => w.kind === 'produced_stock_price_differs' && String(w.product_id) === '30'),
       'og afvigelsen står i cachen, så den kan ses i Opskrifter & priser');
    ok(!fisken.missing_prices_json, 'uden at retten markeres som manglende pris');
    ok(out.warned >= 2, 'kvitteringen tæller de opskrifter der bør ses efter');

    // ── Når routen ikke sender feltet, ser skærmen det aldrig ──
    // Rækkevisningen ovenfor får `cost_price_warnings` serveret. Uden det her
    // kunne `/overview` holde op med at sende det, og ingen test ville sige fra.
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
    app.use('/api/recipes', require('../routes/recipes_overview'));
    const srv = app.listen(0);
    await new Promise(r => srv.once('listening', r));
    const svar = await (await rigtigFetch(`http://127.0.0.1:${srv.address().port}/api/recipes/overview`)).json();
    srv.close();

    // ── Drill-downet skal vise SAMME pris som rækken man klikkede på ──
    // Panelet udledte tidligere prisen selv ud af Grocys råsvar. Gjorde det
    // dét igen, ville det vise seneste køb (40) mens rækken viser 90-dages
    // snittet (24) — og så ved man ikke hvilket tal der gælder.
    const srv2 = app.listen(0);
    await new Promise(r => srv2.once('listening', r));
    const panel = await (await rigtigFetch(
        `http://127.0.0.1:${srv2.address().port}/api/recipes/1/composition`)).json();
    srv2.close();
    const spidskaal = (panel.ingredients || []).find(i => String(i.product_id) === '10') || {};
    ok(Math.abs(spidskaal.cost - 12) < 0.005,
       `panelet regner med snittet 24, ikke seneste køb 40 (fik ${spidskaal.cost})`);
    ok(Math.abs((panel.total_cost ?? 0) - 12) < 0.005,
       'og totalen i panelet er den samme som rækkens');

    // Forælderen `kål` har ingen egen pris; den arver gennemsnittet af børnene
    // (24 og 14 → 19). Uden arven ville linjen stå som "—" i panelet mens den
    // indgik i totalen — præcis dét den gamle børne-hentning i routen løste.
    logOpslag.length = 0;
    const srv3 = app.listen(0);
    await new Promise(r => srv3.once('listening', r));
    const panel5 = await (await rigtigFetch(
        `http://127.0.0.1:${srv3.address().port}/api/recipes/5/composition`)).json();
    srv3.close();
    const kaalLinje = (panel5.ingredients || []).find(i => String(i.product_id) === '50') || {};
    ok(Math.abs(kaalLinje.cost - 38) < 0.005,
       `forælderen arver børnenes snit 19 × 2 kg = 38 (fik ${kaalLinje.cost})`);
    ok(kaalLinje.cost_inherited === true, 'og panelet siger at prisen er arvet');
    ok(logOpslag.length === 1,
       `klik-stien spørger loggen ÉN gang — ikke pr. vare (${logOpslag.length} opslag)`);

    const rk = (svar.recipes || []).find(x => x.grocy_recipe_id === 4) || {};
    const adv = rk.cost_price_warnings || [];
    const remAdv = adv.find(w => w.kind === 'produced_stock_price_differs');
    ok(remAdv && remAdv.product_id === '30', 'routen sender advarslen med ud til skærmen');
    ok(/Remoulade/.test(remAdv?.text || ''), 'færdigformuleret af serveren, så alle flader siger det samme');
    // #695: Mayonaisens pris kommer fra en optælling, ikke et køb. Den bruges,
    // men den skal kunne ses — ellers står et tastet tal som en betalt pris.
    const mayoAdv = adv.find(w => w.kind === 'price_not_purchased');
    ok(mayoAdv && mayoAdv.product_id === '40' && /lagerrettelse/.test(mayoAdv.text || ''),
       'en pris fra en lagerrettelse bruges, men mærkes: ' + (mayoAdv?.text || '(ingen advarsel)'));
    ok(adv.length === 2, `og der er ikke andre advarsler på opskriften (fik ${adv.length})`);
    ok((svar.summary?.price_warning_count ?? 0) >= 2, 'og tæller dem i opsummeringen');
    ok(rk.cost_is_minimum === false && rk.cost_unknown === false,
       'uden at rækken markeres som ufuldstændig');

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})();
