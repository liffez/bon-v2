// apply.js — Læs review-CSV'er og generér/eksekvér cleanup mod arbejdskopien.
//
// SIKKERHED:
//   - Default: --dry-run (printer hvad der ville ske)
//   - --apply kræver eksplicit flag
//   - Tager ALTID backup af arbejdskopi inden ændringer (grocy.db.pre-cleanup-<ts>)
//   - Kører ALT i én transaktion — alt eller intet
//   - Rører ALDRIG den frosne backup
//   - Manuelle 'fix'-rækker bliver ikke ændret i SQL — de listes til Grocy UI todo
//
// Output-filer:
//   ~/grocy-audit-2026-05-02/cleanup/pending-cleanup.sql      (genereret SQL)
//   ~/grocy-audit-2026-05-02/cleanup/manual-fix-todo.md       (manuel todo)
//   ~/grocy-audit-2026-05-02/cleanup/log_<ts>.txt             (apply-log)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { readCsv } = require('./lib/csv');

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v === undefined ? true : v];
        })
);
const DRY_RUN = !args.apply;

const ROOT = path.join(os.homedir(), 'grocy-audit-2026-05-02');
const REVIEW_DIR = path.join(ROOT, 'review');
const CLEANUP_DIR = path.join(ROOT, 'cleanup');
const WORK_DB = path.join(ROOT, 'grocy.db');
const FROZEN_DB = path.join(ROOT, 'grocy-prod-frozen-2026-05-02.db');

fs.mkdirSync(CLEANUP_DIR, { recursive: true });

const log = [];
const logLine = (msg) => { log.push(msg); console.log(msg); };

logLine('═'.repeat(78));
logLine(`APPLY ${DRY_RUN ? '— DRY RUN' : '— LIVE'}`);
logLine('═'.repeat(78));

// ─────────────────────────────────────────────────────────────────────────
// Læs alle review-CSV'er
// ─────────────────────────────────────────────────────────────────────────
const csvFiles = [
    '01_orphan_recipes.csv',
    '02_salg_no_price.csv',
    '03_cost_gt_sales.csv',
    '04_catering_ne_store.csv',
    '05_price_format.csv',
    '06_unit_anomalies.csv',
    '07_broken_nestings.csv'
];

const decisions = {
    delete_recipes: [],       // (id, name, source_file, note)
    archive_recipes: [],      // (id, name, source_file, note) — sætter sellable=0
    delete_nestings: [],      // (nesting_id, source_file, note)
    fix_manual: [],           // (id, name, source_file, current, note)
    keep: []                  // (id, name, source_file, note) — bare logges
};

for (const csvFile of csvFiles) {
    const fullPath = path.join(REVIEW_DIR, csvFile);
    if (!fs.existsSync(fullPath)) {
        logLine(`⚠ Mangler: ${csvFile}`);
        continue;
    }
    const rows = readCsv(fullPath);
    let stats = { keep: 0, fix: 0, delete: 0, archive: 0, blank: 0 };

    for (const r of rows) {
        const dec = (r.decision || '').toLowerCase().trim();
        const note = r.note || '';
        if (!dec) { stats.blank++; continue; }

        if (csvFile === '07_broken_nestings.csv') {
            if (dec === 'delete') {
                decisions.delete_nestings.push({
                    nesting_id: parseInt(r.nesting_id),
                    source_file: csvFile,
                    note
                });
                stats.delete++;
            } else if (dec === 'keep') {
                decisions.keep.push({ id: r.nesting_id, name: 'nesting #' + r.nesting_id, source_file: csvFile, note });
                stats.keep++;
            }
            continue;
        }

        // Andre filer: id refererer til recipes.id (eller products.id for unit_anomalies)
        const idField = csvFile === '06_unit_anomalies.csv' ? 'id' : 'id';
        const id = parseInt(r[idField]);
        const name = r.name;

        if (dec === 'delete') {
            decisions.delete_recipes.push({ id, name, source_file: csvFile, note });
            stats.delete++;
        } else if (dec === 'archive') {
            decisions.archive_recipes.push({ id, name, source_file: csvFile, note });
            stats.archive++;
        } else if (dec === 'fix') {
            decisions.fix_manual.push({ id, name, source_file: csvFile, row: r, note });
            stats.fix++;
        } else if (dec === 'keep') {
            decisions.keep.push({ id, name, source_file: csvFile, note });
            stats.keep++;
        } else {
            logLine(`⚠ ${csvFile}: ukendt decision "${dec}" på id=${id}`);
        }
    }

    logLine(`  ${csvFile}: ${rows.length} rækker (delete=${stats.delete}, archive=${stats.archive}, fix=${stats.fix}, keep=${stats.keep}, blank=${stats.blank})`);
}

logLine('');
logLine('Aggregeret:');
logLine(`  Slet recipes:     ${decisions.delete_recipes.length}`);
logLine(`  Arkivér recipes:  ${decisions.archive_recipes.length} (sellable=0)`);
logLine(`  Slet nestings:    ${decisions.delete_nestings.length}`);
logLine(`  Manuel fix:       ${decisions.fix_manual.length} (kræver Grocy UI)`);
logLine(`  Keep (logget):    ${decisions.keep.length}`);

// ─────────────────────────────────────────────────────────────────────────
// Generér cleanup-SQL
// ─────────────────────────────────────────────────────────────────────────
const sqlLines = [
    '-- Genereret af apply.js — kør IKKE direkte; dette er en preview-fil.',
    '-- Den faktiske eksekvering sker i apply.js mod arbejdskopien (~/grocy-audit-2026-05-02/grocy.db)',
    `-- Genereret: ${new Date().toISOString()}`,
    '',
    'BEGIN TRANSACTION;',
    ''
];

if (decisions.delete_nestings.length) {
    sqlLines.push('-- ─── Slet brækkede recipes_nestings ───');
    for (const d of decisions.delete_nestings) {
        sqlLines.push(`DELETE FROM recipes_nestings WHERE id = ${d.nesting_id}; -- ${d.note}`);
    }
    sqlLines.push('');
}

if (decisions.delete_recipes.length) {
    sqlLines.push('-- ─── Slet recipes (+ deres recipes_pos, recipes_nestings, userfield_values) ───');
    for (const d of decisions.delete_recipes) {
        sqlLines.push(`-- ${d.name} (id ${d.id}) — ${d.note}`);
        sqlLines.push(`DELETE FROM recipes_pos WHERE recipe_id = ${d.id};`);
        sqlLines.push(`DELETE FROM recipes_nestings WHERE recipe_id = ${d.id} OR includes_recipe_id = ${d.id};`);
        sqlLines.push(`DELETE FROM userfield_values WHERE object_id = '${d.id}' AND field_id IN (SELECT id FROM userfields WHERE entity = 'recipes');`);
        sqlLines.push(`DELETE FROM recipes WHERE id = ${d.id};`);
        sqlLines.push('');
    }
}

if (decisions.archive_recipes.length) {
    sqlLines.push('-- ─── Arkivér (sæt sellable=0) ───');
    for (const d of decisions.archive_recipes) {
        sqlLines.push(`-- ${d.name} (id ${d.id}) — ${d.note}`);
        sqlLines.push(`UPDATE userfield_values SET value = '0' WHERE object_id = '${d.id}' AND field_id = (SELECT id FROM userfields WHERE entity='recipes' AND name='sellable');`);
    }
    sqlLines.push('');
}

// Skraldevask: orphan userfield_values for slettede recipes (uafhængigt af review)
sqlLines.push('-- ─── Oprydning: orphan userfield_values for slettede recipes ───');
sqlLines.push(`DELETE FROM userfield_values`);
sqlLines.push(`WHERE field_id IN (SELECT id FROM userfields WHERE entity='recipes')`);
sqlLines.push(`  AND CAST(object_id AS INTEGER) NOT IN (SELECT id FROM recipes);`);
sqlLines.push('');

sqlLines.push('COMMIT;');

const sqlFile = path.join(CLEANUP_DIR, 'pending-cleanup.sql');
fs.writeFileSync(sqlFile, sqlLines.join('\n'));
logLine('');
logLine(`✓ SQL preview: ${sqlFile}`);

// ─────────────────────────────────────────────────────────────────────────
// Generér manual-fix-todo.md
// ─────────────────────────────────────────────────────────────────────────
const todoLines = [
    `# Manuelle rettelser i Grocy UI`,
    ``,
    `> Genereret ${new Date().toISOString().slice(0, 10)} af \`apply.js\``,
    `>`,
    `> Disse rækker er markeret \`fix\` i review-CSV'erne — kræver manuel`,
    `> rettelse i Grocy UI (typisk pris-justering eller enheds-mapping).`,
    `>`,
    `> Lokal Grocy: http://localhost:9283`,
    ``
];
const byFile = {};
for (const f of decisions.fix_manual) {
    if (!byFile[f.source_file]) byFile[f.source_file] = [];
    byFile[f.source_file].push(f);
}
for (const [file, items] of Object.entries(byFile)) {
    todoLines.push(`## ${file} (${items.length})`);
    todoLines.push('');
    for (const it of items) {
        todoLines.push(`- **${it.name}** (id ${it.id})`);
        todoLines.push(`  - note: ${it.note}`);
        // List relevante data fra rækken
        const relevant = Object.entries(it.row).filter(([k, v]) => !['decision', 'note'].includes(k) && v);
        for (const [k, v] of relevant) todoLines.push(`  - ${k}: ${v}`);
        todoLines.push('');
    }
}
const todoFile = path.join(CLEANUP_DIR, 'manual-fix-todo.md');
fs.writeFileSync(todoFile, todoLines.join('\n'));
logLine(`✓ Manual fix-todo: ${todoFile}`);

// ─────────────────────────────────────────────────────────────────────────
// Eksekvér (kun ved --apply)
// ─────────────────────────────────────────────────────────────────────────
if (DRY_RUN) {
    logLine('');
    logLine('═'.repeat(78));
    logLine('DRY RUN — ingen ændringer er kørt mod arbejdskopien.');
    logLine('Læs SQL-filen igennem manuelt, og kør derefter:');
    logLine('  node scripts/grocy-audit/apply.js --apply');
    logLine('═'.repeat(78));
    process.exit(0);
}

// LIVE: tag backup, åbn DB, kør SQL i transaktion
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupFile = path.join(ROOT, `grocy.db.pre-cleanup-${ts}`);

if (path.resolve(WORK_DB) === path.resolve(FROZEN_DB)) {
    console.error('FATAL: arbejdskopi peger på frossen backup. Stopper.');
    process.exit(1);
}

logLine('');
logLine(`Tager backup: ${backupFile}`);
fs.copyFileSync(WORK_DB, backupFile);

const db = new DatabaseSync(WORK_DB);
const sql = fs.readFileSync(sqlFile, 'utf8');

logLine('Kører cleanup-SQL i transaktion...');
try {
    db.exec(sql);
    logLine('✓ Cleanup gennemført.');
} catch (e) {
    logLine(`✗ Fejl: ${e.message}`);
    logLine('Transaktion rullet tilbage. Backup intakt.');
    db.close();
    process.exit(1);
}
db.close();

const logFile = path.join(CLEANUP_DIR, `log_${ts}.txt`);
fs.writeFileSync(logFile, log.join('\n'));
logLine('');
logLine(`✓ Log gemt: ${logFile}`);
logLine('');
logLine('Næste skridt:');
logLine('  1. Kør Fase 1-5 igen mod arbejdskopien — diff mod fredag-rapporterne');
logLine('  2. Kopiér til Docker-volumen: cp grocy.db grocy-local-test/data/grocy.db');
logLine('  3. Genstart container: docker restart grocy-audit');
logLine('  4. Klik rundt i lokal Grocy og verificér visuelt');
