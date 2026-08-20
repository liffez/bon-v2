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

// Migrations der selv slår foreign keys fra kan IKKE ligge i en transaktion.
//
// `PRAGMA foreign_keys` er en no-op så længe der er en transaktion i gang
// (SQLite tillader kun at skifte håndhævelsen når intet BEGIN/SAVEPOINT er
// åbent). Wrappede vi dem, ville pragma'en blive tavst ignoreret, og FK'erne
// ville forblive tændt midt i den 12-trins table-rebuild de er slået fra for.
// Det ville ikke fejle højlydt — det ville rive rækker med sig.
//
// Fem filer gør det i dag (032, 041, 060, 090, 128). De køres som før, ét
// statement ad gangen, og har dermed præcis samme risiko som hidtil.
const OWNS_FK_PRAGMA = /^[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=/im;

/**
 * Fejlbesked der fortæller hvad man gør — ikke bare hvad der gik galt.
 *
 * En fejlet migration efterlader serveren i crash-loop: systemd genstarter,
 * migrationen prøves igen, samme fejl. Uden en anvisning i loggen koster det
 * en fejlsøgning midt i et nedbrud at finde ud af om databasen er halvfærdig.
 */
function migrationError(file, err, wasRolledBack) {
    const lines = [
        `Migration fejlede: ${file}`,
        `  ${err.message}`,
        '',
    ];

    if (wasRolledBack) {
        lines.push(
            '  Ændringerne er rullet tilbage — databasen står som før migrationen.',
            '  Ret SQL-filen og start igen.',
        );
    } else {
        lines.push(
            '  ADVARSEL: denne migration kører uden transaktion (den slår foreign',
            '  keys fra), så den kan være DELVIST anvendt. Tjek databasens tilstand',
            '  før du kører igen — se db/migrate.js for hvorfor.',
        );
    }

    if (/duplicate column|already exists/i.test(err.message)) {
        lines.push(
            '',
            '  Fejlen tyder på at ændringerne ALLEREDE er i databasen, men at',
            '  migrationen ikke blev registreret som kørt. Verificér at hele filens',
            '  indhold er anvendt, og registrér den så med:',
            '',
            `    INSERT INTO _migrations (filename) VALUES ('${file}');`,
        );
    }

    const wrapped = new Error(lines.join('\n'));
    wrapped.cause = err;
    return wrapped;
}

// migrationsDir er injicerbar, så testene kan køre den RIGTIGE runner mod et
// lille sæt kontrollerede migrations i stedet for at teste en kopi af logikken.
function runMigrations(dbPath = DB_PATH, migrationsDir = MIGRATIONS_DIR) {
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

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();   // 001_, 002_, 003_ ... sorterer korrekt

    const ran = new Set(
        db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename)
    );

    let count = 0;
    for (const file of files) {
        if (ran.has(file)) continue;

        console.log(`→ Kører migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        // Registreringen hører til SAMME transaktion som selve migrationen.
        //
        // Ellers findes der et vindue hvor ændringerne er committet men filen
        // ikke er registreret: `db.exec()` kører uden transaktion, så SQLite
        // committer hvert statement for sig, mens `INSERT INTO _migrations`
        // ligger bagefter i JS. Rammer noget det vindue, prøver næste opstart
        // hele filen forfra, rammer sin egen første ALTER og dør. Serveren
        // kommer aldrig ud af det selv — systemd genstarter den bare ind i
        // samme fejl.
        //
        // Det skete for migration 151 (20. august 2026). Main blev deployet
        // lige efter merge og `systemctl restart` kørt flere gange i træk, så
        // TO server-processer startede oven i hinanden. Begge så migrationen
        // som ukørt; den ene nåede at anvende alle fire statements, den anden
        // holdt skrivelåsen da registreringen skulle skrives. Resultatet var
        // en database hvor ændringerne var der, men migrationen så ukørt ud —
        // og en produktion i crash-loop på sin egen
        // "duplicate column name: temperature_cool_product".
        //
        // BEGIN IMMEDIATE frem for BEGIN er derfor ikke pynt: skrivelåsen
        // tages med det samme, så to samtidige processer støder sammen FØR
        // den ene har ændret noget. Taberen fejler rent og efterlader intet.
        if (OWNS_FK_PRAGMA.test(sql)) {
            // Kan ikke wrappes — se OWNS_FK_PRAGMA ovenfor.
            try {
                db.exec(sql);
                db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
            } catch (err) {
                throw migrationError(file, err, false);
            }
        } else {
            db.exec('BEGIN IMMEDIATE');
            try {
                db.exec(sql);
                db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
                db.exec('COMMIT');
            } catch (err) {
                // Rollback kan selv fejle hvis transaktionen allerede er væk
                // (fx efter en I/O-fejl). Den oprindelige fejl er den vigtige.
                try { db.exec('ROLLBACK'); } catch { /* med vilje tavs */ }
                throw migrationError(file, err, true);
            }
        }

        count++;
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
