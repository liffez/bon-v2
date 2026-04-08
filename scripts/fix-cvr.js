/**
 * fix-cvr.js — Ret CVR/legal_name på et firma manuelt
 *
 * Brug:
 *   node scripts/fix-cvr.js --id=474 --cvr=62572310 --legal="Akademisk Arkitektforening"
 *   node scripts/fix-cvr.js --id=474 --cvr=62572310                    # kun CVR
 *   node scripts/fix-cvr.js --id=474 --clear                            # fjern CVR+legal_name
 *   node scripts/fix-cvr.js --list                                      # vis alle med CVR
 *   node scripts/fix-cvr.js --search="danner"                           # søg i firmaer
 */

const path = require('path');
const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const args = process.argv.slice(2);

function getArg(name) {
  const a = args.find(a => a.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

// ── --list ────────────────────────────────────────────────────
if (args.includes('--list')) {
  const rows = db.prepare(`
    SELECT co.id, co.name, co.cvr, co.legal_name, co.ean, COUNT(b.id) as bons
    FROM companies co
    LEFT JOIN bons b ON b.company_id = co.id
    WHERE co.cvr IS NOT NULL AND co.cvr != ''
    GROUP BY co.id
    ORDER BY bons DESC
  `).all();
  console.log(`${rows.length} firmaer med CVR:\n`);
  rows.forEach(r => {
    const legal = r.legal_name && r.legal_name !== r.name ? ` → "${r.legal_name}"` : '';
    console.log(`  id:${r.id}  CVR:${r.cvr}  "${r.name}"${legal}  (${r.bons} bons)`);
  });
  process.exit(0);
}

// ── --search ──────────────────────────────────────────────────
const search = getArg('search');
if (search) {
  const rows = db.prepare(`
    SELECT co.id, co.name, co.cvr, co.legal_name, co.ean, COUNT(b.id) as bons
    FROM companies co
    LEFT JOIN bons b ON b.company_id = co.id
    WHERE co.name LIKE ?
    GROUP BY co.id
    ORDER BY bons DESC
  `).all(`%${search}%`);
  console.log(`${rows.length} firmaer matcher "${search}":\n`);
  rows.forEach(r => {
    const cvr = r.cvr ? `CVR:${r.cvr}` : 'ingen CVR';
    const legal = r.legal_name ? ` legal:"${r.legal_name}"` : '';
    const ean = r.ean ? ` EAN:${r.ean}` : '';
    console.log(`  id:${r.id}  ${cvr}  "${r.name}"${legal}${ean}  (${r.bons} bons)`);
  });
  process.exit(0);
}

// ── --id + --cvr/--legal/--clear ──────────────────────────────
const id = getArg('id');
if (!id) {
  console.log('Brug:');
  console.log('  node scripts/fix-cvr.js --id=474 --cvr=62572310 --legal="Akademisk Arkitektforening"');
  console.log('  node scripts/fix-cvr.js --id=474 --clear');
  console.log('  node scripts/fix-cvr.js --list');
  console.log('  node scripts/fix-cvr.js --search="danner"');
  process.exit(0);
}

const company = db.prepare('SELECT id, name, cvr, legal_name, ean FROM companies WHERE id = ?').get(parseInt(id));
if (!company) {
  console.error(`Firma id:${id} ikke fundet.`);
  process.exit(1);
}

console.log(`Firma: "${company.name}" (id:${company.id})`);
console.log(`  CVR:        ${company.cvr || '(tom)'}`);
console.log(`  Legal name: ${company.legal_name || '(tom)'}`);
console.log(`  EAN:        ${company.ean || '(tom)'}`);

if (args.includes('--clear')) {
  db.prepare("UPDATE companies SET cvr = NULL, legal_name = NULL, updated_at = datetime('now') WHERE id = ?").run(company.id);
  console.log('\n✓ CVR og legal_name ryddet.');
  process.exit(0);
}

const cvr = getArg('cvr');
const legal = getArg('legal');

if (!cvr && !legal) {
  console.error('\nAngiv --cvr= og/eller --legal= (eller --clear)');
  process.exit(1);
}

if (cvr) {
  db.prepare("UPDATE companies SET cvr = ?, updated_at = datetime('now') WHERE id = ?").run(cvr, company.id);
  console.log(`\n✓ CVR sat til: ${cvr}`);
}
if (legal) {
  db.prepare("UPDATE companies SET legal_name = ?, updated_at = datetime('now') WHERE id = ?").run(legal, company.id);
  console.log(`✓ Legal name sat til: ${legal}`);
}
