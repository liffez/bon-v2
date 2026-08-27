#!/usr/bin/env node
// scripts/check-labor-gaps.js — READ-ONLY
// ============================================================
// Hvor mangler der vagter i vagtplanen?
//
// Eventets løn og driftsregnskabets løn hentes begge fra Smartplan. Findes der
// ingen vagter for en dag, bliver lønnen 0 kr — og dagen ser mere rentabel ud
// end den var. Det er ikke en fejl i Bon: worklogs opstår først når en vagt er
// godkendt i Smartplan, og planlagte vagter hentes kun fremad. En fortidig vagt
// der aldrig blev godkendt, er derfor usynlig for begge endpoints.
//
// Scriptet peger på hvor hullerne er, så de kan rettes DÉR de opstod.
// Læser kun det lokale spejl (smartplan_shifts) — ingen kald til Smartplan.
//
// Kør:  node --experimental-sqlite scripts/check-labor-gaps.js
//       ... --since 2026-06-01     (default: 180 dage tilbage)
// ============================================================

const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || './data/bon.db';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const dk = (offset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
};

const SINCE = arg('--since', dk(-180));
const TODAY = dk(0);

const db = openDb(DB_PATH);

const total = db.prepare('SELECT COUNT(*) AS n FROM smartplan_shifts').get().n;
if (!total) {
    console.log('\nSpejlet er tomt — kør en synkronisering først (Settings → Smartplan).\n');
    process.exit(0);
}

// HQ-lokationens navn afgør hvad der er event-arbejde (migration 122).
const hq = (db.prepare("SELECT value FROM settings WHERE key='smartplan_hq_location'").get()?.value
         || 'Ristet Rug').trim();

/** Vagter pr. dato, delt i HQ og event efter Smartplans egen lokation. */
const perDag = new Map();
for (const r of db.prepare(
        'SELECT date, raw_json FROM smartplan_shifts WHERE date BETWEEN ? AND ?').all(SINCE, TODAY)) {
    let loc = '';
    try { loc = (JSON.parse(r.raw_json)?.location?.title || '').trim(); } catch { /* ulæselig */ }
    if (!perDag.has(r.date)) perDag.set(r.date, { hq: 0, event: 0 });
    // Tom lokation regnes som HQ — samme konservative regel som _classifyLocation,
    // så en uklassificeret vagt aldrig tilskrives et event.
    perDag.get(r.date)[(loc && loc !== hq) ? 'event' : 'hq']++;
}
const vagter = (dato) => perDag.get(dato) || { hq: 0, event: 0 };

/* ── 1) Events uden vagter ───────────────────────────────── */

const events = db.prepare(`
    SELECT id, name, start_date, COALESCE(end_date, start_date) AS end_date, status
      FROM events
     WHERE status <> 'cancelled'
       AND COALESCE(end_date, start_date) >= ?
       AND start_date <= ?
     ORDER BY start_date
`).all(SINCE, TODAY);

const dageIMellem = (fra, til) => {
    const ud = [];
    for (let d = new Date(fra + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
        const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
        if (iso > til) break;
        ud.push(iso);
        if (ud.length > 400) break;
    }
    return ud;
};

const evUdenVagter = [];
for (const e of events) {
    const dage = dageIMellem(e.start_date, e.end_date);
    const ialt = dage.reduce((s, d) => s + vagter(d).event, 0);
    const tomme = dage.filter(d => vagter(d).event === 0);
    if (ialt === 0 || tomme.length) {
        evUdenVagter.push({ ...e, dage: dage.length, vagter: ialt, tomme });
    }
}

console.log(`\n${total} vagter i spejlet · periode ${SINCE} → ${TODAY} · HQ-lokation: "${hq}"\n`);

console.log('── EVENTS UDEN VAGTER PÅ EVENT-LOKATIONEN ──');
if (!events.length) {
    console.log('  Ingen events i perioden.\n');
} else if (!evUdenVagter.length) {
    console.log(`  \x1b[32m✓ Alle ${events.length} events har vagter på alle deres dage.\x1b[0m\n`);
} else {
    for (const e of evUdenVagter) {
        const helt = e.vagter === 0;
        console.log(`  ${helt ? '\x1b[31m✗' : '\x1b[33m⚠'} #${e.id}  ${e.name}\x1b[0m`);
        console.log(`      ${e.start_date} → ${e.end_date} · ${e.vagter} vagter på ${e.dage} dage`);
        console.log(`      dage uden vagter: ${e.tomme.join(', ')}`);
    }
    console.log();
}

/* ── 2) Dage med produktion, men ingen vagter overhovedet ── */
// Det er dét driftsregnskabet nu markerer. Her ses hele perioden på én gang.

const bonDage = db.prepare(`
    SELECT b.delivery_date AS dato,
           COUNT(DISTINCT b.id) AS bons,
           COALESCE(SUM(bl.quantity), 0) AS stk
      FROM bons b
      JOIN bon_lines bl ON bl.bon_id = b.id
      JOIN status_definitions sd ON sd.id = b.status_id
     WHERE b.delivery_date BETWEEN ? AND ?
       AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
       AND sd.code NOT IN ('AFLYST','NY','VENTER')
     GROUP BY b.delivery_date
     ORDER BY b.delivery_date
`).all(SINCE, TODAY);

const huller = bonDage.filter(d => { const v = vagter(d.dato); return v.hq === 0 && v.event === 0; });

console.log('── DAGE MED PRODUKTION, MEN INGEN VAGTER ──');
if (!huller.length) {
    console.log('  \x1b[32m✓ Ingen.\x1b[0m\n');
} else {
    console.log(`  \x1b[33m${huller.length} dag(e) — lønnen står som 0 kr på dem:\x1b[0m\n`);
    console.log('  dato         bons   stk');
    for (const d of huller) {
        console.log(`  ${d.dato}  ${String(d.bons).padStart(5)} ${String(Math.round(d.stk)).padStart(6)}`);
    }
    // Sammenhængende striber er lettere at rette end enkeltdage: det er typisk
    // en hel periode der ikke er godkendt, ikke en vagt der mangler.
    const striber = [];
    for (const d of huller) {
        const sidste = striber[striber.length - 1];
        const dagenFør = (() => { const x = new Date(d.dato + 'T12:00:00'); x.setDate(x.getDate() - 1);
            return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(x); })();
        if (sidste && sidste.til === dagenFør) sidste.til = d.dato;
        else striber.push({ fra: d.dato, til: d.dato });
    }
    console.log('\n  Sammenhængende perioder:');
    for (const s of striber) {
        console.log(`    ${s.fra}${s.til !== s.fra ? ' → ' + s.til : ''}`);
    }
    console.log('\n  Ret op i Smartplan: godkend vagtplanen for perioden bagudrettet.');
    console.log('  Timerne dukker op ved næste synkronisering — og FØRST derefter');
    console.log('  giver "Genberegn dagen" i Driftsregnskab mening.\n');
}

db.close();
