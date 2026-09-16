// scripts/test-preview-produced.js
// ============================================================
// Pakkelistens forhåndsvisning må ikke råbe ulven om noget Bon selv laver.
//
// Efter konverteringen (#270) står et mellemprodukt normalt på 0 mellem to
// leveringer — det er meningen. Viste forhåndsvisningen det som en almindelig
// mangel, ville køkkenet se "Frisk Grønt mangler 13 kg" på 28 retter og ikke
// kunne skelne det fra en ægte mangel. Så holder alarmen op med at betyde noget,
// og den ægte mangel drukner.
//
// De to kategorier har hver sit svar (§2):
//   Hurtig  — Bon laver den ved LEVERET. Rækker råvarerne, er der intet at gøre.
//   RR      — personalet laver den efter plan. Bon rører den ALDRIG.
//
//   node scripts/test-preview-produced.js
// ============================================================
'use strict';
const { classifyProducedShortfall } = require('../services/grocyAdapter');
const { productionTypeOf, HURTIG_GROUP } = require('../services/ingredientResolver');

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

// Prædikatet kommer fra ingredientResolver — grænsen mellem de to kategorier
// defineres ÉT sted (#329), og både auto-batchen, forhåndsvisningen og selve
// lagertrækket spørger dér. Testes her, så en omdøbning af gruppen ikke tavst
// deler dem i to.
const erHurtig = (r) => productionTypeOf(r) === 'on_demand';
const HURTIG = { id: 10, name: 'Remoulade',  product_id: 225, userfields: { grupper: 'RR produktion Hurtig' } };
const RR     = { id: 20, name: 'Stegt Gris', product_id: 125, userfields: { grupper: 'RR Produktion' } };

head('Hvem laver varen?');
{
    check(classifyProducedShortfall(undefined, undefined, erHurtig).produced_by === null,
        'en almindelig råvare produceres ikke — den købes, som før');
    check(classifyProducedShortfall([], undefined, erHurtig).produced_by === null,
        'tom producent-liste tæller som "ikke produceret"');
    check(classifyProducedShortfall([HURTIG], undefined, erHurtig).produced_by === 'bon',
        'Hurtig → Bon laver den');
    check(classifyProducedShortfall([RR], undefined, erHurtig).produced_by === 'personale',
        'RR Produktion → personalet laver den, Bon rører den aldrig');
    check(classifyProducedShortfall([RR, HURTIG], undefined, erHurtig).produced_by === 'bon',
        'kan varen laves begge veje, er det Bon der gør det ved LEVERET');
}

head('Rækker råvarerne?');
{
    const dækket = classifyProducedShortfall([HURTIG],
        { batches_needed: 1, batches_made: 1, produce_amount: 1, missing: [] }, erHurtig);
    check(dækket.produce_missing.length === 0, 'råvarer nok → ingenting mangler');
    check(dækket.batches_made === 1 && dækket.produce_amount === 1,
        'og forhåndsvisningen kan sige hvor meget der laves');

    // Hele batches: behovet er 0,03 kg, men der laves et helt kilo.
    const helt = classifyProducedShortfall([HURTIG],
        { batches_needed: 1, batches_made: 1, produce_amount: 1, missing: [] }, erHurtig);
    check(helt.produce_amount === 1, 'der laves et HELT batch, ikke den mængde der mangler');

    const spærret = classifyProducedShortfall([HURTIG],
        { batches_needed: 2, batches_made: 0,
          missing: [{ product_name: 'Mayonaise', needed: 1, stock: 0 }] }, erHurtig);
    check(spærret.produce_missing.length === 1 && spærret.produce_missing[0].product_name === 'Mayonaise',
        'råvarerne rækker ikke → den ægte mangel navngives (mayoen, ikke remouladen)');
    check(spærret.produce_missing[0].needed === 1 && spærret.produce_missing[0].stock === 0,
        'med både behov og beholdning, så beskeden kan skrives færdig');

    // Delvis dækning er stadig en mangel: bonen får ikke det den skal bruge.
    const delvis = classifyProducedShortfall([HURTIG],
        { batches_needed: 2, batches_made: 1,
          missing: [{ product_name: 'Relish', needed: 1, stock: 0.5 }] }, erHurtig);
    check(delvis.produce_missing.length === 1,
        'kun 1 af 2 batches → stadig en mangel, ikke "klaret"');
}

head('Grænsen mellem de to kategorier er ÉN definition');
{
    check(HURTIG_GROUP === 'rr produktion hurtig', 'ingredientResolver ejer gruppenavnet');
    check(erHurtig({ product_id: 1, userfields: { grupper: '  RR Produktion Hurtig  ' } }),
        'og normaliseringen tåler mellemrum og store bogstaver');
    check(!erHurtig({ product_id: 1, userfields: { grupper: 'RR Produktion' } }),
        'uden at komme til at fange RR Produktion med');
    check(productionTypeOf({ userfields: { grupper: 'RR produktion Hurtig' } }) === null,
        'en opskrift UDEN produkt har ingen produktionstype — der er intet at trække');
}

head('Vurderingen: skal der råbes op?');
{
    // Reglen bor på serveren. Regnede frontenden den selv, kunne skærmen komme
    // til at sige noget andet end det der faktisk sker ved LEVERET.
    const R = (...a) => classifyProducedShortfall(...a, erHurtig).is_real_shortfall;

    check(R(undefined, undefined) === true,
        'en råvare der mangler → ja, den skal købes');
    check(R([RR], undefined) === true,
        'et RR-produkt der mangler → ja, nogen skal lave den');
    check(R([HURTIG], { batches_needed: 1, batches_made: 1, missing: [] }) === false,
        'Bon laver den, og råvarerne rækker → NEJ, det er ikke en mangel');
    check(R([HURTIG], { batches_needed: 2, batches_made: 0, missing: [{ product_name: 'Mayo' }] }) === true,
        'Bon kan ikke lave den → ja, og det er råvaren der er problemet');
    check(R([HURTIG], { batches_needed: 2, batches_made: 1, missing: [{ product_name: 'Relish' }] }) === true,
        'kun halvdelen kan laves → ja, bonen mangler stadig noget');
    check(R([HURTIG], undefined) === true,
        'Hurtig uden en plan → vi ved det ikke, så alarmen dæmpes ikke');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
process.exit(fail ? 1 : 0);
