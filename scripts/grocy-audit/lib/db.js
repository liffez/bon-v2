// Lightweight wrapper around node:sqlite (Node 22+ built-in).
// Read-only by default — audit scripts should NEVER modify the DB.
// Cleanup-scripts opt-in by passing { readonly: false }.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DB = path.join(os.homedir(), 'grocy-audit-2026-05-02', 'grocy.db');
const FROZEN_DB = path.join(os.homedir(), 'grocy-audit-2026-05-02', 'grocy-prod-frozen-2026-05-02.db');

function openDb(dbPath = DEFAULT_DB, { readonly = true } = {}) {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`DB-fil findes ikke: ${dbPath}`);
    }
    if (!readonly && path.resolve(dbPath) === path.resolve(FROZEN_DB)) {
        throw new Error('Frossen backup må ALDRIG åbnes write-mode. Brug arbejdskopi.');
    }
    const db = new DatabaseSync(dbPath, { readOnly: readonly });
    return db;
}

function tableExists(db, name) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
    return !!row;
}

function columnExists(db, table, column) {
    if (!tableExists(db, table)) return false;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c.name === column);
}

module.exports = { openDb, tableExists, columnExists, DEFAULT_DB, FROZEN_DB };
