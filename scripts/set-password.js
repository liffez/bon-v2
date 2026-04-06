const bcrypt = require('bcryptjs');
const { openDb } = require('../db/compat');

const dbPath = process.env.DB_PATH || './data/bon.db';
const db = openDb(dbPath);

const email = process.argv[2];
const plain = process.argv[3];

if (!email || !plain) {
  console.error('Brug: node scripts/set-password.js email@eksempel.dk mitpassword');
  process.exit(1);
}

const hash = bcrypt.hashSync(plain, 12);
const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);

if (result.changes === 0) {
  console.error(`Ingen bruger fundet med email: ${email}`);
  process.exit(1);
}

console.log(`Password sat for ${email}`);
