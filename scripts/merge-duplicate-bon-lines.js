// scripts/merge-duplicate-bon-lines.js
// ============================================================
// Engangs-oprydning: slår historiske dublet-rækker i bon_lines sammen.
//
// Baggrund: POST /api/bons/:id/lines lavede før én række pr. "Tilføj"-klik, så
// samme vare kunne ligge som fx 6 × "1× Kartoflen slider" (#B4154). Ruten slår
// nu sammen ved indsættelse, og alle visnings-flader kører gennem
// BonLines.mergeLines() — men de gamle rækker ligger stadig i databasen.
// Dette script fjerner dem.
//
// Sammenlægnings-reglen er IKKE skrevet af igen her — scriptet importerer
// _mergeKey fra shared/bon_lines.js, så DB og visning ikke kan glide fra
// hinanden. Særønsker slås aldrig sammen.
//
// ── SIKKERHED ───────────────────────────────────────────────────────────────
//   • DRY-RUN som standard. Der skrives først med --apply.
//   • --apply tager altid en backup først (VACUUM INTO — WAL-sikker) og
//     printer stien. Ingen backup = ingen skrivning.
//   • Alt sker i ÉN transaktion med invarianter pr. berørt bon:
//       antal stk uændret · linjesum uændret · bons.total_price urørt
//     Fejler bare én, rulles HELE oprydningen tilbage.
//   • Fakturerede bons fredes som udgangspunkt (FAKTURERET/BETALT/AFSLUTTET
//     eller economic_draft_number sat) — de er sendt til kunden, og deres
//     linjer skal blive ved med at matche fakturaen. --include-invoiced
//     overstyrer bevidst.
//   • Hver berørt bon får en changelog-linje, så historikken forklarer hoppet.
//
// ── BRUG ────────────────────────────────────────────────────────────────────
//   node --experimental-sqlite scripts/merge-duplicate-bon-lines.js
//   node --experimental-sqlite scripts/merge-duplicate-bon-lines.js --bon=B4154
//   node --experimental-sqlite scripts/merge-duplicate-bon-lines.js --bon=B4154 --apply
//   node --experimental-sqlite scripts/merge-duplicate-bon-lines.js --apply
//
//   Flag:
//     --bon=<nr|id>        kun én bon (kør denne først)
//     --apply              skriv rigtigt (uden = dry-run)
//     --include-invoiced   tag også fakturerede/betalte/afsluttede bons med
//     --quiet              kun opsummering, ingen linje-for-linje
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');

// Load .env — samme mønster som scripts/check-inventory-deduct.js
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb }    = require('../db/database');
const { _mergeKey } = require('../shared/bon_lines');

const args            = process.argv.slice(2);
const APPLY           = args.includes('--apply');
const INCLUDE_INVOICED = args.includes('--include-invoiced');
const QUIET           = args.includes('--quiet');
const ONLY_BON        = (args.find(a => a.startsWith('--bon=')) || '').split('=')[1] || null;

const FROZEN_STATUSES = ['FAKTURERET', 'BETALT', 'AFSLUTTET'];
const kr = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('da-DK');

function backupDb(db) {
    // Backuppen lægges ved siden af den database der faktisk ændres — ellers
    // kan man komme til at kigge på en backup af noget helt andet.
    const dir = path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');  // utc-ok: filnavn
    const dest = path.join(dir, `bon-foer-linjemerge-${stamp}.db`);
    // VACUUM INTO er WAL-sikker — en rå filkopi kan misse ucheckpointede sider.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
}

/**
 * Find dublet-grupper. Grupperingen sker i JS via _mergeKey fra
 * shared/bon_lines.js, så reglen kun findes ét sted.
 */
function findDuplicateGroups(db) {
    const where = [];
    const params = [];
    if (ONLY_BON) {
        where.push('(b.bon_number = ? OR b.id = ?)');
        params.push(ONLY_BON.replace(/^#/, ''), parseInt(ONLY_BON, 10) || -1);
    }
    if (!INCLUDE_INVOICED) {
        where.push(`sd.code NOT IN (${FROZEN_STATUSES.map(() => '?').join(',')})`);
        params.push(...FROZEN_STATUSES);
        where.push('b.economic_draft_number IS NULL');
    }

    const lines = db.prepare(`
        SELECT l.*, b.bon_number, sd.code AS status_code
        FROM bon_lines l
        JOIN bons b ON l.bon_id = b.id
        LEFT JOIN status_definitions sd ON b.status_id = sd.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.bon_id, l.sort_order, l.id
    `).all(...params);

    const groups = new Map();
    for (const l of lines) {
        // Særønske → aldrig sammenlagt (samme regel som mergeLines).
        if (String(l.special_request || '').trim()) continue;
        const key = l.bon_id + '|' + _mergeKey(l);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(l);
    }
    return [...groups.values()].filter(g => g.length > 1);
}

function main() {
    const db = getDb();

    console.log(`\n── Dublet-linjer i bon_lines ──`);
    console.log(`   DB:      ${process.env.DB_PATH}`);
    console.log(`   Tilstand: ${APPLY ? 'APPLY (skriver)' : 'DRY-RUN (ingen ændringer)'}`);
    if (ONLY_BON) console.log(`   Kun bon: ${ONLY_BON}`);
    console.log(`   Faktureret: ${INCLUDE_INVOICED ? 'MEDTAGES' : 'fredes'}`);

    const groups = findDuplicateGroups(db);
    if (!groups.length) {
        console.log('\n✓ Ingen dublet-linjer fundet — intet at rydde op.\n');
        return 0;
    }

    const byBon = new Map();
    for (const g of groups) {
        if (!byBon.has(g[0].bon_id)) byBon.set(g[0].bon_id, []);
        byBon.get(g[0].bon_id).push(g);
    }
    const rowsRemoved = groups.reduce((s, g) => s + g.length - 1, 0);

    console.log(`\n   ${groups.length} dublet-grupper · ${byBon.size} bons · ${rowsRemoved} rækker forsvinder\n`);

    if (!QUIET) {
        for (const [bonId, bonGroups] of byBon) {
            const nr = bonGroups[0][0].bon_number;
            console.log(`   #${nr} (id ${bonId}, ${bonGroups[0][0].status_code})`);
            for (const g of bonGroups) {
                const qty = g.reduce((s, l) => s + l.quantity, 0);
                const ids = g.map(l => l.id).join(', ');
                console.log(`      ${g.length} rækker (id ${ids}) → ${qty}× ${g[0].product_name}`);
            }
        }
        console.log('');
    }

    if (!APPLY) {
        console.log('   Dry-run — intet er ændret. Kør igen med --apply for at gennemføre.\n');
        return 0;
    }

    // ── Backup FØR skrivning ────────────────────────────────────────────
    let backupPath;
    try {
        backupPath = backupDb(db);
        const mb = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
        console.log(`   Backup: ${backupPath} (${mb} MB)`);
    } catch (err) {
        console.error(`\n❌ Backup fejlede — skriver IKKE: ${err.message}\n`);
        return 1;
    }

    // Facit før ændringen, pr. berørt bon — invarianterne måles mod det her.
    const beforeStmt = db.prepare(`
        SELECT COALESCE(SUM(quantity),0) q, COALESCE(SUM(line_total),0) t, COUNT(*) n
        FROM bon_lines WHERE bon_id = ?`);
    const totalStmt = db.prepare('SELECT total_price, total_units FROM bons WHERE id = ?');
    const before = new Map();
    for (const bonId of byBon.keys()) {
        before.set(bonId, { lines: beforeStmt.get(bonId), bon: totalStmt.get(bonId) });
    }

    const updQty = db.prepare('UPDATE bon_lines SET quantity = ?, line_total = ? WHERE id = ?');
    const delRow = db.prepare('DELETE FROM bon_lines WHERE id = ?');
    const logRow = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
        VALUES ('bon', ?, 'update', 'bon_lines', ?, ?, NULL, ?)`);

    let merged = 0, removed = 0;
    db.exec('BEGIN');
    try {
        for (const [bonId, bonGroups] of byBon) {
            const notes = [];
            for (const g of bonGroups) {
                const keeper = g[0];                       // laveste sort_order/id beholdes
                const rest   = g.slice(1);
                const newQty = g.reduce((s, l) => s + l.quantity, 0);
                // line_total genberegnes af stykprisen — den er ens i hele gruppen
                // (unit_price indgår i _mergeKey), så summen kan ikke skride.
                const newTotal = keeper.unit_price != null ? newQty * keeper.unit_price
                               : g.reduce((s, l) => s + (l.line_total || 0), 0) || null;
                updQty.run(newQty, newTotal, keeper.id);
                for (const l of rest) delRow.run(l.id);
                notes.push(`${g.length}→1: ${newQty}× ${keeper.product_name}`);
                merged++; removed += rest.length;
            }
            logRow.run(bonId,
                `${bonGroups.reduce((s, g) => s + g.length, 0)} linjer`,
                `${bonGroups.length} linjer`,
                'Oprydning: ens linjer slået sammen (scripts/merge-duplicate-bon-lines.js) — ' + notes.join(' · '));
        }

        // ── Invarianter ─────────────────────────────────────────────────
        for (const [bonId, snap] of before) {
            const now = beforeStmt.get(bonId);
            const bon = totalStmt.get(bonId);
            if (now.q !== snap.lines.q) {
                throw new Error(`bon ${bonId}: antal stk ændret ${snap.lines.q} → ${now.q}`);
            }
            if (Math.abs(now.t - snap.lines.t) > 0.005) {
                throw new Error(`bon ${bonId}: linjesum ændret ${kr(snap.lines.t)} → ${kr(now.t)}`);
            }
            if (bon.total_price !== snap.bon.total_price || bon.total_units !== snap.bon.total_units) {
                throw new Error(`bon ${bonId}: bons-totaler blev rørt (må de ikke)`);
            }
            if (now.n >= snap.lines.n) {
                throw new Error(`bon ${bonId}: rækkeantal faldt ikke (${snap.lines.n} → ${now.n})`);
            }
        }

        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        console.error(`\n❌ Invariant brudt — ALT rullet tilbage, databasen er urørt:\n   ${err.message}`);
        console.error(`   Backup ligger stadig i ${backupPath}\n`);
        return 1;
    }

    console.log(`\n✅ ${merged} grupper slået sammen · ${removed} rækker fjernet · ${byBon.size} bons`);
    console.log(`   Antal stk og linjesum er uændrede på alle berørte bons.`);
    console.log(`   Fortryd: stop servicen, læg ${path.basename(backupPath)} tilbage som data/bon.db, start igen.\n`);
    return 0;
}

process.exit(main());
