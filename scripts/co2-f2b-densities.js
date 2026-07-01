#!/usr/bin/env node
'use strict';
/*
 * CO₂ F2b — bulk-væsker: densitet Liter→Kilo (spec CLAUDE_CO2.md §3/§4).
 *
 * Bulk-væsker (stock = Liter) mangler en vej til kg. CO₂-faktoren er pr. kg,
 * så vi giver hver bulk-væske en densitet-konvertering (1 Liter = D kg).
 * Stock-enheden røres IKKE (beslutning: option a) — kun konverteringen tilføjes.
 *
 * KUN høj-sikkerheds-densiteter anvendes automatisk (vand/mælk/olie/øl).
 * Usikre (balsamico, chili sauce, ukendte) LISTES men anvendes ikke —
 * bekræft værdien manuelt og tilføj den til DENSITIES nedenfor.
 *
 * Flaske-/dåsedrikke (sodavand, flaske-øl, vin, cava) hører IKKE til her —
 * de tælles og skal vejes (se co2-f2b-weights.js).
 *
 * Idempotent. dry-run default. --apply. --location=hq|test|cafe|all.
 *   node scripts/co2-f2b-densities.js --location=hq            # dry-run (viser forslag)
 *   node scripts/co2-f2b-densities.js --location=hq --apply
 */

if (!process.env.GROCY_HQ_URL && !process.env.GROCY_TEST_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (_) {}
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const locArg = (args.find(a => a.startsWith('--location=')) || '').split('=')[1] || '';
const ALL = ['hq', 'test', 'cafe'];
let locations;
if (locArg === 'all') locations = ALL;
else if (ALL.includes(locArg)) locations = [locArg];
else { console.error('Brug: --location=hq|test|cafe|all  [--apply]'); process.exit(1); }

const LITER_QU = 6;
const KILO_QU = 4;

// Densitet i kg/L. confidence: 'high' → anvendes; 'review' → listes, anvendes ikke.
// Matches på navn-nøgleord (rækkefølge betyder noget — første match vinder).
const DENSITY_RULES = [
    { kw: ['postevand', 'vand'],            density: 1.00, confidence: 'high',   note: 'vand' },
    { kw: ['mælk', 'oat', 'plante'],        density: 1.03, confidence: 'high',   note: 'mælk' },
    { kw: ['fustage', 'øl'],                density: 1.01, confidence: 'high',   note: 'øl (fustage)' },
    { kw: ['oliven olie', 'trøffel olie', 'olie'], density: 0.92, confidence: 'high', note: 'olie' },
    { kw: ['balsamico'],                    density: 1.10, confidence: 'high',   note: 'balsamico (bekræftet)' },
    { kw: ['eddike'],                       density: 1.01, confidence: 'high',   note: 'eddike' },
    { kw: ['chili', 'sauce'],               density: 1.10, confidence: 'high',   note: 'sauce (bekræftet)' },
];

function resolveDensity(name) {
    const n = String(name || '').toLowerCase();
    for (const r of DENSITY_RULES) {
        if (r.kw.some(k => n.includes(k))) return r;
    }
    return null;
}

function resolveConfig(code) {
    const u = process.env[`GROCY_${code.toUpperCase()}_URL`];
    const k = process.env[`GROCY_${code.toUpperCase()}_KEY`];
    if (!u || !k) throw new Error(`Mangler GROCY_${code.toUpperCase()}_URL / _KEY i .env`);
    return { url: u.replace(/\/+$/, ''), key: k };
}

async function grocy(cfg, method, path, body) {
    const res = await fetch(cfg.url + path, {
        method,
        headers: { 'GROCY-API-KEY': cfg.key, 'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Grocy ${method} ${path} → ${res.status}: ${t.slice(0, 200)}`); }
    const t = await res.text();
    return t ? JSON.parse(t) : {};
}

async function processLocation(code) {
    console.log(`\n══ Lokation: ${code.toUpperCase()} ${APPLY ? '(APPLY)' : '(dry-run)'} ══`);
    const cfg = resolveConfig(code);
    const products = await grocy(cfg, 'GET', '/objects/products');
    const pos = await grocy(cfg, 'GET', '/objects/recipes_pos');
    const conv = await grocy(cfg, 'GET', '/objects/quantity_unit_conversions');

    const used = new Set(pos.map(p => parseInt(p.product_id)).filter(Boolean));
    const hasLiterToKg = new Set(
        conv.filter(c => c.product_id && parseInt(c.from_qu_id) === LITER_QU && parseInt(c.to_qu_id) === KILO_QU)
            .map(c => parseInt(c.product_id))
    );

    const liters = products.filter(p => parseInt(p.qu_id_stock) === LITER_QU && used.has(parseInt(p.id)));

    const apply = [], review = [], skip = [];
    for (const p of liters) {
        if (hasLiterToKg.has(parseInt(p.id))) { skip.push(p.name); continue; }
        const r = resolveDensity(p.name);
        if (!r) { review.push({ name: p.name, id: p.id, density: '?', note: 'ingen regel — bekræft manuelt' }); continue; }
        if (r.confidence === 'high') apply.push({ id: parseInt(p.id), name: p.name, density: r.density, note: r.note });
        else review.push({ id: p.id, name: p.name, density: r.density, note: r.note });
    }

    if (skip.length) console.log(`  ✓ ${skip.length} har allerede densitet: ${skip.join(', ')}`);

    console.log(`\n  Anvendes (høj sikkerhed) — ${apply.length}:`);
    apply.forEach(a => console.log(`    • #${a.id} ${a.name}  →  1 L = ${a.density} kg  (${a.note})`));

    if (review.length) {
        console.log(`\n  ⚠ Kræver bekræftelse (IKKE anvendt) — ${review.length}:`);
        review.forEach(r => console.log(`    • #${r.id} ${r.name}  →  forslag ${r.density} kg/L  (${r.note})`));
        console.log('    → bekræft værdien og tilføj i DENSITY_RULES med confidence:"high".');
    }

    if (!apply.length) { console.log('\n  → Intet at anvende.'); return; }
    if (!APPLY) { console.log('\n  → dry-run: ingen ændringer. Kør med --apply.'); return; }

    for (const a of apply) {
        await grocy(cfg, 'POST', '/objects/quantity_unit_conversions', {
            product_id: a.id, from_qu_id: LITER_QU, to_qu_id: KILO_QU, factor: a.density,
        });
        console.log(`    ✔ #${a.id} ${a.name} (1 L = ${a.density} kg)`);
    }
    console.log('  → Færdig.');
}

(async () => {
    try { for (const c of locations) await processLocation(c); console.log('\nF2b densiteter afsluttet.'); }
    catch (e) { console.error('\nFEJL:', e.message); process.exit(1); }
})();
