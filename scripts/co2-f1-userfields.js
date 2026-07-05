#!/usr/bin/env node
'use strict';
/*
 * CO₂ F1 (#106) — opret nye CO₂-userfields i Grocy + deprecér det korrupte Co2e.
 * Spec: docs/CLAUDE_CO2.md §2 + §7 + §12 trin 1.
 *
 * Hvad scriptet gør (idempotent — kan trygt køres flere gange):
 *   products:
 *     - opretter 5 nye userfields: co2e_per_kg, co2e_source, co2e_klima_id,
 *       co2e_material, co2e_version (hvis de ikke allerede findes)
 *     - omdøber det korrupte `Co2e` → `Co2e_OLD` (data bevares — Grocy-værdier
 *       hænger på field-id, ikke navn) så intet beregningskald rammer det
 *   recipes:
 *     - omdøber `Co2e` → `Co2e_OLD`
 *     - opretter en frisk, tom `recipes.Co2e` (number-decimal) som F5's
 *       genberegnings-cache (§7). De eksisterende recipe-læsere
 *       (getRecipes / refresh-recipe-costs / recipes_overview) peger dermed
 *       fortsat på `Co2e`, men får null/0 indtil F5 fylder den.
 *
 * Grocy-instanser har separate DB'er → kør pr. lokation (hq/test/cafe).
 * URL + API-key læses direkte fra .env (GROCY_<CODE>_URL / GROCY_<CODE>_KEY),
 * så scriptet ikke afhænger af Bon v2's egen DB.
 *
 * Brug:
 *   node scripts/co2-f1-userfields.js --location=test            # dry-run (viser plan)
 *   node scripts/co2-f1-userfields.js --location=test --apply    # udfør
 *   node scripts/co2-f1-userfields.js --location=all --apply     # hq + test + cafe
 */

// ── Indlæs .env hvis Grocy-vars ikke allerede er sat ────────────────
if (!process.env.GROCY_HQ_URL && !process.env.GROCY_TEST_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (_) { /* .env findes ikke — env må være sat på anden vis */ }
}

// ── Argumenter ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const locArg = (args.find(a => a.startsWith('--location=')) || '').split('=')[1] || '';

const ALL_LOCATIONS = ['hq', 'test', 'cafe'];
let locations;
if (locArg === 'all') locations = ALL_LOCATIONS;
else if (ALL_LOCATIONS.includes(locArg)) locations = [locArg];
else {
    console.error('Brug: --location=hq|test|cafe|all  [--apply]');
    process.exit(1);
}

// ── De 5 nye userfields (på products) ───────────────────────────────
const NEW_PRODUCT_FIELDS = [
    { name: 'co2e_per_kg',   type: 'number-decimal',   caption: 'CO₂e pr. kg (resolvet)' },
    { name: 'co2e_source',   type: 'text-single-line', caption: 'CO₂e kilde (klimadb|material|supplier|manual|na)' },
    { name: 'co2e_klima_id', type: 'text-single-line', caption: 'CONCITO Ra-ID' },
    { name: 'co2e_material', type: 'text-single-line', caption: 'Emballage-materiale (pap, LDPE, …)' },
    { name: 'co2e_version',  type: 'text-single-line', caption: 'CO₂e kildeversion (fx CONCITO v1.2)' },
];

const OLD_CAPTION = 'Co2e (DEPRECATED — brug co2e_per_kg)';

// ── Grocy HTTP ──────────────────────────────────────────────────────
function resolveConfig(code) {
    const upper = code.toUpperCase();
    const url = process.env[`GROCY_${upper}_URL`];
    const key = process.env[`GROCY_${upper}_KEY`];
    if (!url || !key) {
        throw new Error(`Mangler GROCY_${upper}_URL / GROCY_${upper}_KEY i .env`);
    }
    return { url: url.replace(/\/+$/, ''), key };
}

async function grocy(cfg, method, path, body) {
    const res = await fetch(cfg.url + path, {
        method,
        headers: {
            'GROCY-API-KEY': cfg.key,
            'Accept': 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Grocy ${method} ${path} → ${res.status}: ${t.slice(0, 200)}`);
    }
    const t = await res.text();
    return t ? JSON.parse(t) : {};
}

function find(fields, entity, name) {
    return fields.find(f => f.entity === entity && f.name === name);
}

// ── Pr. lokation ────────────────────────────────────────────────────
async function processLocation(code) {
    console.log(`\n══ Lokation: ${code.toUpperCase()} ${APPLY ? '(APPLY)' : '(dry-run)'} ══`);
    const cfg = resolveConfig(code);
    const fields = await grocy(cfg, 'GET', '/objects/userfields');

    const plan = []; // { kind: 'rename'|'create', ... , label }

    // 1. Opret 5 nye på products
    for (const f of NEW_PRODUCT_FIELDS) {
        if (find(fields, 'products', f.name)) {
            console.log(`  ✓ products.${f.name} findes allerede`);
        } else {
            plan.push({
                kind: 'create', entity: 'products', name: f.name, type: f.type, caption: f.caption,
                label: `opret products.${f.name} (${f.type})`,
            });
        }
    }

    // 2. products.Co2e → Co2e_OLD
    const prodCo2e = find(fields, 'products', 'Co2e');
    const prodOld  = find(fields, 'products', 'Co2e_OLD');
    if (prodCo2e && !prodOld) {
        plan.push({ kind: 'rename', id: prodCo2e.id, to: 'Co2e_OLD', label: 'omdøb products.Co2e → Co2e_OLD' });
    } else if (prodOld) {
        console.log('  ✓ products.Co2e er allerede deprecated (Co2e_OLD findes)');
    } else {
        console.log('  · products.Co2e findes ikke (intet at deprecere)');
    }

    // 3. recipes.Co2e → Co2e_OLD + frisk recipes.Co2e (F5-cache)
    const recCo2e = find(fields, 'recipes', 'Co2e');
    const recOld  = find(fields, 'recipes', 'Co2e_OLD');
    if (recCo2e && !recOld) {
        plan.push({ kind: 'rename', id: recCo2e.id, to: 'Co2e_OLD', label: 'omdøb recipes.Co2e → Co2e_OLD' });
        // efter omdøbning er navnet "Co2e" frit → opret frisk cache-felt
        plan.push({ kind: 'create', entity: 'recipes', name: 'Co2e', type: 'number-decimal',
                    caption: 'Co2e (genberegnet cache — F5)', label: 'opret frisk recipes.Co2e (F5-cache)' });
    } else {
        if (recOld) console.log('  ✓ recipes.Co2e er allerede deprecated (Co2e_OLD findes)');
        // sørg for at en cache-Co2e findes (hvis hverken Co2e eller _OLD fandtes oprindeligt)
        if (!recCo2e && !recOld) {
            plan.push({ kind: 'create', entity: 'recipes', name: 'Co2e', type: 'number-decimal',
                        caption: 'Co2e (genberegnet cache — F5)', label: 'opret recipes.Co2e (F5-cache)' });
        } else if (recCo2e && recOld) {
            console.log('  ✓ recipes.Co2e (cache) findes ved siden af Co2e_OLD');
        }
    }

    if (!plan.length) {
        console.log('  → Intet at gøre — lokationen er allerede i F1-tilstand.');
        return;
    }

    console.log(`  Plan (${plan.length} handlinger):`);
    plan.forEach(p => console.log(`    • ${p.label}`));

    if (!APPLY) {
        console.log('  → dry-run: ingen ændringer udført. Kør med --apply for at udføre.');
        return;
    }

    // Udfør: renames først (frigør navne), derefter creates
    for (const p of plan.filter(x => x.kind === 'rename')) {
        await grocy(cfg, 'PUT', `/objects/userfields/${p.id}`, { name: p.to, caption: OLD_CAPTION });
        console.log(`    ✔ ${p.label}`);
    }
    for (const p of plan.filter(x => x.kind === 'create')) {
        await grocy(cfg, 'POST', '/objects/userfields', {
            entity: p.entity, name: p.name, type: p.type, caption: p.caption,
            show_as_column_in_tables: 0, input_required: 0,
        });
        console.log(`    ✔ ${p.label}`);
    }
    console.log('  → Færdig.');
}

(async () => {
    try {
        for (const code of locations) {
            await processLocation(code);
        }
        console.log('\nF1 kørsel afsluttet.');
    } catch (err) {
        console.error('\nFEJL:', err.message);
        process.exit(1);
    }
})();
