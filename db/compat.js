// db/compat.js
// ==========================================
// Kompatibilitetslag over node:sqlite.
// Gør at koden kan bruge samme API som
// better-sqlite3 (lastInsertRowid som Number,
// transaction-helper).
// ==========================================

const { DatabaseSync } = require('node:sqlite');

/**
 * Åbn en SQLite-database med patched prepare()
 * så lastInsertRowid altid er Number (ikke BigInt).
 */
function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);

    const origPrepare = db.prepare.bind(db);
    db.prepare = function(sql) {
        const stmt = origPrepare(sql);

        const origRun = stmt.run.bind(stmt);
        stmt.run = function(...args) {
            const result = origRun(...args);
            if (result && typeof result.lastInsertRowid === 'bigint') {
                result.lastInsertRowid = Number(result.lastInsertRowid);
            }
            if (result && typeof result.changes === 'bigint') {
                result.changes = Number(result.changes);
            }
            return result;
        };

        return stmt;
    };

    return db;
}

/**
 * Transaction-wrapper (erstatter better-sqlite3's db.transaction()).
 * Brug: transaction(db, () => { ... })
 */
function transaction(db, fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

module.exports = { openDb, transaction };
