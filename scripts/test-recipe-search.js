// scripts/test-recipe-search.js
// ============================================================
// Ét søgefelt, tre slags træf (designer-spec §6.1).
//
// Påstanden der efterprøves: **brugeren vælger aldrig mellem "ingrediens" og
// "underopskrift"**. Systemet afgør det efter #270-reglen, og reglen er den
// SAMME som `productionTypeOf` (#329) og `buildProducedByIndex` (#558) bygger
// på. En kopi ville skride fra dem — præcis sådan `_buildMailVars` blev til
// tre uenige udgaver.
//
// Fixturen er et read-only udtræk fra grocy-hq, og den bærer selv de kæder
// der gør cyklusværnet svært: 80 producerer vare 231, fem slidere bruger 231,
// og to slider-bokse nester de slidere. Det er to niveauer og begge slags
// afhængighed — en syntetisk fixture ville ikke have fundet på det.
//
// Kører uden Grocy og uden DB.
//
// Kør:  node scripts/test-recipe-search.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

const search = require('../services/recipeSearch');
const { productionTypeOf } = require('../services/ingredientResolver');

function data(over) {
    return Object.assign({
        recipes: SNAP.recipes,
        pos: SNAP.recipes_pos,
        nestings: SNAP.recipes_nestings,
        products: SNAP.products,
        units: SNAP.quantity_units,
    }, over || {});
}

const navne = (liste) => liste.map(x => x.name).sort();
const ider  = (liste) => liste.map(x => x.recipe_id).sort((a, b) => a - b);

(async () => {

// ── §1 #270-reglen: har underopskriften en vare, så brug varen ──────────
console.log('\n── §1 Grupperingen ER beslutningen ──────────────────────');
{
    const g = data();

    // Chili Mayo: opskrift 110 producerer vare 34. Søges der på den, skal den
    // komme som HALVFABRIKAT med varen — ikke som en nesting.
    const r = search.searchTargets('chili mayo', g);
    const semi = r.halvfabrikata.find(x => x.recipe_id === 110);
    ok(!!semi, 'Chili Mayo er et halvfabrikat');
    ok(semi && semi.product_id === 34, 'halvfabrikatet bærer VAREN (34), ikke kun opskriften');
    ok(semi && semi.kind === 'semi', 'kind=semi — linjen lægges på varen');
    ok(!r.nestings.some(x => x.recipe_id === 110), 'den tilbydes IKKE også som nesting');

    // … og heller ikke som «vare på lager». Stod den begge steder, ville der
    // være to knapper der gør præcis det samme — og #270 siger at valget
    // mellem ingrediens og underopskrift er systemets, ikke brugerens.
    ok(!r.varer.some(v => v.product_id === 34),
       'varen «Chili Mayo» står IKKE også under varer — vi laver den selv');
    // Kontrol: der ER en anden chili-VARE, så vare-gruppen ikke bare er tom.
    // Kontrol: en chili-VARE vi IKKE laver selv står stadig under varer —
    // ellers kunne asserten ovenfor bestå fordi gruppen bare var tom.
    const bred = search.searchTargets('chili', g);
    ok(bred.varer.some(v => v.name === 'Spicy Chili Sauce'),
       'kontrol: en indkøbt chili-vare kommer stadig med som vare');

    // En produceret vare skal kunne findes på SIT EGET navn, ikke kun hvis
    // opskriften tilfældigvis hedder det samme.
    const påVarenavn = search.searchTargets('Slider Brød', g);
    ok(påVarenavn.halvfabrikata.some(x => x.product_id === 231),
       'varen «Slider Brød» findes som halvfabrikat — opskriften hedder «Skære Slider Brød»');
    ok(!påVarenavn.varer.some(v => v.product_id === 231), 'og ikke som en indkøbt vare');
    // Kun ÉN post, uanset at både vare- og opskriftsnavn matcher.
    ok(påVarenavn.halvfabrikata.filter(x => x.product_id === 231).length === 1,
       'og kun én gang, selvom begge navne matcher');

    // Varen skal findes på SIT EGET navn, også når opskriften hedder noget
    // helt andet. I fixturen ligner navnene hinanden (Slider Brød / Skære
    // Slider Brød), så den prøve bygges — ellers kunne asserten bestå fordi
    // opskrifts-løkken tilfældigvis fangede den.
    const andetNavn = {
        recipes: [{ id: 900, name: 'Koge natten over', product_id: 910,
                    userfields: { grupper: 'RR Produktion' } }],
        products: [{ id: 910, name: 'Pulled pork', active: '1' }],
        pos: [], nestings: [], units: [],
    };
    const pv = search.searchTargets('Pulled pork', andetNavn);
    ok(pv.halvfabrikata.some(x => x.product_id === 910),
       'varen findes på sit eget navn, selvom opskriften hedder noget andet');
    ok(pv.halvfabrikata[0] && pv.halvfabrikata[0].name === 'Koge natten over',
       'og posten bærer OPSKRIFTENS navn — det er den der skal åbnes');
    ok(!pv.varer.length, 'og den står ikke som en indkøbt vare');

    // Har en vare flere producenter, skal søgningen pege på den SAMME som
    // kostprisen bruger: laveste opskrift-id (`buildProducedByIndex`, #558).
    // Ingen vare i drift har to i dag (målt 20/9), men reglen er det eneste
    // der forhindrer at søgningen og prisen peger hvert sit sted.
    const toProducenter = {
        recipes: [
            { id: 700, name: 'Gammel udgave', product_id: 910, userfields: { grupper: 'RR Produktion' } },
            { id: 800, name: 'Ny udgave', product_id: 910, userfields: { grupper: 'RR Produktion' } },
        ],
        products: [{ id: 910, name: 'Pulled pork', active: '1' }],
        pos: [], nestings: [], units: [],
    };
    const tp = search.searchTargets('Pulled pork', toProducenter);
    ok(tp.halvfabrikata.length === 1, 'kun ÉN post, selvom to opskrifter laver varen');
    ok(tp.halvfabrikata[0].recipe_id === 700,
       'og det er laveste id — samme som kostprisen vælger (#558)');

    // En produceret vare hvis opskrift er BLOKERET (cyklus) må ikke smutte
    // ind ad bagdøren som en almindelig vare.
    const ring = search.searchTargets('Slider Brød', g, { excludeRecipeId: 80 });
    ok(!ring.varer.some(v => v.product_id === 231) &&
       !ring.halvfabrikata.some(x => x.product_id === 231),
       'står man i producenten, tilbydes varen ikke — heller ikke som almindelig vare');
    ok(ring.blokeret.some(x => x.reason === 'self' && /sig selv/.test(x.text)),
       'og grunden siger hvorfor');

    // Samme vej når producenten er blokeret af en ÆGTE cyklus. Fixturen har
    // ikke sådan en graf (at 52 bruger 80's vare er en afhængighed OPAD, ikke
    // en ring), så den bygges: B producerer vare X, og B bruger noget fra A.
    // Står man i A, må X ikke kunne lægges ind — heller ikke som «vare».
    const kunstig = {
        recipes: [
            { id: 900, name: 'A', product_id: 910, userfields: { grupper: 'RR Produktion' } },
            { id: 901, name: 'B', product_id: 911, userfields: { grupper: 'RR Produktion' } },
        ],
        products: [{ id: 910, name: 'Vare A', active: '1' }, { id: 911, name: 'Vare B', active: '1' }],
        pos: [{ recipe_id: 901, product_id: 910 }],      // B bruger A's vare
        nestings: [], units: [],
    };
    const ring2 = search.searchTargets('Vare B', kunstig, { excludeRecipeId: 900 });
    ok(!ring2.varer.some(v => v.product_id === 911) &&
       !ring2.halvfabrikata.some(x => x.product_id === 911),
       'en vare hvis producent er i en ring falder ikke tilbage til at være en vare');
    ok(ring2.blokeret.some(x => x.reason === 'cycle'), 'den blokeres med cyklus-grunden');
    // Kontrol: uden `exclude` er den helt almindeligt valgbar.
    ok(search.searchTargets('Vare B', kunstig).halvfabrikata.some(x => x.product_id === 911),
       'kontrol: uden ringen er den et almindeligt halvfabrikat');

    // Linse Suppe (81) producerer ingen vare → nesting.
    const l = search.searchTargets('linse', g);
    ok(l.nestings.some(x => x.recipe_id === 81), 'Linse Suppe er en nesting');
    ok(!l.halvfabrikata.some(x => x.recipe_id === 81), 'Linse Suppe er IKKE et halvfabrikat');

    // Produktionstypen følger med, så editoren kan sige hvornår varen laves.
    ok(semi && semi.production_type === 'on_demand',
       'Chili Mayo er on_demand (RR produktion Hurtig)');
    const gris = search.searchTargets('langtids', g).halvfabrikata.find(x => x.recipe_id === 28);
    ok(gris && gris.production_type === 'to_stock',
       'Langtids stegt Gris er to_stock (RR Produktion)');
}

// ── §2 Reglen er DELT, ikke skrevet af ──────────────────────────────────
// Kontrollen: for hver opskrift i fixturen skal gruppen matche det
// `productionTypeOf` siger. Skriver nogen en parallel regel i søgningen,
// falder denne.
console.log('\n── §2 Søgningen og productionTypeOf er enige ────────────');
{
    const g = data();
    const varerById = new Map(SNAP.products.map(p => [String(p.id), p]));
    let enige = 0, uenige = [];
    for (const r of SNAP.recipes) {
        const svar = search.searchTargets(r.name, g);
        const type = productionTypeOf(r);
        const vare = varerById.get(String(r.product_id));
        const skalVæreSemi = !!type && !!vare && String(vare.active) === '1';
        const erSemi = svar.halvfabrikata.some(x => x.recipe_id === Number(r.id));
        const erNest = svar.nestings.some(x => x.recipe_id === Number(r.id));
        if (skalVæreSemi ? erSemi : erNest) enige++;
        else uenige.push(r.name + ' (type=' + type + ', semi=' + erSemi + ', nest=' + erNest + ')');
    }
    ok(enige === SNAP.recipes.length && uenige.length === 0,
       `alle ${SNAP.recipes.length} opskrifter grupperes som productionTypeOf siger` +
       (uenige.length ? ' — uenige: ' + uenige.join('; ') : ''));
    ok(SNAP.recipes.filter(r => productionTypeOf(r)).length === 6,
       'kontrol: fixturen HAR 6 producerende opskrifter, så §2 måler noget');
}

// ── §3 Kun aktive varer (#645) ──────────────────────────────────────────
// «kål» blev sat inaktiv i en optælling og gav 13 bons `partial`. En inaktiv
// vare må ikke kunne lægges i en opskrift.
console.log('\n── §3 Inaktive varer tilbydes ikke ──────────────────────');
{
    const g = data();
    const inaktive = SNAP.products.filter(p => String(p.active) !== '1');
    ok(inaktive.length === 5, 'kontrol: fixturen har 5 inaktive varer');

    let lækket = [];
    for (const p of inaktive) {
        const r = search.searchTargets(p.name, g);
        if (r.varer.some(v => v.product_id === Number(p.id))) lækket.push(p.name);
    }
    ok(lækket.length === 0, 'ingen inaktiv vare i resultatet' +
       (lækket.length ? ' — lækket: ' + lækket.join(', ') : ''));

    // Kontrollen der reelt måler filteret: ÉT søgeord, TO varer — «Hvidløgs
    // Pulver» (aktiv) og «Hvidløg - i tern» (slået fra). Kun den ene kommer med.
    // Uden et sådant par kunne asserten ovenfor bestå fordi søgeordet ramte
    // ingenting overhovedet.
    const hvidl = search.searchTargets('hvidløg', g);
    ok(hvidl.varer.some(v => v.name === 'Hvidløgs Pulver'), 'den aktive «Hvidløgs Pulver» kommer med');
    ok(!hvidl.varer.some(v => v.name === 'Hvidløg - i tern'), 'den inaktive «Hvidløg - i tern» gør ikke');
}

// ── §4 Cyklusværn: transitivt, begge slags afhængighed ──────────────────
// Åbner man 80 «Skære Slider Brød», må intet der (transitivt) bruger den
// kunne vælges. Kæden i fixturen er ægte:
//   80 producerer vare 231 → 52/53/54/57/62 bruger 231 → 77/78 nester dem
console.log('\n── §4 Man kan ikke bygge en ring ────────────────────────');
{
    const g = data();
    const r = search.searchTargets('e', g, { excludeRecipeId: 80 });   // bredt søgeord

    const blokeret = new Set(r.blokeret.map(x => x.recipe_id));
    for (const id of [52, 53, 54, 57, 62]) {
        ok(blokeret.has(id), `opskrift ${id} bruger varen fra 80 → blokeret`);
    }
    for (const id of [77, 78]) {
        ok(blokeret.has(id), `slider-boks ${id} nester en af dem → blokeret (2 niveauer)`);
    }
    ok(!r.nestings.some(x => blokeret.has(x.recipe_id)) &&
       !r.halvfabrikata.some(x => blokeret.has(x.recipe_id)),
       'en blokeret opskrift optræder ikke samtidig som valgbar');
    ok(r.blokeret.every(x => x.text && x.reason),
       'hver blokering bærer en grund man kan læse');

    // Kontrol: uden `exclude` er de valgbare — ellers måler §4 ikke noget.
    const fri = search.searchTargets('e', g);
    ok(fri.blokeret.length === 0, 'kontrol: uden exclude blokeres intet');
    ok(fri.nestings.some(x => x.recipe_id === 77), 'kontrol: 77 ER valgbar uden exclude');

    // Den anden vej: 27 «Grisen på Rug» bruges af ingen.
    const gris = search.searchTargets('slider', g, { excludeRecipeId: 27 });
    ok(gris.blokeret.length === 0, 'en opskrift ingen bruger blokerer ingenting');

    // Et ukendt id må ikke vælte søgningen — editoren kan stå på en kladde
    // med et sentinel-id (recipeDraft giver nye kladder id > 1000000).
    const ukendt = search.searchTargets('slider', g, { excludeRecipeId: 1000001 });
    ok(ukendt.nestings.length + ukendt.halvfabrikata.length > 0 && ukendt.blokeret.length === 0,
       'et ukendt exclude-id blokerer ingenting og krakker ikke');
}

// ── §4b En cyklus der ALLEREDE ligger i data må ikke hænge søgningen ────
// Søgningen fyrer ved hvert tastetryk. En uendelig løkke her ville låse
// serveren, ikke bare vise et forkert resultat.
console.log('\n── §4b Et kredsløb i data hænger ikke ───────────────────');
{
    const ring = data({
        nestings: SNAP.recipes_nestings.concat([
            { id: 900, recipe_id: 81, includes_recipe_id: 97, servings: 1 },
            { id: 901, recipe_id: 97, includes_recipe_id: 81, servings: 1 },   // ← ringen
        ]),
    });
    const t0 = Date.now();
    const r = search.searchTargets('e', ring, { excludeRecipeId: 81 });
    const ms = Date.now() - t0;
    ok(ms < 2000, `søgningen svarer (${ms} ms) trods kredsløb i data`);
    ok(r.blokeret.some(x => x.recipe_id === 97), '97 nester 81 → blokeret');
}

// ── §5 Sig selv ─────────────────────────────────────────────────────────
console.log('\n── §5 En opskrift kan ikke indeholde sig selv ───────────');
{
    const g = data();
    const r = search.searchTargets('chili mayo', g, { excludeRecipeId: 110 });
    ok(!r.halvfabrikata.some(x => x.recipe_id === 110) && !r.nestings.some(x => x.recipe_id === 110),
       'Chili Mayo kan ikke vælges når man står i den');
    // VAREN kan heller ikke: den LAVES af denne opskrift, så en linje på den
    // ville regne i ring — kostprisen rekurserer gennem `producedBy` præcis
    // som gennem nestings. En varelinje ser bare uskyldig ud.
    ok(!r.varer.some(x => x.product_id === 34),
       'og heller ikke som «vare» — den laves jo af opskriften man står i');
    ok(r.blokeret.some(x => x.reason === 'self' && /sig selv/.test(x.text)),
       'men den STÅR der med en grund, så man ikke leder efter den igen');
}

// ── §6 Opskrift med en vare der ikke kan bruges ─────────────────────────
// Ikke i fixturen (alle 6 varer er aktive), så den bygges: en opskrift der
// SIGER den producerer en vare, hvis vare er slået fra. Vi nester den ikke som
// erstatning — #329's vagt ville så trække varen og finde ingenting.
console.log('\n── §6 Produceret vare slået fra → blokeret med grund ────');
{
    const varer = SNAP.products.map(p =>
        String(p.id) === '34' ? Object.assign({}, p, { active: '0' }) : p);
    const r = search.searchTargets('chili mayo', data({ products: varer }));

    const b = r.blokeret.find(x => x.recipe_id === 110);
    ok(!!b, 'opskriften er blokeret når dens vare er slået fra');
    ok(b && b.reason === 'inactive_product', 'grunden er inactive_product');
    ok(b && /slået fra/.test(b.text), 'teksten siger hvad der er galt: ' + (b ? b.text : ''));
    ok(!r.nestings.some(x => x.recipe_id === 110),
       'den falder IKKE tilbage til at være en nesting');
    ok(!r.varer.some(x => x.product_id === 34), 'og varen kan ikke vælges direkte');

    // Vare der slet ikke findes.
    const uden = SNAP.products.filter(p => String(p.id) !== '34');
    const r2 = search.searchTargets('chili mayo', data({ products: uden }));
    const b2 = r2.blokeret.find(x => x.recipe_id === 110);
    ok(b2 && b2.reason === 'inactive_product' && /findes/.test(b2.text),
       'en vare der ikke findes blokerer også, med sin egen tekst');
}

// ── §7 Tomt søgeord ─────────────────────────────────────────────────────
console.log('\n── §7 Tomt felt giver tomt svar ─────────────────────────');
{
    const g = data();
    for (const q of ['', '   ', null, undefined]) {
        const r = search.searchTargets(q, g);
        const antal = r.varer.length + r.halvfabrikata.length + r.nestings.length + r.blokeret.length;
        ok(antal === 0, `${JSON.stringify(q)} giver ingen træf (ikke hele kataloget)`);
    }
    ok(search.searchTargets('', g).nyVare === null, 'og heller ikke "opret ny"');
}

// ── §8 Loft pr. gruppe ──────────────────────────────────────────────────
console.log('\n── §8 Listen kan skimmes ────────────────────────────────');
{
    const g = data();
    const r = search.searchTargets('e', g);          // rammer næsten alt
    ok(r.varer.length <= search.MAX_PR_GRUPPE, `varer ≤ ${search.MAX_PR_GRUPPE} (fik ${r.varer.length})`);
    ok(r.nestings.length <= search.MAX_PR_GRUPPE, `nestings ≤ ${search.MAX_PR_GRUPPE}`);
    ok(r.halvfabrikata.length <= search.MAX_PR_GRUPPE, `halvfabrikata ≤ ${search.MAX_PR_GRUPPE}`);
    // Kontrol: der ER mere end loftet at finde, ellers måler asserten intet.
    const alleVarer = SNAP.products.filter(p => String(p.active) === '1' && /e/i.test(p.name));
    ok(alleVarer.length > search.MAX_PR_GRUPPE,
       `kontrol: ${alleVarer.length} varer matcher "e", så loftet gør noget`);
}

// ── §9 «+ Ny vare» er altid en udvej (§8 i specen) ──────────────────────
console.log('\n── §9 En vare der ikke findes kan oprettes ──────────────');
{
    const g = data();
    const r = search.searchTargets('Yuzu-saft', g);
    ok(r.varer.length === 0 && r.nestings.length === 0, 'ukendt søgeord giver ingen træf');
    ok(r.nyVare && r.nyVare.name === 'Yuzu-saft', 'men «+ Ny vare "Yuzu-saft"» tilbydes');
    // Også når der ER træf — man kan søge på noget der ligner uden at mene det.
    const r2 = search.searchTargets('chili mayo', g);
    ok(r2.nyVare && r2.nyVare.name === 'chili mayo', 'også når der er træf');
}

// ── §10 Søgningen er ufølsom for store/små bogstaver og delstrenge ──────
console.log('\n── §10 Man skriver ikke navnet præcist ──────────────────');
{
    const g = data();
    ok(search.searchTargets('CHILI', g).halvfabrikata.some(x => x.recipe_id === 110), 'CHILI');
    ok(search.searchTargets('mayo', g).halvfabrikata.some(x => x.recipe_id === 110), 'midt i navnet');
    ok(search.searchTargets('  chili  ', g).halvfabrikata.some(x => x.recipe_id === 110), 'med mellemrum om');
    ok(search.searchTargets('rødløg', g).halvfabrikata.some(x => x.recipe_id === 14), 'danske tegn');
}

// ── §11 Ruten bruger den delte regel ────────────────────────────────────
// At funktionen er rigtig beviser ikke at ruten kalder den. Her rammes
// `/api/opskrifter/soeg` for alvor, med adapteren stubbet.
console.log('\n── §11 /soeg over HTTP ──────────────────────────────────');
{
    const grocy = require('../services/grocyAdapter');
    const org = {};
    let priserSpurgt = false;
    const stub = {
        getRecipesRaw: async () => SNAP.recipes,
        getAllRecipesPos: async () => SNAP.recipes_pos,
        getRecipeNestings: async () => SNAP.recipes_nestings,
        getProducts: async () => SNAP.products,
        getQuantityUnits: async () => SNAP.quantity_units,
        getProductUnitCostDetails: async () => { priserSpurgt = true; return new Map(); },
    };
    for (const k of Object.keys(stub)) { if (typeof grocy[k] === 'function') { org[k] = grocy[k]; grocy[k] = stub[k]; } }

    const express = require('express');
    const app = express();
    app.use(express.json());
    // Ruten står bag requireAuth() (#316) — sessionen lægges på her, så testen
    // måler søgningen og ikke auth-gaten, som har sine egne tests.
    app.use((req, _res, next) => { req.session = { userId: 1, role: 'admin' }; next(); });
    app.use('/api/opskrifter', require('../routes/opskrifter'));
    const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;

    const j = await (await fetch(`${base}/api/opskrifter/soeg?q=chili%20mayo`)).json();
    ok(j.halvfabrikata && j.halvfabrikata.some(x => x.recipe_id === 110),
       'ruten grupperer Chili Mayo som halvfabrikat');
    ok(j.nyVare && j.nyVare.name === 'chili mayo', 'ruten tilbyder «+ Ny vare»');
    ok(priserSpurgt === false,
       'søgningen henter IKKE priser — den fyrer ved hvert tastetryk');

    const j2 = await (await fetch(`${base}/api/opskrifter/soeg?q=e&exclude=80`)).json();
    ok(j2.blokeret.some(x => x.recipe_id === 77),
       'ruten sender `exclude` videre — cyklusværnet virker over HTTP');

    const r3 = await fetch(`${base}/api/opskrifter/soeg?q=e&exclude=vrøvl`);
    ok(r3.status === 400, 'ugyldigt `exclude` afvises frem for tavst at blive ignoreret');

    const j4 = await (await fetch(`${base}/api/opskrifter/soeg`)).json();
    ok(j4.varer.length === 0 && j4.nestings.length === 0,
       'uden `q` returneres ikke hele kataloget');

    await new Promise(r => srv.close(r));
    for (const k of Object.keys(org)) grocy[k] = org[k];
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

})();
