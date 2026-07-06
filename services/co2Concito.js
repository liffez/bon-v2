// services/co2Concito.js
// ==========================================
// CO₂ F4 — import af fødevare-faktorer (Katrines CONCITO-kuraterede ark) → Grocy.
// Spec: docs/CLAUDE_CO2.md §1 (kildehierarki) + §8 (import-loop) + §12 trin 4.
//
// Ren logik (ingen Grocy-kald, ingen fs her) → fuldt unit-testbar:
//   • parseCsv   — Katrines Ingredienser-snapshot (scripts/co2/concito_ingredienser.csv)
//   • resolveFields — én CSV-række → { co2e_klima_id, co2e_per_kg, co2e_source, co2e_version }
//     efter kildehierarki: Klimadatabase-faktor > Hørkram-faktor > (ingen)
//   • matchProduct — Katrine-række → Grocy-produkt: Hørkram-varenr via barcode (sikkert),
//     ellers navne-fuzzy (Dice-bigram)
//   • buildPlan — hele importen → diff (write/unchanged/no_factor/unmatched) + plausibilitet
//
// CLI'en (scripts/co2-f4-import.js) henter Grocy-data + fs, kalder disse, og skriver.
// ==========================================

'use strict';

// Kildeversioner (skrives til co2e_version). Katrines ark = CONCITO v1.1-seed (§8).
const KLIMA_VERSION   = 'CONCITO v1.1 (Katrine)';
const HORKRAM_VERSION = 'Hørkram (Katrine)';

// Plausibilitetsgrænser (§9): faktor uden for [0, 40] er mistænkelig (0 er ok — fx vand).
const FACTOR_MAX = 40;
// Navne-fuzzy: match accepteres ved score ≥ dette (jf. kodebasens 0.6-tærskel).
const NAME_THRESHOLD = 0.6;

// Manuelle navne-aliaser: Katrine-navn (normaliseret) → Grocy-produktnavn (normaliseret).
// Bruges når varenr mangler OG fuzzy ikke rammer. Bekræftet manuelt med Leif (F4-review).
const NAME_ALIASES = {
    'olie solsikkekerne': 'olie',
    'pepper':             'pebber stødt',   // Grocy: "pebber - stødt"
    'gris':               'svinekam',
};

// Kollision: to rækker → samme produkt med faktorer inden for denne relative
// afstand behandles som SAMME (dedupér, ikke konflikt) — fanger rundings-dubletter
// (fx 1,2476 vs 1,25) uden at maskere ægte forskelle (fx 3,61 vs 4,99).
const COLLISION_REL_TOL = 0.02;

// Katrine-rækker der IKKE skal importeres (normaliseret navn). Bekræftet m. Leif:
// Grocy's "Frikadeller" ER bønnefrikadellen (= Katrines "Frikadelle med bønner"),
// så Katrines egen "Frikadeller"-række (hakkebøf) har ingen Grocy-vare.
const MANUAL_EXCLUDE = new Set(['frikadeller']);

// Synonym-grupper: Grocy har dublet-/variant-varer for samme råvare (bekræftet m.
// Leif — bl.a. via Grocy parent_product_id: Hvidkål er barn af "kål"). Faktoren
// skrives til ALLE i gruppen. Angives som normaliserede navne; opløses til
// produkt-id'er ved kørsel (lokations-robust). [kanonisk, ...synonymer].
const SYNONYM_GROUPS = [
    ['hvidkål', 'kål'],
    ['rødløg rå', 'rødløg sylt'],
    ['løvstikke frisk', 'løvstikke pakke'],
    ['burgerlommer alm', 'små burgerlommer'],   // samme brød, forskellig størrelse (låser sliderne op)
    ['rødkål rå', 'rødkål sylt'],               // samme rødkål, rå vs syltet
];

/** Byg Map<product_id, [synonym product_id, ...]> ud fra SYNONYM_GROUPS + produktliste. */
function buildSynonymMap(products) {
    const byNorm = new Map();
    for (const p of products) { const n = normName(p.name); if (!byNorm.has(n)) byNorm.set(n, p.id); }
    const map = new Map();
    for (const group of SYNONYM_GROUPS) {
        const ids = group.map(n => byNorm.get(n)).filter(id => id != null);
        for (const id of ids) {
            const others = ids.filter(x => x !== id);
            if (others.length) map.set(String(id), others);
        }
    }
    return map;
}

/* ---------- CSV ---------- */

/** Citat-bevidst CSV-parse → array af række-objekter (header-styret). */
function parseCsv(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.length);
    if (!lines.length) return [];
    const header = splitCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        if (cells.every(c => c === '')) continue;
        const obj = {};
        header.forEach((h, j) => { obj[h] = (cells[j] || '').trim(); });
        rows.push(obj);
    }
    return rows;
}

function splitCsvLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

/* ---------- resolution (kildehierarki §1) ---------- */

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/**
 * Én CSV-række → hvilke userfields der skal skrives.
 * Klimadatabase-faktor har forrang; ellers Hørkram; ellers null (ingen faktor).
 * Returnerer også `suspicious` (faktor > FACTOR_MAX) så importen kan flage den.
 */
function resolveFields(row) {
    const klimaId = (row.klima_id || '').trim();
    const klima = num(row.klima_kg);
    const horkram = num(row.horkram_kg);

    if (klima != null && klima >= 0) {
        return {
            fields: {
                co2e_klima_id: klimaId,
                co2e_per_kg:   String(klima),
                co2e_source:   'klimadb',
                co2e_version:  KLIMA_VERSION,
            },
            factor: klima,
            source: 'klimadb',
            suspicious: klima > FACTOR_MAX,
        };
    }
    if (horkram != null && horkram > 0) {
        return {
            fields: {
                co2e_klima_id: klimaId,   // bevar Ra-ID hvis kendt, selv når faktoren er Hørkram
                co2e_per_kg:   String(horkram),
                co2e_source:   'supplier',
                co2e_version:  HORKRAM_VERSION,
            },
            factor: horkram,
            source: 'supplier',
            suspicious: horkram > FACTOR_MAX,
        };
    }
    return null; // ingen brugbar faktor
}

/* ---------- navne-fuzzy (Dice-bigram) ---------- */

/** Normalisér til matchning: lowercase, fjern tegnsætning, kollaps mellemrum. Bevarer æøå. */
function normName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^0-9a-zæøå]+/gi, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Sørensen–Dice på tegn-bigrammer. 1 = identisk, 0 = intet fælles. */
function dice(a, b) {
    a = normName(a); b = normName(b);
    if (!a.length || !b.length) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = bg(a), B = bg(b);
    let inter = 0;
    for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
    return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

/**
 * Match én Katrine-række → Grocy-produkt.
 *   1. Hørkram-varenr → barcode → produkt (sikkert, score 1)
 *   2. navne-fuzzy (Dice ≥ NAME_THRESHOLD)
 * @param barcodeToPid Map<string varenr, number product_id>
 * @param products [{ id, name }]
 * @returns { product|null, via:'varenr'|'navn'|'none', score }
 */
function matchProduct(row, products, barcodeToPid) {
    const varenr = (row.horkram_varenr || '').trim();
    if (varenr && barcodeToPid.has(varenr)) {
        const pid = barcodeToPid.get(varenr);
        const p = products.find(x => String(x.id) === String(pid));
        if (p) return { product: p, via: 'varenr', score: 1 };
    }
    // Manuel alias (bekræftet med Leif) — matcher på eksakt Grocy-navn.
    const aliasTarget = NAME_ALIASES[normName(row.ingrediens)];
    if (aliasTarget) {
        const p = products.find(x => normName(x.name) === aliasTarget);
        if (p) return { product: p, via: 'alias', score: 1 };
    }
    let best = null, bestScore = 0;
    for (const p of products) {
        const s = dice(row.ingrediens, p.name);
        if (s > bestScore) { bestScore = s; best = p; }
    }
    if (best && bestScore >= NAME_THRESHOLD) return { product: best, via: 'navn', score: bestScore };
    return { product: null, via: 'none', score: bestScore };
}

/* ---------- plan ---------- */

/**
 * Byg importplanen. Sammenligner resolvet faktor mod produktets NUVÆRENDE userfields
 * så uændrede rækker ikke skrives igen (idempotens).
 * @param rows CSV-rækker
 * @param products [{ id, name, userfields }]
 * @param barcodeToPid Map
 * @returns { entries, summary }
 */
function buildPlan(rows, products, barcodeToPid, synonymMap) {
    const syn = synonymMap || new Map();
    const productById = new Map(products.map(p => [String(p.id), p]));
    // Har produktet allerede præcis den resolvede faktor? (idempotens-tjek)
    const hasFactor = (p, fields) => {
        const uf = (p && p.userfields) || {};
        return String(uf.co2e_per_kg || '') === fields.co2e_per_kg
            && (uf.co2e_source || '') === fields.co2e_source
            && (uf.co2e_klima_id || '') === fields.co2e_klima_id;
    };

    const entries = rows.map(row => {
        const excluded = MANUAL_EXCLUDE.has(normName(row.ingrediens));
        const match = excluded ? { product: null, via: 'excluded', score: 0 } : matchProduct(row, products, barcodeToPid);
        const resolved = resolveFields(row);

        let action;
        let also = [];   // synonym-produkter der (stadig) mangler faktoren
        if (excluded) action = 'excluded';
        else if (!match.product) action = 'unmatched';
        else if (!resolved) action = 'no_factor';
        else {
            const canonicalNeeds = !hasFactor(match.product, resolved.fields);
            // Synonym-dubletter (fx kål ← Hvidkål) der mangler faktoren — uafhængigt
            // af om canonical selv skal skrives (den kan allerede være opdateret).
            also = (syn.get(String(match.product.id)) || [])
                .filter(id => { const sp = productById.get(String(id)); return sp && !hasFactor(sp, resolved.fields); });
            action = (canonicalNeeds || also.length) ? 'write' : 'unchanged';
            // writeTargets: canonical (kun hvis den mangler) + trængende synonymer.
            match._writeTargets = (canonicalNeeds ? [match.product.id] : []).concat(also);
        }
        return { row, match, resolved, action, also, writeTargets: (match && match._writeTargets) || [],
                 suspicious: !!(resolved && resolved.suspicious) };
    });

    // Kollision: flere rækker der vil skrive til SAMME produkt (typisk dubleret
    // Hørkram-varenr i Katrines ark). Samme faktor → dedupér (behold varenr-match,
    // ellers første; øvrige = 'duplicate'). Forskellig faktor → 'conflict' (skriv
    // IKKE — vi må ikke gætte hvilket tal der er rigtigt).
    const byPid = new Map();
    entries.forEach((e, i) => {
        if (e.action !== 'write') return;
        const pid = String(e.match.product.id);
        (byPid.get(pid) || byPid.set(pid, []).get(pid)).push(i);
    });
    for (const idxs of byPid.values()) {
        if (idxs.length < 2) continue;
        const nums = idxs.map(i => Number(entries[i].resolved.fields.co2e_per_kg));
        const min = Math.min(...nums), max = Math.max(...nums);
        const rel = max === 0 ? (min === 0 ? 0 : 1) : (max - min) / Math.abs(max);
        if (rel > COLLISION_REL_TOL) {
            idxs.forEach(i => { entries[i].action = 'conflict'; });
        } else {
            // samme faktor: behold ét (foretræk varenr-match), resten = duplicate
            let keep = idxs.find(i => entries[i].match.via === 'varenr');
            if (keep == null) keep = idxs[0];
            idxs.forEach(i => { if (i !== keep) entries[i].action = 'duplicate'; });
        }
    }

    const summary = { total: rows.length, write: 0, unchanged: 0, no_factor: 0, unmatched: 0,
                      conflict: 0, duplicate: 0, excluded: 0, suspicious: 0,
                      via_varenr: 0, via_navn: 0, via_alias: 0, synonym_writes: 0 };
    for (const e of entries) {
        summary[e.action]++;
        if (e.action === 'write') summary.synonym_writes += e.also.length;
        if (e.suspicious) summary.suspicious++;
        if (e.match.via === 'varenr') summary.via_varenr++;
        else if (e.match.via === 'navn') summary.via_navn++;
        else if (e.match.via === 'alias') summary.via_alias++;
    }
    return { entries, summary };
}

module.exports = {
    parseCsv, resolveFields, normName, dice, matchProduct, buildPlan, buildSynonymMap,
    KLIMA_VERSION, HORKRAM_VERSION, FACTOR_MAX, NAME_THRESHOLD,
};
