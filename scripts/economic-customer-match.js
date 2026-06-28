/**
 * scripts/economic-customer-match.js
 * ════════════════════════════════════════════════════════════════════════
 * ENGANGS-BACKFILL: kobl e-conomics EKSISTERENDE kunder til Bon-firmaer/kunder.
 *
 * RETNING: e-conomic → Bon. Vi itererer e-conomics ~999 kunder og finder den
 * Bon-entitet de svarer til (CVR → EAN → navn) — IKKE den anden vej. Skriver
 * `economic_customer_id` tilbage på det matchede Bon-firma (eller privatkunde).
 *
 *   GENERÉR REVIEW (dry, skriver intet):
 *     node --experimental-sqlite scripts/economic-customer-match.js --db data/prod-copy.db
 *       → data/economic-customer-review.csv (godkendt_target-kolonne: "company:ID"/"customer:ID"/"-")
 *
 *   ANVEND GODKENDT LISTE (skriver til Bon-DB):
 *     node --experimental-sqlite scripts/economic-customer-match.js --apply data/economic-customer-review.csv --db data/bon.db
 *       → UPDATE companies/customers SET economic_customer_id. Overskriver aldrig et sat nr.
 *
 * Kundenummer i e-conomic er PR. FIRMA. Privatpersoner er deres egen kunde.
 * Kontaktperson/"Deres reference" (customerContactNumber) håndteres separat.
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const eco = require('../services/economicAdapter');

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DB_PATH   = arg('--db', 'data/prod-copy.db');
const APPLY_CSV = arg('--apply', null);
const OUT_CSV   = arg('--out', 'data/economic-customer-review.csv');
const DRY       = argv.includes('--dry-run');
const FORCE     = argv.includes('--force');

const digits = (s) => String(s || '').replace(/\D/g, '');
const LEGAL = /\b(a\/s|aps|ivs|i\/s|p\/s|k\/s|amba|a\.m\.b\.a|holding|danmark|denmark)\b/gi;
function norm(s) { return String(s || '').toLowerCase().replace(/["'`.,]/g, '').replace(LEGAL, '').replace(/[-–—/]/g, ' ').replace(/\s+/g, ' ').trim(); }
function bg(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) { a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b) return 1; const A = bg(a), B = bg(b); let i = 0, sa = 0, sb = 0; for (const v of A.values()) sa += v; for (const [g, v] of B) { sb += v; if (A.has(g)) i += Math.min(v, A.get(g)); } return sa + sb ? 2 * i / (sa + sb) : 0; }

// Kollaps newlines til mellemrum (nogle e-conomic-navne har linjeskift) så CSV'en
// forbliver én række pr. record — ellers brækker den linje-baserede parser.
const csvCell = (v) => { const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim(); return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCsv(t) { const L = t.split(/\r?\n/).filter(x => x.trim() !== ''); const h = L.shift().split(';'); return L.map(l => { const c = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ';' && !q) { c.push(cur); cur = ''; } else cur += ch; } c.push(cur); const o = {}; h.forEach((x, i) => o[x.trim()] = (c[i] ?? '').trim()); return o; }); }

// ════════════════════════════════════════════════════════════════════════
//  APPLY: læs godkendt CSV → skriv economic_customer_id på Bon-entiteter
// ════════════════════════════════════════════════════════════════════════
function applyMode() {
    const db = new DatabaseSync(DB_PATH);
    const rows = parseCsv(fs.readFileSync(APPLY_CSV, 'utf8'));
    const targets = rows.map(r => {
        const m = /^(company|customer):(\d+)$/.exec((r.godkendt_target || '').trim());
        return m ? { eco_nr: r.economic_nr, type: m[1], id: Number(m[2]), name: r.economic_navn } : null;
    }).filter(Boolean).filter(t => /^\d+$/.test(String(t.eco_nr)));

    console.log(`Læste ${rows.length} rækker · ${targets.length} med et godkendt Bon-target`);
    if (DRY) {
        console.log(`\n── DRY-RUN — intet skrives. ${targets.length} koblinger VILLE blive skrevet: ──`);
        for (const t of targets) console.log(`  ${t.type} ${String(t.id).padStart(5)}  ← economic kunde ${t.eco_nr}  (${t.name})`);
        db.close(); process.exit(0);
    }
    let wrote = 0, skipped = 0, failed = 0;
    const tbl = { company: 'companies', customer: 'customers' };
    for (const t of targets) {
        try {
            const cur = db.prepare(`SELECT economic_customer_id FROM ${tbl[t.type]} WHERE id = ?`).get(t.id);
            if (!cur) { failed++; console.log(`  ✗ ${t.type} ${t.id} findes ikke`); continue; }
            if (!FORCE && cur.economic_customer_id != null && String(cur.economic_customer_id).trim() !== '') { skipped++; continue; }
            db.prepare(`UPDATE ${tbl[t.type]} SET economic_customer_id = ? WHERE id = ?`).run(String(t.eco_nr), t.id);
            wrote++; console.log(`  ✓ ${t.type} ${t.id} → economic ${t.eco_nr}  (${t.name})`);
        } catch (e) { failed++; console.log(`  ✗ ${t.type} ${t.id}: ${e.message}`); }
    }
    console.log(`\nFærdig: ${wrote} skrevet · ${skipped} sprunget over (havde allerede nr.) · ${failed} fejl`);
    db.close(); process.exit(failed ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════
//  GENERATE: match e-conomic-kunder → Bon-entiteter
// ════════════════════════════════════════════════════════════════════════
async function generateMode() {
    if (!eco.isConfigured()) { console.error('✗ e-conomic ikke konfigureret'); process.exit(1); }

    // e-conomics kunder
    let ecoCust = [], skip = 0;
    while (true) { const r = await eco.rest('/customers?pagesize=100&skippages=' + skip); ecoCust = ecoCust.concat(r.collection || []); if (!r.pagination?.nextPage || ++skip > 30) break; }
    const customers = ecoCust.map(k => ({ number: String(k.customerNumber), name: k.name || '', ids: [digits(k.corporateIdentificationNumber), digits(k.ean)].filter(Boolean), barred: !!k.barred }));
    console.log(`e-conomic: ${customers.length} kunder`);

    // Bon-firmaer + private kunder
    const db = new DatabaseSync(DB_PATH);
    const companies = db.prepare('SELECT id, name, cvr, ean, economic_customer_id FROM companies').all()
        .map(c => ({ ...c, ids: [digits(c.cvr), digits(c.ean)].filter(Boolean) }));
    const privates = db.prepare("SELECT id, (first_name || ' ' || COALESCE(last_name,'')) AS name, economic_customer_id FROM customers WHERE company_id IS NULL").all();
    db.close();

    // id-indeks (CVR/EAN → firma)
    const idIndex = new Map();
    for (const c of companies) for (const id of c.ids) if (!idIndex.has(id)) idIndex.set(id, c);

    function classify(k) {
        if (k.barred) return { status: 'SPÆRRET', match: '', type: '', id: '', name: '', cvr: '', score: 0 };
        // 1) id-match (CVR/EAN) — stærkest, eneste der auto-udfyldes
        for (const id of k.ids) { const hit = idIndex.get(id); if (hit) return { status: 'AUTO', match: 'cvr/ean', type: 'company', id: hit.id, name: hit.name, cvr: hit.cvr, score: 1 }; }
        // 2) navne-match mod firmaer + private (bedste af de to) — KUN review, aldrig auto
        let best = null;
        for (const c of companies) { const s = dice(k.name, c.name); if (!best || s > best.score) best = { type: 'company', id: c.id, name: c.name, cvr: c.cvr, score: s }; }
        for (const p of privates) { const s = dice(k.name, p.name); if (s > (best?.score || 0)) best = { type: 'customer', id: p.id, name: p.name, cvr: '', score: s }; }
        if (!best || best.score < 0.6) return { status: 'INGEN', match: 'navn', type: '', id: '', name: best?.name || '', cvr: '', score: best?.score || 0 };
        return { status: best.score >= 0.82 ? 'NAVN-STÆRK' : 'TJEK', match: 'navn', ...best };
    }

    let rows = customers.map(k => ({ k, m: classify(k) }));

    // Kollision KUN blandt CVR/EAN-matches: flere e-conomic-kunder med samme CVR →
    // samme Bon-firma (afdelinger under samme CVR / dubletter i e-conomic). Navne-
    // matches deltager ikke — ellers flagges en populær firma falsk som kollision.
    const seen = new Map();
    for (const r of rows) if (r.m.match === 'cvr/ean') { const key = r.m.type + ':' + r.m.id; seen.set(key, (seen.get(key) || 0) + 1); }
    for (const r of rows) if (r.m.match === 'cvr/ean' && seen.get(r.m.type + ':' + r.m.id) > 1) r.m.status = 'KOLLISION';

    // sortér: AUTO, KOLLISION, NAVN-STÆRK, TJEK, INGEN, SPÆRRET
    const ord = { AUTO: 0, KOLLISION: 1, 'NAVN-STÆRK': 2, TJEK: 3, INGEN: 4, 'SPÆRRET': 5 };
    rows.sort((a, b) => (ord[a.m.status] - ord[b.m.status]) || a.k.name.localeCompare(b.k.name));

    const header = ['status', 'economic_nr', 'economic_navn', 'economic_cvr', 'economic_ean', 'match', 'score', 'bon_type', 'bon_id', 'bon_navn', 'bon_cvr', 'godkendt_target'];
    const out = [header.join(';')];
    for (const { k, m } of rows) {
        const approved = m.status === 'AUTO' && m.id ? `${m.type}:${m.id}` : '';   // KUN CVR/EAN auto-udfyldes
        out.push([m.status, k.number, k.name, k.ids[0] || '', k.ids[1] || '', m.match, m.score ? m.score.toFixed(2) : '', m.type, m.id, m.name, m.cvr || '', approved].map(csvCell).join(';'));
    }
    fs.writeFileSync(OUT_CSV, out.join('\n') + '\n');

    const cnt = (s) => rows.filter(r => r.m.status === s).length;
    console.log('\nSTATUS-FORDELING:');
    for (const s of ['AUTO', 'KOLLISION', 'NAVN-STÆRK', 'TJEK', 'INGEN', 'SPÆRRET']) console.log(`  ${s.padEnd(11)} ${String(cnt(s)).padStart(4)}`);
    console.log(`\n→ Skrev ${rows.length} rækker til ${OUT_CSV}`);
    console.log('   KUN AUTO (CVR/EAN-match) er forhåndsudfyldt i godkendt_target — de er sikre.');
    console.log('   NAVN-STÆRK/TJEK/KOLLISION/INGEN udfyldes/bekræftes manuelt (forkert kunde = faktura til forkert firma).');
    console.log(`   Format på godkendt_target: "company:ID" / "customer:ID" / "-" (ingen kobling).`);
    console.log(`\n   Anvend:  node --experimental-sqlite scripts/economic-customer-match.js --apply ${OUT_CSV} --db data/bon.db`);
}

(APPLY_CSV ? applyMode() : generateMode());
