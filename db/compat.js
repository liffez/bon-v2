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
 *
 * INDLEJRBAR. SQLite kan ikke have en transaktion inde i en anden, så et
 * indre `BEGIN` fejlede med "cannot start a transaction within a transaction".
 * Det ramte hver gang noget wrappede en helper der selv bruger transaction() —
 * fx `createBon()`, som kalder `nextBonNumber()`, der låser nummerserien i sin
 * egen transaktion. Man kunne altså ikke oprette flere bons atomisk, hvilket
 * er præcis hvad et fler-dags-tilbud skal (#425).
 *
 * Ydre niveau bruger BEGIN/COMMIT; indre niveauer bruger SAVEPOINT, så en indre
 * fejl ruller sit eget arbejde tilbage uden at rive den ydre transaktion med —
 * og en ydre rollback tager stadig det hele.
 *
 * Dybden holdes pr. database-handle (WeakMap), ikke globalt: to handles må
 * kunne have hver sin transaktion uden at tælle i samme regnskab.
 */
const _txDepth = new WeakMap();

function transaction(db, fn) {
    const depth = _txDepth.get(db) || 0;
    const name = `sp_${depth}`;

    if (depth === 0) db.exec('BEGIN');
    else db.exec(`SAVEPOINT ${name}`);
    _txDepth.set(db, depth + 1);

    try {
        const result = fn();
        if (depth === 0) db.exec('COMMIT');
        else db.exec(`RELEASE ${name}`);
        _txDepth.set(db, depth);
        return result;
    } catch (e) {
        // Sæt dybden tilbage FØR rollback: fejler rollback også, må tælleren
        // ikke blive hængende og gøre næste transaktion på handlen forkert.
        _txDepth.set(db, depth);
        if (depth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO ${name}`);
        throw e;
    }
}

module.exports = { openDb, transaction };
