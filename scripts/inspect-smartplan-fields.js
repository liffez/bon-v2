#!/usr/bin/env node
// scripts/inspect-smartplan-fields.js — READ-ONLY
// ============================================================
// Hvilke felter leverer Smartplan egentlig på en vagt?
//
// Vi bruger elleve. Om der er flere — fx en note hvor det står HVILKEN festival
// vagten hører til — har ingen set efter. Spørgsmålet er blevet aktuelt: kører
// to events samme weekend, kan lønnen ikke fordeles på dato + lokation alene.
//
// Siden vagtplanen nu spejles lokalt (migration 163), ligger de rå svar i
// databasen. Spørgsmålet kan altså besvares UDEN at kalde Smartplan.
//
// Kør:  node --experimental-sqlite scripts/inspect-smartplan-fields.js
//       ... --field notes      (vis alle værdier for ét felt)
// ============================================================

const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || './data/bon.db';
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf('--field'); return i >= 0 ? argv[i + 1] : null; })();

const db = openDb(DB_PATH);

const rows = db.prepare('SELECT source, raw_json FROM smartplan_shifts').all();
if (!rows.length) {
    console.log('\nSpejlet er tomt — kør en synkronisering først (Settings → Smartplan → Synkroniser nu).\n');
    process.exit(0);
}

// Fladt nøgle-kort, ét niveau ned i objekter. Dybere er sjældent interessant og
// gør outputtet ulæseligt.
function flatten(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) {
            Object.assign(out, flatten(v, key));
        } else {
            out[key] = v;
        }
    }
    return out;
}

const seen = new Map();   // felt → { filled, total, samples:Set }
for (const r of rows) {
    let rec;
    try { rec = JSON.parse(r.raw_json); } catch { continue; }
    const flat = flatten(rec);
    for (const [k, v] of Object.entries(flat)) {
        if (!seen.has(k)) seen.set(k, { filled: 0, total: 0, samples: new Set() });
        const e = seen.get(k);
        e.total++;
        const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
        if (!empty) {
            e.filled++;
            if (e.samples.size < 4) e.samples.add(typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
    }
}

if (only) {
    console.log(`\nAlle udfyldte værdier for "${only}":\n`);
    const vals = new Map();
    for (const r of rows) {
        let rec; try { rec = JSON.parse(r.raw_json); } catch { continue; }
        const v = flatten(rec)[only];
        if (v == null || v === '') continue;
        const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
        vals.set(key, (vals.get(key) || 0) + 1);
    }
    if (!vals.size) { console.log('  (feltet findes ikke eller er tomt overalt)\n'); process.exit(0); }
    for (const [v, n] of [...vals].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)} ×  ${v.slice(0, 100)}`);
    }
    console.log();
    process.exit(0);
}

console.log(`\n${rows.length} vagter i spejlet. Felter Smartplan leverer:\n`);
console.log('  udfyldt   felt                              eksempel');
console.log('  ' + '─'.repeat(78));

const BRUGT = new Set([
    'uuid', 'display_date', 'owner.uuid', 'owner.first_name', 'owner.last_name',
    'jobtype.uuid', 'jobtype.title', 'location.title',
    'planned_start_dt', 'planned_end_dt', 'planned_shift_duration',
    'attendance_start_dt', 'attendance_end_dt', 'attendance_shift_duration',
    'attendance_status',
]);

for (const [k, e] of [...seen].sort((a, b) => b[1].filled - a[1].filled)) {
    const pct = Math.round(e.filled / e.total * 100);
    const mark = BRUGT.has(k) ? ' ' : '★';   // ★ = felt vi IKKE bruger i dag
    const sample = [...e.samples][0] || '';
    console.log(`  ${mark} ${String(pct).padStart(3)} %   ${k.padEnd(32)}  ${sample.slice(0, 34)}`);
}

console.log('\n  ★ = felt vi ikke bruger i dag.');
console.log('  Leder du efter noten med festivalens navn: kig efter et ★-felt med');
console.log('  fritekst, og se alle værdier med  --field <navn>\n');

db.close();
