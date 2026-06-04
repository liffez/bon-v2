/**
 * scripts/dev-admin.js
 * ════════════════════════════════════════════════════════════
 * Opretter (eller nulstiller) en dedikeret LOKAL test-admin med kendte
 * credentials, så man kan logge ind under udvikling/test uden at kende
 * det rigtige admin-password — og uden at overskrive den eksisterende
 * admin (der kan matche produktion / mail-routing).
 *
 * Idempotent: kør det igen for at nulstille password/PIN til standard.
 *
 *   node --experimental-sqlite scripts/dev-admin.js
 *   node --experimental-sqlite scripts/dev-admin.js egen@mail.dk minkode 1234
 *
 * Kør KUN mod en lokal DB (data/bon.db / DB_PATH). Det refuserer at
 * køre hvis NODE_ENV=production for at undgå at lægge en bagdør i prod.
 * ════════════════════════════════════════════════════════════
 */

const bcrypt = require('bcryptjs');
const { openDb } = require('../db/compat');

if (process.env.NODE_ENV === 'production') {
    console.error('✋ Nægter at køre med NODE_ENV=production — dette er kun et lokalt test-værktøj.');
    process.exit(1);
}

const email = process.argv[2] || 'dev@ristetrug.dk';
const password = process.argv[3] || 'dev1234';
const pin = process.argv[4] || '9999';

const dbPath = process.env.DB_PATH || './data/bon.db';
const db = openDb(dbPath);

const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

if (existing) {
    db.prepare(`
        UPDATE users
           SET password_hash = ?, pin = ?, mobile_pin = ?, role = 'admin', is_active = 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
    `).run(hash, pin, pin, existing.id);
    console.log(`↻ Opdateret eksisterende test-admin (id ${existing.id})`);
} else {
    const ins = db.prepare(`
        INSERT INTO users (name, email, password_hash, role, pin, mobile_pin, is_active)
        VALUES ('Dev Admin', ?, ?, 'admin', ?, ?, 1)
    `).run(email, hash, pin, pin);
    console.log(`✓ Oprettet ny test-admin (id ${ins.lastInsertRowid})`);
}

console.log('');
console.log('  Lokal test-admin klar:');
console.log(`    Email:    ${email}`);
console.log(`    Password: ${password}`);
console.log(`    PIN:      ${pin}`);
console.log(`    DB:       ${dbPath}`);
