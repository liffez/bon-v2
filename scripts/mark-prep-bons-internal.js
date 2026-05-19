/**
 * mark-prep-bons-internal.js — Engangsoprydning
 *
 * Markerer prep-bons (v1-synced AFSLUTTET med total_price=0, der ikke i
 * forvejen er is_internal=1) som is_internal=1, så de holdes ude af
 * ordre-tællere i reports, CRM-pipeline og lego-chart.
 *
 * Brug:
 *   node --experimental-sqlite scripts/mark-prep-bons-internal.js --dry  # vis kandidater uden at ændre
 *   node --experimental-sqlite scripts/mark-prep-bons-internal.js        # udfør (transaction + changelog)
 *
 * Kontekst: 1. juni 2026 — efter at sync fra v1 blev lukket, blev der
 * fundet ~111 AFSLUTTET-bons (v1-sync, 0 kr). Brugeren reviewede dem
 * manuelt og bekræftede de er enten legitimt afsluttede eller prep-bonner.
 * Dette script markerer dem der mangler is_internal=1.
 */

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const DRY = process.argv.includes('--dry');

// ── Find kandidater ────────────────────────────────────────────
// Hård (29) + Soft (82) - filter til kun is_internal=0.
const SQL_CANDIDATES = `
  SELECT b.id, b.bon_number, b.delivery_date, b.pax, b.total_price,
         (SELECT COUNT(*) FROM bon_lines bl WHERE bl.bon_id=b.id) AS lines,
         COALESCE(co.name, c.first_name || ' ' || COALESCE(c.last_name,'')) AS who
  FROM bons b
  JOIN status_definitions sd ON b.status_id=sd.id
  LEFT JOIN companies co ON b.company_id=co.id
  LEFT JOIN customers c ON b.customer_id=c.id
  WHERE sd.code='AFSLUTTET'
    AND b.sync_source='v1'
    AND (b.total_price IS NULL OR b.total_price=0)
    AND COALESCE(b.is_internal, 0) = 0
    AND (
      -- Hård: ingen invoice + ingen linjer
      (COALESCE(b.invoice_info,'') = '' AND NOT EXISTS (SELECT 1 FROM bon_lines bl WHERE bl.bon_id=b.id))
      -- Soft: har linjer (line-revenue er 0 så ingen omsætning-indvirkning)
      OR EXISTS (SELECT 1 FROM bon_lines bl WHERE bl.bon_id=b.id)
    )
  ORDER BY b.delivery_date DESC
`;

const candidates = db.prepare(SQL_CANDIDATES).all();
console.log(`Fundet ${candidates.length} kandidater (v1-sync AFSLUTTET, 0 kr, is_internal=0):`);
candidates.forEach(r => {
    const kat = r.lines > 0 ? 'soft' : 'hård';
    console.log(`  [${kat}] ${r.delivery_date}  #${(r.bon_number || '').padEnd(12)} pax=${String(r.pax || '?').padStart(4)}  lines=${r.lines}  ${(r.who || '—').slice(0, 35)}`);
});

if (candidates.length === 0) {
    console.log('\nIngen at opdatere. Færdig.');
    process.exit(0);
}

if (DRY) {
    console.log('\n--dry: ingen ændringer foretaget.');
    process.exit(0);
}

// ── Udfør i transaction ────────────────────────────────────────
const NOTE = 'Engangsoprydning: prep-bon markeret is_internal=1 efter manuel review (afsluttet sync fra v1)';

const insertChange = db.prepare(`
    INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes, payload)
    VALUES ('bon', ?, 'update', 'is_internal', '0', '1', NULL, ?, NULL)
`);
const updateBon = db.prepare(`UPDATE bons SET is_internal = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);

const result = transaction(db, () => {
    let updated = 0;
    for (const c of candidates) {
        const r = updateBon.run(c.id);
        if (r.changes === 1) {
            insertChange.run(c.id, NOTE);
            updated++;
        }
    }
    return updated;
});

console.log(`\n✓ Opdaterede ${result} bons til is_internal=1 med changelog-entry.`);
