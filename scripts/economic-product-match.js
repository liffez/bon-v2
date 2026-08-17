/**
 * scripts/economic-product-match.js
 * ════════════════════════════════════════════════════════════════════════
 * ENGANGS-BACKFILL: foreslå economic_product_number for solgte Grocy-recipes
 * og (efter review) skriv de godkendte numre til Grocy HQ's recipe-userfield.
 *
 * Spec: docs/economics/CLAUDE_ECONOMIC_ADAPTER.md → PRODUKTNUMMER-MAPPING.
 *
 *   GENERÉR REVIEW-LISTE (dry — skriver intet til Grocy):
 *     node --experimental-sqlite scripts/economic-product-match.js --db data/prod-copy.db
 *       → skriver data/economic-match-review.csv (status, forslag, godkendt_nr-kolonne)
 *
 *   ANVEND GODKENDT LISTE (skriver til Grocy HQ):
 *     node --experimental-sqlite scripts/economic-product-match.js --apply data/economic-match-review.csv
 *       → PUT /userfields/recipes/{id} for hver række med et tal i godkendt_nr.
 *         Skriver ALDRIG hvis godkendt_nr er tom eller '-'. Overskriver aldrig et
 *         allerede sat nummer (med mindre --force).
 *
 * Opskrifter der er slettet i Grocy får status SLETTET og godkendt_nr = '-'. De kan
 * ikke kobles: userfield-værdier overlever sletningen, så en PUT ser ud til at lykkes,
 * men faktureringen læser /objects/recipes og ser dem aldrig. Apply-mode tjekker
 * eksistensen igen, så en håndredigeret CSV heller ikke kan skrive et spøgelse.
 *
 * Kategori afgør status (renere end navne-gætteri):
 *   sælgbar mad + emballage → match til vare · x-Levering/x-Service → service-varenr
 *   RR Produktion* → prep, ingen kobling.
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
const OUT_CSV   = arg('--out', 'data/economic-match-review.csv');
const AUTO_MIN  = parseFloat(arg('--min', '0.72'));
const FORCE     = argv.includes('--force');
const DRY       = argv.includes('--dry-run');

// ─── kategorier ────────────────────────────────────────────────────────────
const SELLABLE_CATS = ['01 Sandwich', '04 Slider', '02 Salat', '03 Kager', '05 Drikke', 'Frugt'];
const PACKAGING_CATS = ['06 Emballage', 'Tilbehør & Bokse'];
const SERVICE_CATS  = ['x-Levering', 'x- Service'];
const PREP_CATS     = ['RR Produktion', 'RR produktion Hurtig'];

// ─── navne-normalisering + score (Dice + prefix/containment-bonus) ──────────
function norm(s) {
    return String(s || '').toLowerCase()
        .replace(/["'`]/g, '')
        .replace(/\(emballage\)/g, '')
        .replace(/[-–—/]/g, ' ')
        .replace(/\bm\b|\bmed\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}
function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function dice(a, b) {
    if (!a || !b) return 0; if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b); let inter = 0, sa = 0, sb = 0;
    for (const v of A.values()) sa += v;
    for (const [g, v] of B) { sb += v; if (A.has(g)) inter += Math.min(v, A.get(g)); }
    return sa + sb === 0 ? 0 : (2 * inter) / (sa + sb);
}
function score(a, b) {
    const na = norm(a), nb = norm(b);
    let s = dice(na, nb);
    if (na && nb && Math.min(na.length, nb.length) >= 4 && (nb.startsWith(na) || na.startsWith(nb))) s = Math.max(s, 0.85);
    if (na && nb && Math.min(na.length, nb.length) >= 5 && (nb.includes(na) || na.includes(nb))) s = Math.max(s, 0.80);
    return s;
}

// ─── domæne-regler (fra kontoret, 25. juni) ────────────────────────────────
const DISCONTINUED = /^(tomaten|humus)/i;               // udgået → ingen kobling
function kasseOverride(name) {
    if (!/transportkasse/i.test(name)) return null;
    return /m\.?\s*l[åa]g|med l[åa]g/i.test(name)
        ? { number: '58', name: 'Transportkasse, med låg' }
        : { number: '56', name: 'Transportkasse, uden låg' };
}
function serviceMatch(name) {
    const n = name.toLowerCase();
    if (/el-?taxa|elbil/.test(n))          return { number: '100', name: 'Levering med el-taxa' };
    if (/by-?ekspressen/.test(n))          return /langt v[æa]k/.test(n) ? { number: '18', name: 'Transport udenfor Stor.Kbh' } : { number: '17', name: 'Levering med cykel' };
    if (/rr leverer/.test(n))              return { number: '103', name: 'Levering Ristet Rug' };
    if (/servicepersonale|bemanding/.test(n)) return { number: '50', name: 'Bemanding/undervisning/konsulent' };
    if (/ekspres/.test(n))                 return { number: '64', name: 'Ekspresgebyr 10%' };
    if (/milj[øo]/.test(n))                return { number: '98', name: 'MiljøBidrag' };
    if (/betalingsgebyr|kortbetaling/.test(n)) return { number: '99', name: 'Betalingsgebyr' };
    return null;
}

// ─── CSV helpers ───────────────────────────────────────────────────────────
const csvCell = (v) => { const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim(); return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    const head = lines.shift().split(';');
    return lines.map(l => {
        // simpel parser (felter uden indlejret ; i godkendt_nr — tal/'-')
        const cells = []; let cur = '', q = false;
        for (const ch of l) { if (ch === '"') q = !q; else if (ch === ';' && !q) { cells.push(cur); cur = ''; } else cur += ch; }
        cells.push(cur);
        const o = {}; head.forEach((h, i) => o[h.trim()] = (cells[i] ?? '').trim()); return o;
    });
}

// ════════════════════════════════════════════════════════════════════════
//  APPLY-MODE: læs godkendt CSV → skriv til Grocy HQ
// ════════════════════════════════════════════════════════════════════════
async function applyMode() {
    const HQ_URL = process.env.GROCY_HQ_URL, HQ_KEY = process.env.GROCY_HQ_KEY;
    if (!HQ_URL || !HQ_KEY) { console.error('✗ GROCY_HQ_URL/GROCY_HQ_KEY mangler i .env'); process.exit(1); }
    const rows = parseCsv(fs.readFileSync(APPLY_CSV, 'utf8'));
    const writable = rows.filter(r => /^\d+$/.test((r.godkendt_nr || '').trim()));
    const skippedRows = rows.length - writable.length;
    console.log(`Læste ${rows.length} rækker · ${writable.length} med et godkendt tal · ${skippedRows} sprunget over (tom/'-')`);

    if (DRY) {
        console.log(`\n── DRY-RUN — intet skrives. Følgende ${writable.length} koblinger VILLE blive skrevet til Grocy HQ: ──`);
        for (const r of writable) console.log(`  recipe ${String(r.recipe_id).padStart(4)}  ${String(r.recipe_navn).slice(0, 34).padEnd(35)} → ${r.godkendt_nr}`);
        console.log(`\n(Kør uden --dry-run for at skrive mod ${HQ_URL})`);
        process.exit(0);
    }

    console.log(`Skriver til Grocy HQ: ${HQ_URL}\n`);
    let wrote = 0, skipped = 0, failed = 0, gone = 0;
    for (const r of writable) {
        const id = r.recipe_id, num = r.godkendt_nr.trim();
        try {
            // Findes opskriften overhovedet? Userfield-VÆRDIER overlever at en opskrift
            // slettes i Grocy, så en PUT lykkes på et id der ikke findes — og et GET
            // svarer med den gamle værdi. Faktureringen læser /objects/recipes og ser
            // kun levende opskrifter, så et spøgelse dér er usynligt: koblingen ser
            // udført ud og virker ikke. Tjek derfor eksistensen FØR alt andet.
            const exists = await fetch(`${HQ_URL}/objects/recipes/${id}`, { headers: { 'GROCY-API-KEY': HQ_KEY, 'Accept': 'application/json' } });
            if (exists.status === 404) {
                gone++;
                console.log(`  ⊘ recipe ${id} findes ikke i Grocy — kan ikke kobles (${r.recipe_navn})`);
                continue;
            }
            if (!exists.ok) throw new Error(`kunne ikke slå opskriften op: HTTP ${exists.status}`);

            if (!FORCE) {
                const cur = await fetch(`${HQ_URL}/userfields/recipes/${id}`, { headers: { 'GROCY-API-KEY': HQ_KEY, 'Accept': 'application/json' } }).then(x => x.ok ? x.json() : {});
                if (cur && cur.economic_product_number && String(cur.economic_product_number).trim() !== '') { skipped++; console.log(`  ↷ recipe ${id} har allerede ${cur.economic_product_number} (brug --force for at overskrive)`); continue; }
            }
            const res = await fetch(`${HQ_URL}/userfields/recipes/${id}`, {
                method: 'PUT', headers: { 'GROCY-API-KEY': HQ_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ economic_product_number: num }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            wrote++; console.log(`  ✓ recipe ${id} → ${num}  (${r.recipe_navn})`);
        } catch (e) { failed++; console.log(`  ✗ recipe ${id}: ${e.message}`); }
    }
    console.log(`\nFærdig: ${wrote} skrevet · ${skipped} havde allerede et nummer · ${gone} findes ikke i Grocy · ${failed} fejl`);
    if (gone) {
        console.log(`\n  ${gone === 1 ? 'Den slettede opskrift lever' : `De ${gone} slettede opskrifter lever`}`
            + ' kun videre på gamle bons og kan aldrig kobles.');
        console.log('  Deres bons faktureres via "Fakturér som engangsbeløb" i faktureringen. Se issue #441.');
    }
    process.exit(failed ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════
//  GENERATE-MODE: byg review-CSV
// ════════════════════════════════════════════════════════════════════════
async function generateMode() {
    if (!eco.isConfigured()) { console.error('✗ e-conomic ikke konfigureret i .env'); process.exit(1); }

    // e-conomics aktive produkter
    let products = [], skip = 0;
    while (true) { const r = await eco.rest('/products?pagesize=100&skippages=' + skip); products = products.concat(r.collection || []); if (!r.pagination?.nextPage || ++skip > 20) break; }
    const active = products.filter(p => !p.barred).map(p => ({ number: String(p.productNumber), name: p.name }));
    console.log(`e-conomic: ${products.length} produkter (${active.length} aktive)`);

    // Levende opskrifter i Grocy. CSV'en bygges af bon_lines, som også rummer
    // opskrifter der siden er slettet — de kan ikke kobles, og skal ikke se ud
    // som om de kan. Kan Grocy ikke nås, markerer vi ingen (og siger det).
    let liveIds = null;
    const HQ_URL = process.env.GROCY_HQ_URL, HQ_KEY = process.env.GROCY_HQ_KEY;
    if (HQ_URL && HQ_KEY) {
        try {
            const arr = await fetch(`${HQ_URL}/objects/recipes`, { headers: { 'GROCY-API-KEY': HQ_KEY, 'Accept': 'application/json' } }).then(x => x.json());
            liveIds = new Set(arr.map(r => Number(r.id)));
            console.log(`Grocy HQ: ${liveIds.size} levende opskrifter`);
        } catch (e) { console.log(`⚠ Kunne ikke hente opskrifter fra Grocy (${e.message}) — slettede markeres ikke.`); }
    } else {
        console.log('⚠ GROCY_HQ_URL/GROCY_HQ_KEY mangler — slettede opskrifter markeres ikke.');
    }

    // solgte recipes m. dominant kategori
    const db = new DatabaseSync(DB_PATH);
    const raw = db.prepare(`SELECT grocy_recipe_id rid, product_name name, COALESCE(category,'') cat, COUNT(*) n
                            FROM bon_lines WHERE grocy_recipe_id IS NOT NULL GROUP BY grocy_recipe_id, product_name, category`).all();
    db.close();
    const byRid = new Map();
    for (const r of raw) {
        let e = byRid.get(r.rid); if (!e) { e = { rid: r.rid, sold: 0, names: new Map(), cats: new Map() }; byRid.set(r.rid, e); }
        e.sold += r.n; e.names.set(r.name, (e.names.get(r.name) || 0) + r.n); e.cats.set(r.cat, (e.cats.get(r.cat) || 0) + r.n);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const recipes = [...byRid.values()].map(e => ({ rid: e.rid, name: top(e.names), cat: top(e.cats), sold: e.sold }));
    console.log(`DB ${DB_PATH}: ${recipes.length} distinkte solgte recipes\n`);

    // Kategori-bevidst straf: en Salat-recipe må ikke ramme en sandwich/slider-vare osv.
    // (fanger fx "Kyllingen BBQ-Salat" → 35 "…salat m brød", ikke 70 "Kyllingen").
    function catPenalty(cat, pname) {
        const p = pname.toLowerCase();
        if (cat === '02 Salat')    return /salat|bowl/.test(p) ? 1 : 0.45;
        if (cat === '04 Slider')   return /slider/.test(p) ? 1 : 0.45;
        if (cat === '01 Sandwich') return /slider|salat m br|bowl/.test(p) ? 0.45 : 1;
        return 1;
    }
    function bestMatch(name, cat) {
        let best = null;
        for (const p of active) { const s = score(name, p.name) * catPenalty(cat, p.name); if (!best || s > best.s) best = { ...p, s }; }
        return best;
    }
    // Catch-all-kategorier er for upålidelige til auto-udfyldning → maks. TJEK.
    const AMBIGUOUS = new Set(['Tilbehør & Bokse', 'lunch', '']);

    function classify(r) {
        const base = { status: '', number: '', pname: '', score: 0, approved: '' };
        // Først af alt: findes opskriften stadig? Et navne-gæt på "udgået" er en
        // heuristik — 404 fra Grocy er en kendsgerning, og den slår alt andet.
        if (liveIds && !liveIds.has(Number(r.rid))) return { ...base, status: 'SLETTET', approved: '-' };
        if (DISCONTINUED.test(r.name)) return { ...base, status: 'UDGÅET', approved: '-' };
        if (PREP_CATS.includes(r.cat)) return { ...base, status: 'PREP', approved: '-' };
        const kasse = kasseOverride(r.name);
        if (kasse) return { status: 'AUTO', number: kasse.number, pname: kasse.name, score: 1, approved: kasse.number };
        if (SERVICE_CATS.includes(r.cat)) {
            const sm = serviceMatch(r.name);
            if (sm) return { status: 'SERVICE', number: sm.number, pname: sm.name, score: 1, approved: sm.number };
            const b = bestMatch(r.name, r.cat);   // fald tilbage til fuzzy (fanger fx "Skilte" → 102)
            return b && b.s >= AUTO_MIN
                ? { status: 'SERVICE', number: b.number, pname: b.name, score: b.s, approved: b.number }
                : { status: 'SERVICE?', number: b?.number || '', pname: b?.name || '', score: b?.s || 0, approved: '' };
        }
        // sælgbar mad/emballage → kategori-bevidst fuzzy match
        const best = bestMatch(r.name, r.cat);
        if (!best) return { ...base, status: 'MANGLER?' };
        const canAuto = best.s >= AUTO_MIN && !AMBIGUOUS.has(r.cat);
        if (canAuto)       return { status: 'AUTO', number: best.number, pname: best.name, score: best.s, approved: best.number };
        if (best.s >= 0.5) return { status: 'TJEK', number: best.number, pname: best.name, score: best.s, approved: '' };
        return { status: 'MANGLER?', number: best.number, pname: best.name, score: best.s, approved: '' };
    }

    const rows = recipes.map(r => ({ ...r, ...classify(r) }));
    const order = { AUTO: 0, SERVICE: 1, 'SERVICE?': 2, TJEK: 3, 'MANGLER?': 4, UDGÅET: 5, PREP: 6, SLETTET: 7 };
    rows.sort((a, b) => (order[a.status] - order[b.status]) || (b.sold - a.sold));

    // CSV
    const header = ['status', 'solgt', 'recipe_id', 'kategori', 'recipe_navn', 'forslag_nr', 'forslag_navn', 'score', 'godkendt_nr'];
    const out = [header.join(';')];
    for (const r of rows) out.push([r.status, r.sold, r.rid, r.cat, r.name, r.number, r.pname, r.score ? r.score.toFixed(2) : '', r.approved].map(csvCell).join(';'));
    fs.writeFileSync(OUT_CSV, out.join('\n') + '\n');

    // konsol-opsummering
    const count = (s) => rows.filter(r => r.status === s).length;
    console.log('STATUS-FORDELING:');
    for (const s of ['AUTO', 'SERVICE', 'SERVICE?', 'TJEK', 'MANGLER?', 'UDGÅET', 'PREP', 'SLETTET'])
        console.log(`  ${s.padEnd(9)} ${String(count(s)).padStart(3)}`);
    console.log(`\n→ Skrev ${rows.length} rækker til ${OUT_CSV}`);
    console.log('   AUTO + SERVICE er forhåndsudfyldt i godkendt_nr. TJEK/MANGLER?/SERVICE? er tomme — udfyld/ret i Excel.');
    const slettet = count('SLETTET');
    if (slettet) console.log(`   SLETTET (${slettet}) findes ikke længere i Grocy og kan ALDRIG kobles — deres bons faktureres som engangsbeløb (issue #441).`);
    console.log('   PREP + UDGÅET har godkendt_nr = "-" (bevidst ingen kobling).');
    console.log(`\n   Når listen er gennemgået:  node --experimental-sqlite scripts/economic-product-match.js --apply ${OUT_CSV}`);
}

(APPLY_CSV ? applyMode() : generateMode());
