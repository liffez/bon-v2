#!/usr/bin/env node
// scripts/audit-stock-counts.js
// ==========================================
// READ-ONLY. Fyldes optællings-loggen (#673) — og kan den bruges?
//
// Loggen har ingen visning før faktordiagnosen (§14.9, fase 7). Uden dette
// script kan man ikke se i drift om linjerne faktisk bliver skrevet, og en
// log der stille holder op med at fylde, er præcis den slags hul vi er blevet
// brændt på før (#305, #319).
//
// Rapporten viser:
//   * optællingerne i perioden: status, tid, fysiske enheder, varer pr. udfald
//   * tegn på at noget er galt: gemt uden linjer, forladte åbne optællinger,
//     linjer uden poster
//   * de første spor til faktordiagnosen: varer talt i en anden enhed end
//     lager-enheden, med gennemsnitlig afvigelse
//
// Brug:
//   npm run audit:optaellinger
//   ... -- --days 30        periode (standard 14 dage)
//   ... -- --count 42       alle linjer og poster i én optælling
// ==========================================

'use strict';

const OUTCOME_LABEL = { corrected: 'rettet', unchanged: 'uændret', kept_stock: 'beholdt', failed: 'fejlede' };
const STATUS_LABEL = { open: 'åben', saved: 'gemt', discarded: 'kasseret' };
const FORLADT_TIMER = 12;

// SQLite-tid er UTC uden markør; vis den i dansk tid uanset serverens tidszone.
function dk(ts) {
    if (!ts) return '—';
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return String(ts);
    const del = {};
    new Intl.DateTimeFormat('da-DK', {
        timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).forEach(x => { del[x.type] = x.value; });
    return `${del.day}/${del.month} ${del.hour}:${del.minute}`;
}

function fmt(n) {
    if (n === null || n === undefined) return '—';
    return String(Math.round(n * 1000) / 1000).replace('.', ',');
}

function buildReport(db, { days = 14, countId = null } = {}) {
    const out = [];
    const p = (s = '') => out.push(s);

    if (countId) {
        const c = db.prepare(`
            SELECT c.*, u.name AS user_name FROM stock_counts c
            LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(countId);
        if (!c) { p(`Optælling ${countId} findes ikke.`); return out.join('\n'); }
        p(`Optælling #${c.id} · ${STATUS_LABEL[c.status] || c.status} · Grocy-lokation ${c.grocy_location_id}` +
          ` · ${c.user_name || 'ukendt bruger'}`);
        p(`  startet ${dk(c.started_at)} · afsluttet ${dk(c.finished_at)}`);
        const lines = db.prepare(`
            SELECT * FROM stock_count_lines WHERE count_id = ?
            ORDER BY sort_index IS NULL, sort_index, product_id`).all(c.id);
        if (!lines.length) { p('  ingen linjer'); return out.join('\n'); }
        const entries = db.prepare('SELECT * FROM stock_count_entries WHERE line_id = ? ORDER BY id');
        for (const l of lines) {
            const dev = l.deviation_pct === null ? '' : ` · afvigelse ${l.deviation_pct > 0 ? '+' : ''}${fmt(l.deviation_pct)} %`;
            p(`  ${l.sort_index ?? '·'}. ${l.product_name || 'produkt ' + l.product_id} [${l.physical_unit_name}]` +
              ` · talt ${fmt(l.stock_qty)} · forventet ${fmt(l.expected_qty)}${dev} · ${OUTCOME_LABEL[l.outcome] || l.outcome}`);
            const es = entries.all(l.id);
            if (!es.length) p('       (ingen poster)');
            for (const e of es) p(`       ${fmt(e.qty)} × enhed ${e.qu_id} · faktor ${fmt(e.factor_used)}`);
        }
        return out.join('\n');
    }

    const since = `-${Number(days)} days`;
    const counts = db.prepare(`
        SELECT c.*, u.name AS user_name,
               (SELECT COUNT(*) FROM stock_count_lines l WHERE l.count_id = c.id) AS n_lines
        FROM stock_counts c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.started_at >= datetime('now', ?)
        ORDER BY c.started_at DESC`).all(since);

    p(`Optællinger de seneste ${days} dage: ${counts.length}`);
    if (!counts.length) {
        p('  Ingen. Er der talt i perioden, bliver optællingen ikke oprettet på serveren —');
        p('  tjek at klienten er opdateret (shared/inventory_check.js med #673).');
        return out.join('\n');
    }

    const byStatus = {};
    counts.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
    p('  ' + Object.keys(byStatus).map(s => `${byStatus[s]} ${STATUS_LABEL[s] || s}`).join(' · '));
    p();

    const perOutcome = db.prepare(`SELECT outcome, COUNT(*) n FROM stock_count_lines WHERE count_id = ? GROUP BY outcome`);
    const units = db.prepare(`SELECT DISTINCT physical_unit_name AS n FROM stock_count_lines WHERE count_id = ? ORDER BY 1`);
    for (const c of counts) {
        const o = perOutcome.all(c.id).map(r => `${r.n} ${OUTCOME_LABEL[r.outcome] || r.outcome}`).join(', ');
        const u = units.all(c.id).map(r => r.n).join(', ');
        p(`  #${c.id}  ${dk(c.started_at)} → ${dk(c.finished_at)}  ${(STATUS_LABEL[c.status] || c.status).padEnd(8)}` +
          ` lokation ${c.grocy_location_id}${u ? ' · ' + u : ''} · ${c.n_lines} linjer${o ? ' (' + o + ')' : ''}`);
    }

    // ── Tegn på at noget er galt ──
    const advarsler = [];
    const tomme = counts.filter(c => c.status === 'saved' && c.n_lines === 0);
    if (tomme.length) advarsler.push(`${tomme.length} gemt uden linjer (#${tomme.map(c => c.id).join(', #')}) — loggen blev ikke skrevet`);
    const forladte = db.prepare(`
        SELECT id FROM stock_counts
        WHERE status = 'open' AND started_at < datetime('now', ?) AND started_at >= datetime('now', ?)`)
        .all(`-${FORLADT_TIMER} hours`, since);
    if (forladte.length) advarsler.push(`${forladte.length} åben i over ${FORLADT_TIMER} timer (#${forladte.map(c => c.id).join(', #')}) — talt, men aldrig gemt`);
    const udenPoster = db.prepare(`
        SELECT COUNT(*) n FROM stock_count_lines l
        JOIN stock_counts c ON c.id = l.count_id
        WHERE c.started_at >= datetime('now', ?) AND l.stock_qty > 0
          AND NOT EXISTS (SELECT 1 FROM stock_count_entries e WHERE e.line_id = l.id)`).get(since).n;
    if (udenPoster) advarsler.push(`${udenPoster} linjer med en mængde men uden poster — kan ikke bruges til faktordiagnosen`);
    p();
    p(advarsler.length ? 'Se efter:' : 'Intet at se efter.');
    advarsler.forEach(a => p('  ⚠ ' + a));

    // ── Første spor til faktordiagnosen (§14.9) ──
    // Kun linjer hvor varen er talt ét sted (deviation_pct er sat), og kun
    // poster i en anden enhed end lager-enheden (faktor ≠ 1).
    const faktor = db.prepare(`
        SELECT l.product_id, MAX(l.product_name) AS navn, e.qu_id, e.factor_used,
               COUNT(DISTINCT l.id) AS n, AVG(l.deviation_pct) AS snit
        FROM stock_count_lines l
        JOIN stock_counts c ON c.id = l.count_id
        JOIN stock_count_entries e ON e.line_id = l.id
        WHERE c.started_at >= datetime('now', ?) AND l.deviation_pct IS NOT NULL AND e.factor_used != 1
        GROUP BY l.product_id, e.qu_id, e.factor_used
        ORDER BY n DESC, ABS(AVG(l.deviation_pct)) DESC
        LIMIT 15`).all(since);
    p();
    p('Talt i en anden enhed end lager-enheden (første spor til §14.9):');
    if (!faktor.length) p('  endnu ingen');
    for (const f of faktor) {
        p(`  ${(f.navn || 'produkt ' + f.product_id).padEnd(28)} enhed ${f.qu_id} · faktor ${fmt(f.factor_used)}` +
          ` · ${f.n} gang${f.n === 1 ? '' : 'e'} · snit-afvigelse ${f.snit > 0 ? '+' : ''}${fmt(f.snit)} %`);
    }
    p();
    p('Detaljer for én optælling: npm run audit:optaellinger -- --count <id>');
    return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
    const { openDb } = require('../db/compat');
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
    const db = openDb(process.env.DB_PATH || './data/bon.db');
    try {
        db.prepare('SELECT 1 FROM stock_counts LIMIT 1').get();
    } catch (e) {
        console.log('Tabellen stock_counts findes ikke — migration 179 er ikke kørt på denne database.');
        process.exit(0);
    }
    console.log(buildReport(db, {
        days: parseInt(val('--days')) || 14,
        countId: parseInt(val('--count')) || null,
    }));
}
