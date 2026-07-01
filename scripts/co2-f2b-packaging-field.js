#!/usr/bin/env node
'use strict';
/*
 * CO₂ F2b — opret `co2e_packaging_g`-userfield på Grocy products.
 * Spec: docs/CLAUDE_CO2.md §3/§6 (emballage-vægt pr. stk).
 *
 * Holder emballage-/tara-vægten (gram pr. stk) for tælle-varer der har en
 * beholder rundt om indholdet (fx flaske-/dåsedrikke). Gemmes som gram i et
 * eget felt — IKKE i Grocys native "Emballagevægt", som er bundet til
 * lager-enheden (ubrugelig som vægt når stock = Antal).
 *
 * Netto indhold = kg-vej − (co2e_packaging_g / 1000). CO₂-motoren (F5) læser feltet.
 *
 * Idempotent. dry-run default. --apply. --location=hq|test|cafe|all.
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

const FIELD = { entity: 'products', name: 'co2e_packaging_g', type: 'number-decimal',
                caption: 'Emballage pr. stk (g) — CO₂/ESG' };

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
    const fields = await grocy(cfg, 'GET', '/objects/userfields');
    const exists = fields.some(f => f.entity === FIELD.entity && f.name === FIELD.name);
    if (exists) { console.log(`  ✓ products.${FIELD.name} findes allerede.`); return; }
    console.log(`  Plan: opret products.${FIELD.name} (${FIELD.type})`);
    if (!APPLY) { console.log('  → dry-run: ingen ændringer. Kør med --apply.'); return; }
    await grocy(cfg, 'POST', '/objects/userfields', {
        entity: FIELD.entity, name: FIELD.name, type: FIELD.type, caption: FIELD.caption,
        show_as_column_in_tables: 0, input_required: 0,
    });
    console.log(`  ✔ oprettet products.${FIELD.name}`);
}

(async () => {
    try { for (const c of locations) await processLocation(c); console.log('\nFærdig.'); }
    catch (e) { console.error('\nFEJL:', e.message); process.exit(1); }
})();
