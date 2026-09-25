// scripts/audit-indkob-enheder.js
// ============================================================
// Hvilke indkøbsvarer mangler en vej fra leverandørens enhed til vores?
//
// En vare har tre enheder i spil, og kun to af springene er løst:
//
//   1. Leverandørens salgsenhed → leverandørens basisenhed   (karton → pose)
//   2. Grocys indkøbsenhed      → Grocys lagerenhed          (kasse  → kg)
//   3. Leverandørens basisenhed ⟷ Grocys indkøbsenhed        (pose   → ?)
//
// Spring 2 klarer `resolveToStockAmount()` (#358). Spring 1 er Fase A's A2.
// Spring 3 har ingen ejer — og uden det kan en bestilling på "1 karton"
// ikke oversættes til noget lageret forstår. Se docs/indkob/CLAUDE_INDKOB_FASE_A.md §5.4.
//
// Dette script tæller hvor mange koblinger der mangler hvad, så listen kan
// udfyldes ét sted i stedet for at blive opdaget én vare ad gangen.
//
// READ-ONLY. Rører hverken Grocy, Hørkram eller databasen.
//
//   node --experimental-sqlite scripts/audit-indkob-enheder.js
//   node --experimental-sqlite scripts/audit-indkob-enheder.js --hoka
//   node --experimental-sqlite scripts/audit-indkob-enheder.js --csv enheder.csv
//
// --hoka slår varenumrene op hos Hørkram og viser hvilke salgsenheder de
//        faktisk sælges i. Kræver HORKRAM_USER + HORKRAM_PASS i .env.
//        Uden flaget bruges kun det Grocy allerede ved.
// --csv  skriver hele listen til en fil med en tom kolonne "beslutning",
//        så den kan gennemgås uden for en terminal.
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

const WITH_HOKA = process.argv.includes('--hoka');
const CSV_PATH  = (() => {
    const i = process.argv.indexOf('--csv');
    return i > -1 ? (process.argv[i + 1] || 'indkob-enheder.csv') : null;
})();

// Hørkram er den eneste leverandør vi henter enheder fra i dag. Andre
// handelssteder tages med i optællingen, men uden opslag.
const HOKA_LOCATION_NAME = 'Hørkram';

function fmt(v, fallback = '—') {
    if (v === null || v === undefined || v === '') return fallback;
    return String(v);
}

function pad(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

// Akse 3: kan leverandørens basisenhed oversættes til vores indkøbsenhed?
//   'ens'     — de måler det samme (begge stk-agtige)
//   'kendt'   — vi køber i kg og kender vægten pr. basisenhed
//   'volumen' — vi køber i liter, Hørkram regner i kg. Springet skal bindes
//   'mangler' — vi ved det ikke, og så skal nogen veje eller spørge
//   'ukendt'  — kørt uden --hoka, så leverandørens side er ikke hentet
const STK_ENHEDER    = ['antal', 'stk', 'pakke', 'kasse', 'pose', 'flaske', 'glas', 'bundt', 'karton', 'fustage'];
const VAEGT_ENHEDER  = ['kilo', 'gram'];
const VOLUMEN_ENHEDER = ['liter', 'ml'];

function akse3Status(r) {
    if (!r.hoka_basis && !r.hoka_kg) return 'ukendt';
    const kob = String(r.grocy_kob || '').toLowerCase();
    // Køber vi i kilo, skal vi vide hvad én basisenhed vejer.
    if (VAEGT_ENHEDER.includes(kob)) return r.hoka_kg ? 'kendt' : 'mangler';
    // Køber vi i liter, mens Hørkram regner i kg, er tallene ikke det samme.
    // Vand er 1:1, olie er ikke — så det skal bindes pr. vare, ikke gættes.
    if (VOLUMEN_ENHEDER.includes(kob)) return 'volumen';
    // Køber vi i stk-agtige enheder, måler begge sider i stykker.
    if (STK_ENHEDER.includes(kob)) return 'ens';
    return 'mangler';
}

async function main() {
    const [products, barcodes, conversions, units, locations] = await Promise.all([
        grocy.getProducts(),
        grocy.getProductBarcodes(),
        grocy.getQuantityUnitConversions(),
        grocy.getQuantityUnits(),
        grocy.getShoppingLocations().catch(() => []),
    ]);

    const unitName = id => units.find(u => parseInt(u.id) === parseInt(id))?.name || (id ? `enhed ${id}` : null);
    const locName  = id => locations.find(l => parseInt(l.id) === parseInt(id))?.name || null;
    const prodById = new Map(products.map(p => [parseInt(p.id), p]));

    const rows = [];
    for (const bc of barcodes) {
        const p = prodById.get(parseInt(bc.product_id));
        if (!p || p.active === 0) continue;

        const uf        = bc.userfields || {};
        const kob       = parseInt(p.qu_id_purchase);
        const lager     = parseInt(p.qu_id_stock);
        const faktor    = kob === lager
            ? 1
            : findConversionFactor(conversions, parseInt(p.id), kob, lager);

        rows.push({
            produkt:        p.name,
            produkt_id:     parseInt(p.id),
            leverandor:     locName(bc.shopping_location_id) || '—',
            varenr:         bc.barcode,
            grocy_kob:      unitName(kob),
            grocy_lager:    unitName(lager),
            omregning:      faktor,                       // null = mangler
            bc_enhed:       unitName(bc.qu_id),           // stregkodens egen enhed
            bc_maengde:     bc.amount,                    // … og mængde
            lev_enhed:      uf.supplier_unit_code || null,
            lev_antal:      uf.supplier_unit_qty || null,
            pakstorrelse:   uf.pack_size_stock_unit || null,
            aftale:         uf.is_agreement_item === '1',
            // fyldes af --hoka
            hoka_enheder:   null,   // fx "kt×5 / ps"
            hoka_basis:     null,   // Hørkrams basisenhed, fx "ps"
            hoka_kg:        null,   // kg pr. basisenhed, når den kan udledes
            hoka_kg_kilde:  null,   // 'oplyst' | 'udledt af pris' — aldrig et gæt
        });
    }

    if (WITH_HOKA) await berigMedHorkram(rows);

    // ---- klassificér -------------------------------------------------
    // Rækkefølgen er bevidst: en manglende omregning gør resten ligegyldig,
    // for så kan tallet ikke nå lageret uanset hvad leverandøren siger.
    // Akse 3 (leverandørens basisenhed ⟷ vores indkøbsenhed) er den sidste
    // og den eneste ingen ejer i dag — se §5.4 i Fase A.
    for (const r of rows) {
        r.akse3 = akse3Status(r);
        if (r.omregning === null)        r.mangler = 'omregning køb→lager';
        else if (r.akse3 === 'mangler')  r.mangler = 'vægt pr. leverandør-enhed';
        else if (r.akse3 === 'volumen')  r.mangler = 'liter mod kilo';
        else if (!r.lev_enhed)           r.mangler = 'enhed på koblingen';
        else if (!r.pakstorrelse)        r.mangler = 'pakstørrelse';
        else                             r.mangler = null;
    }

    const manglerOmregning = rows.filter(r => r.mangler === 'omregning køb→lager');
    const manglerAkse3     = rows.filter(r => r.mangler === 'vægt pr. leverandør-enhed');
    const manglerVolumen   = rows.filter(r => r.mangler === 'liter mod kilo');
    const manglerEnhed     = rows.filter(r => r.mangler === 'enhed på koblingen');
    const manglerPak       = rows.filter(r => r.mangler === 'pakstørrelse');
    const klar             = rows.filter(r => !r.mangler);
    const hoka             = rows.filter(r => r.leverandor === HOKA_LOCATION_NAME);

    console.log('\n═══ Indkøb: enheder på leverandør-koblingerne ═══\n');
    console.log(`Koblinger i alt (aktive varer):        ${rows.length}`);
    console.log(`  heraf hos ${HOKA_LOCATION_NAME}:${' '.repeat(Math.max(1, 24 - HOKA_LOCATION_NAME.length))}${hoka.length}`);
    console.log('');
    console.log(`Mangler omregning køb → lager:         ${manglerOmregning.length}   ← varen kan ikke lægges på lager`);
    if (WITH_HOKA) {
        console.log(`Mangler vægt pr. leverandør-enhed:     ${manglerAkse3.length}   ← akse 3: vi køber i kg, men ved ikke hvad én pose vejer`);
        console.log(`Liter mod kilo:                        ${manglerVolumen.length}   ← akse 3: vi køber i liter, Hørkram regner i kg`);
    }
    console.log(`Mangler leverandørens enhed:           ${manglerEnhed.length}   ← skærmen gætter enheden`);
    console.log(`Mangler pakstørrelse:                  ${manglerPak.length}   ← mængden regnes som 1 pr. pakke`);
    console.log(`Komplette:                             ${klar.length}\n`);

    const visGruppe = (titel, liste, note) => {
        if (!liste.length) return;
        console.log(`── ${titel} (${liste.length}) ──`);
        if (note) console.log(`   ${note}`);
        console.log(`   ${pad('vare', 28)} ${pad('varenr', 10)} ${pad('køb', 7)} ${pad('lev.enhed', 9)} ${WITH_HOKA ? pad('basis', 6) + pad('kg/basis', 10) + 'Hørkram sælger i' : ''}`);
        for (const r of liste.slice(0, 40)) {
            const kg = r.hoka_kg ? `${r.hoka_kg}${r.hoka_kg_kilde === 'udledt af pris' ? ' *' : ''}` : '—';
            const hoka = WITH_HOKA ? pad(fmt(r.hoka_basis), 6) + pad(kg, 10) + fmt(r.hoka_enheder, '') : '';
            console.log(`   ${pad(r.produkt, 28)} ${pad(r.varenr, 10)} ${pad(fmt(r.grocy_kob), 7)} ${pad(fmt(r.lev_enhed), 9)} ${hoka}`);
        }
        if (liste.length > 40) console.log(`   … og ${liste.length - 40} mere (brug --csv for hele listen)`);
        console.log('');
    };

    visGruppe('Mangler omregning', manglerOmregning,
        'Ret i Grocy: varen → Quantity unit conversions → køb → lager med den rigtige faktor.');
    visGruppe('Mangler vægt pr. leverandør-enhed (akse 3)', manglerAkse3,
        'Vi køber varen i kilo, men Hørkram sælger den i poser/kartoner og oplyser ingen vægt. Vej én, eller spørg Hørkram.');
    visGruppe('Liter mod kilo (akse 3)', manglerVolumen,
        'Vi køber i liter, Hørkram regner i kg. Vand er 1:1, olie er ikke — bind det pr. vare.');
    visGruppe('Mangler leverandørens enhed', manglerEnhed,
        'Sættes ved koblingen i Indstillinger → Indkøb → Hørkram, eller ved at koble varen igen.');
    visGruppe('Mangler pakstørrelse', manglerPak,
        'pack_size_stock_unit på stregkoden — hvor meget af lagerenheden der er i én pakke.');

    if (!WITH_HOKA) {
        console.log('Kør med --hoka for at se hvilke salgsenheder Hørkram faktisk har på varerne.\n');
    }

    if (CSV_PATH) {
        const head = ['produkt', 'produkt_id', 'leverandor', 'varenr', 'grocy_kob', 'grocy_lager',
            'omregning', 'stregkode_enhed', 'stregkode_maengde', 'lev_enhed', 'lev_antal',
            'pakstorrelse', 'aftale', 'hoerkram_salgsenheder', 'hoerkram_basisenhed',
            'kg_pr_basisenhed', 'kg_kilde', 'akse3', 'mangler', 'beslutning'];
        const esc = v => {
            const s = v === null || v === undefined ? '' : String(v);
            return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const lines = [head.join(';')];
        for (const r of rows) {
            lines.push([r.produkt, r.produkt_id, r.leverandor, r.varenr, r.grocy_kob, r.grocy_lager,
                r.omregning === null ? 'MANGLER' : r.omregning, r.bc_enhed, r.bc_maengde,
                r.lev_enhed, r.lev_antal, r.pakstorrelse, r.aftale ? 'ja' : '',
                r.hoka_enheder, r.hoka_basis, r.hoka_kg, r.hoka_kg_kilde, r.akse3,
                r.mangler, ''].map(esc).join(';'));
        }
        fs.writeFileSync(CSV_PATH, '﻿' + lines.join('\n'), 'utf8');
        console.log(`Skrevet til ${CSV_PATH} — kolonnen "beslutning" står tom til gennemgangen.\n`);
    }
}

// Slår varenumrene op hos Hørkram og noterer hvilke salgsenheder de har.
// Fejler opslaget, står feltet tomt — vi gætter aldrig på en enhed.
async function berigMedHorkram(rows) {
    let fetchSnapshotSummaries;
    try {
        ({ fetchSnapshotSummaries } = require('../routes/horkram'));
    } catch (err) {
        console.error(`Kunne ikke indlæse Hørkram-modulet: ${err.message}\n`);
        return;
    }
    const ids = rows
        .filter(r => r.leverandor === HOKA_LOCATION_NAME && /^\d+$/.test(String(r.varenr)))
        .map(r => String(r.varenr));
    if (!ids.length) return;

    console.log(`Slår ${ids.length} varenumre op hos Hørkram …`);
    let res;
    try {
        res = await fetchSnapshotSummaries(ids);
    } catch (err) {
        console.error(`Hørkram-opslaget fejlede: ${err.message}. Kolonnen står tom.\n`);
        return;
    }

    const byId = new Map();
    for (const p of (res?.products || [])) byId.set(String(p.varenummer), p);

    let ramt = 0, doede = 0, udledt = 0;
    for (const r of rows) {
        const p = byId.get(String(r.varenr));
        if (!p) { if (r.leverandor === HOKA_LOCATION_NAME) doede++; continue; }
        ramt++;

        const su = p.salesUnits || [];
        if (su.length) {
            r.hoka_enheder = su.map(u => `${u.code}${Number(u.quantity) !== 1 ? `×${u.quantity}` : ''}${u.isDefault ? ' (std)' : ''}`).join(' / ');
        }
        r.hoka_basis = p.baseUnitCode || null;

        // Vægten pr. basisenhed: Hørkram oplyser den nogle gange direkte.
        // Ellers kan den udledes af de to priser — men så skal det stå at
        // den er udledt, så ingen læser den som en måling.
        if (p.netWeightKg) {
            r.hoka_kg = Number(p.netWeightKg);
            r.hoka_kg_kilde = 'oplyst';
        } else if (p.pricePerUnit && p.pricePerKg && Number(p.pricePerKg) > 0) {
            const kg = Number(p.pricePerUnit) / Number(p.pricePerKg);
            if (isFinite(kg) && kg > 0) {
                r.hoka_kg = Math.round(kg * 1000) / 1000;
                r.hoka_kg_kilde = 'udledt af pris';
                udledt++;
            }
        }
    }
    console.log(`  ${ramt} varenumre svarede, ${doede} gav intet svar (typisk udgået).`);
    console.log(`  ${udledt} af vægtene er udledt af pris pr. enhed ÷ pris pr. kg — markeret med * og skal bekræftes.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
