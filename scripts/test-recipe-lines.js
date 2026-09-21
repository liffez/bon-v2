// scripts/test-recipe-lines.js
// ============================================================
// Linjemodellen (designer-spec §14, reglerne R6.x/R7.x/R8.x).
//
// Den regner ingenting — den oversætter en kladde-linje plus dens beregnede
// tal til noget der kan tegnes. Det der efterprøves her er derfor REGLERNE,
// ikke aritmetik:
//
//   • en linje må ikke skifte form (R6.1) — handlinger ligger altid i ⋯
//   • stepper kun hvor man TÆLLER (R6.2)
//   • prikken er afklaret/ikke — ikke lagerstatus (R6.3)
//   • svind ANNOTERES, mængden er uberørt (R6.5 / I2)
//   • emballage kendes på varegruppen, ikke på sektionsnavnet (R7.5)
//   • manglende enhed BLOKERER, manglende pris gør tallet til et mindstetal
//
// §8 rammer den ÆGTE `/beregn`: at modellen er rigtig beviser ikke at
// koblingen mellem kladdens linjer og motorernes tal holder. Den kobling er
// det eneste sted et tal kan lande på den forkerte linje.
//
// Kør:  node scripts/test-recipe-lines.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const SNAP = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'tests', 'fixtures', 'recipe_designer', 'hq_recipes.json'), 'utf8'));

const RL = require('../shared/recipe_lines');

// Kontekst som editoren giver den: enhedsnavne fra Grocy, emballage fra den
// DELTE regel (browseren får den serveret; her importeres den direkte, så de
// to ikke kan komme til at være uenige).
const { isPackagingGroup } = require('../services/co2Materials');
const ctx = {
    enhedNavn: new Map(SNAP.quantity_units.map(u => [String(u.id), u.name])),
    gruppeNavn: new Map([['1', 'Kolonial'], ['2', 'Grønt'], ['3', 'Emballage'], ['4', 'Kød']]),
    erEmballageGruppe: isPackagingGroup,
};

const kiloId = String((SNAP.quantity_units.find(u => /^kilo$/i.test(u.name)) || {}).id);
const antalId = String((SNAP.quantity_units.find(u => /^antal$/i.test(u.name)) || {}).id);

(async () => {

// ── §1 Typen og badget ──────────────────────────────────────────────────
console.log('\n── §1 Hvad slags linje er det? ──────────────────────────');
{
    ok(RL.typeFor({ product_id: 5, amount: 1 }) === 'product', 'vare → product');
    ok(RL.typeFor({ includes_recipe_id: 80, servings: 1 }) === 'nesting', 'underopskrift → nesting');
    ok(RL.typeFor({ product_id: 34, semi_recipe_id: 110 }) === 'semi', 'halvfabrikat → semi');
    ok(RL.typeFor({ new_product: { name: 'Yuzu' } }) === 'new', 'ny vare → new');

    // Rækkefølgen er reglen: en ny vare er uafklaret uanset hvad den ellers bærer.
    ok(RL.typeFor({ new_product: { name: 'Yuzu' }, product_id: 5, semi_recipe_id: 9 }) === 'new',
       'new vinder over alt andet — den peger ikke på noget der findes');

    // En GEMT opskrift bærer intet `semi_recipe_id` — i Grocy er et
    // halvfabrikat bare en varelinje. Serveren siger det i stedet.
    ok(RL.typeFor({ product_id: 226, amount: 1 }, { producer_recipe_id: 98 }) === 'semi',
       'serverens `producer_recipe_id` gør en varelinje til et halvfabrikat');
    ok(RL.typeFor({ product_id: 1, amount: 1 }, { producer_recipe_id: null }) === 'product',
       'uden producent er det en almindelig vare');
    ok(RL.typeFor({ new_product: { name: 'x' } }, { producer_recipe_id: 98 }) === 'new',
       'men en ny vare er stadig uafklaret — den findes ikke endnu');

    ok(RL.badgeFor('product') === null, 'en almindelig vare bærer INTET badge');
    ok(RL.badgeFor('semi').text === 'HALVFABRIKAT' && RL.badgeFor('semi').expandable,
       'HALVFABRIKAT kan foldes ud');
    ok(RL.badgeFor('nesting').text === 'NESTING' && RL.badgeFor('nesting').expandable,
       'NESTING kan foldes ud');
    ok(RL.badgeFor('new').text === 'NY VARE' && !RL.badgeFor('new').expandable,
       'NY VARE kan IKKE foldes ud — der er intet bagved endnu');
}

// ── §2 Enheder og steppere (R6.2, R6.4) ─────────────────────────────────
console.log('\n── §2 Man tæller nogle ting og vejer andre ──────────────');
{
    for (const [ind, ud] of [['Kilo','kg'], ['kilogram','kg'], ['gram','g'], ['Antal','stk'],
                             ['Styk','stk'], ['Liter','l'], ['Milliliter','ml']]) {
        ok(RL.visEnhed(ind) === ud, `«${ind}» vises som «${ud}»`);
    }
    // Ukendte enheder bevares — Grocy har «Timer» og «Kr» i drift (x- Service).
    ok(RL.visEnhed('Timer') === 'Timer', 'en ukendt enhed opfindes ikke om');
    ok(RL.visEnhed('') === '' && RL.visEnhed(null) === '', 'tom enhed giver tom streng');

    ok(RL.erTaelleenhed('Antal') === true, 'Antal tælles → stepper');
    ok(RL.erTaelleenhed('stk') === true, 'stk tælles → stepper');
    ok(RL.erTaelleenhed('Kilo') === false, 'Kilo vejes → talfelt, ikke stepper');
    ok(RL.erTaelleenhed('Liter') === false, 'Liter måles → talfelt');
    ok(RL.erTaelleenhed('Timer') === false, 'en ukendt enhed får ikke stepper');

    const v = RL.buildLine({ product_id: 5, amount: 2, qu_id_stock: kiloId }, null, ctx);
    ok(v.stepper === false && v.unit === 'kg', 'en kilo-linje: talfelt, vist som kg');
    const s = RL.buildLine({ product_id: 5, amount: 2, qu_id_stock: antalId }, null, ctx);
    ok(s.stepper === true && s.unit === 'stk', 'en antals-linje: stepper, vist som stk');

    // Serverens enhed vinder over det lokale opslag: den står ved siden af den
    // mængde tallet er regnet i, så etiket og tal kan ikke komme fra hver sit sted.
    const fraServer = RL.buildLine({ product_id: 5, amount: 2 }, { unit: 'Kilo' }, ctx);
    ok(fraServer.unit === 'kg', 'serverens enhed bruges — og normaliseres');
    const fraCtx = RL.buildLine({ product_id: 5, amount: 2, qu_id_stock: antalId }, null, ctx);
    ok(fraCtx.unit === 'stk', 'uden serverens svar slås den op lokalt (reserven)');
    // Kontrol: de to ville give FORSKELLIGT — ellers måler asserten ovenfor intet.
    const begge = RL.buildLine({ product_id: 5, amount: 2, qu_id_stock: antalId }, { unit: 'Kilo' }, ctx);
    ok(begge.unit === 'kg', 'og serveren vinder når begge findes');

    const n = RL.buildLine({ includes_recipe_id: 80, servings: 2 }, null, ctx);
    ok(n.unit === 'portion' && n.amount === 2,
       'en nesting uden serverens enhed står i portioner');
    ok(n.stepper === false, 'og får ikke stepper — 2,5 portion er lovligt');

    // Reglen selv: hvad ER én portion? (`RecipeYield.portionUnit`)
    const RY = require('../shared/recipe_yield');
    const pu = (n, u) => RY.portionUnit({ userfields: { recipeunit: u, recipeunitnumber: n } });
    ok(pu('1', 'antal').exact === true && pu('1', 'antal').unit === 'antal',
       '«1 portion er 1 antal» kan bruges som enhed');
    ok(pu('3', 'antal').exact === false && pu('3', 'antal').per === 3,
       '«1 portion er 3 antal» kan IKKE — men forholdet kendes');
    ok(pu('1,1', 'Kilo').exact === false, 'dansk komma læses: 1,1 er ikke 1');
    ok(pu('1', '').unit === null && pu('', 'antal').unit === null && pu('0', 'antal').unit === null,
       'et tomt eller nul-felt giver ingen enhed — vi opfinder ikke en');

    // §B12: opskriften siger selv hvad én portion ER. Serveren sender enheden
    // når den betyder det samme som tallet; ellers ingen, og vi bliver ved
    // «portion» frem for at lyve om det der står i feltet.
    const nStk = RL.buildLine({ includes_recipe_id: 53, servings: 2 },
                              { unit: 'antal', portion_per: 1 }, ctx);
    ok(nStk.unit === 'stk' && nStk.amount === 2,
       '«1 portion er 1 antal» → enheden står som stk, og tallet er uberørt');
    ok(nStk.stepper === true,
       'og den får stepper — man tæller sliders, man vejer dem ikke');

    // Er forholdet ikke 1:1, sender serveren ingen enhed. Browseren må ALDRIG
    // selv falde tilbage på opskriftens felt: «2» med etiketten «stk» ville
    // påstå 2 stk hvor der er 6.
    const nPort = RL.buildLine({ includes_recipe_id: 80, servings: 2 },
                               { unit: null, portion_per: 3 }, ctx);
    ok(nPort.unit === 'portion' && nPort.amount === 2,
       '«1 portion er 3 antal» → feltet bliver ved portioner');
    ok(nPort.stepper === false, 'og uden stepper');
}

// ── §3 Svind annoteres, mængden er uberørt (R6.5 / I2) ──────────────────
console.log('\n── §3 Bon annoterer, den transformerer ikke ─────────────');
{
    const l = RL.buildLine({ product_id: 5, amount: 1.1, qu_id_stock: kiloId,
                             waste_pct: 10, waste_label: 'rensesvind' }, null, ctx);
    ok(l.amount === 1.1, 'mængden er præcis det der blev tastet — ikke regnet om');
    ok(l.annotation === '+10 % rensesvind medregnet', 'svindet står som tekst ved siden af');

    const uden = RL.buildLine({ product_id: 5, amount: 1.1, qu_id_stock: kiloId }, null, ctx);
    ok(uden.annotation === null, 'uden svind står der ingenting');
    ok(RL.svindTekst({ waste_pct: 0 }) === null, '0 % er ikke en annotation');
    ok(RL.svindTekst({ waste_pct: 7.5 }) === '+7,5 % svind medregnet',
       'dansk komma, og «svind» når der ikke står andet');
}

// ── §4 Hvad mangler — og hvad betyder det? (R8.2/R8.4, I3) ──────────────
console.log('\n── §4 Manglende enhed ≠ manglende pris ──────────────────');
{
    const udenEnhed = RL.buildLine({ new_product: { name: 'Yuzu-saft' }, amount: 2 }, null, ctx);
    ok(udenEnhed.blocks_save === true, 'uden enhed BLOKERER linjen gem (R8.4)');
    ok(udenEnhed.missing.includes('enhed'), 'og siger at det er enheden');
    ok(udenEnhed.status === 'open', 'prikken er åben (R6.3)');
    ok(udenEnhed.unresolved === true, 'linjen er uafklaret (R8.1)');

    const medEnhed = RL.buildLine(
        { new_product: { name: 'Yuzu-saft', qu_id_stock: kiloId }, amount: 2 }, null, ctx);
    ok(medEnhed.blocks_save === false, 'med enhed må den gemmes …');
    ok(medEnhed.unresolved === true, '… men den er stadig uafklaret');
    ok(medEnhed.cost_is_minimum && medEnhed.co2_is_minimum,
       'uden pris og CO₂ er linjens tal MINDSTETAL (I3), ikke forkerte');
    ok(medEnhed.unit === 'kg', 'enheden vises normaliseret også på en ny vare');

    const fuld = RL.buildLine({ new_product: { name: 'Yuzu-saft', qu_id_stock: kiloId,
                                               price_per_unit: 120, co2e_per_unit: 0.4 },
                                amount: 2 }, null, ctx);
    ok(fuld.missing.length === 0, 'en fuldt udfyldt ny vare mangler intet');
    ok(fuld.cost_is_minimum === false, 'og dens tal er ikke mindstetal');
    ok(fuld.unresolved === true, 'men den er fortsat uafklaret indtil den er oprettet');

    const utomtNavn = RL.buildLine({ new_product: { name: '  ', qu_id_stock: kiloId }, amount: 1 }, null, ctx);
    ok(utomtNavn.blocks_save === true, 'en ny vare uden navn blokerer også');

    // En EKSISTERENDE vare uden pris er ikke uafklaret — den findes jo.
    const kendt = RL.buildLine({ product_id: 5, amount: 1, qu_id_stock: kiloId },
                               { missing_cost: true, missing_co2: false, cost: null }, ctx);
    ok(kendt.unresolved === false, 'en kendt vare uden pris er IKKE uafklaret');
    ok(kendt.blocks_save === false, 'og blokerer ikke gem');
    ok(kendt.cost_is_minimum === true, 'men dens kostpris er et mindstetal');
}

// ── §5 Emballage kendes på varegruppen (R7.5) ───────────────────────────
console.log('\n── §5 En omdøbt sektion må ikke flytte kg ───────────────');
{
    const iEmbSektion = RL.buildLine(
        { product_id: 5, amount: 1, product_group_id: 2, section: 'Emballage' }, null, ctx);
    ok(iEmbSektion.is_packaging === false,
       'en GRØNT-vare i en sektion der HEDDER «Emballage» er ikke emballage');

    const embVare = RL.buildLine(
        { product_id: 9, amount: 1, product_group_id: 3, section: 'Fyld' }, null, ctx);
    ok(embVare.is_packaging === true,
       'en emballage-vare i sektionen «Fyld» ER emballage');

    // Kontrol: reglen er den DELTE. Bliver den erstattet af en der læser
    // sektionsnavnet, falder de to asserts ovenfor.
    ok(isPackagingGroup('Emballage') === true && isPackagingGroup('Grønt') === false,
       'kontrol: co2Materials.isPackagingGroup skelner de to grupper');

    const uden = RL.buildLine({ product_id: 5, amount: 1 }, null, {});
    ok(uden.is_packaging === false, 'uden reglen gætter vi ikke — intet er emballage');

    // SERVEREN har sidste ord: `/beregn` afgør emballage i samme gennemgang
    // som madvægten, så browseren ikke behøver en kopi af listen. Uden det
    // kunne R7.5 skride ét sted uden at skride begge.
    const serverSiger = RL.buildLine(
        { product_id: 5, amount: 1, product_group_id: 2 }, { is_packaging: true }, ctx);
    ok(serverSiger.is_packaging === true,
       'serverens `is_packaging` vinder over browserens gæt');
    const serverSigerNej = RL.buildLine(
        { product_id: 9, amount: 1, product_group_id: 3 }, { is_packaging: false }, ctx);
    ok(serverSigerNej.is_packaging === false, 'også den anden vej');
    // Kontrol: uden serverens svar ville de to give det MODSATTE — ellers
    // måler de to asserts ovenfor ikke at overstyringen virker.
    ok(RL.buildLine({ product_id: 5, amount: 1, product_group_id: 2 }, null, ctx).is_packaging === false &&
       RL.buildLine({ product_id: 9, amount: 1, product_group_id: 3 }, null, ctx).is_packaging === true,
       'kontrol: uden serverens svar siger browseren det modsatte');
}

// ── §6 Sektioner (R7.6) ─────────────────────────────────────────────────
console.log('\n── §6 Linjer uden sektion står øverst ───────────────────');
{
    const liste = RL.buildList({ lines: [
        { product_id: 1, amount: 1, section: 'Fyld' },
        { product_id: 2, amount: 1 },
        { product_id: 3, amount: 1, section: 'Brød' },
        { product_id: 4, amount: 1, section: 'Fyld' },
    ] }, null, ctx);

    ok(liste.sections.length === 3, 'tre grupper: uden sektion + Fyld + Brød');
    ok(liste.sections[0].name === '' && liste.sections[0].titled === false,
       'de uden sektion står FØRST og uden overskrift');
    ok(liste.sections[0].lines.length === 1, 'og der er én af dem');
    ok(liste.sections[1].name === 'Fyld' && liste.sections[2].name === 'Brød',
       'sektionerne følger listens egen rækkefølge, ikke alfabetet');
    ok(liste.sections[1].lines.length === 2, 'Fyld har begge sine linjer, også den der kom sidst');

    const kunSektion = RL.buildList({ lines: [{ product_id: 1, amount: 1, section: 'Fyld' }] }, null, ctx);
    ok(kunSektion.sections.length === 1 && kunSektion.sections[0].titled === true,
       'er alt i sektioner, er der ingen tom gruppe');
}

// ── §7 Båndet og gennemgangen (§8.3/§8.4) ───────────────────────────────
console.log('\n── §7 Få uafklarede er en undtagelse, mange er en liste ─');
{
    const ny = (navn, enhed) => ({ new_product: enhed ? { name: navn, qu_id_stock: enhed } : { name: navn }, amount: 1 });

    const faa = RL.buildList({ lines: [ny('A'), { product_id: 1, amount: 1 }] }, null, ctx);
    ok(faa.unresolved_count === 1 && faa.dim === false, '1 uafklaret: gul række, ikke dæmpet');

    const mange = RL.buildList({ lines: [ny('A'), ny('B'), ny('C'), ny('D')] }, null, ctx);
    ok(mange.unresolved_count === 4 && mange.dim === true,
       `${RL.GUL_GRAENSE + 1} uafklarede: dæmpet — en gul væg er ulæselig`);
    ok(RL.buildList({ lines: [ny('A'), ny('B'), ny('C')] }, null, ctx).dim === false,
       `${RL.GUL_GRAENSE} er stadig undtagelsen`);

    const blandet = RL.buildList({ lines: [
        ny('Mangler enhed'),                    // blokerer
        ny('Har enhed', kiloId),                // mindstetal
        { product_id: 1, amount: 1 },
    ] }, null, ctx);
    ok(blandet.blocking_count === 1, 'kun den uden enhed tæller som blokerende');
    const b = RL.unresolvedBanner(blandet);
    ok(b && b.count === 2, 'båndet tæller begge uafklarede');
    ok(b && /kan ikke gemmes/.test(b.detail) && /mindstetal/.test(b.detail),
       'og deler dem i de to slags: ' + (b ? b.detail : ''));
    ok(RL.unresolvedBanner(RL.buildList({ lines: [{ product_id: 1, amount: 1 }] }, null, ctx)) === null,
       'intet bånd når intet er uafklaret — et bånd der altid står, læses ikke');

    // §8.4: manglende enhed før manglende pris, fordi enheden blokerer gem.
    const raekke = RL.reviewOrder(RL.buildList({ lines: [
        ny('Har enhed', kiloId),   // i=0, mindstetal
        { product_id: 1, amount: 1 },
        ny('Mangler enhed'),       // i=2, blokerer
        ny('Også uden enhed'),     // i=3, blokerer
    ] }, null, ctx));
    ok(raekke.length === 3, 'kun de uafklarede er med i gennemgangen');
    ok(raekke[0].name === 'Mangler enhed' && raekke[1].name === 'Også uden enhed',
       'de blokerende kommer først');
    ok(raekke[2].name === 'Har enhed', 'og mindstetallet til sidst');
    ok(raekke[0].draft_index === 2 && raekke[1].draft_index === 3,
       'inden for gruppen følges listens rækkefølge, så man går oppefra og ned');
}

// ── §8 Koblingen til de ÆGTE tal ────────────────────────────────────────
// Modellen kan være rigtig og stadig hænge tallene på den forkerte linje.
// `/beregn` lægger nestings EFTER varelinjer, så en positionsbaseret kobling
// ville bytte om så snart de to blandes. Her køres den rigtige motor.
console.log('\n── §8 Tallene lander på den linje de hører til ──────────');
{
    const recipeDraft = require('../services/recipeDraft');
    const priceByProduct = new Map();
    SNAP.products.forEach(p => priceByProduct.set(String(p.id), 10 + (p.id % 17)));
    const g = {
        recipes: SNAP.recipes, pos: SNAP.recipes_pos, nestings: SNAP.recipes_nestings,
        products: SNAP.products, units: SNAP.quantity_units,
        conversions: SNAP.quantity_unit_conversions,
        groups: [{ id: 3, name: 'Emballage' }],
        priceByProduct, priceDetailByProduct: new Map(),
    };

    // Rækkefølgen er med vilje blandet: nesting, vare, nesting, vare.
    const kladde = {
        recipe_id: null, name: 'Testkladde', base_servings: 1,
        yield: { amount: 1, unit: 'Kilo' },
        lines: [
            { includes_recipe_id: 110, servings: 1, section: 'Dressing' },   // Chili Mayo
            { product_id: 33, amount: 0.2, section: 'Grønt' },               // Rødløg - Sylt
            { includes_recipe_id: 98, servings: 2, section: 'Dressing' },    // Tahin
            { product_id: 136, amount: 0.01, section: 'Krydderi' },          // Hvidløgs Pulver
            { new_product: { name: 'Yuzu-saft' }, amount: 0.05, section: 'Dressing' },
        ],
    };

    const ov = await recipeDraft.computeDraft(kladde, g);
    const liste = RL.buildList(kladde, ov, ctx);

    ok(liste.lines.length === 5, 'alle fem kladde-linjer kommer med');
    ok(liste.lines[0].type === 'nesting' && liste.lines[0].includes_recipe_id === 110,
       'linje 0 er stadig Chili Mayo-nestingen');
    ok(liste.lines[1].product_id === 33, 'linje 1 er stadig Rødløg-varen');
    ok(liste.lines[3].name === 'Hvidløgs Pulver', 'linje 3 har sit rigtige navn');
    // Hver linje der peger på en EKSISTERENDE vare har sin enhed fra /beregn.
    // En ny vare uden valgt enhed har bevidst ingen — det er netop dét der
    // blokerer gem (R8.4), og en opfundet enhed ville skjule manglen.
    ok(liste.lines.filter(l => l.type !== 'nesting' && !l.unresolved).every(l => !!l.unit),
       'hver kendt varelinje har sin enhed fra /beregn');
    ok(!liste.lines[4].unit && liste.lines[4].blocks_save,
       'den nye vare har INGEN enhed — og blokerer derfor gem');

    // Rødløg-varen produceres af opskrift 14. Kladden siger det ikke — det er
    // en almindelig varelinje — men serveren gør, og så skal badget frem.
    ok(liste.lines[1].type === 'semi' && liste.lines[1].badge.text === 'HALVFABRIKAT',
       'en gemt varelinje hvis vare laves af en opskrift får HALVFABRIKAT-badget');
    ok(liste.lines[1].semi_recipe_id === 14, 'og bærer opskriften, så den kan åbnes');
    ok(liste.lines[1].expandable === true, 'og kan foldes ud');
    ok(liste.lines[3].type === 'product' && liste.lines[3].badge === null,
       'kontrol: en købt vare får INTET badge');

    // Selve påstanden: tallene hører til DEN linje.
    const fraOv = new Map(ov.lines.map(l => [l.draft_index, l]));
    let enige = 0;
    liste.lines.forEach((l, i) => {
        const b = fraOv.get(i);
        if (!b) return;
        if (l.cost === b.cost && l.weight_g === b.weight_g && l.co2e === b.co2e) enige++;
    });
    ok(enige === 5, `alle 5 linjer bærer motorens egne tal (enige: ${enige})`);

    // Kontrol: nestings og varelinjer ligger FAKTISK i forskellig rækkefølge i
    // svaret — ellers kunne en positionskobling bestå ved et tilfælde.
    const idx = ov.lines.map(l => l.draft_index);
    ok(JSON.stringify(idx) !== JSON.stringify([0, 1, 2, 3, 4]),
       'kontrol: /beregn leverer IKKE kladdens rækkefølge (' + idx.join(',') + ')');

    // Summen: linjernes kostpris skal lægge sammen til overskriften.
    const sum = liste.lines.reduce((a, l) => a + (l.cost || 0), 0);
    ok(Math.abs(sum - (ov.cost.total || 0)) < 1e-9,
       `linjerne lægger sammen til totalen (${sum.toFixed(4)} vs ${(ov.cost.total || 0).toFixed(4)})`);

    // Den nye vare uden pris gør totalen til et mindstetal — ikke til en fejl.
    ok(ov.cost.complete === false, 'totalen er et MINDSTETAL når en linje mangler pris (I3)');
    ok(liste.lines[4].unresolved && liste.lines[4].blocks_save,
       'og den nye vare uden enhed blokerer gem');
    ok(liste.blocking_count === 1, 'præcis én linje blokerer');

    // Emballage hele vejen fra motoren: ingen af linjerne her ER emballage,
    // og serverens svar skal sige det — ikke browserens gæt.
    ok(ov.lines.every(l => l.is_packaging === false),
       '/beregn mærker hver linje med om den er emballage');
    ok(liste.lines.every(l => l.is_packaging === false), 'og linjemodellen bærer det videre');
}

// ── §9 Sektionsskabelonen udledes af driften (R7.3/R7.4) ────────────────
// En hårdkodet liste ville foreslå noget køkkenet ikke gør. Målt på grocy-hq
// bruger 7 af 7 slidere «Emballage» — det ER et mønster, og det skal frem.
console.log('\n── §9 Skabelonen beskriver det der er ──────────────────');
{
    const c = { recipes: SNAP.recipes, pos: SNAP.recipes_pos };

    const slider = RL.sectionTemplate('04 Slider', c);
    ok(slider.source === 'usage' && slider.sections.includes('Emballage'),
       '04 Slider foreslår «Emballage» — 7 af 7 bruger den');
    ok(slider.basis === 7, 'og siger at forslaget bygger på 7 opskrifter');

    const hurtig = RL.sectionTemplate('RR produktion Hurtig', c);
    ok(hurtig.source === 'none' && hurtig.sections.length === 0,
       'en gruppe uden sektioner foreslår INTET — vi opfinder ikke');

    ok(RL.sectionTemplate('Findes Ikke', c).source === 'none', 'ukendt gruppe → intet');
    ok(RL.sectionTemplate('', c).source === 'none', 'tom gruppe → intet');
    ok(RL.sectionTemplate('04 Slider', {}).source === 'none', 'uden data → intet, ikke et krak');

    // Settings vinder: driften beskriver hvad der ER, ikke hvad der skal være.
    const sat = RL.sectionTemplate('01 Sandwich', Object.assign({}, c,
        { templates: { '01 Sandwich': ['Brød', 'Fyld', 'Dressing', 'Grønt', 'Emballage'] } }));
    ok(sat.source === 'settings' && sat.sections.length === 5,
       'en eksplicit skabelon overtrumfer driften');
    ok(sat.sections[0] === 'Brød' && sat.sections[4] === 'Emballage',
       'og bevarer sin rækkefølge');
    // Kontrol: UDEN settings giver samme gruppe noget andet — ellers måler
    // asserten ovenfor ikke at overstyringen virker.
    ok(JSON.stringify(RL.sectionTemplate('01 Sandwich', c).sections) !== JSON.stringify(sat.sections),
       'kontrol: driften ville have sagt noget andet');
    // En tom liste i settings er ikke et valg om «ingen sektioner» — det er en
    // manglende opsætning, så driften gælder.
    const tom = RL.sectionTemplate('04 Slider', Object.assign({}, c, { templates: { '04 Slider': [] } }));
    ok(tom.source === 'usage', 'en TOM skabelon i settings falder tilbage til driften');

    // Tærsklen: en sektion brugt af én ud af syv er ikke et mønster.
    const spredt = {
        recipes: [{ id: 1, userfields: { grupper: 'G' } }, { id: 2, userfields: { grupper: 'G' } },
                  { id: 3, userfields: { grupper: 'G' } }, { id: 4, userfields: { grupper: 'G' } }],
        pos: [{ recipe_id: 1, ingredient_group: 'Fælles' }, { recipe_id: 1, ingredient_group: 'Sjælden' },
              { recipe_id: 2, ingredient_group: 'Fælles' }, { recipe_id: 3, ingredient_group: 'Fælles' },
              { recipe_id: 4, ingredient_group: 'Fælles' }],
    };
    const t = RL.sectionTemplate('G', spredt);
    ok(t.sections.length === 1 && t.sections[0] === 'Fælles',
       'en sektion brugt af 1 af 4 er ikke et mønster og foreslås ikke');

    // Rækkefølgen: den plads sektionen typisk HAR, ikke alfabetet.
    const orden = {
        recipes: [{ id: 1, userfields: { grupper: 'G' } }, { id: 2, userfields: { grupper: 'G' } }],
        pos: [{ recipe_id: 1, ingredient_group: 'Brød' }, { recipe_id: 1, ingredient_group: 'Fyld' },
              { recipe_id: 1, ingredient_group: 'Emballage' },
              { recipe_id: 2, ingredient_group: 'Brød' }, { recipe_id: 2, ingredient_group: 'Fyld' },
              { recipe_id: 2, ingredient_group: 'Emballage' }],
    };
    ok(JSON.stringify(RL.sectionTemplate('G', orden).sections) === '["Brød","Fyld","Emballage"]',
       'rækkefølgen er den de står i — ikke alfabetisk (Brød, Emballage, Fyld)');

    // Opskrifter UDEN sektioner må ikke fortynde nævneren, ellers forsvinder
    // et ægte mønster i dem der ikke har taget det i brug endnu.
    const blandet = {
        recipes: [1, 2, 3, 4, 5, 6].map(id => ({ id, userfields: { grupper: 'G' } })),
        pos: [{ recipe_id: 1, ingredient_group: 'Emballage' }, { recipe_id: 2, ingredient_group: 'Emballage' },
              { recipe_id: 3, ingredient_group: null }, { recipe_id: 4, ingredient_group: '' },
              { recipe_id: 5, ingredient_group: null }, { recipe_id: 6, ingredient_group: null }],
    };
    const b = RL.sectionTemplate('G', blandet);
    ok(b.sections.length === 1 && b.basis === 2,
       'to af seks bruger «Emballage» — mønsteret står, og basis siger 2');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);

})();
