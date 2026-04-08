/**
 * merge-ean-duplicates.js — Merger firmaer med samme EAN-nummer
 *
 * Kør: node scripts/merge-ean-duplicates.js --dry-run   # Vis hvad der ville ske
 * Kør: node scripts/merge-ean-duplicates.js --run        # Udfør merge
 *
 * For hver EAN-gruppe:
 * 1. Beholder firmaet med flest bons (primary)
 * 2. Gemmer de andre firmaers navne i primary.notes (afdelingsinfo bevares)
 * 3. Flytter alle kunder og bons til primary
 * 4. Sletter de tomme duplikater
 */

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const run = args.includes('--run');

if (!dryRun && !run) {
  console.log('Brug: node scripts/merge-ean-duplicates.js --dry-run   (vis plan)');
  console.log('      node scripts/merge-ean-duplicates.js --run        (udfør merge)');
  process.exit(0);
}

// Find alle EAN-duplikat-grupper
const eanGroups = db.prepare(`
  SELECT ean, GROUP_CONCAT(id) as ids
  FROM companies
  WHERE ean IS NOT NULL AND ean != ''
  GROUP BY ean
  HAVING COUNT(*) > 1
`).all();

console.log(`Fundet ${eanGroups.length} EAN-grupper med duplikater\n`);

let totalMerged = 0;
let totalCustomersMoved = 0;
let totalBonsMoved = 0;
let totalDeleted = 0;

const mergeActions = [];

for (const group of eanGroups) {
  const ids = group.ids.split(',').map(Number);

  // Hent alle firmaer i gruppen med bon-count
  const companies = ids.map(id => {
    const co = db.prepare('SELECT id, name, ean, notes, phone, email, invoice_email, address_id FROM companies WHERE id = ?').get(id);
    const bonCount = db.prepare('SELECT COUNT(*) as c FROM bons WHERE company_id = ?').get(id).c;
    const customerCount = db.prepare('SELECT COUNT(*) as c FROM customers WHERE company_id = ?').get(id).c;
    return { ...co, bonCount, customerCount };
  });

  // Sortér: flest bons først, derefter flest kunder, derefter laveste id
  companies.sort((a, b) => b.bonCount - a.bonCount || b.customerCount - a.customerCount || a.id - b.id);

  const primary = companies[0];
  const duplicates = companies.slice(1);

  if (duplicates.length === 0) continue;

  // Saml unikke navne fra duplikater (som ikke er identiske med primary)
  const otherNames = duplicates
    .map(d => d.name)
    .filter(n => n.toLowerCase().trim() !== primary.name.toLowerCase().trim());
  const uniqueOtherNames = [...new Set(otherNames)];

  // Saml kontaktinfo fra duplikater som primary mangler
  const extraPhone = !primary.phone && duplicates.find(d => d.phone)?.phone;
  const extraEmail = !primary.email && duplicates.find(d => d.email)?.email;
  const extraInvoiceEmail = !primary.invoice_email && duplicates.find(d => d.invoice_email)?.invoice_email;

  const action = {
    ean: group.ean,
    primary,
    duplicates,
    uniqueOtherNames,
    extraPhone,
    extraEmail,
    extraInvoiceEmail,
    customersMoved: 0,
    bonsMoved: 0,
  };

  // Tæl hvad der skal flyttes
  for (const dup of duplicates) {
    action.customersMoved += dup.customerCount;
    action.bonsMoved += dup.bonCount;
  }

  mergeActions.push(action);
  totalMerged++;
  totalCustomersMoved += action.customersMoved;
  totalBonsMoved += action.bonsMoved;
  totalDeleted += duplicates.length;
}

// ─── Output ───────────────────────────────────────────────────

for (const action of mergeActions) {
  console.log(`EAN ${action.ean}:`);
  console.log(`  ✓ Beholder: "${action.primary.name}" (id:${action.primary.id}, ${action.primary.bonCount} bons, ${action.primary.customerCount} kunder)`);
  for (const dup of action.duplicates) {
    console.log(`  ✗ Sletter:  "${dup.name}" (id:${dup.id}, ${dup.bonCount} bons, ${dup.customerCount} kunder)`);
  }
  if (action.uniqueOtherNames.length) {
    console.log(`  📝 Gemmer i notes: ${action.uniqueOtherNames.join(' | ')}`);
  }
  if (action.extraPhone) console.log(`  📞 Overtager tlf: ${action.extraPhone}`);
  if (action.extraEmail) console.log(`  📧 Overtager email: ${action.extraEmail}`);
  console.log('');
}

console.log('═══════════════════════════════════════');
console.log(`Grupper:           ${mergeActions.length}`);
console.log(`Firmaer slettet:   ${totalDeleted}`);
console.log(`Kunder flyttet:    ${totalCustomersMoved}`);
console.log(`Bons flyttet:      ${totalBonsMoved}`);
console.log(`Firmaer efter:     ${1230 - totalDeleted} (ca.)`);
console.log('═══════════════════════════════════════');

if (dryRun) {
  console.log('\n🔍 DRY RUN — intet er ændret. Kør med --run for at udføre.');
  process.exit(0);
}

// ─── Udfør merge ──────────────────────────────────────────────

console.log('\n🔧 Udfører merge...\n');

transaction(db, () => {
  for (const action of mergeActions) {
    const primaryId = action.primary.id;

    // 1. Opdater notes med alternative navne
    if (action.uniqueOtherNames.length) {
      const existingNotes = action.primary.notes || '';
      const nameList = action.uniqueOtherNames.join('\n');
      const newNotes = existingNotes
        ? existingNotes + '\n\n--- Tidligere navne (EAN-merge) ---\n' + nameList
        : '--- Tidligere navne (EAN-merge) ---\n' + nameList;
      db.prepare('UPDATE companies SET notes = ? WHERE id = ?').run(newNotes, primaryId);
    }

    // 2. Overtag kontaktinfo hvis primary mangler
    if (action.extraPhone) {
      db.prepare('UPDATE companies SET phone = ? WHERE id = ?').run(action.extraPhone, primaryId);
    }
    if (action.extraEmail) {
      db.prepare('UPDATE companies SET email = ? WHERE id = ?').run(action.extraEmail, primaryId);
    }
    if (action.extraInvoiceEmail) {
      db.prepare('UPDATE companies SET invoice_email = ? WHERE id = ?').run(action.extraInvoiceEmail, primaryId);
    }

    // 3. Flyt kunder og bons fra duplikater til primary
    for (const dup of action.duplicates) {
      db.prepare('UPDATE customers SET company_id = ? WHERE company_id = ?').run(primaryId, dup.id);
      db.prepare('UPDATE bons SET company_id = ? WHERE company_id = ?').run(primaryId, dup.id);

    }

    // 4. Slet duplikater (FK-safe: ingen kunder/bons peger på dem længere)
    for (const dup of action.duplicates) {
      db.prepare('DELETE FROM companies WHERE id = ?').run(dup.id);
    }
  }
});

// Verificer
const remaining = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
const orphanBons = db.prepare('SELECT COUNT(*) as c FROM bons WHERE company_id IS NOT NULL AND company_id NOT IN (SELECT id FROM companies)').get().c;
const orphanCust = db.prepare('SELECT COUNT(*) as c FROM customers WHERE company_id IS NOT NULL AND company_id NOT IN (SELECT id FROM companies)').get().c;

console.log('✅ Merge fuldført!');
console.log(`   Firmaer nu: ${remaining}`);
console.log(`   Forældreløse bons: ${orphanBons}`);
console.log(`   Forældreløse kunder: ${orphanCust}`);

if (orphanBons > 0 || orphanCust > 0) {
  console.log('⚠️  ADVARSEL: Der er forældreløse referencer!');
}
