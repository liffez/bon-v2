// tests/migrate.test.js
// ============================================================
// Migrations skal være ALT-ELLER-INTET.
//
// Baggrund (20. august 2026): migration 151 blev anvendt uden at blive
// registreret som kørt. `db.exec(sql)` kørte uden transaktion, så SQLite
// committede hvert statement for sig, mens `INSERT INTO _migrations` lå
// bagefter i JS. Resultatet var en database der var ændret, en migration der
// så ukørt ud, og en produktionsserver der crash-loopede på sin egen første
// ALTER TABLE — uden at kunne komme ud af det selv.
//
// Testene kører den RIGTIGE runner (migrationsDir injiceres) mod små,
// kontrollerede migrations-mapper. Ingen kopi af logikken.
// ============================================================

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const { runMigrations } = require('../db/migrate');
const { DatabaseSync }  = require('node:sqlite');

/** Midlertidig migrations-mappe + db-sti. Ryddes af kalderen. */
function scratch(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonmig-'));
    const migDir = path.join(dir, 'migrations');
    fs.mkdirSync(migDir);
    for (const [name, sql] of Object.entries(files)) {
        fs.writeFileSync(path.join(migDir, name), sql);
    }
    return { dir, migDir, dbPath: path.join(dir, 'test.db') };
}

function inspect(dbPath) {
    const db = new DatabaseSync(dbPath);
    const cols = t => db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map(r => r.name);
    const ran  = () => db.prepare('SELECT filename FROM _migrations ORDER BY filename')
                         .all().map(r => r.filename);
    const tables = () => db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);
    return { db, cols, ran, tables };
}

test('en fejlende migration efterlader INTET — hverken ændring eller registrering', () => {
    // Præcis formen fra 151: flere ALTER'er, hvor en senere fejler. Før
    // rettelsen var de tidligere ALTER'er committet og lå tilbage i databasen.
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
        '002_halv.sql': [
            'ALTER TABLE t ADD COLUMN foer TEXT;',
            'ALTER TABLE t ADD COLUMN efter TEXT;',
            'SELECT dette_er_ikke_en_funktion();',   // ← fejler til sidst
        ].join('\n'),
    });

    assert.throws(() => runMigrations(dbPath, migDir), /002_halv\.sql/);

    const { cols, ran } = inspect(dbPath);
    assert.deepStrictEqual(cols('t'), ['id'],
        'kolonner fra den fejlede migration må ikke overleve');
    assert.deepStrictEqual(ran(), ['001_base.sql'],
        'kun den migration der lykkedes må være registreret');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('en fejlet migration kan køres igen når SQL-filen er rettet', () => {
    // Konsekvensen af rollback: fordi intet blev anvendt, rammer anden kørsel
    // ikke "duplicate column". Det var netop dét produktionen sad fast i.
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
        '002_halv.sql': 'ALTER TABLE t ADD COLUMN felt TEXT;\nSELECT ikke_en_funktion();',
    });

    assert.throws(() => runMigrations(dbPath, migDir));

    fs.writeFileSync(path.join(migDir, '002_halv.sql'), 'ALTER TABLE t ADD COLUMN felt TEXT;');
    runMigrations(dbPath, migDir);   // må ikke kaste

    const { cols, ran } = inspect(dbPath);
    assert.ok(cols('t').includes('felt'), 'den rettede migration skal være anvendt');
    assert.deepStrictEqual(ran(), ['001_base.sql', '002_halv.sql']);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('ændring og registrering committes sammen', () => {
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
        '002_ok.sql':   'ALTER TABLE t ADD COLUMN felt TEXT;',
    });

    runMigrations(dbPath, migDir);

    const { cols, ran } = inspect(dbPath);
    assert.ok(cols('t').includes('felt'));
    assert.deepStrictEqual(ran(), ['001_base.sql', '002_ok.sql'],
        'en anvendt migration SKAL være registreret — ellers køres den igen');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations køres kun én gang', () => {
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
        '002_ok.sql':   'ALTER TABLE t ADD COLUMN felt TEXT;',
    });

    runMigrations(dbPath, migDir);
    runMigrations(dbPath, migDir);   // ville give "duplicate column" hvis den kørte igen

    assert.deepStrictEqual(inspect(dbPath).ran(), ['001_base.sql', '002_ok.sql']);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('fejlbeskeden anviser hvad man gør ved en allerede-anvendt migration', () => {
    // Situationen fra 20. august: ændringen ER i databasen, registreringen
    // mangler. Loggen skal give svaret, ikke bare "duplicate column name".
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY, felt TEXT);',
        '002_dublet.sql': 'ALTER TABLE t ADD COLUMN felt TEXT;',
    });

    let msg = '';
    try { runMigrations(dbPath, migDir); } catch (e) { msg = e.message; }

    assert.match(msg, /002_dublet\.sql/,        'skal navngive filen');
    assert.match(msg, /duplicate column/i,      'skal bevare den oprindelige fejl');
    assert.match(msg, /_migrations/,            'skal pege på registreringen som årsag');
    assert.match(msg, /INSERT INTO _migrations/, 'skal give den konkrete udvej');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations der slår foreign keys fra køres UDEN transaktion', () => {
    // `PRAGMA foreign_keys` er en no-op inde i en transaktion. Wrappede vi
    // disse, ville FK-håndhævelsen stille forblive tændt midt i en
    // table-rebuild — en fejl der ikke larmer, men river rækker med sig.
    const { dir, migDir, dbPath } = scratch({
        '001_base.sql': [
            'CREATE TABLE forael (id INTEGER PRIMARY KEY);',
            'CREATE TABLE barn (id INTEGER PRIMARY KEY, forael_id INTEGER REFERENCES forael(id));',
            'INSERT INTO forael (id) VALUES (1);',
            'INSERT INTO barn (id, forael_id) VALUES (1, 1);',
        ].join('\n'),
        // Table-rebuild efter SQLites 12-trins opskrift.
        '002_rebuild.sql': [
            'PRAGMA foreign_keys = OFF;',
            'CREATE TABLE forael_ny (id INTEGER PRIMARY KEY, note TEXT);',
            'INSERT INTO forael_ny (id) SELECT id FROM forael;',
            'DROP TABLE forael;',
            'ALTER TABLE forael_ny RENAME TO forael;',
            'PRAGMA foreign_keys = ON;',
        ].join('\n'),
    });

    runMigrations(dbPath, migDir);   // ville fejle på DROP hvis FK'erne var tændt

    const { cols, ran, db } = inspect(dbPath);
    assert.ok(cols('forael').includes('note'), 'rebuild skal være gennemført');
    assert.deepStrictEqual(ran(), ['001_base.sql', '002_rebuild.sql'],
        'også en utransaktioneret migration skal registreres');
    assert.strictEqual(db.prepare('SELECT count(*) n FROM barn').get().n, 1,
        'børnene må ikke være revet med');

    fs.rmSync(dir, { recursive: true, force: true });
});
