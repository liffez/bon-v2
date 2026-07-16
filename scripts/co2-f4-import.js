#!/usr/bin/env node
'use strict';
/*
 * CO₂ F4 — import Katrines CONCITO-kuraterede fødevare-faktorer → Grocy.
 * Spec: docs/CLAUDE_CO2.md §1 + §8 + §12 trin 4.
 *
 * Læser scripts/co2/concito_ingredienser.csv (snapshot af Katrines "Ingredienser"-ark,
 * 124 råvarer) og skriver co2e_klima_id + co2e_per_kg + co2e_source + co2e_version
 * til matchende Grocy-produkter. Match: Hørkram-varenr via barcode (sikkert),
 * ellers navne-fuzzy. Al logik i services/co2Concito.js (unit-testet).
 *
 * Idempotent (uændrede rækker springes over). dry-run default. --apply.
 * Skriver ALDRIG når produktet ikke matches eller rækken mangler faktor.
 *
 * Brug:
 *   node scripts/co2-f4-import.js --location=hq               # dry-run: fuld diff-rapport
 *   node scripts/co2-f4-import.js --location=hq --unmatched   # + list umatchede/no-factor rækker
 *   node scripts/co2-f4-import.js --location=hq --apply
 */

const fs = require('fs');
const path = require('path');
const C = require('../services/co2Concito');

if (!process.env.GROCY_HQ_URL && !process.env.GROCY_TEST_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (_) {}
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SHOW_UNMATCHED = args.includes('--unmatched');
const locArg = (args.find(a => a.startsWith('--location=')) || '').split('=')[1] || '';
const ALL = ['hq', 'test', 'cafe'];
let locations;
if (locArg === 'all') locations = ALL;
else if (ALL.includes(locArg)) locations = [locArg];
else { console.error('Brug: --location=hq|test|cafe|all  [--apply] [--unmatched]'); process.exit(1); }

const CSV_PATH = path.join(__dirname, 'co2', 'concito_ingredienser.csv');

// Synonym-par fra data/bon.db (co2_synonyms) — flyttet fra hardcodet kode så de kan
// ses + redigeres i CO₂-rapporten. Fald tilbage til co2Concito's seed hvis tabellen
// ikke findes eller DB'en er utilgængelig.
let SYNONYM_PAIRS = null;
try {
    const { openDb } = require('../db/compat');
    const { loadSynonymPairs } = require('../services/co2Synonyms');
    SYNONYM_PAIRS = loadSynonymPairs(openDb(path.join(__dirname, '..', 'data', 'bon.db')));
    console.log(`Synonym-par fra DB: ${SYNONYM_PAIRS.length}`);
} catch (e) {
    console.log('Synonym-par: bruger seed (DB/tabel utilgængelig:', e.message, ')');
}

function resolveConfig(code) {
    const u = process.env[`GROCY_${code.toUpperCase()}_URL`];
    const k = process.env[`GROCY_${code.toUpperCase()}_KEY`];
    if (!u || !k) throw new Error(`Mangler GROCY_${code.toUpperCase()}_URL / _KEY i .env`);
    return { url: u.replace(/\/+$/, ''), key: k };
}

async function grocy(cfg, method, p, body) {
    const res = await fetch(cfg.url + p, {
        method,
        headers: { 'GROCY-API-KEY': cfg.key, 'Accept': 'application/json',
                   ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Grocy ${method} ${p} → ${res.status}: ${t.slice(0, 200)}`); }
    const t = await res.text();
    return t ? JSON.parse(t) : {};
}

async function processLocation(code, rows) {
    console.log(`\n══ Lokation: ${code.toUpperCase()} ${APPLY ? '(APPLY)' : '(dry-run)'} ══`);
    const cfg = resolveConfig(code);
    const [products, barcodes] = await Promise.all([
        grocy(cfg, 'GET', '/objects/products'),
        grocy(cfg, 'GET', '/objects/product_barcodes'),
    ]);
    const barcodeToPid = new Map();
    for (const b of barcodes) {
        const code = (b.barcode || '').trim();
        if (code && !barcodeToPid.has(code)) barcodeToPid.set(code, b.product_id);
    }

    const synonymMap = C.buildSynonymMap(products, SYNONYM_PAIRS);
    const { entries, summary } = C.buildPlan(rows, products, barcodeToPid, synonymMap);
    const prodName = new Map(products.map(p => [String(p.id), p.name]));

    const matched = summary.write + summary.unchanged + summary.no_factor + summary.conflict + summary.duplicate;
    console.log(`  Rækker: ${summary.total}`);
    console.log(`    matchet:    ${matched}   (via varenr ${summary.via_varenr}, via navn ${summary.via_navn}, via alias ${summary.via_alias})`);
    console.log(`      heraf skriv: ${summary.write},  uændret: ${summary.unchanged},  uden faktor: ${summary.no_factor}`);
    if (summary.duplicate) console.log(`      dubletter (samme faktor, dedupet): ${summary.duplicate}`);
    if (summary.excluded)  console.log(`    udeladt (manuel):  ${summary.excluded}`);
    if (summary.synonym_writes) console.log(`    + synonym-skrivninger (dublet-varer): ${summary.synonym_writes}`);
    console.log(`    umatchet:   ${summary.unmatched}`);
    if (summary.conflict) console.log(`    ⚠ KONFLIKT (flere rækker → samme produkt, forskellig faktor — skrives IKKE): ${summary.conflict}`);
    if (summary.suspicious) console.log(`    ⚠ mistænkelige faktorer (>${C.FACTOR_MAX}): ${summary.suspicious}`);

    // Konflikter er altid vigtige at se — vis dem uanset --unmatched.
    const conflicts = entries.filter(e => e.action === 'conflict');
    if (conflicts.length) {
        console.log(`\n  ⚠ Konflikter (ret varenr/navn i Katrines ark, kør igen):`);
        const byPid = {};
        conflicts.forEach(e => { (byPid[e.match.product.id] = byPid[e.match.product.id] || []).push(e); });
        Object.entries(byPid).forEach(([pid, es]) => {
            console.log(`    [${pid}] ${es[0].match.product.name}:`);
            es.forEach(e => console.log(`        ← "${e.row.ingrediens}" (${e.resolved.source} ${e.resolved.fields.co2e_per_kg}, via ${e.match.via})`));
        });
    }

    // Vis hvad der skrives (navn: kilde faktor, match-vej + score for navne-match)
    const writes = entries.filter(e => e.action === 'write');
    if (writes.length) {
        console.log(`\n  Vil skrive (${writes.length}):`);
        writes.forEach(e => {
            const via = e.match.via === 'navn' ? `navn ${(e.match.score).toFixed(2)}` : e.match.via;
            const susp = e.suspicious ? ' ⚠' : '';
            const also = e.also.length ? ` (+ synonym: ${e.also.map(id => prodName.get(String(id)) || id).join(', ')})` : '';
            console.log(`    • ${e.row.ingrediens.padEnd(24)} → [${e.match.product.id}] ${e.match.product.name.padEnd(22)} ${e.resolved.source} ${e.resolved.fields.co2e_per_kg}${susp}  (${via})${also}`);
        });
    }

    if (SHOW_UNMATCHED) {
        const um = entries.filter(e => e.action === 'unmatched');
        const nf = entries.filter(e => e.action === 'no_factor');
        if (um.length) { console.log(`\n  Umatchede (${um.length}) — intet Grocy-produkt:`); um.forEach(e => console.log(`    · ${e.row.ingrediens}`)); }
        if (nf.length) { console.log(`\n  Uden faktor (${nf.length}) — matchet men ingen CO₂-tal:`); nf.forEach(e => console.log(`    · ${e.row.ingrediens} → [${e.match.product.id}] ${e.match.product.name}`)); }
    }

    if (!APPLY) {
        console.log('\n  → dry-run: intet skrevet. Kør med --apply. (--unmatched viser resten.)');
        return;
    }
    let ok = 0, err = 0;
    for (const e of writes) {
        // writeTargets = canonical (hvis den mangler) + trængende synonym-dublet-varer.
        for (const pid of e.writeTargets) {
            try { await grocy(cfg, 'PUT', `/userfields/products/${pid}`, e.resolved.fields); ok++; }
            catch (ex) { console.log(`    ✗ ${e.row.ingrediens} → ${pid}: ${ex.message}`); err++; }
        }
    }
    console.log(`\n  → Skrevet: ${ok}${err ? `, fejl: ${err}` : ''}.`);
}

(async () => {
    try {
        const rows = C.parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
        console.log(`Indlæst ${rows.length} rækker fra ${path.relative(process.cwd(), CSV_PATH)}`);
        for (const code of locations) await processLocation(code, rows);
        console.log('\nF4 import afsluttet.');
    } catch (err) {
        console.error('\nFEJL:', err.message);
        process.exit(1);
    }
})();
