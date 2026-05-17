#!/usr/bin/env node
/**
 * scripts/cleanup-test-bons.js
 * ════════════════════════════════════════════════════════════
 * Sletter test-bons med 'B%'-prefiks oprettet under udviklingen.
 * Køres EN gang før launch for at få en ren start på nummerserien.
 *
 * Default: dry-run — viser hvad der vil ske uden at ændre noget.
 * Kør med --apply for faktisk at slette.
 *
 * Eksempel (lokal):
 *   node --experimental-sqlite scripts/cleanup-test-bons.js
 *   node --experimental-sqlite scripts/cleanup-test-bons.js --apply
 *
 * Eksempel (Hetzner — produktion):
 *   cd /home/leif/bon-v2
 *   git pull
 *   sudo -u www-data node --experimental-sqlite scripts/cleanup-test-bons.js
 *   sudo -u www-data node --experimental-sqlite scripts/cleanup-test-bons.js --apply
 *
 * Idempotent: hvis der ingen B-bons er, gør scriptet ingenting.
 * ════════════════════════════════════════════════════════════ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const APPLY   = process.argv.includes('--apply');
const NEXT_BON_NUMBER = '4000';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

console.log(`DB: ${DB_PATH}`);
console.log(`Mode: ${APPLY ? 'APPLY (sletter)' : 'DRY-RUN (viser kun)'}`);
console.log('');

// Find alle B-bons
const bons = db.prepare(
  "SELECT id, bon_number, created_at FROM bons WHERE bon_number LIKE 'B%' ORDER BY id"
).all();

if (bons.length === 0) {
  console.log('Ingen B-bons fundet — intet at gøre.');
  process.exit(0);
}

const ids = bons.map(b => b.id);
const ph  = ids.map(() => '?').join(',');

console.log(`Fundet ${bons.length} B-bons:`);
for (const b of bons) {
  console.log(`  - bon ${b.id} (${b.bon_number}) oprettet ${b.created_at}`);
}
console.log('');

// Tæl relaterede records
function count(label, sql) {
  const c = db.prepare(sql).get(...ids).c;
  console.log(`  ${label}: ${c}`);
  return c;
}

console.log('Relaterede rækker der vil blive påvirket:');
const counts = {
  bon_lines:      count('bon_lines (CASCADE)',          `SELECT COUNT(*) AS c FROM bon_lines WHERE bon_id IN (${ph})`),
  changelog:      count('changelog (DELETE)',           `SELECT COUNT(*) AS c FROM changelog WHERE entity_type = 'bon' AND entity_id IN (${ph})`),
  mail_threads:   count('mail_threads (DELETE)',        `SELECT COUNT(*) AS c FROM mail_threads WHERE bon_id IN (${ph})`),
  mail_messages:  count('mail_messages (DELETE)',       `SELECT COUNT(*) AS c FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph}))`),
  mail_attachments: count('mail_attachments (DELETE)',  `SELECT COUNT(*) AS c FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph})))`),
  web_orders:     count('web_orders (DELETE)',          `SELECT COUNT(*) AS c FROM web_orders WHERE bon_id IN (${ph})`),
  notifications:  count('notifications (DELETE)',       `SELECT COUNT(*) AS c FROM notifications WHERE bon_id IN (${ph})`),
  delivery_events: count('delivery_events (DELETE)',    `SELECT COUNT(*) AS c FROM delivery_events WHERE bon_id IN (${ph})`),
  crm_activities: count('crm_activities (DELETE)',      `SELECT COUNT(*) AS c FROM crm_activities WHERE bon_id IN (${ph})`),
  shopping_list:  count('shopping_list (SET NULL)',     `SELECT COUNT(*) AS c FROM shopping_list WHERE source_bon_id IN (${ph})`),
  mail_unmatched: count('mail_unmatched (SET NULL)',    `SELECT COUNT(*) AS c FROM mail_unmatched WHERE linked_bon_id IN (${ph})`),
  crm_unmatched:  count('crm_unmatched_emails (SET NULL)', `SELECT COUNT(*) AS c FROM crm_unmatched_emails WHERE linked_bon_id IN (${ph})`),
  quotes:         count('quotes.converted_to_bon_id (SET NULL)', `SELECT COUNT(*) AS c FROM quotes WHERE converted_to_bon_id IN (${ph})`),
  geo_calc:       count('geo_calculations (DELETE)',    `SELECT COUNT(*) AS c FROM geo_calculations WHERE bon_id IN (${ph})`),
};

const currentNext = db.prepare("SELECT value FROM settings WHERE key = 'bon_number_next'").get();
console.log('');
console.log(`bon_number_next er nu: ${currentNext?.value}`);
console.log(`→ vil blive sat til:   ${NEXT_BON_NUMBER}`);
console.log('');

if (!APPLY) {
  console.log('💡 Kør med --apply for at slette');
  process.exit(0);
}

// Apply — alt i én transaktion
console.log('Sletter...');
db.exec('BEGIN');
try {
  // Mail-kæden: attachments → messages → threads
  db.prepare(
    `DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph})))`
  ).run(...ids);
  db.prepare(
    `DELETE FROM mail_messages WHERE thread_id IN (SELECT id FROM mail_threads WHERE bon_id IN (${ph}))`
  ).run(...ids);
  db.prepare(`DELETE FROM mail_threads WHERE bon_id IN (${ph})`).run(...ids);

  // SET NULL for tabeller hvor link er auditrelateret
  db.prepare(`UPDATE shopping_list SET source_bon_id = NULL WHERE source_bon_id IN (${ph})`).run(...ids);
  db.prepare(`UPDATE mail_unmatched SET linked_bon_id = NULL WHERE linked_bon_id IN (${ph})`).run(...ids);
  db.prepare(`UPDATE crm_unmatched_emails SET linked_bon_id = NULL WHERE linked_bon_id IN (${ph})`).run(...ids);
  db.prepare(`UPDATE quotes SET converted_to_bon_id = NULL WHERE converted_to_bon_id IN (${ph})`).run(...ids);

  // DELETE for tabeller hvor records er test
  db.prepare(`DELETE FROM web_orders WHERE bon_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM notifications WHERE bon_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM delivery_events WHERE bon_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM crm_activities WHERE bon_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM geo_calculations WHERE bon_id IN (${ph})`).run(...ids);

  // Polymorf changelog
  db.prepare(`DELETE FROM changelog WHERE entity_type = 'bon' AND entity_id IN (${ph})`).run(...ids);

  // Selve bons (cascade fjerner bon_lines)
  const res = db.prepare(`DELETE FROM bons WHERE id IN (${ph})`).run(...ids);
  console.log(`  Slettet ${res.changes} bons`);

  // Reset nummerserie
  db.prepare("UPDATE settings SET value = ? WHERE key = 'bon_number_next'").run(NEXT_BON_NUMBER);
  console.log(`  bon_number_next sat til ${NEXT_BON_NUMBER}`);

  db.exec('COMMIT');
  console.log('');
  console.log('✅ Cleanup gennemført');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ Rollback udført pga. fejl:', err.message);
  process.exit(1);
}
