/**
 * import-cvr-review.js — Importér godkendte CVR-matches fra review
 *
 * Kør: node scripts/import-cvr-review.js                        (fra data/cvr-approved.json)
 * Kør: node scripts/import-cvr-review.js --file=path/to/file.json
 * Kør: node scripts/import-cvr-review.js --dry-run               (vis hvad der ville ske)
 */

const path = require('path');
const fs = require('fs');
const { openDb, transaction } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file='));
const filePath = fileArg
  ? fileArg.split('=')[1]
  : path.join(__dirname, '..', 'data', 'cvr-approved.json');

if (!fs.existsSync(filePath)) {
  console.error(`Fil ikke fundet: ${filePath}`);
  console.error('Kør enrich-cvr.js --export-review først, derefter godkend i tools/cvr-review.html');
  process.exit(1);
}

const approved = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (!Array.isArray(approved) || approved.length === 0) {
  console.log('Ingen godkendte matches at importere.');
  process.exit(0);
}

console.log(`Indlæst ${approved.length} godkendte matches fra ${filePath}`);

// Validér format
const invalid = approved.filter(a => !a.id || !a.cvr);
if (invalid.length) {
  console.error(`${invalid.length} entries mangler id eller cvr — afbryder.`);
  process.exit(1);
}

// Tjek mod eksisterende CVR
const existing = db.prepare("SELECT id, name, cvr FROM companies WHERE cvr IS NOT NULL AND cvr != ''").all();
const existingCvr = new Map(existing.map(e => [e.id, e.cvr]));

let skipped = 0;
let updated = 0;

if (dryRun) {
  console.log('\n🔍 DRY RUN — viser hvad der ville ske:\n');
  for (const a of approved) {
    const co = db.prepare('SELECT id, name, cvr FROM companies WHERE id = ?').get(a.id);
    if (!co) { console.log(`  ⚠ ID ${a.id} — firma ikke fundet, springer over`); skipped++; continue; }
    if (co.cvr && co.cvr !== a.cvr) { console.log(`  ⚠ ID ${a.id} "${co.name}" — har allerede CVR ${co.cvr}, springer over`); skipped++; continue; }
    if (co.cvr === a.cvr) { console.log(`  = ID ${a.id} "${co.name}" — allerede sat til ${a.cvr}`); skipped++; continue; }
    console.log(`  ✓ ID ${a.id} "${co.name}" → CVR:${a.cvr} "${a.legal_name || ''}"`);
    updated++;
  }
  console.log(`\nVille opdatere: ${updated}, Spring over: ${skipped}`);
} else {
  transaction(db, () => {
    const updateCvr = db.prepare("UPDATE companies SET cvr = ?, updated_at = datetime('now') WHERE id = ? AND (cvr IS NULL OR cvr = '')");
    const updateLegal = db.prepare("UPDATE companies SET legal_name = ?, updated_at = datetime('now') WHERE id = ?");

    for (const a of approved) {
      const co = db.prepare('SELECT id, name, cvr FROM companies WHERE id = ?').get(a.id);
      if (!co) { console.log(`⚠ ID ${a.id} — firma ikke fundet`); skipped++; continue; }
      if (co.cvr && co.cvr !== a.cvr) { console.log(`⚠ ID ${a.id} "${co.name}" — har allerede CVR ${co.cvr}`); skipped++; continue; }
      if (co.cvr === a.cvr) { skipped++; continue; }

      updateCvr.run(a.cvr, a.id);
      if (a.legal_name) updateLegal.run(a.legal_name, a.id);
      updated++;
    }
  });

  const totalCvr = db.prepare("SELECT COUNT(*) as c FROM companies WHERE cvr IS NOT NULL AND cvr != ''").get().c;
  console.log(`\n✅ Importeret: ${updated} CVR-numre`);
  console.log(`   Sprunget over: ${skipped}`);
  console.log(`   Firmaer med CVR nu: ${totalCvr}`);

  // CVR-duplikater
  const dups = db.prepare(`
    SELECT cvr, GROUP_CONCAT(name, ' | ') as names, COUNT(*) as c
    FROM companies WHERE cvr IS NOT NULL AND cvr != ''
    GROUP BY cvr HAVING c > 1
  `).all();
  if (dups.length) {
    console.log(`\n⚠ ${dups.length} CVR-duplikat-grupper:`);
    dups.forEach(d => console.log(`  CVR ${d.cvr} (${d.c}x): ${d.names}`));
  }
}
