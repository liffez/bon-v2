// scripts/ensure-grocy-userfields.js
// ============================================================
// Grocys userfields er stamdata som Bon LÆSER, men som ingen migration kan
// oprette. Står feltet ikke i instansen, fejler koden — og fejlen viser sig
// som et tomt felt, ikke som en fejlbesked.
//
// HVORFOR SCRIPTET FINDES
// CLAUDE.md har hidtil sagt "skal oprettes manuelt i Grocy". Det er et
// deploy-trin uden en tjekliste, og det gælder pr. instans: HQ, trailer og
// test kan drive fra hinanden uden at nogen opdager det. Målt 21.09.2026 var
// HQ og test enige (92 hver) — men kun fordi test lige var overskrevet med en
// kopi. `cafe` havde 83. Drift er den naturlige tilstand.
//
// HVAD DET GØR OG IKKE GØR
//   • Opretter felter der MANGLER. Aldrig andet.
//   • Rører ALDRIG et felt der findes: ikke type, ikke caption, ikke config.
//     Et felts type kan ikke ændres uden at man skal tage stilling til de
//     værdier der allerede står i det.
//   • Sletter aldrig noget.
//   • Holder sig til de fire entiteter Bon selv skriver i. `userentity-*`,
//     `equipment` og `chores` tilhører andre apps og rører vi ikke.
//
// Kør:
//   node scripts/ensure-grocy-userfields.js --location hq            (tjek)
//   node scripts/ensure-grocy-userfields.js --diff hq,test           (sammenlign)
//   node scripts/ensure-grocy-userfields.js --location test --apply  (opret)
// ============================================================
'use strict';

require('dotenv').config({ quiet: true });

/* ══════════════════════════════════════════════════════════════
   Erklæringen — de felter Bon selv læser eller skriver
   ══════════════════════════════════════════════════════════════
   `brugt` peger på hvem der bruger feltet, så en oprydning kan se hvad der
   går i stykker hvis feltet fjernes. Felter der findes i drift uden at Bon
   rører dem, står under `kendt`: de rapporteres, men oprettes ikke — vi
   opretter kun det vi kan pege på en linje kode for.
*/
const T = {
    tekst: 'text-single-line',
    tal: 'number-decimal',
    heltal: 'number-integral',
    flueben: 'checkbox',
    tid: 'datetime',
    liste: 'preset-checklist',
};

const ERKLAERING = {
    products: {
        paakraevet: [
            ['HverDag', T.tekst, 'HverDag', 'Lageroptælling — tjek-interval i dage'],
            ['LastCheckedAt', T.tid, 'LastCheckedAt', 'Optælling, lageroversigt, varemodtagelse'],
            ['LastCheckedUnit', T.tekst, 'LastCheckedUnit', 'Optælling — hvilken fysisk enhed'],
            ['Oeko', T.flueben, 'Øko', 'Visning'],
            ['co2e_per_kg', T.tal, 'CO₂e pr. kg (resolvet)', 'CO₂-modulet'],
            ['co2e_source', T.tekst, 'CO₂e kilde (klimadb|material|supplier|manual|na)', 'CO₂-modulet'],
            ['co2e_klima_id', T.tekst, 'CONCITO Ra-ID', 'CO₂-modulet'],
            ['co2e_material', T.tekst, 'Emballage-materiale (pap, LDPE, …)', 'CO₂ F3'],
            ['co2e_version', T.tekst, 'CO₂e kildeversion (fx CONCITO v1.2)', 'CO₂-modulet'],
            ['co2e_packaging_g', T.tal, 'Emballage pr. stk (g) — CO₂/ESG', 'CO₂-modulet'],
            ['supplier_price_per_kg', T.tekst, 'Leverandør pris/kg', 'Hørkram-priser'],
            ['price_updated_at', T.tekst, 'Pris sidst opdateret', 'Hørkram-priser'],
            ['hk_organic', T.tekst, 'Økologisk (generelt)', 'Hørkram-scraper'],
            ['hk_country', T.tekst, 'Oprindelsesland', 'Hørkram-scraper'],
            ['hk_allergens', T.tekst, 'Allergener', 'Hørkram-scraper'],
            ['hk_co2e', T.tekst, 'CO2e (kg/kg)', 'Hørkram-scraper'],
        ],
        kendt: ['Co2e_OLD', 'hk_energy_kj', 'hk_energy_kcal', 'hk_fat', 'hk_fat_saturated',
                'hk_carbs', 'hk_sugar', 'hk_fiber', 'hk_protein', 'hk_salt'],
    },
    recipes: {
        paakraevet: [
            ['grupper', T.liste, 'Grupper', 'Kategori — læses af alt. Valgmulighederne skal fyldes i hånden'],
            ['recipeunit', T.liste, 'Recipe Enhed', 'Udbyttets enhed. Valgmulighederne skal fyldes i hånden'],
            ['recipeunitnumber', T.tal, 'Antal recipieenheder', 'Udbyttet — lagertræk, kostpris, CO₂'],
            ['sellable', T.flueben, 'salgsbar', 'VarePicker, bestillingsformular'],
            ['Oeko', T.flueben, 'Øko', 'VarePicker'],
            ['costprice', T.tal, 'Kost Pris', 'Kostpris-fallback'],
            ['SalespriceStore', T.tal, 'Salgspris Butik', 'Priskategori'],
            ['SalespriceCatering', T.tal, 'Salgspris Catering', 'Priskategori'],
            ['SalespriceFestival', T.tal, 'Salgspris Festival', 'Priskategori'],
            ['SalespriceProduktion', T.heltal, 'Produktion', 'Priskategori'],
            ['SalespriceWaiste', T.heltal, 'waiste', 'Priskategori'],
            ['Co2e', T.tal, 'Co2e (genberegnet cache — F5)', 'CO₂ F5-motorens cache'],
            ['economic_product_number', T.tekst, 'economic product number', 'Fakturering'],
            ['arbejdstid_min', T.tal, 'Aktiv arbejdstid (min/batch)', 'Opskrift-kalkulationens løn-linje'],
        ],
        kendt: ['Co2e_OLD', 'sellableZettle'],
        planlagt: [
            ['maalvaegt_g', T.tal, 'Målvægt (g mad)',
             'Opskrift-designeren §5 — IKKE besluttet endnu, oprettes kun med --include-planned'],
        ],
    },
    product_barcodes: {
        paakraevet: [
            ['is_preferred', T.tekst, 'Foretrukket', 'Leverandørpriser — hvilket varenummer gælder'],
            ['is_agreement_item', T.tekst, 'Aftalevare', 'Indkøb — chip-sortering'],
            ['pack_size_stock_unit', T.tekst, 'pakke enhed', 'Indkøb — pakkestørrelse'],
            ['supplier_unit_code', T.tekst, 'supplier_unit_code', 'Hørkram-kurv'],
            ['supplier_unit_qty', T.tekst, 'supplier_unit_qty', 'Hørkram-kurv'],
            ['hk_gtin', T.tekst, 'EAN/GTIN', 'Varemodtagelse — kode-opslag'],
            ['hk_price_per_unit', T.tekst, 'Enhedspris (DKK)', 'Leverandørpriser'],
            ['hk_scraped_at', T.tekst, 'Sidst hentet', 'Hørkram-scraper'],
            ['hk_organic', T.tekst, 'Økologisk', 'Hørkram-scraper'],
            ['hk_country', T.tekst, 'Oprindelsesland', 'Hørkram-scraper'],
            ['hk_allergens', T.tekst, 'Allergener', 'Hørkram-scraper'],
        ],
        kendt: ['hk_brand', 'hk_url', 'hk_image', 'hk_markings', 'hk_manufacturer'],
    },
    shopping_list: {
        paakraevet: [
            ['ordered_at', T.tekst, 'Bestilt tidspunkt', 'Bestilling'],
            ['ordered_qty', T.tekst, 'Bestilt mængde', 'Bestilling'],
            ['ordered_supplier', T.tekst, 'Leverandør', 'Bestilling'],
            ['ordered_varenr', T.tekst, 'Bestilt varenr', 'Bestilling'],
        ],
        kendt: [],
    },
};

/* ══════════════════════════════════════════════════════════════
   Hjælpere
   ══════════════════════════════════════════════════════════════ */

/**
 * To skrivemåder for samme type findes i drift: 24 felter i HQ står som
 * `text_single_line` med underscores, hvilket ikke er en gyldig Grocy-type —
 * de er oprettet med en tastefejl, og Grocy har gemt den. Uden den her ville
 * scriptet melde falsk drift mellem to instanser der er enige.
 */
const normType = (t) => String(t || '').replace(/_/g, '-').toLowerCase();

function instans(kode) {
    const k = String(kode).toUpperCase();
    const url = process.env[`GROCY_${k}_URL`];
    const key = process.env[`GROCY_${k}_KEY`];
    if (!url || !key) {
        throw new Error(`Lokationen "${kode}" mangler GROCY_${k}_URL og/eller GROCY_${k}_KEY i .env`);
    }
    return { kode, url: url.replace(/\/+$/, ''), key };
}

async function hent(i) {
    const r = await fetch(i.url + '/objects/userfields', { headers: { 'GROCY-API-KEY': i.key } });
    if (!r.ok) throw new Error(`${i.kode}: HTTP ${r.status} fra /objects/userfields`);
    const uf = await r.json();
    const m = new Map();
    for (const u of uf) m.set(u.entity + '.' + u.name, u);
    return m;
}

async function opret(i, entity, navn, type, caption) {
    const r = await fetch(i.url + '/objects/userfields', {
        method: 'POST',
        headers: { 'GROCY-API-KEY': i.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, name: navn, caption, type,
                               show_as_column_in_tables: 0, config: null }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 160)}`);
    let id = null;
    try { id = JSON.parse(t).created_object_id; } catch (e) { /* Grocy svarer altid JSON */ }
    if (!id) throw new Error('Grocy returnerede intet id');
    return Number(id);
}

/** Alt der skal findes, fladt. `planlagt` kun når brugeren beder om det. */
function kraevede(medPlanlagte) {
    const ud = [];
    for (const [entity, e] of Object.entries(ERKLAERING)) {
        for (const [navn, type, caption, brugt] of e.paakraevet) {
            ud.push({ entity, navn, type, caption, brugt, planlagt: false });
        }
        if (medPlanlagte) {
            for (const [navn, type, caption, brugt] of (e.planlagt || [])) {
                ud.push({ entity, navn, type, caption, brugt, planlagt: true });
            }
        }
    }
    return ud;
}

const ERKLAERET_NAVNE = new Set(
    Object.entries(ERKLAERING).flatMap(([entity, e]) =>
        [...e.paakraevet.map(f => entity + '.' + f[0]),
         ...(e.planlagt || []).map(f => entity + '.' + f[0]),
         ...e.kendt.map(n => entity + '.' + n)]));

/* ══════════════════════════════════════════════════════════════
   Kommandoerne
   ══════════════════════════════════════════════════════════════ */

async function tjek(kode, { apply, medPlanlagte }) {
    const i = instans(kode);
    const har = await hent(i);
    const skal = kraevede(medPlanlagte);

    const mangler = [], afvigendeType = [];
    for (const f of skal) {
        const u = har.get(f.entity + '.' + f.navn);
        if (!u) { mangler.push(f); continue; }
        if (normType(u.type) !== normType(f.type)) {
            afvigendeType.push({ ...f, faktisk: u.type });
        }
    }

    console.log(`\n── ${kode} (${i.url}) ──`);
    console.log(`   ${har.size} userfields i instansen · ${skal.length} erklæret af Bon`);

    if (!mangler.length) {
        console.log('   \x1b[32m✓\x1b[0m intet mangler');
    } else {
        console.log(`   \x1b[33m${mangler.length} mangler:\x1b[0m`);
        for (const f of mangler) {
            console.log(`     ${f.entity}.${f.navn}  (${f.type})` +
                        (f.planlagt ? '  [planlagt]' : '') + `  — ${f.brugt}`);
        }
    }

    // Typeafvigelser rettes ALDRIG automatisk: feltet har værdier i sig, og en
    // typeændring er en beslutning om dem.
    if (afvigendeType.length) {
        console.log(`   \x1b[33m${afvigendeType.length} har en anden type end erklæret\x1b[0m (rettes i hånden):`);
        for (const f of afvigendeType) {
            console.log(`     ${f.entity}.${f.navn}: står som "${f.faktisk}", erklæret "${f.type}"`);
        }
    }

    // Felter Bon aldrig rører — kun til orientering.
    const bonsEntiteter = new Set(Object.keys(ERKLAERING));
    const ukendte = [...har.values()]
        .filter(u => bonsEntiteter.has(u.entity) && !ERKLAERET_NAVNE.has(u.entity + '.' + u.name))
        .map(u => u.entity + '.' + u.name);
    if (ukendte.length) {
        console.log(`   ${ukendte.length} felt(er) på Bons entiteter som erklæringen ikke kender: ${ukendte.join(', ')}`);
    }

    if (!apply) {
        if (mangler.length) console.log('\n   Kør med --apply for at oprette dem.');
        return { mangler, oprettet: [] };
    }

    const oprettet = [], fejlede = [];
    for (const f of mangler) {
        try {
            const id = await opret(i, f.entity, f.navn, f.type, f.caption);
            oprettet.push(f);
            console.log(`   \x1b[32m+\x1b[0m oprettet ${f.entity}.${f.navn} (id ${id})`);
            if (f.type === T.liste) {
                console.log(`     \x1b[33m⚠\x1b[0m valgmulighederne er TOMME — udfyld dem i Grocy, ` +
                            `ellers står feltet uden indhold`);
            }
        } catch (e) {
            fejlede.push({ f, error: e.message });
            console.log(`   \x1b[31m✗\x1b[0m ${f.entity}.${f.navn}: ${e.message}`);
        }
    }
    console.log(`\n   ${oprettet.length} oprettet · ${fejlede.length} fejlede`);
    return { mangler, oprettet, fejlede };
}

async function diff(koder) {
    const [a, b] = koder.map(instans);
    const [ha, hb] = await Promise.all([hent(a), hent(b)]);
    const alle = new Set([...ha.keys(), ...hb.keys()]);

    const kunA = [], kunB = [], typeDiff = [];
    for (const k of alle) {
        const ua = ha.get(k), ub = hb.get(k);
        if (ua && !ub) kunA.push(k);
        else if (!ua && ub) kunB.push(k);
        else if (normType(ua.type) !== normType(ub.type)) {
            typeDiff.push(`${k}: ${a.kode}=${ua.type} · ${b.kode}=${ub.type}`);
        }
    }

    console.log(`\n── ${a.kode} (${ha.size}) mod ${b.kode} (${hb.size}) ──`);
    const vis = (titel, liste) => {
        if (!liste.length) { console.log(`   \x1b[32m✓\x1b[0m ${titel}: ingen`); return; }
        console.log(`   \x1b[33m${titel} (${liste.length}):\x1b[0m`);
        liste.sort().forEach(x => console.log('     ' + x));
    };
    vis(`kun i ${a.kode}`, kunA);
    vis(`kun i ${b.kode}`, kunB);
    vis('forskellig type', typeDiff);
    return { kunA, kunB, typeDiff };
}

/* ══════════════════════════════════════════════════════════════ */

async function main() {
    const arg = process.argv.slice(2);
    const værdi = (navn) => { const i = arg.indexOf(navn); return i >= 0 ? arg[i + 1] : null; };
    const apply = arg.includes('--apply');
    const medPlanlagte = arg.includes('--include-planned');
    const d = værdi('--diff');

    if (d) {
        const koder = d.split(',').map(s => s.trim()).filter(Boolean);
        if (koder.length !== 2) throw new Error('--diff tager præcis to lokationer, fx --diff hq,test');
        if (apply) throw new Error('--diff er read-only; brug --location … --apply for at oprette');
        await diff(koder);
        return;
    }

    const kode = værdi('--location');
    if (!kode) {
        throw new Error('Angiv --location <kode> (fx hq, test). Lokationen skal navngives ' +
                        'eksplicit — et script der gætter kan skrive i den forkerte instans.');
    }
    const r = await tjek(kode, { apply, medPlanlagte });
    if (!apply && r.mangler.length) process.exitCode = 1;   // brugbar i en tjekliste
}

if (require.main === module) {
    main().catch(e => { console.error('\x1b[31m' + e.message + '\x1b[0m'); process.exit(2); });
}

module.exports = { ERKLAERING, kraevede, normType, ERKLAERET_NAVNE };
