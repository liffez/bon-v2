// scripts/tjek-dagen.js
// ============================================================
// Dagens tjek af lager- og produktionsflowet. LÆS-KUN.
//
// Fem spørgsmål, i faldende orden efter hvor galt det kan gå:
//
//   1. Hvad flyttede sig i dag?          — forbrug, produktion, optællinger
//   2. Lavede Bon noget selv?            — auto-batchen (#267)
//   3. Står mellemprodukterne rigtigt?   — det Bon regner videre på
//   4. Kan Bon overhovedet lave dem?     — råvarer der spærrer, målt med
//                                          auto-batchens EGNE funktioner
//   5. Er der noget på indkøbslisten der ikke kan købes?
//
// Nr. 5 er en regressions-detektor. Et mellemprodukt kan ikke bestilles hos en
// leverandør — "Langtids Stegt Gris, 1 stk" er ikke en indkøbslinje, den steges.
// Trækket lagde dem på listen indtil #547; dukker de op igen, er noget rullet
// tilbage.
//
//   npm run tjek:dagen
//   npm run tjek:dagen -- --dato 2026-08-24
//   npm run tjek:dagen -- --instance test
//
// Går direkte på Grocys REST-API. Ingen database, ingen adapter-cache — og
// dermed ingen vej til at skrive noget.
// ============================================================

'use strict';

const { todayISO } = require('../db/helpers');
const { buildProducerIndex, collectRecipeNeedsFlat } = require('../services/ingredientResolver');
const { affordableBatches, groupOf, HURTIG_GROUP } = require('../services/autoBatch');
const { makeEffectiveStock } = require('../services/grocyAdapter');

const argOf = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const INSTANCE = (argOf('--instance') || 'hq').toUpperCase();
// todayISO() er forankret i Europe/Copenhagen. date('now') og toISOString() er
// UTC og peger på I GÅR mellem midnat og kl. 02 — se #133, senest i vagthundens
// eget datovindue.
const DAG = argOf('--dato') || todayISO();

const URL = process.env[`GROCY_${INSTANCE}_URL`];
const KEY = process.env[`GROCY_${INSTANCE}_KEY`];
if (!URL || !KEY) {
    console.error(`\n✗ GROCY_${INSTANCE}_URL / _KEY er ikke indlæst. Kør fra projektroden med --env-file=.env.\n`);
    process.exit(1);
}

const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;

async function get(path) {
    const res = await fetch(URL + path, { headers: { 'GROCY-API-KEY': KEY, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
}

const num = n => String(Math.round((Number(n) || 0) * 10000) / 10000).replace('.', ',');
let advarsler = 0;

(async () => {
    const [recipes, allPos, nestings, products, units, conversions, stock, shopping] = await Promise.all([
        get('/objects/recipes'), get('/objects/recipes_pos'), get('/objects/recipes_nestings'),
        get('/objects/products'), get('/objects/quantity_units'),
        get('/objects/quantity_unit_conversions'), get('/stock'), get('/objects/shopping_list'),
    ]);
    // Hele stock_log giver HTTP 500 — den er for stor. Serveren filtrerer i stedet.
    const log = await get(`/objects/stock_log?query%5B%5D=row_created_timestamp%3E%3D${DAG}&limit=1000`)
        .then(r => r.filter(x => String(x.row_created_timestamp || '').startsWith(DAG)))
        .catch(err => { console.warn(Y(`  (kunne ikke hente dagens bevægelser: ${err.message})`)); return null; });

    const rawRecipeMap = new Map(recipes.map(r => [Number(r.id), { ...r, id: Number(r.id) }]));
    const productMap   = new Map(products.map(p => [Number(p.id), p]));
    const unitMap      = new Map(units.map(u => [Number(u.id), u]));
    const P = id => (productMap.get(Number(id)) || {}).name || `#${id}`;
    const enhed = id => (unitMap.get(Number((productMap.get(Number(id)) || {}).qu_id_stock)) || {}).name || '';

    const posByRecipe = {}, nestingsByRecipe = {};
    for (const p of allPos)   (posByRecipe[p.recipe_id] ||= []).push(p);
    for (const n of nestings) (nestingsByRecipe[n.recipe_id] ||= []).push(n);

    const producerIndex = buildProducerIndex(rawRecipeMap);
    const effectiveStock = makeEffectiveStock(stock, products);

    console.log(`\n${B(`Dagens tjek · ${INSTANCE} · ${DAG}`)}\n`);

    // ── 1 · Hvad flyttede sig ────────────────────────────────────────────
    if (log) {
        console.log(B('1 · Bevægelser i dag'));
        if (!log.length) {
            console.log(D('  ingen — ingen leveringer, ingen optælling\n'));
        } else {
            const perType = {};
            for (const r of log) (perType[r.transaction_type] ||= []).push(r);
            for (const [type, rs] of Object.entries(perType).sort()) {
                const perPid = new Map();
                for (const r of rs) perPid.set(+r.product_id, (perPid.get(+r.product_id) || 0) + parseFloat(r.amount || 0));
                console.log(`  ${type} ${D(`(${rs.length})`)}`);
                for (const [pid, sum] of [...perPid].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12))
                    console.log(`      ${num(sum).padStart(10)} ${enhed(pid).padEnd(6)} ${P(pid)}`);
                if (perPid.size > 12) console.log(D(`      … og ${perPid.size - 12} varer mere`));
            }
            console.log();
        }
    }

    // ── 2 · Lavede Bon noget selv? ───────────────────────────────────────
    console.log(B('2 · Auto-batch'));
    if (!log) {
        console.log(D('  kan ikke afgøres uden bevægelserne\n'));
    } else {
        const lavet = log.filter(r => r.transaction_type === 'self-production' && parseFloat(r.amount) > 0);
        if (!lavet.length) {
            console.log(D('  Bon producerede intet i dag. Det er rigtigt hvis der var dækning.\n'));
        } else {
            for (const r of lavet) console.log(`  ${G('+')} ${num(r.amount).padStart(8)} ${enhed(r.product_id).padEnd(6)} ${P(r.product_id)}`);
            console.log();
        }
    }

    // ── 3 · Mellemprodukterne ────────────────────────────────────────────
    console.log(B('3 · Mellemprodukter på lager'));
    const rows = [...producerIndex.entries()].map(([pid, prods]) => ({
        pid, navn: P(pid), lager: effectiveStock(pid),
        hurtig: prods.some(r => groupOf(r) === HURTIG_GROUP),
    })).sort((a, b) => a.lager - b.lager || a.navn.localeCompare(b.navn, 'da'));
    for (const r of rows) {
        const mærke = r.lager < 0 ? R('NEGATIVT') : r.lager === 0 ? Y('tom') : '';
        if (r.lager <= 0) advarsler++;
        console.log(`  ${r.navn.padEnd(26).slice(0, 26)} ${num(r.lager).padStart(9)} ${enhed(r.pid).padEnd(6)}`
                  + `${(r.hurtig ? D('Bon laver den') : D('personalet laver den')).padEnd(32)} ${mærke}`);
    }
    console.log();

    // ── 4 · Kan Bon lave dem? ────────────────────────────────────────────
    //
    // Målt med auto-batchens EGNE funktioner, ikke en parallel udregning — så
    // svaret her er det samme som ved næste levering.
    console.log(B('4 · Kan Bon lave Hurtig-blandingerne lige nu?'));
    let spærret = 0;
    for (const [pid, prods] of producerIndex.entries()) {
        const hurtig = prods.filter(r => groupOf(r) === HURTIG_GROUP);
        if (!hurtig.length) continue;
        const behov = new Map();
        collectRecipeNeedsFlat(hurtig[0].id, 1, posByRecipe, nestingsByRecipe, rawRecipeMap,
            (rp, amt) => behov.set(Number(rp), (behov.get(Number(rp)) || 0) + amt),
            new Set(), { skipEmballage: true });
        if (!behov.size) continue;
        if (affordableBatches(behov, effectiveStock) > 0) continue;
        spærret++; advarsler++;
        const mangler = [...behov.entries()]
            .filter(([rp, per]) => effectiveStock(rp) < per)
            .map(([rp, per]) => `${P(rp)} (har ${num(effectiveStock(rp))}, skal bruge ${num(per)})`);
        console.log(`  ${R('✗')} ${P(pid).padEnd(24).slice(0, 24)} mangler ${mangler.join(' · ')}`);
    }
    if (!spærret) console.log(G('  alle kan laves — råvarerne rækker til mindst ét batch'));
    console.log();

    // ── 5 · Indkøbslisten ────────────────────────────────────────────────
    console.log(B('5 · Kan alt på indkøbslisten købes?'));
    const uindkøbelige = shopping.filter(x => producerIndex.has(Number(x.product_id)));
    if (!uindkøbelige.length) {
        console.log(G('  ja — ingen mellemprodukter på listen'));
    } else {
        for (const x of uindkøbelige) {
            const auto = /Auto-tilføjet ved LEVERET/.test(x.note || '');
            if (auto) advarsler++;
            console.log(`  ${auto ? R('✗') : Y('!')} ${P(x.product_id).padEnd(24).slice(0, 24)} ${num(x.amount).padStart(7)}`
                      + `  ${D((x.note || '(ingen note)').slice(0, 44))}`);
        }
        console.log(D('\n  ✗ = lagt på af trækket. Det skulle #547 have stoppet — sig til hvis den dukker op.'));
        console.log(D('  ! = lagt på i hånden (fx Råvarer-modalens kurv). Ikke en fejl, men den kan ikke bestilles.'));
    }

    console.log(`\n${advarsler ? Y(`${advarsler} ting at kigge på`) : G('intet at bemærke')}\n`);
})().catch(err => { console.error(R(`\n✗ ${err.message}\n`)); process.exit(1); });
