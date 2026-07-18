// db/migrate.js
// ==========================================
// Kører alle SQL-migrations der ikke allerede
// er kørt. Nummererede filer køres i rækkefølge.
//
// Brug:
//   node db/migrate.js              ← kør direkte
//   require('./db/migrate')         ← fra server.js
// ==========================================

const { openDb } = require('./compat');
const fs       = require('fs');
const path     = require('path');

const DB_PATH        = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function runMigrations(dbPath = DB_PATH) {
    // Sørg for at data-mappen eksisterer
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = openDb(dbPath);

    // Kritiske SQLite-indstillinger
    db.exec('PRAGMA foreign_keys = ON');    // SKAL aktiveres — SQLite har dem fra som default
    db.exec('PRAGMA journal_mode = WAL');   // Bedre concurrent read-performance

    // Tabel til at tracke hvilke migrations er kørt
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            filename    TEXT UNIQUE NOT NULL,
            ran_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();   // 001_, 002_, 003_ ... sorterer korrekt

    const ran = new Set(
        db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
    );

    let count = 0;
    for (const file of files) {
        if (!ran.has(file)) {
            console.log(`→ Kører migration: ${file}`);
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            db.exec(sql);
            db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
            count++;
        }
    }

    if (count === 0) {
        console.log('✓ Database er opdateret — ingen nye migrations');
    } else {
        console.log(`✓ ${count} migration(er) kørt`);
    }

    return db;
}

// Kør direkte hvis kaldt som script
if (require.main === module) {
    // Guard (#338): test:migrate SKAL ramme test-DB'en.
    //
    // Uden dette tjek kørte `npm run test:reset` skema-ændringer mod
    // produktionsdatabasen, hvis .env.test manglede eller pegede forkert —
    // safety_check sad først på test:fixture, altså ET TRIN FOR SENT. Det der
    // ændrer skema var ubeskyttet; det der indsætter rækker var beskyttet.
    //
    // Flaget er opt-in, fordi scriptet også bruges legitimt i produktion
    // (server-start + `npm run migrate` ved deploy). Kræves derfor kun når
    // kalderen selv siger "det her skal være et testmiljø".
    //
    // skipDb: true — test.db er typisk lige slettet af test:reset og skal
    // netop skabes af denne kørsel. De øvrige tjek (NODE_ENV, DB_PATH,
    // GROCY_API_URL) er dem der fanger prod.
    if (process.argv.includes('--require-test-env')) {
        require('../tests/scripts/safety_check')({ skipDb: true });
    }
    runMigrations();
}

module.exports = { runMigrations };
