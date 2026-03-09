// db/database.js
// ==========================================
// Åbner databasen og returnerer et db-objekt
// klar til brug. Singleton — samme instans
// deles i hele processen.
// ==========================================

const Database = require('better-sqlite3');
const path     = require('path');
const { runMigrations } = require('./migrate');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

let _db = null;

function getDb() {
    if (!_db) {
        _db = runMigrations(DB_PATH);

        // Pragmas køres igen her i tilfælde af at
        // migrate.js returnerer en eksisterende forbindelse
        _db.pragma('foreign_keys = ON');
        _db.pragma('journal_mode = WAL');
    }
    return _db;
}

module.exports = { getDb };
