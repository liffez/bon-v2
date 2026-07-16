#!/usr/bin/env node
'use strict';
/*
 * CO₂ F2b — "6 ægte fejl": flyt fejlplacerede varer til rigtig produktgruppe.
 * Spec: docs/CLAUDE_CO2.md §4 (tabellen med de 6 ægte fejl).
 *
 * Kun de varer der ligger i FORKERT gruppe flyttes:
 *   - Emballage fejlplaceret i "Lager varer"  → "10 Emballage"
 *     (så F3's materiale-tildeler fanger dem — den filtrerer på gruppenavn /emballage/i)
 *   - Fatdane sodavand i "11 Oversigt"          → "08 Drikkevarer"
 *     (de øvrige Fatdane-varianter ligger allerede i drikke-gruppen)
 *
 * IKKE her (bevidst):
 *   - petit four: ligger allerede i "07 Kager" — mangler kun kg-vej (vejes via
 *     kitchen/stock.html → CO₂ kg-vej-værktøjet)
 *   - laurbærblade: §4 kræver kun kg-vej, ingen flyt (vejes samme sted)
 *   - Selve vægtene: sættes af vejeværktøjet (shared/co2_veje.js), ikke her
 *
 * Match sker på NAVN (ikke id — id'er varierer pr. Grocy-instans). Idempotent:
 * en vare der allerede står i målgruppen springes over.
 *
 * Brug:
 *   node scripts/co2-f2b-group-fixes.js --location=hq            # dry-run (viser plan)
 *   node scripts/co2-f2b-group-fixes.js --location=hq --apply
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

// Flyt: produktnavn (eksakt, case-insensitivt) → målgruppens navn.
const MOVES = [
    { name: 'Fryseposer',         toGroup: '10 Emballage' },
    { name: 'Bagepapir',          toGroup: '10 Emballage' },
    { name: 'Vaccum poser',       toGroup: '10 Emballage' },
    { name: 'Fatdane - sodavand', toGroup: '08 Drikkevarer' },
];

const SRC_GROUP_TO_REVIEW = 'Lager varer'; // listes til øjesyn (kan gemme flere fejlplaceringer)

function resolveConfig(code) {
    const u = process.env[`GROCY_${code.toUpperCase()}_URL`];
    const k = process.env[`GROCY_${code.toUpperCase()}_KEY`];
    if (!u || !k) throw new Error(`Mangler GROCY_${code.toUpperCase()}_URL / _KEY i .env`);
    return { url: u.replace(/\/+$/, ''), key: k };
}

async function grocy(cfg, method, path, body) {
    const res = await fetch(cfg.url + path, {
        method,
        headers: { 'GROCY-API-KEY': cfg.key, 'Accept': 'application/json',
                   ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Grocy ${method} ${path} → ${res.status}: ${t.slice(0, 200)}`); }
    const t = await res.text();
    return t ? JSON.parse(t) : {};
}

const norm = (s) => (s || '').toString().trim().toLowerCase();

async function processLocation(code) {
    console.log(`\n══ Lokation: ${code.toUpperCase()} ${APPLY ? '(APPLY)' : '(dry-run)'} ══`);
    const cfg = resolveConfig(code);
    const [products, groups] = await Promise.all([
        grocy(cfg, 'GET', '/objects/products'),
        grocy(cfg, 'GET', '/objects/product_groups'),
    ]);
    const groupById = new Map(groups.map(g => [String(g.id), g.name]));
    const groupIdByName = new Map(groups.map(g => [norm(g.name), String(g.id)]));

    const plan = [];
    for (const mv of MOVES) {
        const p = products.find(x => norm(x.name) === norm(mv.name));
        if (!p) { console.log(`  · "${mv.name}" ikke fundet på ${code} — springer over`); continue; }
        const targetId = groupIdByName.get(norm(mv.toGroup));
        if (!targetId) { console.log(`  ⚠ målgruppe "${mv.toGroup}" findes ikke på ${code}`); continue; }
        const curId = String(p.product_group_id || '');
        if (curId === targetId) { console.log(`  ✓ "${p.name}" står allerede i "${mv.toGroup}"`); continue; }
        plan.push({ id: p.id, name: p.name, from: groupById.get(curId) || '—', to: mv.toGroup, toId: targetId });
    }

    if (plan.length) {
        console.log(`\n  Plan (${plan.length} flyt):`);
        plan.forEach(x => console.log(`    • [${x.id}] ${x.name}: "${x.from}" → "${x.to}"`));
    } else {
        console.log('\n  → Intet at flytte — alle står korrekt.');
    }

    // Til øjesyn: hvad ligger ellers i "Lager varer" (kan gemme flere fejlplaceringer)?
    const srcId = groupIdByName.get(norm(SRC_GROUP_TO_REVIEW));
    if (srcId) {
        const rest = products.filter(p => String(p.product_group_id) === srcId).map(p => p.name);
        if (rest.length) {
            console.log(`\n  ℹ Til øjesyn — øvrige varer i "${SRC_GROUP_TO_REVIEW}" (${rest.length}):`);
            console.log('     ' + rest.sort((a, b) => a.localeCompare(b, 'da')).join(', '));
        }
    }

    if (!APPLY || !plan.length) {
        if (plan.length) console.log('\n  → dry-run: intet ændret. Kør med --apply for at flytte.');
        return;
    }
    for (const x of plan) {
        await grocy(cfg, 'PUT', `/objects/products/${x.id}`, { product_group_id: Number(x.toId) });
        console.log(`    ✔ flyttet [${x.id}] ${x.name} → "${x.to}"`);
    }
    console.log('  → Færdig.');
}

(async () => {
    try {
        for (const code of locations) await processLocation(code);
        console.log('\nF2b gruppe-flyt afsluttet.');
    } catch (err) {
        console.error('\nFEJL:', err.message);
        process.exit(1);
    }
})();
