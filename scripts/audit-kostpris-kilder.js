// scripts/audit-kostpris-kilder.js
// ============================================================
// Read-only: hvor kommer kostprisen fra, og hvad flytter sig? (#557 + #558)
//
// Genskaber de to tabeller issuerne bygger på, mod den LEVENDE Grocy, og måler
// hvad prisreglerne betyder i kroner:
//
//   1. Producerede goder: lagerprisen mod hvad opskriften koster at lave.
//      Lagerprisen på noget vi selv laver er et artefakt — `setInventory()`
//      sender ingen pris, så Grocy bærer den forrige videre fra optælling til
//      optælling. Rødløg - Sylt stod 96 % over råvarerne.
//   2. Varer hvor seneste køb ligger langt fra gennemsnittet. Typisk fordi
//      varen har flere varenumre (mayo: 1 kg-pose 114,56 · 5 kg-spand 42,01).
//   3. Effekten pr. opskrift, opdelt på de to regler, så man kan se hvilken
//      der flytter hvad.
//
// FØR-tallet er ikke et gæt: den gamle adfærd genskabes ved at fodre den samme
// beregning med den GAMLE prisrækkefølge (seneste køb først) og ved at fjerne
// `product_id` fra de producerende opskrifter hvis produkt HAR en lagerpris —
// præcis de tilfælde hvor den gamle regel lod lagerprisen vinde. Ingen kopi af
// den gamle kode, og ingen omskiftere i produktionskoden.
//
// SKRIVER INTET — hverken til Grocy eller til databasen. Alle kald er GET.
//
// Kør fra projektroden:
//   node --env-file=.env scripts/audit-kostpris-kilder.js
//   node --env-file=.env scripts/audit-kostpris-kilder.js --alle --csv ud.csv
// ============================================================

'use strict';

const fs = require('fs');
const grocy = require('../services/grocyAdapter');
const {
    computeAll, unitCostDetail, yieldInStockUnits,
    WARN_LAST_VS_AVG_PCT, WARN_STOCK_VS_RECIPE_PCT,
} = require('../services/recipeCost');

const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', b: '\x1b[1m', off: '\x1b[0m' };

const args  = process.argv.slice(2);
const ALLE  = args.includes('--alle');
const CSV   = args.includes('--csv') ? (args[args.indexOf('--csv') + 1] || 'kostpris-effekt.csv') : null;
const TOP   = ALLE ? Infinity : 20;

const kr  = n => (n == null) ? '—' : Number(n).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n == null) ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(0) + ' %';
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** Prisrækkefølgen FØR #557: seneste køb → gennemsnit → lagerværdi/mængde. */
function gammelPrisregel(d) {
    if (!d) return null;
    if (d.last_price > 0) return d.last_price;
    if (d.avg_price > 0) return d.avg_price;
    // `stock_value`/`stock_row`/`parent_avg` var ens før og efter.
    return (d.source === 'avg' || d.source === 'last') ? null : d.cost;
}

/**
 * Den gamle produceret-regel, udtrykt som en ændring af INPUT frem for af
 * beregningen: fjern `product_id` fra de producerende opskrifter hvis produkt
 * HAR en pris. Så findes produktet ikke i `producedBy`, og beregningen falder
 * tilbage på lagerprisen — nøjagtig det den gamle kode gjorde.
 *
 * Goder UDEN pris beholder deres `product_id` og arver fortsat fra opskriften;
 * det gjorde den gamle kode også (#269).
 */
function gammelProduceretRegel(recipes, priserGl) {
    return recipes.map(r => {
        const pid = String(Number(r.product_id) || '');
        return (pid && priserGl.has(pid)) ? { ...r, product_id: null } : r;
    });
}

async function main() {
    const cfg = grocy.getGrocyConfig();
    console.log(`\n${C.b}Kostpris-kilder — ${cfg.locationName}${C.off}`);
    console.log(`${C.dim}${cfg.url}  ·  read-only${C.off}\n`);

    const [recipes, pos, nestings, products, units, conversions] = await Promise.all([
        grocy.getRecipesRaw(), grocy.getAllRecipesPos(), grocy.getRecipeNestings(),
        grocy.getProducts(), grocy.getQuantityUnits(), grocy.getQuantityUnitConversions(),
    ]);
    const detaljer = await grocy.getProductUnitCostDetails();
    const produktById = new Map(products.map(p => [String(p.id), p]));

    const priserNy = new Map();
    const priserGl = new Map();
    for (const [pid, d] of detaljer) {
        if (d.cost > 0) priserNy.set(pid, d.cost);
        const g = gammelPrisregel(d);
        if (g > 0) priserGl.set(pid, g);
    }

    const fælles = { pos, nestings, products, units, conversions };
    const efter  = computeAll({ ...fælles, recipes, priceByProduct: priserNy, priceDetailByProduct: detaljer });

    // Den gamle produceret-regel: lagerprisen vandt når den fandtes. Fjernes
    // `product_id` for præcis de produkter, falder beregningen tilbage på
    // lagerprisen — altså nøjagtig den gamle adfærd.
    const gammelRegel = gammelProduceretRegel(recipes, priserGl);
    const før    = computeAll({ ...fælles, recipes: gammelRegel, priceByProduct: priserGl });
    const kun557 = computeAll({ ...fælles, recipes: gammelRegel, priceByProduct: priserNy });

    // ── 1. Producerede goder ─────────────────────────────────
    console.log(`${C.b}1. Producerede goder — lagerpris mod hvad opskriften koster${C.off}`);
    console.log(`${C.dim}   Tærskel for advarsel: ${WARN_STOCK_VS_RECIPE_PCT} %. Opskriften vinder altid.${C.off}\n`);
    const prod = [];
    for (const r of recipes) {
        const pid = String(Number(r.product_id) || '');
        if (!pid) continue;
        const produkt = produktById.get(pid);
        if (!produkt) continue;
        const y = yieldInStockUnits(r, produkt, units, conversions);
        const b = efter.get(r.id);
        const opskrift = (y > 0 && b && b.cost > 0) ? b.cost / y : null;
        const lager = priserNy.get(pid) ?? null;
        prod.push({
            navn: produkt.name, opskriftNavn: r.name, lager, opskrift, udbytte: y,
            afv: (lager != null && opskrift) ? (lager - opskrift) / opskrift * 100 : null,
        });
    }
    prod.sort((a, b) => Math.abs(b.afv ?? -1) - Math.abs(a.afv ?? -1));
    console.log(`   ${pad('Vare', 26)}${padL('lagerpris', 11)}${padL('opskriften', 12)}${padL('afvigelse', 11)}`);
    for (const p of prod) {
        const mark = p.afv == null ? C.dim
            : Math.abs(p.afv) > WARN_STOCK_VS_RECIPE_PCT ? C.red : C.grn;
        const note = p.opskrift == null
            ? `  ${C.dim}(kostprisen kan ikke regnes${p.udbytte > 0 ? '' : ' — intet udbytte'})${C.off}` : '';
        console.log(`   ${pad(p.navn, 26)}${padL(kr(p.lager), 11)}${padL(kr(p.opskrift), 12)}`
                  + `${mark}${padL(pct(p.afv), 11)}${C.off}${note}`);
    }
    const overTaerskel = prod.filter(p => p.afv != null && Math.abs(p.afv) > WARN_STOCK_VS_RECIPE_PCT);
    console.log(`\n   ${prod.length} producerede varer · ${overTaerskel.length} over tærsklen`
              + ` · ${prod.filter(p => p.lager == null).length} uden lagerpris\n`);

    // ── 2. Seneste køb mod gennemsnit ────────────────────────
    console.log(`${C.b}2. Varer hvor seneste køb ligger langt fra gennemsnittet${C.off}`);
    console.log(`${C.dim}   Tærskel: ${WARN_LAST_VS_AVG_PCT} %. Gennemsnittet bruges.${C.off}\n`);
    const spredt = [];
    for (const [pid, d] of detaljer) {
        if (!d.warn) continue;
        spredt.push({ navn: produktById.get(pid)?.name || `#${pid}`, ...d });
    }
    spredt.sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct));
    if (!spredt.length) console.log(`   ${C.dim}ingen${C.off}`);
    for (const p of spredt) {
        console.log(`   ${pad(p.navn, 26)}${padL('seneste ' + kr(p.last_price), 20)}`
                  + `${padL('snit ' + kr(p.avg_price), 16)}${C.red}${padL(pct(p.deviation_pct), 11)}${C.off}`);
    }
    console.log(`\n   ${spredt.length} af ${detaljer.size} prissatte varer\n`);

    // ── 3. Effekt pr. opskrift ───────────────────────────────
    console.log(`${C.b}3. Hvad flytter sig${C.off}`);
    console.log(`${C.dim}   FØR = gammel prisrækkefølge + lagerprisen på producerede goder.${C.off}\n`);
    const flyt = [];
    for (const r of recipes) {
        const a = før.get(r.id)?.cost ?? 0;
        const b = efter.get(r.id)?.cost ?? 0;
        const m = kun557.get(r.id)?.cost ?? 0;
        if (Math.abs(b - a) < 0.005) continue;
        flyt.push({
            id: r.id, navn: r.name, før: a, efter: b,
            d557: m - a, d558: b - m,
            pctÆndring: a > 0 ? (b - a) / a * 100 : null,
        });
    }
    flyt.sort((x, y) => Math.abs(y.pctÆndring ?? 0) - Math.abs(x.pctÆndring ?? 0));

    console.log(`   ${pad('Opskrift', 34)}${padL('før', 10)}${padL('efter', 10)}${padL('ændring', 10)}`
              + `${padL('#557', 10)}${padL('#558', 10)}`);
    for (const f of flyt.slice(0, TOP)) {
        const farve = Math.abs(f.pctÆndring ?? 0) >= 10 ? C.red : C.yel;
        console.log(`   ${pad(f.navn, 34)}${padL(kr(f.før), 10)}${padL(kr(f.efter), 10)}`
                  + `${farve}${padL(pct(f.pctÆndring), 10)}${C.off}`
                  + `${padL(f.d557 ? kr(f.d557) : '·', 10)}${padL(f.d558 ? kr(f.d558) : '·', 10)}`);
    }
    if (flyt.length > TOP) console.log(`   ${C.dim}… og ${flyt.length - TOP} mere (--alle)${C.off}`);

    const op   = flyt.filter(f => f.efter > f.før).length;
    const ned  = flyt.length - op;
    const kun5 = flyt.filter(f => Math.abs(f.d557) >= 0.005).length;
    const kun8 = flyt.filter(f => Math.abs(f.d558) >= 0.005).length;
    const medianPct = flyt.length
        ? [...flyt].map(f => Math.abs(f.pctÆndring ?? 0)).sort((a, b) => a - b)[Math.floor(flyt.length / 2)]
        : 0;

    console.log(`\n${C.b}   ${flyt.length} af ${recipes.length} opskrifter flytter kostpris${C.off}`
              + ` — ${op} op, ${ned} ned`);
    console.log(`   median ${medianPct.toFixed(1)} %`
              + ` · største ${pct(flyt[0]?.pctÆndring)} (${flyt[0]?.navn ?? '—'})`);
    console.log(`   ${kun5} rørt af prisreglen (#557) · ${kun8} af producerede goder (#558)\n`);

    // ── Advarsler i alt ──────────────────────────────────────
    let medAdvarsel = 0;
    for (const r of recipes) if ((efter.get(r.id)?.warnings.size ?? 0) > 0) medAdvarsel++;
    console.log(`${C.dim}   ${medAdvarsel} opskrifter får mindst én advarsel i Opskrifter & priser.${C.off}\n`);

    if (CSV) {
        const linjer = ['opskrift_id;navn;foer;efter;aendring_pct;delta_557;delta_558'];
        for (const f of flyt) {
            linjer.push([f.id, `"${String(f.navn).replace(/"/g, '""')}"`,
                         f.før.toFixed(2), f.efter.toFixed(2),
                         (f.pctÆndring ?? 0).toFixed(1), f.d557.toFixed(2), f.d558.toFixed(2)].join(';'));
        }
        fs.writeFileSync(CSV, linjer.join('\n') + '\n', 'utf-8');
        console.log(`${C.dim}   Skrevet: ${CSV} (${flyt.length} linjer)${C.off}\n`);
    }
}

module.exports = { gammelPrisregel, gammelProduceretRegel };

if (require.main === module) {
    main().catch(e => { console.error('\n' + C.red + e.message + C.off + '\n'); process.exit(1); });
}
