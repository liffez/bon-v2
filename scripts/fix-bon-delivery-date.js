// scripts/fix-bon-delivery-date.js
// ==========================================
// Ret leveringsdatoen på ÉN bon — med spor.
//
// Drifts-fund 15/9 2026: cafe-3320 (Able, v1-import) står med leveringsdato
// 2027-03-04. Naboerne cafe-3322..3325 ligger alle på 2026-03-04, så det er
// året der er tastet forkert. Det er den eneste bon i basen med en dato efter
// 2026, og den gav Able "Sidst ordre 2027-03-04 · -169d" i CRM'et.
//
// Scriptet retter én bon ad gangen og skriver en changelog-linje, så det kan
// ses bagefter hvad der blev ændret og hvorfor. Dry-run som standard.
//
//   node --experimental-sqlite scripts/fix-bon-delivery-date.js --bon cafe-3320 --to 2026-03-04
//   node --experimental-sqlite scripts/fix-bon-delivery-date.js --bon cafe-3320 --to 2026-03-04 --apply
//
// Bagefter: tryk "Gem & genberegn" under CRM → Kundeindsigt, så RFM-scoren
// (sidst ordre / recency) følger den rettede dato.
// ==========================================

const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
process.env.DB_PATH = DB_PATH;

const { openDb, transaction } = require('../db/compat');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
}
const BON   = arg('--bon');
const TO    = arg('--to');
const APPLY = process.argv.includes('--apply');

if (!BON || !TO) {
    console.error('Brug: --bon <bon-nummer> --to <YYYY-MM-DD> [--apply]');
    process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(TO) || Number.isNaN(Date.parse(TO + 'T12:00:00Z'))
    || new Date(TO + 'T12:00:00Z').toISOString().slice(0, 10) !== TO) { // utc-ok: gyldigheds-tjek af en tastet dato
    console.error(`"${TO}" er ikke en gyldig dato (YYYY-MM-DD)`);
    process.exit(2);
}

function main() {
    const db = openDb(DB_PATH);
    const bon = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.pickup_time, b.delivery_time, b.pax,
               b.total_price, sd.code AS status, c.name AS company, b.v1_id
        FROM bons b
        LEFT JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN companies c ON c.id = b.company_id
        WHERE b.bon_number = ?
    `).get(BON);

    if (!bon) { console.error(`Bon ${BON} findes ikke`); process.exit(1); }

    console.log(`${bon.bon_number}  ${bon.company || '(intet firma)'} · ${bon.status} · ${bon.pax} pax · ${bon.total_price} kr`);
    console.log(`  leveringsdato: ${bon.delivery_date}  →  ${TO}`);

    if (bon.delivery_date === TO) {
        console.log('\nDatoen står allerede rigtigt — intet at gøre.');
        return;
    }

    // Kontekst: naboerne i v1-nummerserien, så man kan se at datoen passer ind.
    if (bon.v1_id) {
        const nabo = db.prepare(`
            SELECT bon_number, delivery_date FROM bons
            WHERE v1_id BETWEEN ? AND ? AND id <> ? ORDER BY v1_id
        `).all(bon.v1_id - 3, bon.v1_id + 3, bon.id);
        console.log('  naboer i v1-serien: ' + nabo.map(n => `${n.bon_number}=${n.delivery_date}`).join('  '));
    }

    if (!APPLY) { console.log('\n(dry-run — kør med --apply for at skrive)'); return; }

    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '') + '-' + process.pid; // utc-ok: filnavn
    const backup = DB_PATH.replace(/\.db$/, '') + `.pre-bon-dato-${stamp}.db`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`\nBackup: ${backup}`);

    transaction(db, () => {
        const r = db.prepare(
            'UPDATE bons SET delivery_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND delivery_date = ?'
        ).run(TO, bon.id, bon.delivery_date);
        if (r.changes !== 1) throw new Error(`forventede 1 række, ramte ${r.changes} — ruller tilbage`);
        db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
            VALUES ('bon', ?, 'update', 'delivery_date', ?, ?, ?)
        `).run(bon.id, bon.delivery_date, TO,
               'Leveringsdato rettet manuelt (scripts/fix-bon-delivery-date.js) — tastefejl i året fra v1-import');
    });
    console.log(`✓ ${bon.bon_number}: ${bon.delivery_date} → ${TO}`);
    console.log('\nHusk: "Gem & genberegn" under CRM → Kundeindsigt, så RFM følger den rettede dato.');
}

main();
