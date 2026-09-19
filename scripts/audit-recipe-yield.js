// scripts/audit-recipe-yield.js
// ============================================================
// En opskrift kan ikke give mere ud end der går ind.
//
// HVORFOR SCRIPTET FINDES
// Køkkenet undrede sig over at `Cookie bagning` viste 1,2 kg dej ind og
// 1,4 kg udbytte ud. Massebevarelse er en regel man kan kontrollere, og den
// afslørede tre fejl — heriblandt `Løvstikke pakker`, der laver 1 KILO ud af
// 35 gram frisk løvstikke. Faktor 28, i en opskrift der bruges i 8 menuer.
//
// HVORFOR DET IKKE ER KOSMETIK
// Udbyttet er ikke et pyntetal. Efter #360 er det DET TAL DER LÆGGES PÅ
// LAGERET når en batch produceres, og efter #517 er kostprisen
// `batchkost ÷ udbytte`. Et udbytte 28× for højt giver 28× for meget på
// lageret OG en kostpris 28× for lav — begge dele usynligt.
//
// HVAD SCRIPTET IKKE KAN
// Det kræver at BEGGE sider kan vejes: udbyttet og hver eneste råvare skal
// enten lagerføres i kilo eller have en kg-konvertering på produktet. Kan én
// råvare ikke vejes, kan opskriften ikke afgøres — og den rapporteres da som
// UKONTROLLERBAR, ikke som OK. En opskrift vi ikke kan tjekke er ikke det
// samme som en opskrift der er i orden.
//
// Emballage tælles ikke med: en serviet hører til menulinjen, ikke til
// blandingen. Samme afgrænsning som `services/autoBatch.js` bruger.
//
// READ-ONLY. Måler mod den aktive Grocy-lokation.
//
//   node --env-file=.env scripts/audit-recipe-yield.js
//   node --env-file=.env scripts/audit-recipe-yield.js --alle   (vis også de sunde)
//
// Exit 1 hvis mindst én opskrift giver mere ud end ind.
// ============================================================

'use strict';

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const grocy = require('../services/grocyAdapter');
const { yieldPerBatchStockOf } = require('../services/ingredientResolver');
const { num: grocyNum } = require('../shared/grocy_num');

const VIS_ALLE = process.argv.includes('--alle');

// Grocy-kaldene har ingen timeout i adapteren. Et hængende kald ville få
// scriptet til at stå helt stille uden en linje output — netop den slags
// tavse stilstand resten af arbejdet handler om at fjerne.
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS) || 60000;

function medTimeout(navn, p) {
    return Promise.race([
        p,
        new Promise((_, afvis) => setTimeout(
            () => afvis(new Error(`${navn}: intet svar fra Grocy inden for ${TIMEOUT_MS / 1000} s`)),
            TIMEOUT_MS).unref()),
    ]);
}

// Et udbytte må gerne ligge en anelse over input — afrundinger i
// konverteringer alene skal ikke give en alarm.
const TOLERANCE_PCT = 1;

// Svind er normalt: syltelage hældes fra, kød taber væske. Målt i drift går
// det op til 64 % (`Rødkål - Syltet`, 2,745 → 1,000). Men et svind på 99 %
// er ikke madlavning — det er en tastefejl. `Linse Suppe` stod med 360 g
// råvarer og et erklæret udbytte på ÉT GRAM.
//
// Grænsen er sat lavt nok til at ægte indkogning har luft, og højt nok til at
// en faktor-1000-fejl ikke kan gemme sig.
const SVIND_GRÆNSE_PCT = -90;

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const RØD = (s) => `\x1b[31m${s}\x1b[0m`;
const GUL = (s) => `\x1b[33m${s}\x1b[0m`;
const GRØN = (s) => `\x1b[32m${s}\x1b[0m`;
const tal = (n, d = 3) => Number(n).toFixed(d);

async function main() {
    // Cachen skal ryddes først: retter nogen i Grocy mens scriptet kører, kan
    // et FRISK råvaretal blive holdt op mod et GAMMELT udbytte — og så
    // rapporterer kontrollen en fejl der ikke findes. Set under udviklingen.
    if (grocy.clearCache) grocy.clearCache();

    // Sig hvor der læses fra, FØR der læses. Kører nogen scriptet mod den
    // forkerte Grocy, skal det stå der — ikke opdages bagefter.
    let hvor = '(ukendt)';
    try { hvor = require('../services/grocyAdapter').getGrocyConfig?.().url || hvor; } catch (e) {}
    console.log(DIM(`Database: ${process.env.DB_PATH}`));
    console.log(DIM(`Grocy:    ${hvor}`));
    // Egen linje, ikke en halv: Nodes ExperimentalWarning skrives til stderr og
    // lander oven i en uafsluttet linje, så beskeden forsvandt i terminalen.
    console.log(DIM('Henter opskrifter, råvarer, produkter og enheder fra Grocy...'));

    const t0 = Date.now();
    const [recipes, allPos, products, units, conversions] = await medTimeout('Grocy', Promise.all([
        grocy.getRecipesRaw(),
        grocy.getAllRecipesPos(),
        grocy.getProducts(),
        grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]));
    console.log(DIM(`hentet på ${((Date.now() - t0) / 1000).toFixed(1)} s`));

    const productMap = new Map(products.map(p => [p.id, p]));
    const unitMap = new Map(units.map(u => [Number(u.id), u]));
    const posByRecipe = {};
    for (const p of allPos) (posByRecipe[p.recipe_id] ||= []).push(p);

    const KILO = [...unitMap.values()].find(u => /^kilo$/i.test(u.name || ''));
    if (!KILO) {
        console.error('Fandt ingen "Kilo"-enhed i Grocy — kan ikke veje noget.');
        process.exit(2);
    }

    /** Vægt i kg af `amount` af et produkt i dets lager-enhed. null = kan ikke vejes. */
    function kg(productId, amount) {
        const p = productMap.get(Number(productId));
        if (!p) return null;
        if (Number(p.qu_id_stock) === Number(KILO.id)) return amount;
        const c = conversions.find(x =>
            String(x.product_id) === String(productId)
            && Number(x.from_qu_id) === Number(p.qu_id_stock)
            && Number(x.to_qu_id) === Number(KILO.id));
        return c ? amount * parseFloat(c.factor) : null;
    }

    const fejl = [], svind = [], ukontrollerbar = [], sunde = [], udenUdbytte = [];

    // Enheds-navn → kg-faktor, til opskrifter der endnu IKKE producerer et
    // produkt. En blanding der er erklæret i kg kan vejes uden et produkt —
    // og det er netop dem der står for tur til at blive konverteret (#268,
    // #270). Fanges fejlen først EFTER konverteringen, er den nået på lageret.
    const MASSE = { kilo: 1, kg: 1, gram: 0.001, g: 0.001 };
    function erklæretKg(r) {
        const uf = r.userfields || {};
        const per = grocyNum(uf.recipeunitnumber);
        if (!Number.isFinite(per) || per <= 0) return null;
        const base = parseFloat(r.base_servings);
        const total = per * (Number.isFinite(base) && base > 0 ? base : 1);
        const f = MASSE[String(uf.recipeunit || '').trim().toLowerCase()];
        return f == null ? null : total * f;
    }

    for (const r of recipes) {
        const harProdukt = r.product_id && String(r.product_id) !== '0';
        const prod = harProdukt ? productMap.get(Number(r.product_id)) : null;
        if (harProdukt && !prod) continue;

        const gruppe = String(r.userfields?.grupper || '').trim();
        // Rene arbejdstrin (0 råvarer) er ikke opskrifter i denne forstand.
        if (!prod && !(posByRecipe[r.id] || []).length) continue;

        const udStock = prod ? yieldPerBatchStockOf(r, prod, unitMap, conversions) : null;
        if (prod && udStock == null) {
            udenUdbytte.push({ navn: r.name, gruppe, produkt: prod.name });
            continue;
        }
        // Uden et produceret produkt gælder reglen kun PRODUKTIONS-opskrifter.
        // På en menuopskrift betyder `recipeunit`/`recipeunitnumber` noget helt
        // andet — portionsstørrelse til prissætning og skalering i vare-
        // vælgeren, ikke udbyttet af en batch. `Linse Suppe` erklærer "1 gram"
        // som portionsstørrelse; at læse det som et udbytte ville kalde en
        // korrekt menuopskrift for en fejl.
        if (!prod && !/^rr produktion/i.test(gruppe)) continue;
        if (!prod && erklæretKg(r) == null) continue;   // ikke erklæret i masse — intet at veje mod

        const udKg = prod ? kg(prod.id, udStock) : erklæretKg(r);
        const linjer = (posByRecipe[r.id] || [])
            .filter(i => (i.ingredient_group || '').toLowerCase() !== 'emballage');

        let ind = 0;
        const kanIkkeVejes = [];
        for (const i of linjer) {
            const w = kg(i.product_id, parseFloat(i.amount) || 0);
            if (w == null) kanIkkeVejes.push((productMap.get(Number(i.product_id)) || {}).name || `#${i.product_id}`);
            else ind += w;
        }

        if (udKg == null || kanIkkeVejes.length || !linjer.length || ind <= 0) {
            ukontrollerbar.push({
                navn: r.name, gruppe, produkt: prod ? prod.name : '(intet produkt endnu)',
                grund: udKg == null ? 'udbyttet kan ikke vejes'
                     : !linjer.length ? 'ingen råvarer'
                     : kanIkkeVejes.length ? `mangler kg-omregning: ${kanIkkeVejes.join(', ')}`
                     : 'råvarerne vejer 0',
            });
            continue;
        }

        const pct = (udKg / ind - 1) * 100;
        const række = { navn: r.name, gruppe, ind, ud: udKg, pct,
                        produkt: prod ? prod.name : null,
                        udStock: prod ? udStock : udKg,
                        enhed: prod ? (unitMap.get(Number(prod.qu_id_stock))?.name || '') : 'kg' };
        if (pct > TOLERANCE_PCT) fejl.push(række);
        else if (pct < SVIND_GRÆNSE_PCT) svind.push(række);
        else sunde.push(række);
    }

    fejl.sort((a, b) => b.pct - a.pct);
    svind.sort((a, b) => a.pct - b.pct);
    sunde.sort((a, b) => a.pct - b.pct);

    console.log(`\nGennemgår udbytte for ${recipes.length} opskrifter.`);
    console.log(`${fejl.length + svind.length + sunde.length} kan vejes på begge sider · `
              + `${ukontrollerbar.length} kan ikke afgøres · ${udenUdbytte.length} uden erklæret udbytte\n`);

    console.log(B(`── FEJL: giver mere ud end ind (${fejl.length}) ──`));
    if (!fejl.length) {
        console.log('   ' + GRØN('ingen') + ' — massebevarelsen holder overalt hvor den kan måles\n');
    } else {
        console.log(DIM('   Udbyttet er dét der lægges på lageret, og kostprisen er batchkost ÷ udbytte.'));
        console.log(DIM('   Et for højt udbytte giver både for meget lager og en for lav kostpris.\n'));
        for (const f of fejl) {
            console.log(`   ${RØD(f.navn.padEnd(26).slice(0, 26))} ${DIM(f.gruppe.padEnd(22).slice(0, 22))} `
                      + `ind ${tal(f.ind)} kg → ud ${tal(f.ud)} kg   ${RØD('+' + f.pct.toFixed(0) + ' %')}`);
            console.log(DIM(`      ${f.produkt ? `producerer "${f.produkt}"` : 'endnu ikke konverteret til produkt'}`
                          + ` · erklæret udbytte ${tal(f.udStock)} ${f.enhed}`));
        }
        console.log();
    }

    console.log(B(`── Usandsynligt stort svind (${svind.length}) ──`));
    console.log(DIM(`   Over ${-SVIND_GRÆNSE_PCT} % væk. Svind er normalt — op til 64 % er målt i drift —`));
    console.log(DIM('   men dét her er ikke madlavning, det er et forkert tal.'));
    for (const s2 of svind) {
        console.log(`   ${RØD(s2.navn.padEnd(26).slice(0, 26))} ${DIM(s2.gruppe.padEnd(22).slice(0, 22))} `
                  + `ind ${tal(s2.ind)} kg → ud ${tal(s2.ud)} kg   ${RØD(s2.pct.toFixed(0) + ' %')}`);
        console.log(DIM(`      ${s2.produkt ? `producerer "${s2.produkt}"` : 'endnu ikke konverteret til produkt'}`
                      + ` · erklæret udbytte ${tal(s2.udStock)} ${s2.enhed}`));
    }
    if (!svind.length) console.log('   ' + GRØN('ingen'));
    console.log();

    console.log(B(`── Kan ikke afgøres (${ukontrollerbar.length}) ──`));
    console.log(DIM('   Ikke det samme som "i orden" — der mangler en kg-omregning før de kan tjekkes.'));
    for (const u of ukontrollerbar) {
        console.log(`   ${GUL(u.navn.padEnd(26).slice(0, 26))} ${DIM(u.gruppe.padEnd(22).slice(0, 22))} ${u.grund}`);
    }
    if (!ukontrollerbar.length) console.log('   ' + GRØN('ingen'));
    console.log();

    if (udenUdbytte.length) {
        console.log(B(`── Uden erklæret udbytte (${udenUdbytte.length}) ──`));
        console.log(DIM('   `recipeunitnumber` eller `recipeunit` mangler i Grocy. Produktions-panelet'));
        console.log(DIM('   lader feltet stå tomt, og auto-batchen (#267) springer dem over.'));
        console.log('   ' + udenUdbytte.map(u => u.navn).join(' · '));
        console.log();
    }

    if (VIS_ALLE && sunde.length) {
        console.log(B(`── Sunde (${sunde.length}) — svind er normalt ──`));
        for (const s of sunde) {
            console.log(`   ${s.navn.padEnd(26).slice(0, 26)} ${DIM(s.gruppe.padEnd(22).slice(0, 22))} `
                      + `ind ${tal(s.ind)} → ud ${tal(s.ud)}   ${s.pct.toFixed(0)} %`);
        }
        console.log();
    } else if (sunde.length) {
        console.log(DIM(`   (${sunde.length} sunde opskrifter — kør med --alle for at se dem)\n`));
    }

    process.exit((fejl.length || svind.length) ? 1 : 0);
}

main().catch(err => {
    console.error('FEJL:', err.message);
    process.exit(2);
});
