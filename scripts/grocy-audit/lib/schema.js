// Discover the actual schema of the Grocy DB.
// Outputs a JSON-summary so we can write Fase 1–5 against the real tables.
//
// Usage: node scripts/grocy-audit/lib/schema.js [path-to-db]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDb } = require('./db');

function discoverSchema(db) {
    const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map(r => r.name);

    const schema = {};
    for (const t of tables) {
        try {
            schema[t] = {
                columns: db.prepare(`PRAGMA table_info("${t}")`).all().map(c => ({
                    name: c.name,
                    type: c.type,
                    notnull: c.notnull,
                    dflt: c.dflt_value,
                    pk: c.pk
                })),
                count: db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
            };
        } catch (e) {
            schema[t] = { error: e.message };
        }
    }

    const views = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='view' ORDER BY name
    `).all().map(r => r.name);

    return { tables: schema, views };
}

if (require.main === module) {
    const dbPath = process.argv[2] || path.join(os.homedir(), 'grocy-audit-2026-05-02', 'grocy.db');
    const db = openDb(dbPath);
    const schema = discoverSchema(db);
    db.close();

    const outDir = path.join(os.homedir(), 'grocy-audit-2026-05-02', 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'schema.json');
    fs.writeFileSync(outFile, JSON.stringify(schema, null, 2));

    const tableNames = Object.keys(schema.tables);
    console.log(`✓ Schema gemt: ${outFile}`);
    console.log(`  Tabeller: ${tableNames.length}`);
    console.log(`  Views: ${schema.views.length}`);
    console.log('');
    console.log('Top 20 tabeller efter rækketælling:');
    tableNames
        .map(n => ({ name: n, count: schema.tables[n].count || 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
        .forEach(t => console.log(`  ${String(t.count).padStart(8)} ${t.name}`));
}

module.exports = { discoverSchema };
