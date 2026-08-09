// scripts/check-receipt-unit-conversions.js
// ============================================================
// Hvilke produkter kan varemodtagelsen IKKE længere lægge på lager?
//
// Efter #358 omregner varemodtagelsen fra indkøbs-enhed til lager-enhed i
// stedet for at skrive tallet råt. Findes der ingen omregning i Grocy, nægter
// den — bevidst: et forkert lagertal ser rigtigt ud og opdages først ved en
// fysisk optælling, hvor det til gengæld ligner en uforklarlig difference.
//
// Prisen for den beslutning er at et produkt med forskellig købs- og
// lager-enhed OG uden konvertering nu beder om hjælp i stedet for at gætte.
// Dette script finder dem, så listen kan ordnes i Grocy FØR nogen står med
// varerne i hånden.
//
// READ-ONLY. Rører hverken Grocy eller databasen.
//
//   node --experimental-sqlite scripts/check-receipt-unit-conversions.js
//
// Ret op i Grocy: produktet → "Quantity unit conversions" → tilføj
// købs-enhed → lager-enhed med den rigtige faktor (fx 1 kasse = 7,78 kg).
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const grocy = require('../services/grocyAdapter');
const { findConversionFactor } = require('../services/quConvert');

async function main() {
    const [products, conversions, units, shoppingList] = await Promise.all([
        grocy.getProducts(),
        grocy.getQuantityUnitConversions(),
        grocy.getQuantityUnits(),
        grocy.getShoppingList().catch(() => []),
    ]);

    const unitName = id => units.find(u => parseInt(u.id) === parseInt(id))?.name || `enhed ${id}`;
    const onList   = new Set(shoppingList.map(r => parseInt(r.product_id)));

    const ambiguous = products.filter(p =>
        p.active !== 0 && p.qu_id_stock && p.qu_id_purchase &&
        parseInt(p.qu_id_stock) !== parseInt(p.qu_id_purchase));

    const missing = ambiguous.filter(p =>
        findConversionFactor(conversions, parseInt(p.id),
            parseInt(p.qu_id_purchase), parseInt(p.qu_id_stock)) === null);

    console.log(`\nProdukter i alt (aktive):            ${products.filter(p => p.active !== 0).length}`);
    console.log(`Forskellig købs- og lager-enhed:     ${ambiguous.length}`);
    console.log(`  ├─ har omregning (går igennem):    ${ambiguous.length - missing.length}`);
    console.log(`  └─ MANGLER omregning:              ${missing.length}\n`);

    if (!missing.length) {
        console.log('✓ Alle produkter kan omregnes — varemodtagelsen nægter ingen.\n');
        return 0;
    }

    // Varer der ligger på indkøbslisten lige nu, rammer først — de er på vej hjem.
    const urgent = missing.filter(p => onList.has(parseInt(p.id)));
    const rest   = missing.filter(p => !onList.has(parseInt(p.id)));

    const show = (list, title) => {
        if (!list.length) return;
        console.log(`${title}`);
        for (const p of list) {
            console.log(`  • ${p.name}  (id ${p.id})  køb: ${unitName(p.qu_id_purchase)} → lager: ${unitName(p.qu_id_stock)}`);
        }
        console.log('');
    };

    show(urgent, `⚠ PÅ INDKØBSLISTEN NU — ordn disse først (${urgent.length}):`);
    show(rest,   `Øvrige uden omregning (${rest.length}):`);

    console.log('Ret i Grocy: produktet → Quantity unit conversions → tilføj købs-enhed → lager-enhed.');
    console.log('Indtil da: varemodtagelsen lægger dem IKKE på lager, men skriver en fejl på linjen');
    console.log('og markerer modtagelsen "delvist godkendt". Selve fødevarekontrollen gemmes som altid.\n');
    return urgent.length ? 1 : 0;
}

module.exports = { };

if (require.main === module) {
    main()
        .then(code => process.exit(code))
        .catch(err => { console.error(`FEJL: ${err.message}`); process.exit(2); });
}
