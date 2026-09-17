// scripts/test-kostpris-vindue.js
// ============================================================
// Kostpris-vinduet er en INDSTILLING, ikke en konstant (#557).
//
// 90 dage er et forsøg: alle de forkerte posteringer i Grocy er fra 2024, så
// vinduet holder dem ude — men kun 16 af 156 varer rammer overhovedet snittet,
// og det rigtige tal kendes først når man har set effekten. Derfor kan det
// ændres, og derfor ligger feltet i ⚙-popoveren inde i Opskrifter & priser:
// dér virkningen kan ses, ikke i den globale settings-liste hvor det ville
// blive glemt.
//
// Det testen skal fange:
//   · at indstillingen faktisk BESTEMMER prisen — ikke bare bliver gemt
//   · at cachen er nøglet på vinduet (ellers serveres de gamle tal i ti
//     minutter, og indstillingen ligner noget der ikke virker)
//   · at en gemt advarsel siger hvilket vindue den blev regnet under
//   · at vrøvl ikke kan slå kostprisen ihjel
//
// Kør:  node scripts/test-kostpris-vindue.js
// ============================================================

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Isoleret DB bygget af de RIGTIGE migrationer — så testen også beviser at
// migration 176 seeder indstillingen. Et håndskrevet skema ville bestå selv
// hvis migrationen manglede.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vindue-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { getDb } = require('../db/database');
const db = getDb();
db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('default_grocy_location_id','1')`).run();
db.prepare(`UPDATE locations SET grocy_api_url='https://eksempel/api', grocy_api_key='n' WHERE id=1`).run();

const vm = require('vm');
const {
    unitCostDetail, describeWarning, clampWindowDays,
    PRICE_WINDOW_DAYS_DEFAULT, MIN_PRICE_WINDOW_DAYS, MAX_PRICE_WINDOW_DAYS,
} = require('../services/recipeCost');
const { offsetISO, getRecipeCostWindowDays, invalidateRecipeCostWindowCache } = require('../db/helpers');
const grocy = require('../services/grocyAdapter');

let pass = 0, fail = 0;
function ok(cond, msg) {
    // Kalderne bruger optional chaining: en assert der KASTER er et dårligere
    // signal end en der fejler — mutationen ligner så et brudt testscript.
    if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
    else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
const near = (a, b, e = 0.005) => Number.isFinite(Number(a)) && Math.abs(Number(a) - b) < e;
const kob = (price, amount, date) => ({ price, amount, purchased_date: date });

const sætVindue = v => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('recipe_cost_price_window_days', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v));
    invalidateRecipeCostWindowCache();
};

// ══ 1 · Vinduet er et tal med grænser ════════════════════════
console.log('\nV1 · clampWindowDays — ét sted, så tal og visning ikke kan skride fra hinanden');
{
    ok(clampWindowDays(180) === 180, 'et gyldigt tal går uændret igennem');
    ok(clampWindowDays(1) === MIN_PRICE_WINDOW_DAYS, 'under minimum klampes op — en dag er ikke et snit');
    ok(clampWindowDays(99999) === MAX_PRICE_WINDOW_DAYS, 'over maksimum klampes ned');
    ok(clampWindowDays('180') === 180, 'en streng fra et formularfelt tolkes som tal');
    ok(clampWindowDays(90.6) === 91, 'decimaler rundes — dage er hele');
    ok(clampWindowDays('vrøvl') === PRICE_WINDOW_DAYS_DEFAULT, 'vrøvl falder tilbage på defaulten');
    ok(clampWindowDays(null) === PRICE_WINDOW_DAYS_DEFAULT, 'og det samme gør ingenting');
    ok(MIN_PRICE_WINDOW_DAYS < PRICE_WINDOW_DAYS_DEFAULT && PRICE_WINDOW_DAYS_DEFAULT < MAX_PRICE_WINDOW_DAYS,
       'defaulten ligger inden for sine egne grænser');
}

// ══ 2 · Advarslen bærer sit eget vindue ══════════════════════
console.log('\nV2 · En gemt advarsel siger hvilket vindue den blev regnet under');
{
    const d = unitCostDetail(null, [kob(100, 1, offsetISO(-10)), kob(50, 9, offsetISO(-5))],
                             { since: offsetISO(-90), windowDays: 90 });
    ok(d?.window_days === 90, 'vinduet følger med ud af beregningen');

    const d2 = unitCostDetail(null, [kob(100, 1, offsetISO(-10))], { since: offsetISO(-180), windowDays: 180 });
    ok(d2?.window_days === 180, 'og det er DET vindue der blev brugt, ikke defaulten');

    // Teksten skal sige 180 når advarslen blev regnet over 180 — ellers lyver
    // en gemt advarsel efter at indstillingen er ændret.
    const tekst = describeWarning({ kind: 'last_vs_avg', product: 'Mayo',
                                    last_price: 42, avg_price: 114, deviation_pct: -63, window_days: 180 });
    ok(tekst.includes('180-dages'), 'advarslens tekst bruger advarslens eget vindue');
    ok(!tekst.includes('90-dages'), 'og ikke defaulten');

    const gammel = describeWarning({ kind: 'last_vs_avg', product: 'Mayo',
                                     last_price: 42, avg_price: 114, deviation_pct: -63 });
    ok(gammel.includes(`${PRICE_WINDOW_DAYS_DEFAULT}-dages`),
       'en advarsel fra før feltet fandtes falder tilbage på defaulten frem for at sige "undefined"');
}

// ══ 3 · Helperen læser indstillingen ═════════════════════════
console.log('\nV3 · Indstillingen læses fra databasen, og vrøvl kan ikke vælte den');
{
    invalidateRecipeCostWindowCache();
    ok(getRecipeCostWindowDays() === PRICE_WINDOW_DAYS_DEFAULT,
       `migration 176 seeder ${PRICE_WINDOW_DAYS_DEFAULT} dage`);

    sætVindue(180);
    ok(getRecipeCostWindowDays() === 180, 'en ændret værdi slår igennem');

    sætVindue(99999);
    ok(getRecipeCostWindowDays() === MAX_PRICE_WINDOW_DAYS, 'en urimelig værdi klampes, ikke bruges råt');

    sætVindue('ikke et tal');
    ok(getRecipeCostWindowDays() === PRICE_WINDOW_DAYS_DEFAULT,
       'vrøvl i settings giver defaulten — kostprisen må ikke kunne slås ihjel af et tastefejl');

    db.prepare(`UPDATE settings SET value='' WHERE key='recipe_cost_price_window_days'`).run();
    invalidateRecipeCostWindowCache();
    ok(getRecipeCostWindowDays() === PRICE_WINDOW_DAYS_DEFAULT, 'og det samme gør en tom værdi');

    // Cachen: uden rydningen ville en ændring først gælde om et minut, og
    // popoveren ville se ud som om den ikke gemte.
    sætVindue(120);
    ok(getRecipeCostWindowDays() === 120, 'rydningen får ændringen til at gælde straks');
    db.prepare(`UPDATE settings SET value='45' WHERE key='recipe_cost_price_window_days'`).run();
    ok(getRecipeCostWindowDays() === 120, 'uden rydning holder cachen på den kendte værdi (60s)');
    invalidateRecipeCostWindowCache();
    ok(getRecipeCostWindowDays() === 45, 'og slipper den efter rydning');
}

// ══ 4 + 5 · Adapteren og routen ══════════════════════════════
(async () => {
    // Spidskål: ét køb for 200 dage siden (uden for begge vinduer — den slags
    // Grocy nægter at fortryde), ét for 120 dage siden (kun inde i det LANGE
    // vindue) og ét for 10 dage siden. De tre gør de to vinduer målbart
    // forskellige: 90 dage → 40 kr, 180 dage → 25 kr.
    const KOEB = {
        10: [
            { price: 4000, amount: 0.1, purchased_date: offsetISO(-200) },
            { price: 20,   amount: 3,   purchased_date: offsetISO(-120) },
            { price: 40,   amount: 1,   purchased_date: offsetISO(-10)  },
        ],
    };
    const SVAR = {
        '/objects/recipes': [
            { id: 1, name: 'Kålsalat', base_servings: 1,
              userfields: { sellable: '1', recipeunit: 'antal', recipeunitnumber: '1' } },
        ],
        '/objects/recipes_pos': [{ id: 1, recipe_id: 1, product_id: 10, amount: 1, qu_id: 1 }],
        '/objects/recipes_nestings': [],
        '/objects/products': [{ id: 10, name: 'Spidskål', qu_id_stock: 1, qu_id_purchase: 1 }],
        '/objects/quantity_units': [{ id: 1, name: 'Kilo' }],
        '/objects/quantity_unit_conversions': [],
        '/recipes/fulfillment': [{ recipe_id: 1, costs: 999 }],
        '/objects/stock': [],
        '/objects/stock_entries': [],
    };

    const rigtigFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const sti = String(url).split('?')[0];
        if (sti.endsWith('/objects/stock_log')) {
            const q = decodeURIComponent(String(url)).match(/product_id=(\d+)/);
            return { ok: true, status: 200, json: async () => (q ? KOEB[q[1]] : null) || [] };
        }
        const n = Object.keys(SVAR).find(k => sti.endsWith(k));
        if (n) return { ok: true, status: 200, json: async () => SVAR[n] };
        const pm = sti.match(/\/stock\/products\/(\d+)$/);
        if (pm) return { ok: true, status: 200, json: async () => ({}) };
        throw new Error('uventet kald: ' + url);
    };

    console.log('\nV4 · Indstillingen BESTEMMER prisen — den bliver ikke bare gemt');
    {
        sætVindue(90);
        grocy.clearCache();
        const d90 = await grocy.getProductUnitCostDetails(4);
        ok(near(d90.get('10')?.cost, 40),
           `90 dage: kun købet for 10 dage siden er med → 40 kr (fik ${d90.get('10')?.cost})`);
        ok(d90.get('10')?.window_days === 90, 'og detaljen siger hvilket vindue den blev regnet under');

        // Cache-nøglen. Uden vinduet i nøglen ville næste linje give 40 igen —
        // i op til ti minutter — og indstillingen ligne noget der ikke virkede.
        sætVindue(180);
        const d180 = await grocy.getProductUnitCostDetails(4);
        ok(near(d180.get('10')?.cost, 25),
           `180 dage: også købet for 120 dage siden tæller → (3×20 + 1×40)/4 = 25 kr (fik ${d180.get('10')?.cost})`);
        ok(d180.get('10')?.window_days === 180, 'detaljen følger med over på det nye vindue');

        // Den giftige postering fra "2024" må ikke komme ind ad bagvejen, heller
        // ikke når man skruer vinduet op til maksimum.
        sætVindue(MAX_PRICE_WINDOW_DAYS);
        const dMax = await grocy.getProductUnitCostDetails(4);
        ok((dMax.get('10')?.cost || 0) > 100,
           'et vindue på tre år lukker 2024-posteringen ind igen — det er dét vinduet er til for');

        // Tilbage til 90: cachen fra første kald må gerne genbruges, men den
        // skal give 40 og ikke det sidste tal vi så.
        sætVindue(90);
        const igen = await grocy.getProductUnitCostDetails(4);
        ok(near(igen.get('10')?.cost, 40), 'og tilbage på 90 dage er tallet 40 igen, ikke det sidst beregnede');

        // Et eksplicit vindue vinder over indstillingen (bruges af auditen).
        const eksplicit = await grocy.getProductUnitCostDetails(4, { windowDays: 180 });
        ok(near(eksplicit.get('10')?.cost, 25), 'en kalder kan bede om et andet vindue uden at røre indstillingen');
    }

    console.log('\nV5 · Popoverens endpoint — gemmer, klamper, afviser vrøvl, genberegner');
    {
        sætVindue(90);
        grocy.clearCache();

        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
        app.use('/api/recipes', require('../routes/recipes_overview'));
        const srv = app.listen(0);
        await new Promise(r => srv.once('listening', r));
        const base = `http://127.0.0.1:${srv.address().port}/api/recipes`;
        const put = (body) => rigtigFetch(base + '/price-window', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const r1 = await put({ days: 180 });
        const j1 = await r1.json();
        ok(r1.status === 200 && j1.days === 180, 'gemt: 180 dage');
        invalidateRecipeCostWindowCache();
        ok(getRecipeCostWindowDays() === 180, 'og det står i databasen bagefter');
        ok(j1.refreshed >= 1, 'kostpriserne genberegnes i samme kald — ellers viser skærmen de gamle tal');

        // Genberegningen skal have brugt det NYE vindue. Gjorde den ikke det,
        // ville cachen bære 40 kr videre, og skiftet ville være rent kosmetisk.
        const cache = db.prepare(`SELECT cost_price_excl_moms FROM recipe_cost_cache WHERE grocy_recipe_id=1`).get();
        ok(near(cache?.cost_price_excl_moms, 25),
           `cachen bærer 180-dages tallet 25 kr (fik ${cache?.cost_price_excl_moms})`);

        // Advarslen der blev gemt under genberegningen skal bære DET vindue.
        // Uden det siger teksten "90-dages" om et tal regnet over 180 — og en
        // gemt advarsel der lyver er værre end ingen advarsel.
        const adv = db.prepare(
            `SELECT price_warnings_json FROM recipe_cost_cache WHERE grocy_recipe_id=1`).get();
        const advList = adv?.price_warnings_json ? JSON.parse(adv.price_warnings_json) : [];
        const wLast = advList.find(w => w.kind === 'last_vs_avg');
        ok(!!wLast, 'seneste køb 40 ligger 60 % fra 180-dages snittet 25 → advarsel');
        ok(wLast?.window_days === 180, 'og advarslen bærer det vindue den blev regnet under');
        ok(describeWarning(wLast || {}).includes('180-dages'),
           'så teksten på skærmen siger 180 dage, ikke defaulten');

        const r2 = await put({ days: 2 });
        const j2 = await r2.json();
        ok(r2.status === 200 && j2.days === MIN_PRICE_WINDOW_DAYS && j2.clamped === true,
           'en urimelig værdi klampes, og svaret siger at den blev det');

        const r3 = await put({ days: 'vrøvl' });
        ok(r3.status === 400, 'vrøvl afvises frem for at blive gemt som defaulten i stilhed');
        const r4 = await put({});
        ok(r4.status === 400, 'og det samme gør et tomt kald');
        invalidateRecipeCostWindowCache();
        ok(getRecipeCostWindowDays() === MIN_PRICE_WINDOW_DAYS,
           'et afvist kald har ikke ændret noget — værdien er stadig den sidst gemte');

        // Popoveren henter alt i ét kald; uden vinduet i svaret ville feltet
        // stå tomt hver gang den åbnes.
        const t = await (await rigtigFetch(base + '/targets')).json();
        ok(t.price_window_days === MIN_PRICE_WINDOW_DAYS, '/targets leverer den aktive værdi til popoveren');
        ok(t.price_window_min === MIN_PRICE_WINDOW_DAYS && t.price_window_max === MAX_PRICE_WINDOW_DAYS,
           'og grænserne, så feltet kan afvise inden man trykker gem');
        ok(t.price_window_default === PRICE_WINDOW_DAYS_DEFAULT, 'og defaulten');

        // Overskriften skriver vinduet ud. Uden feltet på /overview kunne den
        // holde op med at sige det, og ingen test ville sige fra.
        await put({ days: 120 });
        const o = await (await rigtigFetch(base + '/overview')).json();
        ok(o.price_window_days === 120, '/overview siger hvad tallene på skærmen er regnet på');

        // Svaret fra den RIGTIGE route fodres til den RIGTIGE renderer nedenfor.
        const overviewSvar = o;
        srv.close();

        console.log('\nV6 · Skærmen — overskrift og popover');
        {
            // Browserkode kan ikke require'es. Vi kører den rigtige fil i en
            // sandkasse og kalder dens egne funktioner — ikke en kopi.
            const src = fs.readFileSync(
                path.join(__dirname, '..', 'office', 'views', 'opskrifter.js'), 'utf8');
            const ctx = { window: {}, document: { getElementById: () => null },
                          console: { log(){}, warn(){}, error(){} }, setTimeout, clearTimeout };
            ctx.globalThis = ctx;
            vm.createContext(ctx);
            vm.runInContext(src, ctx);
            // `const _opsState` bliver ikke en egenskab på konteksten (kun
            // funktions-erklæringer gør), men den lever i kontekstens
            // leksikalske scope — så et efterfølgende script kan hente den.
            vm.runInContext('globalThis.__state = _opsState;', ctx);

            // Overskriften: vinduet skal stå skrevet ud, så man kan se hvad
            // tallene i tabellen er regnet på uden at åbne popoveren.
            let html = '';
            const beholder = { set innerHTML(v) { html = v; }, get innerHTML() { return html; },
                               querySelector: () => null, querySelectorAll: () => [] };
            ctx.__state.container = beholder;
            ctx.__state.data = overviewSvar;
            try { ctx._opsRender(); } catch (e) { /* binderne rammer null-DOM — markup'en er sat */ }
            ok(html.includes('snit over 120 dage'),
               'overskriften siger hvad kostpriserne er regnet på (fik: '
               + (html.match(/snit over [^<]*/) || ['intet'])[0] + ')');

            // Popoveren: feltet skal bære den AKTIVE værdi og sine grænser.
            // Uden dem stod feltet tomt hver gang popoveren blev åbnet.
            let popHtml = '';
            const pop = { set innerHTML(v) { popHtml = v; }, get innerHTML() { return popHtml; },
                          classList: { remove(){}, add(){}, contains: () => false },
                          querySelector: () => ({ addEventListener(){} }),
                          querySelectorAll: () => [] };
            ctx.__state.targetsData = { categories: ['02 Salat'], targets: [],
                                          price_window_days: 120, price_window_min: 7,
                                          price_window_max: 1095, price_window_default: 90 };
            ctx._opsRenderTargetPop(pop);
            ok(/id="ops-window-days"/.test(popHtml), 'popoveren har feltet');
            ok(/value="120"/.test(popHtml), 'forudfyldt med den aktive værdi');
            ok(/min="7"/.test(popHtml) && /max="1095"/.test(popHtml),
               'og med grænserne, så feltet kan sige fra inden man trykker gem');
            ok(/data-act="save-window"/.test(popHtml), 'og en knap der gemmer');
            ok(popHtml.includes('Mål for DB% pr. kategori'),
               'DB-målene er der stadig — popoveren fik et felt, den mistede ikke et');
        }
    }

    globalThis.fetch = rigtigFetch;
    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(fail ? 1 : 0);
})();
