#!/usr/bin/env node
'use strict';
/*
 * CO₂ F5 — beregn opskrift-CO₂ og skriv recipes.Co2e (cache).
 * Spec: docs/CLAUDE_CO2.md §7 + §12 trin 5.
 *
 * Henter Grocy-data, kører motoren (services/co2Engine.js) og rapporterer
 * dækning: hvor mange opskrifter er FULDT beregnet vs. mangler faktor/kg-vej.
 * --apply skriver recipes.Co2e (kun for komplette opskrifter — vi cacher aldrig
 * et halvt tal). --oracle sammenligner mod Katrines Samlet Data (test-orakel).
 *
 * Brug:
 *   node scripts/co2-f5-compute.js --location=hq                 # dækningsrapport
 *   node scripts/co2-f5-compute.js --location=hq --oracle        # + validér mod orakel
 *   node scripts/co2-f5-compute.js --location=hq --missing       # + list manglende faktor/kg-vej
 *   node scripts/co2-f5-compute.js --location=hq --apply         # skriv recipes.Co2e (komplette)
 *
 * Natligt (crontab på serveren, efter refresh-recipe-costs.js kl. 03:00):
 *   15 3 * * * cd /home/leif/bon-v2 && node scripts/co2-f5-compute.js --location=hq --apply >> logs/co2.log 2>&1
 * Kun forskelle skrives, og loggen viser hver ændring med før → efter.
 */

const fs = require('fs');
const path = require('path');
const engine = require('../services/co2Engine');
const { parseCsv, dice } = require('../services/co2Concito');

if (!process.env.GROCY_HQ_URL && !process.env.GROCY_TEST_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (_) {}
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ORACLE = args.includes('--oracle');
const SHOW_MISSING = args.includes('--missing');
const locArg = (args.find(a => a.startsWith('--location=')) || '').split('=')[1] || '';
const ALL = ['hq', 'test', 'cafe'];
let locations;
if (locArg === 'all') locations = ALL;
else if (ALL.includes(locArg)) locations = [locArg];
else { console.error('Brug: --location=hq|test|cafe|all  [--apply] [--oracle] [--missing]'); process.exit(1); }

const ORACLE_PATH = path.join(__dirname, 'co2', 'oracle_samlet_data.csv');
const ORACLE_TOL = 0.15; // 15% — Katrine kan bruge lidt andre kg-konverteringer

function resolveConfig(code) {
    const u = process.env[`GROCY_${code.toUpperCase()}_URL`];
    const k = process.env[`GROCY_${code.toUpperCase()}_KEY`];
    if (!u || !k) throw new Error(`Mangler GROCY_${code.toUpperCase()}_URL / _KEY i .env`);
    return { url: u.replace(/\/+$/, ''), key: k };
}
async function grocy(cfg, method, p, body) {
    const res = await fetch(cfg.url + p, {
        method, headers: { 'GROCY-API-KEY': cfg.key, 'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Grocy ${method} ${p} → ${res.status}: ${t.slice(0, 200)}`); }
    const t = await res.text();
    return t ? JSON.parse(t) : {};
}

const fmt = (n) => (Math.round(n * 10000) / 10000);

async function processLocation(code) {
    const stamp = new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' });
    console.log(`\n══ Lokation: ${code.toUpperCase()} ${APPLY ? '(APPLY)' : '(dry-run)'} · ${stamp} ══`);
    const cfg = resolveConfig(code);
    const [recipes, pos, nestings, products, conversions, units] = await Promise.all([
        grocy(cfg, 'GET', '/objects/recipes'),
        grocy(cfg, 'GET', '/objects/recipes_pos'),
        grocy(cfg, 'GET', '/objects/recipes_nestings'),
        grocy(cfg, 'GET', '/objects/products'),
        grocy(cfg, 'GET', '/objects/quantity_unit_conversions'),
        grocy(cfg, 'GET', '/objects/quantity_units'),
    ]);

    const results = engine.computeAll({ recipes, pos, nestings, products, conversions, units });

    // Kun opskrifter med mindst én ingrediens (spring tomme/pseudo-opskrifter over).
    const posRecipeIds = new Set(pos.map(p => p.recipe_id));
    const nestRecipeIds = new Set(nestings.map(n => n.recipe_id));
    const real = [...results.values()].filter(r => posRecipeIds.has(r.recipe_id) || nestRecipeIds.has(r.recipe_id));

    const complete = real.filter(r => r.complete);
    const partial = real.filter(r => !r.complete);
    console.log(`  Opskrifter med ingredienser: ${real.length}`);
    console.log(`    ✅ komplette (alle ingredienser har faktor + kg-vej): ${complete.length}`);
    console.log(`    ⚠ delvise (mangler noget): ${partial.length}`);

    // Hyppigst manglende (aggregeret på tværs af opskrifter)
    const missFactor = new Map(), missKg = new Map();
    partial.forEach(r => {
        r.missing_factor.forEach(x => missFactor.set(x, (missFactor.get(x) || 0) + 1));
        r.missing_kgvej.forEach(x => missKg.set(x, (missKg.get(x) || 0) + 1));
    });
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} (${v})`);
    if (missFactor.size) console.log(`\n  Mangler FAKTOR (top): ${top(missFactor).join(', ')}`);
    if (missKg.size)     console.log(`  Mangler KG-VEJ (top): ${top(missKg).join(', ')}`);

    if (SHOW_MISSING) {
        console.log('\n  Delvise opskrifter:');
        partial.slice(0, 40).forEach(r => console.log(`    · ${r.name}: faktor[${r.missing_factor.join(', ')}] kgvej[${r.missing_kgvej.join(', ')}]`));
    }

    if (ORACLE) compareOracle(real);

    // Producerede varer (§3 "computed"): hvad ville blive skrevet som co2e_per_kg?
    // Vises ALTID — også i dry-run — for det er her #663 ville være set før en --apply.
    // Reglen bor i co2Engine.computedProductFactors (faktor = total ÷ udbytte i kg).
    const prodRows = engine.computedProductFactors({ recipes, pos, nestings, products, conversions, units }, fmt);
    console.log('\n  Producerede varer → co2e_per_kg (computed):');
    for (const x of prodRows) {
        const cur = x.current == null ? '—' : `${fmt(Number(x.current))} (${x.current_source || 'uden kilde'})`;
        const nu = x.action === 'skip' ? `springes over: ${x.reason}` : `${x.factor}${x.action === 'unchanged' ? ' (uændret)' : ''}  [udbytte ${fmt(x.yield_kg)} kg]`;
        console.log(`    #${String(x.product_id).padEnd(4)} ${x.product_name.padEnd(24)} ← ${x.recipe_name.padEnd(26)} i dag ${cur.padEnd(22)} → ${nu}`);
    }

    // Opskrifternes Co2e-cache: kun forskelle. Kører natligt — et "intet ændret"
    // skal kunne skelnes fra et "76 ændret" i loggen.
    const cache = engine.recipeCacheUpdates({ recipes, pos, nestings }, results, fmt);
    const toWrite = cache.filter(x => x.action === 'write');
    const stale = cache.filter(x => x.action === 'stale');
    const f = (n) => n == null ? '—' : String(n).replace('.', ',');
    console.log(`\n  recipes.Co2e: ${toWrite.length} ændret · ${cache.filter(x => x.action === 'unchanged').length} uændret`);
    for (const x of toWrite) console.log(`    · ${x.name}: ${f(x.current)} → ${f(x.next)}`);
    if (stale.length) {
        console.log(`  ⚠ ${stale.length} ufuldstændige opskrifter har stadig et gammelt tal (røres ikke):`);
        for (const x of stale) console.log(`    · ${x.name}: ${f(x.current)}`);
    }

    if (APPLY) {
        let ok = 0, err = 0;
        for (const x of toWrite) {
            try { await grocy(cfg, 'PUT', `/userfields/recipes/${x.recipe_id}`, { Co2e: String(x.next) }); ok++; }
            catch (e) { console.log(`    ✗ ${x.name}: ${e.message}`); err++; }
        }
        console.log(`\n  → recipes.Co2e skrevet: ${ok}${err ? `, fejl: ${err}` : ''}.`);

        // Propagér (§3 "computed") til output-produktets co2e_per_kg, så opskrifter
        // der bruger PRODUKTET også har et tal. Motoren foretrækker alligevel den
        // levende udrulning fra opskriften når den kan (#663) — cachen er fallback.
        // Rører ALDRIG en ægte kilde (klimadb/material/supplier/manual/na).
        let prodOk = 0;
        for (const x of prodRows.filter(x => x.action === 'write')) {
            try {
                await grocy(cfg, 'PUT', `/userfields/products/${x.product_id}`, {
                    co2e_per_kg: String(x.factor), co2e_source: 'computed', co2e_version: 'Beregnet fra opskrift',
                });
                prodOk++;
            } catch (e) { console.log(`    ✗ output-produkt ${x.product_name}: ${e.message}`); }
        }
        console.log(`  → output-produkt-faktorer (computed) skrevet: ${prodOk}.`);
    } else {
        console.log('\n  → dry-run: intet skrevet. Kør med --apply (skriver kun komplette).');
    }
}

function compareOracle(real) {
    let oracle;
    try { oracle = parseCsv(fs.readFileSync(ORACLE_PATH, 'utf8')); }
    catch { console.log('\n  (orakel-CSV ikke fundet — spring validering over)'); return; }

    console.log(`\n  ── Orakel-validering (Katrines Samlet Data, ${oracle.length} opskrifter, tol ±${ORACLE_TOL * 100}%) ──`);
    let matched = 0, within = 0, diverge = 0, incomplete = 0, nomatch = 0;
    for (const o of oracle) {
        const target = Number(o.co2e_per_sandwich);
        // match orakel-navn → Grocy-opskrift (fuzzy)
        let best = null, bestScore = 0;
        for (const r of real) { const s = dice(o.produkt, r.name); if (s > bestScore) { bestScore = s; best = r; } }
        if (!best || bestScore < 0.6) { nomatch++; continue; }
        matched++;
        if (!best.complete) { incomplete++; continue; } // kan ikke sammenlignes retfærdigt (mangler data i Grocy)
        const got = best.co2e_per_serving;
        const rel = target ? Math.abs(got - target) / target : (got === 0 ? 0 : 1);
        const ok = rel <= ORACLE_TOL;
        if (ok) within++; else diverge++;
        const flag = ok ? '✓' : '✗';
        if (!ok) console.log(`    ${flag} ${o.produkt.padEnd(18)} orakel ${fmt(target)}  motor ${fmt(got)}  (afvig ${(rel * 100).toFixed(0)}%)`);
    }
    console.log(`  Matchede ${matched}/${oracle.length}: ✓ inden for tolerance ${within}, ✗ afviger ${diverge}, ⏳ ufuldstændige i Grocy ${incomplete}, ikke-matchet ${nomatch}`);
}

(async () => {
    try {
        for (const code of locations) await processLocation(code);
        console.log('\nF5 compute afsluttet.');
    } catch (err) { console.error('\nFEJL:', err.message); process.exit(1); }
})();
