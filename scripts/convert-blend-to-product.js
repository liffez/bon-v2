// scripts/convert-blend-to-product.js
// ============================================================
// Konvertér én `RR produktion Hurtig`-blanding til et rigtigt produkt (#268).
//
// FØR:  menu  ──nesting──>  blanding  ──>  råvarer
// EFTER: menu ──recipes_pos──> PRODUKT  <──produces── blanding ──> råvarer
//
// Efter springet er mellemproduktet tælleligt ved optælling, og råvarerne
// forbruges præcis én gang — i produktionen.
//
// Alt hvad scriptet gør, gemmes i en tilstandsfil, og `--rollback` lægger det
// hele tilbage. Det er hele grunden til at det er et script og ikke klik i
// Grocy: en manuel konvertering af 26 menuer kan ikke fortrydes.
//
//   # 1. mål før
//   node --env-file=.env scripts/recipe-fingerprint.js --uses Remoulade --out foer.json
//   # 2. se hvad der ville ske
//   node --env-file=.env scripts/convert-blend-to-product.js --recipe Remoulade --state remo.json
//   # 3. gør det
//   node --env-file=.env scripts/convert-blend-to-product.js --recipe Remoulade --state remo.json --apply
//   # 4. mål efter og sammenlign
//   node --env-file=.env scripts/recipe-fingerprint.js --uses Remoulade --out efter.json
//   node scripts/recipe-fingerprint.js --diff foer.json efter.json
//   # 5. fortryd
//   node --env-file=.env scripts/convert-blend-to-product.js --rollback --state remo.json --apply
//
// Dry-run er default. `--apply` skriver.
//
// KUN DEN SIDSTE TREDJEDEL: `--kun-rewire`
// Konverteringen er tre skridt: opret produktet, sæt opskriften til at producere
// det, flyt menuerne fra nesting til produktlinje. Er de to første allerede gjort
// — i hånden, eller fordi produktet fandtes i forvejen — nægtede scriptet at køre
// ("producerer allerede X. Intet at konvertere."), og sidste skridt måtte klikkes
// i Grocy uden gate og uden fortrydelse. Det var situationen i #559: Chili Mayo
// fandtes både som produkt og som opskrift.
//
//   node --env-file=.env scripts/convert-blend-to-product.js \
//     --recipe "Chili Mayo" --kun-rewire --state chili.json --apply
//
// `--kun-rewire` KRÆVER at opskriften allerede producerer et produkt, og opretter
// intet. Derfor er `--location` og `--group` heller ikke påkrævede: de bestemmer
// hvor et NYT produkt lander, og der oprettes ingen. Tilstandsfil, gate og
// `--rollback` er de samme som ellers.
//
// LAGER-ENHED ≠ UDBYTTE-ENHED
// Som standard lagerføres produktet i den enhed opskriften erklærer sit udbytte
// i. Det holder for blandinger (1 kg mayo → produkt i Kilo), men ikke for en
// antalsvare: skårne slider-brød tælles i stk og vejes i kilo (§6/§7.1). Dér:
//
//   --stock-unit Kilo --unit-size 0.06
//
// `--unit-size` er hvad ÉN udbytte-enhed vejer i lager-enheden — 1 slider =
// 0,06 kg. Tallet gættes ikke: uden det afbryder scriptet. Findes omregningen
// allerede på produktet (fx ved genbrug), bruges den i stedet.
//
// LOKATION OG VAREGRUPPE VÆLGES
// `--location` og `--group` er påkrævede. Tidligere kopierede scriptet dem fra
// et vilkårligt eksisterende produceret produkt — og gættet satte Remoulade i
// FRYSEREN. Lokationen styrer hvilken liste varen dukker op på ved fysisk
// optælling, så et forkert gæt betyder at varen aldrig bliver talt. Otte
// konverteringer er otte gæt. Begge tager navn eller id:
//
//   --location Køleskab --group "05 Dressinger"
//
// Instansen bestemmes af databasen (`settings.default_grocy_location_id`) —
// samme opslag som appen. Peger den et andet sted end Test, kræves `--confirm-hq`.
// ============================================================

'use strict';

const fs   = require('fs');
const path = require('path');

const APPLY    = process.argv.includes('--apply');
const KUN_REWIRE = process.argv.includes('--kun-rewire');
const ROLLBACK = process.argv.includes('--rollback');
const CONFIRM  = process.argv.includes('--confirm-hq');
const STATE    = argOf('--state');
const STOCK_UNIT_ARG = argOf('--stock-unit');
const LOCATION_ARG   = argOf('--location');
const GROUP_ARG      = argOf('--group');
const UNIT_SIZE_ARG  = argOf('--unit-size');

function argOf(f) { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; }
function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

const ER_CLI = require.main === module;
if (ER_CLI && !STATE) die('Angiv --state <fil>. Uden en tilstandsfil kan konverteringen ikke fortrydes.');

const grocy = require(path.join(__dirname, '..', 'services', 'grocyAdapter'));
const { num: grocyNum } = require('../shared/grocy_num');

// Samme fritekst→enhed-oversættelse som resolveren bruger. `recipeunit` er
// fritekst ("kg"), Grocys enheder hedder "Kilo".
const UNIT_ALIASES = { kg: 'kilo', kilo: 'kilo', kilogram: 'kilo', g: 'gram', gram: 'gram',
                       l: 'liter', liter: 'liter', ml: 'ml',
                       stk: 'antal', 'stk.': 'antal', styk: 'antal', antal: 'antal' };
const norm = (s) => { const n = String(s || '').trim().toLowerCase(); return UNIT_ALIASES[n] || n; };

/**
 * Hvilken enhed lagerføres produktet i, og hvad skal menu-mængderne ganges med?
 *
 * REN funktion — hele beslutningen kan efterprøves uden at røre Grocy, fordi et
 * fejlgreb her skriver et forkert tal ind i hver eneste menu på én gang.
 *
 * `recipes_pos.amount` er i LAGER-enhed (qu_id er kun visning). Er udbyttet
 * erklæret i en anden enhed end produktet lagerføres i, skal mængden derfor
 * omregnes — ellers skrives "1" (antal) og læses som "1" (kilo).
 *
 * @returns {{ yieldUnit, stockUnit, factor, createConversion }}
 *   factor            udbytte-enhed → lager-enhed (1 når de er ens)
 *   createConversion  omregning der mangler i Grocy, eller null
 */
function resolveUnits({ recipe, units, conversions, productId, stockUnitArg, unitSizeArg }) {
    const uf = recipe.userfields || {};
    const yieldUnit = units.find(u => norm(u.name) === norm(uf.recipeunit));
    if (!yieldUnit) {
        throw new Error(`"${recipe.name}" har recipeunit "${uf.recipeunit}", som ikke svarer til nogen Grocy-enhed.`);
    }
    if (!stockUnitArg) {
        // Uændret adfærd: produktet lagerføres i sin udbytte-enhed.
        return { yieldUnit, stockUnit: yieldUnit, factor: 1, createConversion: null };
    }
    const stockUnit = units.find(u => norm(u.name) === norm(stockUnitArg));
    if (!stockUnit) throw new Error(`--stock-unit "${stockUnitArg}" svarer ikke til nogen Grocy-enhed.`);
    if (Number(stockUnit.id) === Number(yieldUnit.id)) {
        return { yieldUnit, stockUnit, factor: 1, createConversion: null };
    }

    // Findes omregningen allerede på produktet? Så er den sandheden — vi laver
    // ikke en ny ved siden af, og vi overskriver ikke en der er sat i hånden.
    const eksisterende = (conversions || []).find(c =>
        Number(c.product_id) === Number(productId)
        && Number(c.from_qu_id) === Number(yieldUnit.id)
        && Number(c.to_qu_id) === Number(stockUnit.id));
    if (eksisterende) {
        const f = parseFloat(eksisterende.factor);
        if (!(f > 0)) throw new Error(`Omregningen på produkt ${productId} har faktor "${eksisterende.factor}".`);
        return { yieldUnit, stockUnit, factor: f, createConversion: null };
    }

    const size = parseFloat(unitSizeArg);
    if (!(size > 0)) {
        throw new Error(
            `Udbyttet er i ${yieldUnit.name}, men produktet skal lagerføres i ${stockUnit.name}, `
          + `og der findes ingen omregning. Angiv --unit-size <tal> = hvad ÉN ${yieldUnit.name} `
          + `vejer i ${stockUnit.name}. Tallet gættes ikke.`);
    }
    return {
        yieldUnit, stockUnit, factor: size,
        createConversion: { from_qu_id: yieldUnit.id, to_qu_id: stockUnit.id, factor: size },
    };
}

/**
 * Hvilket skridt står vi ved — hele konverteringen, eller kun den sidste tredjedel?
 *
 * REN funktion. Vagten er den eneste ting der står mellem "flyt to menuer" og
 * "opret et produkt oveni et der allerede er i brug" — netop dét greb fejl i
 * #559 — så den skal kunne efterprøves uden at røre Grocy.
 *
 * @returns {{ kunRewire: boolean, productId: number|null }}
 * @throws  når flaget og opskriftens tilstand ikke passer sammen
 */
function resolveMode({ recipe, produktNavn, kunRewire }) {
    const harProdukt = recipe.product_id != null && String(recipe.product_id) !== '0';
    if (kunRewire) {
        if (!harProdukt) {
            throw new Error(
                `${recipe.id} "${recipe.name}" producerer ikke noget produkt endnu, så der er intet at `
              + 'flytte menuerne over på. Kør uden --kun-rewire — så oprettes produktet først.');
        }
        return { kunRewire: true, productId: Number(recipe.product_id) };
    }
    if (harProdukt) {
        throw new Error(
            `${recipe.id} "${recipe.name}" producerer allerede "${produktNavn || recipe.product_id}". `
          + 'Mangler kun menuerne, så brug --kun-rewire.');
    }
    return { kunRewire: false, productId: null };
}

/**
 * Slå en lokation eller varegruppe op på navn eller id.
 *
 * REN funktion. Kaster med HELE listen i beskeden — står man og skal vælge, er
 * det svaret man mangler, ikke en besked om at man valgte forkert.
 */
function resolveNamed(list, arg, label) {
    const v = String(arg ?? '').trim();
    const muligheder = (list || []).map(x => `${x.id} ${x.name}`).join(' · ');
    if (!v) throw new Error(`Angiv --${label}. Den gættes ikke.\n  Vælg mellem: ${muligheder}`);

    const påId = (list || []).find(x => String(x.id) === v);
    if (påId) return påId;

    // Et rent tal er ment som et id. Falder det igennem til stumpe-matchning,
    // finder "0" cifrene inde i "02 Pålæg", "05 Dressinger" og "10 Emballage",
    // og beskeden bliver "passer på flere" — hvilket sender folk det forkerte
    // sted hen at lede.
    if (/^\d+$/.test(v)) throw new Error(`--${label} med id ${v} findes ikke.\n  Vælg mellem: ${muligheder}`);

    const n = v.toLowerCase();
    const eksakt = (list || []).filter(x => String(x.name || '').trim().toLowerCase() === n);
    if (eksakt.length === 1) return eksakt[0];

    // Delvist navn er en bekvemmelighed — men kun når det peger ét sted hen.
    const delvis = (list || []).filter(x => String(x.name || '').toLowerCase().includes(n));
    if (delvis.length === 1) return delvis[0];
    if (delvis.length > 1) {
        throw new Error(`--${label} "${v}" passer på flere: ${delvis.map(x => x.name).join(', ')}`);
    }
    throw new Error(`--${label} "${v}" findes ikke.\n  Vælg mellem: ${muligheder}`);
}

/**
 * Må et eksisterende produkt med samme navn genbruges?
 *
 * REN funktion. Vagten skal måle mod produktets LAGER-enhed, ikke mod
 * opskriftens udbytte-enhed: skårne slider-brød lagerføres i kilo mens udbyttet
 * er i sliders, og en sammenligning mod udbyttet ville afvise et helt korrekt
 * produkt. Peger vi derimod et produkt med en anden lager-enhed på opskriften,
 * lander udbyttet i den forkerte enhed — præcis fejlen #360 handlede om.
 *
 * @returns {string|null} fejlbesked, eller null når det er i orden
 */
function checkReusableProduct(produkt, stockUnit) {
    if (Number(produkt.qu_id_stock) === Number(stockUnit.id)) return null;
    return `Produktet "${produkt.name}" (#${produkt.id}) findes, men lagerføres i enhed `
         + `${produkt.qu_id_stock}, ikke ${stockUnit.id} (${stockUnit.name}). `
         + 'Ret enheden i Grocy, omdøb produktet, eller vælg en anden --stock-unit.';
}

/**
 * Menu-mængden i LAGER-enhed. `servings` tælles i portioner, udbyttet er pr.
 * portion, og factor bærer den over i lager-enheden.
 */
function menuAmountStock(servings, perServing, factor) {
    return servings * perServing * factor;
}

/**
 * Hvad ANTYDER opskriften at én udbytte-enhed vejer? Kun når den har præcis én
 * ingrediens i mållageret — så er svaret entydigt (32 brød à 3,84 kg / 64
 * sliders = 0,06). Et forslag til mennesket, ikke en værdi vi bruger.
 */
function suggestUnitSize(pos, products, stockUnitId, yieldPerBatch) {
    if (!(yieldPerBatch > 0)) return null;
    const iMål = (pos || []).filter(x => {
        const p = (products || []).find(pp => Number(pp.id) === Number(x.product_id));
        return p && Number(p.qu_id_stock) === Number(stockUnitId);
    });
    if (iMål.length !== 1) return null;
    const total = parseFloat(iMål[0].amount) || 0;
    return total > 0 ? total / yieldPerBatch : null;
}

async function main() {
    const cfg = grocy.getGrocyConfig();
    console.log(`\nGrocy-instans: \x1b[1m${cfg.locationName}\x1b[0m  ·  ${APPLY ? '\x1b[31mSKRIVER\x1b[0m' : 'dry-run'}`);
    if (String(cfg.locationName).toLowerCase() !== 'test' && !CONFIRM) {
        die(`Instansen er "${cfg.locationName}", ikke Test. Tilføj --confirm-hq hvis det er med vilje.`);
    }

    if (ROLLBACK) return rollback(cfg);

    const recipeArg = argOf('--recipe');
    if (!recipeArg) die('Angiv --recipe <id eller navn>');
    if (fs.existsSync(STATE)) die(`${STATE} findes allerede. Kør --rollback først, eller vælg et andet navn.`);

    const [rawMap, allPos, nestings, products, units, conversions, locations, groups] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
        grocy.getLocations(), grocy.getProductGroups(),
    ]);
    const rawList = [...rawMap.entries()].map(([id, r]) => ({ ...r, id: r.id ?? id }));

    // ── Find blandingen ──
    const byId = rawList.find(r => String(r.id) === String(recipeArg));
    const byName = rawList.filter(r => String(r.name || '').toLowerCase().includes(String(recipeArg).toLowerCase()));
    const recipe = byId || (byName.length === 1 ? byName[0] : null);
    if (!recipe) {
        if (byName.length > 1) die(`"${recipeArg}" matcher flere: ${byName.map(r => `${r.id} ${r.name}`).join(', ')}`);
        die(`Ingen opskrift matcher "${recipeArg}"`);
    }
    let tilstand;
    try {
        const p = products.find(x => Number(x.id) === Number(recipe.product_id));
        tilstand = resolveMode({ recipe, produktNavn: p ? p.name : null, kunRewire: KUN_REWIRE });
    } catch (err) {
        die(err.message);
    }
    // Produktet der skal peges på. I --kun-rewire er det opskriftens eget; ellers
    // findes det først når vi opretter det længere nede.
    const eksisterendeProdukt = tilstand.kunRewire
        ? products.find(x => Number(x.id) === tilstand.productId)
        : null;
    if (tilstand.kunRewire && !eksisterendeProdukt) {
        die(`Opskriften peger på produkt ${tilstand.productId}, som ikke findes i Grocy.`);
    }

    // ── Udbyttet SKAL være erklæret ──
    // Uden det kan menu-mængderne ikke regnes, og gaten kan ikke folde
    // produktet tilbage til råvarer. Vi opfinder ikke et udbytte.
    const uf = recipe.userfields || {};
    const perServing = grocyNum(uf.recipeunitnumber);
    const base = parseFloat(recipe.base_servings) || 1;
    if (!Number.isFinite(perServing) || perServing <= 0) {
        die(`"${recipe.name}" mangler userfield recipeunitnumber. Udfyld udbyttet i Grocy først (jf. #372) — ellers`
            + ' kan hverken menu-mængderne eller gatens tilbage-foldning regnes.');
    }
    let enheder;
    try {
        enheder = resolveUnits({
            recipe, units, conversions, productId: tilstand.productId,
            stockUnitArg: STOCK_UNIT_ARG, unitSizeArg: UNIT_SIZE_ARG,
        });
    } catch (err) {
        // Antyder opskriften selv et tal, så sig det — det sparer et opslag,
        // og et forkert gæt bliver lettere at få øje på.
        const stockUnit = units.find(u => norm(u.name) === norm(STOCK_UNIT_ARG || ''));
        const forslag = stockUnit
            ? suggestUnitSize(allPos.filter(x => Number(x.recipe_id) === Number(recipe.id)),
                              products, stockUnit.id, perServing * base)
            : null;
        die(err.message + (forslag ? `\n  Opskriften antyder ${round(forslag)} — efterprøv den inden du bruger den.` : ''));
    }
    const { yieldUnit, stockUnit, factor } = enheder;

    // ── Menuerne der nester den ──
    const hits = nestings.filter(n => Number(n.includes_recipe_id) === Number(recipe.id));
    if (!hits.length) die(`Ingen opskrift nester "${recipe.name}". Intet at flytte.`);

    // ── Lokation og varegruppe VÆLGES ──
    //
    // Før kopierede scriptet dem fra det første aktive producerede produkt det
    // faldt over. Gættet ramte varegruppen på Remoulade og lokationen forkert:
    // den landede i Fryseren og skulle stå på køl. Lokationen bestemmer hvilken
    // liste varen dukker op på ved den fysiske optælling, så en vare det forkerte
    // sted bliver aldrig talt — og lageret driver, uden at nogen ser hvorfor.
    // I --kun-rewire oprettes intet produkt, og så er der intet at placere.
    // Krævede vi dem alligevel, ville operatøren skulle finde på en lokation
    // for et produkt der allerede står et sted.
    let lokation = null, gruppe = null, newProduct = null;
    if (!tilstand.kunRewire) {
        try {
            lokation = resolveNamed(locations, LOCATION_ARG, 'location');
            gruppe   = resolveNamed(groups,    GROUP_ARG,    'group');
        } catch (err) {
            die(err.message);
        }
        newProduct = {
            name: recipe.name,
            location_id:      lokation.id,
            qu_id_purchase:   stockUnit.id,
            qu_id_stock:      stockUnit.id,
            product_group_id: gruppe.id,
            active: 1,
        };
    } else {
        // Samme vagt som ved genbrug: peger vi menuerne på et produkt med en
        // anden lager-enhed, lander mængderne i den forkerte enhed (#360).
        const enhedsfejl = checkReusableProduct(eksisterendeProdukt, stockUnit);
        if (enhedsfejl) die(enhedsfejl);
    }

    console.log(`\nBlanding:  ${recipe.id} "${recipe.name}"  (base_servings ${base})`);
    console.log(`Udbytte:   ${perServing} ${yieldUnit.name} pr. portion  →  ${perServing * base} ${yieldUnit.name} pr. batch`);
    if (tilstand.kunRewire) {
        console.log(`Produkt:   ${eksisterendeProdukt.id} "${eksisterendeProdukt.name}" (findes — intet oprettes)`);
        console.log(`Kun rewire: produkt og produces-kobling er på plads, kun menulinjerne mangler.`);
    } else {
        console.log(`Nyt produkt: "${newProduct.name}" · lager-enhed ${stockUnit.name}`);
        console.log(`Placering:  ${lokation.name} · gruppe ${gruppe.name}`);
    }
    if (factor !== 1) {
        console.log(`Omregning:  1 ${yieldUnit.name} = ${round(factor)} ${stockUnit.name}`
                  + (enheder.createConversion ? '  (oprettes)' : '  (findes i forvejen)'));
    }
    console.log(`\n${hits.length} menu${hits.length === 1 ? '' : 'er'} flyttes fra nesting til produktlinje:\n`);

    const plan = hits.map(n => {
        const menu = rawMap.get(Number(n.includes_recipe_id) === Number(recipe.id) ? Number(n.recipe_id) : null)
                  || rawMap.get(Number(n.recipe_id)) || {};
        const servings = parseFloat(n.servings) || 0;
        // Udbyttet er PR PORTION, og nesting-servings tælles i portioner.
        // Samme fortolkning som resolveren bruger, ellers ville regnestykket
        // skride ved springet. `factor` bærer den over i LAGER-enheden, som er
        // den `recipes_pos.amount` læses i.
        const amount = menuAmountStock(servings, perServing, factor);
        return { nesting: n, menu_id: Number(n.recipe_id), menu_name: menu.name || `#${n.recipe_id}`, servings, amount };
    }).sort((a, b) => a.menu_id - b.menu_id);

    for (const p of plan) {
        console.log(`  ${String(p.menu_id).padStart(4)} ${p.menu_name.padEnd(28).slice(0, 28)}  nesting ${p.servings} portioner  →  ${round(p.amount)} ${stockUnit.name}`);
    }

    if (!APPLY) {
        console.log(`\nDry-run — intet skrevet. Tilføj --apply for at gøre det.\n`);
        console.log(`Husk at måle FØR:  node --env-file=.env scripts/recipe-fingerprint.js --uses "${recipe.name}" --out foer.json\n`);
        return;
    }

    // ── Skriv ──
    const state = {
        instance: cfg.locationName,
        recipe_id: Number(recipe.id),
        recipe_name: recipe.name,
        recipe_had_product_id: recipe.product_id || null,
        kun_rewire: tilstand.kunRewire,
        created_product_id: null,
        // Oprettet enheds-omregning (fx 1 Antal = 0,06 Kilo). Skal med, ellers
        // efterlader en fortrydelse en omregning der peger på et slettet produkt.
        created_conversion_id: null,
        // Genbrugt frem for oprettet? Så må rollback ALDRIG slette det.
        reused_product_id: null,
        reused_product_was_active: null,
        created_pos: [],
        removed_nestings: [],
        at: new Date().toISOString(),   // utc-ok: tidsstempel i en tilstandsfil
    };
    // Tilstandsfilen skrives FØR hvert skridt, ikke til sidst. Går noget galt
    // midtvejs, skal --rollback stadig kunne rydde op efter det der NÅEDE at ske.
    const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + '\n');
    save();

    try {
        // Findes produktet allerede? Grocy har UNIQUE på `products.name`, og en
        // rollback SLETTER ikke et produkt der har lager — den deaktiverer det.
        // Uden genbrug kan en konvertering der er rullet tilbage derfor ikke
        // køres igen: den falder på navnet. Fundet i generalprøven på test.
        const eksisterende = tilstand.kunRewire ? eksisterendeProdukt : products.find(x =>
            String(x.name || '').trim().toLowerCase() === String(newProduct.name).trim().toLowerCase());

        if (tilstand.kunRewire) {
            // Intet oprettes. Produktet registreres som GENBRUGT, så en
            // fortrydelse hverken sletter eller deaktiverer et produkt der var
            // her før os — og `recipe_had_product_id` bærer produces-koblingen
            // tilbage, præcis som den stod.
            state.created_product_id = Number(eksisterendeProdukt.id);
            state.reused_product_id = Number(eksisterendeProdukt.id);
            state.reused_product_was_active = String(eksisterendeProdukt.active);
            save();
            console.log(`\n✓ produkt ${eksisterendeProdukt.id} "${eksisterendeProdukt.name}" bruges som det er`);
        } else if (eksisterende) {
            const enhedsfejl = checkReusableProduct(eksisterende, stockUnit);
            if (enhedsfejl) die(enhedsfejl);
            state.created_product_id = Number(eksisterende.id);
            state.reused_product_id = Number(eksisterende.id);
            state.reused_product_was_active = String(eksisterende.active);
            save();
            console.log(`\n✓ produkt genbrugt: ${eksisterende.id} "${eksisterende.name}"`
                      + (String(eksisterende.active) === '0' ? ' (var deaktiveret — aktiveres)' : ''));
            if (String(eksisterende.active) === '0') {
                await grocy.updateProduct(eksisterende.id, { active: 1 });
            }
        } else {
            const created = await grocy.createProduct(newProduct);
            state.created_product_id = Number(created.created_object_id);
            save();
            console.log(`\n✓ produkt oprettet: ${state.created_product_id}`);
        }

        // Omregningen SKAL stå før menu-linjerne skrives. Uden den kan hverken
        // udbyttet (yieldPerBatchStockOf) eller optællingen omsætte mellem de to
        // enheder, og produktet ville være ubrugeligt i den mellemtilstand.
        // Et genbrugt produkt kan allerede have omregningen — `resolveUnits` kunne
        // ikke vide det, for produktet fandtes ikke da den blev kaldt. Uden det
        // her tjek ville en genkørsel lægge en dublet ved siden af den gamle.
        const harAllerede = enheder.createConversion && conversions.some(c =>
            Number(c.product_id) === Number(state.created_product_id)
            && Number(c.from_qu_id) === Number(enheder.createConversion.from_qu_id)
            && Number(c.to_qu_id) === Number(enheder.createConversion.to_qu_id));
        if (harAllerede) {
            console.log(`✓ omregning fandtes i forvejen på produkt ${state.created_product_id}`);
        } else if (enheder.createConversion) {
            const c = await grocy.createQuConversion({
                product_id: state.created_product_id, ...enheder.createConversion,
            });
            state.created_conversion_id = Number(c.created_object_id);
            save();
            console.log(`✓ omregning oprettet: 1 ${yieldUnit.name} = ${round(factor)} ${stockUnit.name}`);
        }

        if (tilstand.kunRewire) {
            console.log(`✓ "${recipe.name}" producerede produktet i forvejen — uændret`);
        } else {
            await grocy.updateRecipe(recipe.id, { product_id: state.created_product_id });
            console.log(`✓ "${recipe.name}" producerer nu produktet`);
        }

        for (const p of plan) {
            const pos = await grocy.createRecipePos({
                recipe_id: p.menu_id,
                product_id: state.created_product_id,
                amount: p.amount,
                qu_id: stockUnit.id,
                ingredient_group: '',
            });
            state.created_pos.push({ id: Number(pos.created_object_id), recipe_id: p.menu_id, amount: p.amount });
            save();

            // Nestingen fjernes FØRST når produktlinjen står der. Rækkefølgen
            // betyder noget: fejler vi imellem, er råvarerne talt to gange
            // (synligt i gaten) frem for tabt (usynligt).
            await grocy.deleteRecipeNesting(p.nesting.id);
            state.removed_nestings.push({
                id: Number(p.nesting.id), recipe_id: p.menu_id,
                includes_recipe_id: Number(recipe.id), servings: p.servings,
            });
            save();
            console.log(`✓ ${p.menu_name}: nesting → produktlinje ${round(p.amount)} ${stockUnit.name}`);
        }
    } catch (err) {
        console.error(`\n✗ Afbrudt: ${err.message}`);
        console.error(`  Tilstanden er gemt i ${STATE} — kør --rollback --apply for at rydde op.\n`);
        process.exit(1);
    }

    console.log(`\nFærdig. Tilstand: ${STATE}`);
    console.log(`Mål efter:  node --env-file=.env scripts/recipe-fingerprint.js --uses "${recipe.name}" --out efter.json`);
    console.log(`Sammenlign: node scripts/recipe-fingerprint.js --diff foer.json efter.json\n`);
}

if (ER_CLI) main().catch(err => die(err.stack || err.message));

// Enheds-logikken eksporteres, så beslutningen kan efterprøves uden Grocy.
// Et fejlgreb dér skriver et forkert tal ind i hver eneste menu på én gang.
module.exports = { resolveUnits, menuAmountStock, suggestUnitSize, resolveNamed, checkReusableProduct, resolveMode };

async function rollback(cfg) {
    if (!fs.existsSync(STATE)) die(`${STATE} findes ikke.`);
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.instance !== cfg.locationName) {
        die(`Tilstanden blev skrevet mod "${state.instance}", men databasen peger på "${cfg.locationName}".`);
    }

    console.log(`\nRuller tilbage: ${state.recipe_id} "${state.recipe_name}"`);
    console.log(`  ${state.created_pos.length} produktlinjer slettes · ${state.removed_nestings.length} nestings genskabes · produkt ${state.created_product_id}`);
    if (!APPLY) { console.log('\nDry-run — intet skrevet. Tilføj --apply.\n'); return; }

    for (const n of state.removed_nestings) {
        await grocy.createRecipeNesting({
            recipe_id: n.recipe_id, includes_recipe_id: n.includes_recipe_id, servings: n.servings,
        });
        console.log(`✓ nesting genskabt på ${n.recipe_id} (${n.servings} portioner)`);
    }
    for (const p of state.created_pos) {
        await grocy.deleteRecipePos(p.id);
        console.log(`✓ produktlinje ${p.id} slettet fra ${p.recipe_id}`);
    }
    await grocy.updateRecipe(state.recipe_id, { product_id: state.recipe_had_product_id || null });
    console.log(state.recipe_had_product_id
        ? `✓ "${state.recipe_name}" producerer stadig produkt ${state.recipe_had_product_id} — som før`
        : `✓ "${state.recipe_name}" producerer ikke længere et produkt`);

    // Omregningen hænger på produktet, så den skal væk først.
    if (state.created_conversion_id) {
        await grocy.deleteQuConversion(state.created_conversion_id);
        console.log(`✓ enheds-omregning ${state.created_conversion_id} slettet`);
    }

    if (state.reused_product_id) {
        // Produktet fandtes FØR konverteringen. Det er ikke vores at slette —
        // vi må kun sætte `active` tilbage til det den var.
        const foer = state.reused_product_was_active;
        if (foer != null && String(foer) !== '1') {
            await grocy.updateProduct(state.reused_product_id, { active: Number(foer) });
        }
        console.log(`✓ produkt ${state.reused_product_id} var der i forvejen — kun aktiv-flaget sat tilbage`);
    } else if (state.created_product_id) {
        // Har nogen nået at producere ind i produktet, må det IKKE slettes —
        // så ville lagerhistorikken forsvinde med det. Deaktivér i stedet og
        // sig det højt.
        //
        // ⚠ Konsekvens, fundet i generalprøven: navnet er UNIQUE i Grocy, så
        // et deaktiveret produkt spærrer for at konverteringen kan køres igen.
        // Derfor genbruger konverteringen et eksisterende produkt med samme
        // navn i stedet for at oprette et nyt.
        const stock = await grocy.getStock();
        const has = stock.some(s => Number(s.product_id) === Number(state.created_product_id) && parseFloat(s.amount) !== 0);
        if (has) {
            await grocy.updateProduct(state.created_product_id, { active: 0 });
            console.log(`⚠ produkt ${state.created_product_id} har lager — deaktiveret i stedet for slettet`);
            console.log(`  (en ny konvertering vil GENBRUGE det, ikke oprette et nyt)`);
        } else {
            await grocy.deleteProduct(state.created_product_id);
            console.log(`✓ produkt ${state.created_product_id} slettet`);
        }
    }

    fs.renameSync(STATE, STATE + '.rulledtilbage');
    console.log(`\nTilbage til udgangspunktet. Tilstandsfilen er omdøbt til ${STATE}.rulledtilbage\n`);
}

function round(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
