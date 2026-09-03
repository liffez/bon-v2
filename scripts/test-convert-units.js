// scripts/test-convert-units.js
// ============================================================
// Enheds-logikken i konverteringen (#268/#270).
//
// `recipes_pos.amount` er i LAGER-enhed — `qu_id` er kun visning. Lagerførte
// konverteringen produktet i sin UDBYTTE-enhed og skrev mængderne i samme,
// gik det godt så længe de to var ens. Skære Slider Brød er det første sted de
// ikke er: udbyttet er i sliders (antal), lageret føres i kilo. Skrives "1"
// hvor der menes 0,06, rammer fejlen 12 menuer på én gang — og den er tavs,
// for et tal er et tal.
//
// Derfor er beslutningen skilt ud som en ren funktion og testes her uden Grocy.
//
//   node scripts/test-convert-units.js
// ============================================================
'use strict';
const { resolveUnits, menuAmountStock, suggestUnitSize, resolveNamed,
        checkReusableProduct, resolveMode } = require('./convert-blend-to-product');

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const near  = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
const kaster = (fn, frag) => {
    try { fn(); return false; } catch (e) { return frag ? e.message.includes(frag) : true; }
};

const UNITS = [
    { id: 4, name: 'Kilo' },
    { id: 8, name: 'Antal' },
    { id: 9, name: 'Liter' },
];
const blanding = { name: 'Remoulade', userfields: { recipeunit: 'kg', recipeunitnumber: '1' } };
const slider   = { name: 'Skære Slider Brød', userfields: { recipeunit: 'antal', recipeunitnumber: '1' } };

head('Samme enhed — uændret adfærd');
{
    const r = resolveUnits({ recipe: blanding, units: UNITS, conversions: [], productId: null });
    check(r.stockUnit.id === 4, 'uden --stock-unit lagerføres der i udbytte-enheden');
    check(r.factor === 1, 'faktor 1');
    check(r.createConversion === null, 'og der oprettes ingen omregning');

    // "kg" i opskriften, "Kilo" i Grocy — samme enhed, skrevet forskelligt.
    const eks = resolveUnits({ recipe: blanding, units: UNITS, conversions: [],
                               productId: null, stockUnitArg: 'Kilo' });
    check(eks.factor === 1 && eks.createConversion === null,
        '--stock-unit der peger på SAMME enhed ændrer intet (kg = Kilo)');
}

head('Forskellig enhed — tallet gættes ikke');
{
    check(kaster(() => resolveUnits({ recipe: slider, units: UNITS, conversions: [],
                                      productId: null, stockUnitArg: 'Kilo' }), '--unit-size'),
        'lager i Kilo, udbytte i Antal, ingen omregning → afbryder og beder om --unit-size');

    const r = resolveUnits({ recipe: slider, units: UNITS, conversions: [],
                             productId: null, stockUnitArg: 'Kilo', unitSizeArg: '0.06' });
    check(r.stockUnit.id === 4 && r.yieldUnit.id === 8, 'lager Kilo, udbytte Antal');
    check(near(r.factor, 0.06), '1 slider = 0,06 kg');
    check(r.createConversion && r.createConversion.from_qu_id === 8 && r.createConversion.to_qu_id === 4,
        'omregningen oprettes i den rigtige retning (Antal → Kilo)');
    check(near(r.createConversion.factor, 0.06), 'med den angivne faktor');

    check(kaster(() => resolveUnits({ recipe: slider, units: UNITS, conversions: [], productId: null,
                                      stockUnitArg: 'Kilo', unitSizeArg: '0' })),
        'en faktor på 0 accepteres ikke');
    check(kaster(() => resolveUnits({ recipe: slider, units: UNITS, conversions: [], productId: null,
                                      stockUnitArg: 'Fantasi' }), 'svarer ikke til nogen'),
        'en ukendt lager-enhed afvises');
}

head('En omregning der findes i forvejen er sandheden');
{
    const conv = [{ product_id: 225, from_qu_id: 8, to_qu_id: 4, factor: '0.06' }];
    // En assert der KASTER er et dårligere signal end en der fejler: stakken
    // skjuler hvad der gik galt. Så vi fanger og lader den fælde sit eget navn.
    let r = null, kastede = null;
    try {
        r = resolveUnits({ recipe: slider, units: UNITS, conversions: conv,
                           productId: 225, stockUnitArg: 'Kilo' });
    } catch (e) { kastede = e.message; }
    check(r !== null, `den bruges — uden at --unit-size skal angives${kastede ? ` (kastede: ${kastede})` : ''}`);
    check(r && near(r.factor, 0.06), 'med den faktor der står i Grocy');
    check(r && r.createConversion === null, 'og der laves ikke en til ved siden af');

    // Et andet produkts omregning må ikke smitte af.
    const r2 = () => resolveUnits({ recipe: slider, units: UNITS, conversions: conv,
                                    productId: 999, stockUnitArg: 'Kilo' });
    check(kaster(r2, '--unit-size'), 'omregningen er produkt-scopet — den gælder ikke et andet produkt');
}

head('Menu-mængden skal ende i lager-enhed');
{
    // Drifts-tilfældet: hver af de 12 slider-menuer nester med servings = 1.
    check(near(menuAmountStock(1, 1, 0.06), 0.06),
        'slider-menu: 1 portion × 1 antal × 0,06 → 0,06 kg (var 1 før fixet — 16× for meget)');
    check(near(menuAmountStock(0.25, 1, 1), 0.25), 'blanding: uændret når faktoren er 1');
    check(near(menuAmountStock(0.035, 1, 1), 0.035), 'og på små mængder også');
    check(near(menuAmountStock(2, 1.115, 1), 2.23), 'udbytte ≠ 1 bæres med (Tahin 1,115)');
}

head('Forslaget til --unit-size er et hint, ikke en værdi');
{
    const products = [
        { id: 1, name: 'Brød Rug', qu_id_stock: 4 },
        { id: 2, name: 'Salt',     qu_id_stock: 4 },
    ];
    // 32 brød = 3,84 kg → 64 sliders. Entydigt: én ingrediens i mållageret.
    check(near(suggestUnitSize([{ product_id: 1, amount: 3.84 }], products, 4, 64), 0.06),
        'én ingrediens i mållageret → 3,84 / 64 = 0,06');
    check(suggestUnitSize([{ product_id: 1, amount: 3.84 }, { product_id: 2, amount: 0.1 }], products, 4, 64) === null,
        'to ingredienser → intet forslag (svaret er ikke entydigt)');
    check(suggestUnitSize([{ product_id: 1, amount: 3.84 }], products, 4, 0) === null,
        'uden et udbytte kan der ikke regnes');
    check(suggestUnitSize([], products, 4, 64) === null, 'ingen ingredienser → intet forslag');
}

head('Lokation og varegruppe vælges — de gættes ikke');
{
    // De rigtige rækker fra grocy-hq: gættet satte Remoulade i Fryseren (4),
    // og dressingerne hører til i 05 Dressinger (14), ikke 02 Pålæg (2).
    const LOK = [{ id: 3, name: 'Externt Lager' }, { id: 4, name: 'Fryser' },
                 { id: 5, name: 'Hylder' }, { id: 6, name: 'Køleskab' }];
    const GRP = [{ id: 2, name: '02 Pålæg' }, { id: 14, name: '05 Dressinger' },
                 { id: 9, name: '10 Emballage' }];

    check(resolveNamed(LOK, '6', 'location').name === 'Køleskab', 'id virker');
    check(resolveNamed(LOK, 'Køleskab', 'location').id === 6, 'eksakt navn virker');
    check(resolveNamed(LOK, 'køleskab', 'location').id === 6, 'og det er ligeglad med store bogstaver');
    check(resolveNamed(LOK, 'køl', 'location').id === 6, 'et entydigt stumpe-navn virker');
    check(resolveNamed(GRP, 'Dressinger', 'group').id === 14, 'gruppen kan også vælges på navn');

    check(kaster(() => resolveNamed(LOK, '', 'location'), 'gættes ikke'),
        'uden valg afbrydes der — det er hele pointen');
    check(kaster(() => resolveNamed(LOK, '', 'location'), 'Køleskab'),
        'og listen står i beskeden, så man kan vælge med det samme');
    check(kaster(() => resolveNamed(LOK, 'Findes ikke', 'location'), 'findes ikke'),
        'et ukendt navn afvises');
    check(kaster(() => resolveNamed(GRP, '0', 'group'), 'findes ikke'),
        'et ukendt id afvises');

    // "Lager" ligger i både "Externt Lager" og ingen andre her — men et stumpe
    // der peger flere steder hen må ikke vælge på egen hånd.
    const TVETYDIG = [{ id: 1, name: 'Køl 1' }, { id: 2, name: 'Køl 2' }];
    check(kaster(() => resolveNamed(TVETYDIG, 'Køl', 'location'), 'passer på flere'),
        'et tvetydigt stumpe-navn afvises frem for at vælge det første');
    check(resolveNamed(TVETYDIG, 'Køl 2', 'location').id === 2, 'men det fulde navn er stadig entydigt');
}

head('Genbrug af et eksisterende produkt måles mod LAGER-enheden');
{
    const kilo = { id: 4, name: 'Kilo' }, antal = { id: 8, name: 'Antal' };

    // Drifts-tilfældet: skårne slider-brød lagerføres i kilo, udbyttet er i
    // sliders. Måltes der mod udbyttet, ville et helt korrekt produkt blive
    // afvist — og en fortrudt konvertering kunne ikke køres igen.
    check(checkReusableProduct({ id: 225, name: 'Skære Slider Brød', qu_id_stock: 4 }, kilo) === null,
        'produkt i Kilo + --stock-unit Kilo → genbruges, selvom udbyttet er i Antal');

    const fejl = checkReusableProduct({ id: 226, name: 'Gammel vare', qu_id_stock: 8 }, kilo);
    check(typeof fejl === 'string', 'et produkt i den forkerte lager-enhed afvises stadig (#360)');
    check(typeof fejl === 'string' && fejl.includes('Kilo'),
        'og beskeden siger hvilken enhed der forventes');

    check(checkReusableProduct({ id: 227, name: 'Remoulade', qu_id_stock: 4 }, kilo) === null,
        'en almindelig blanding er upåvirket');
    check(typeof checkReusableProduct({ id: 228, name: 'X', qu_id_stock: 4 }, antal) === 'string',
        'og vagten virker begge veje');
}

head('Hele konverteringen vs. kun sidste tredjedel (#559)');
{
    const frisk  = { id: 110, name: 'Chili Mayo', product_id: null };
    const nul    = { id: 110, name: 'Chili Mayo', product_id: '0' };
    const koblet = { id: 110, name: 'Chili Mayo', product_id: '34' };

    const m1 = resolveMode({ recipe: frisk, produktNavn: null, kunRewire: false });
    check(m1.kunRewire === false && m1.productId === null,
        'opskrift uden produkt + uden flag → almindelig konvertering');

    // Grocy skriver "0" for "producerer intet". Læses det som et id, ville
    // konverteringen tro at produktet fandtes og springe oprettelsen over.
    const m2 = resolveMode({ recipe: nul, produktNavn: null, kunRewire: false });
    check(m2.kunRewire === false && m2.productId === null,
        'product_id "0" tælles som INTET produkt, ikke som id 0');

    const m3 = resolveMode({ recipe: koblet, produktNavn: 'Chili Mayo', kunRewire: true });
    check(m3.kunRewire === true && m3.productId === 34,
        'opskrift der allerede producerer + --kun-rewire → rewire mod produkt 34');

    check(kaster(() => resolveMode({ recipe: koblet, produktNavn: 'Chili Mayo', kunRewire: false }),
        '--kun-rewire'),
        'allerede koblet UDEN flag afvises — og beskeden peger på flaget');

    check(kaster(() => resolveMode({ recipe: frisk, produktNavn: null, kunRewire: true }),
        'intet at flytte'),
        '--kun-rewire på en opskrift uden produkt afvises — der er intet at pege på');

    check(kaster(() => resolveMode({ recipe: nul, produktNavn: null, kunRewire: true })),
        'og "0" tæller heller ikke her som et produkt');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail ? 1 : 0);
