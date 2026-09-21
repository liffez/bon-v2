// tests/isolated_test_scripts.test.js
// ============================================================
// #516 — et test-script må ikke røre udviklerens egen database.
//
// Scripterne mocker Grocy fuldstændigt, men kalder `grocyAdapter`, som slår
// lokationen op gennem getGrocyConfig() → getDb() → runMigrations(data/bon.db).
// Stien er repo-absolut, så hverken cwd eller en fetch-mock holder dem væk:
// en test kunne migrere udviklerens database som bivirkning, og fejle af en
// grund der intet havde med dens egen logik at gøre.
//
// Testen måler det man kan se udefra: bliver en fil i repoets `data/` rørt?
// Derfor spawnes scripterne som rigtige processer.
//
// Kør:  node --test tests/isolated_test_scripts.test.js
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROD = path.join(__dirname, '..');
const DATA = path.join(ROD, 'data');
const HELPER = path.join(ROD, 'scripts', 'helpers', 'isolated_db.js');

// De otte fra #516. Listen er med vilje skrevet ud: en ny test-fil skal
// tilføjes bevidst, ikke fanges af et mønster der tier når den flytter sig.
const SCRIPTS = [
    'test-prep-packing', 'test-recipe-factor', 'test-yield-model', 'test-gram-chaining',
    'test-resolver-graph', 'test-subrecipe-status', 'test-packing-units', 'test-producibility',
];

const kør = (fil, env = {}) =>
    spawnSync(process.execPath, ['--experimental-sqlite', path.join(ROD, 'scripts', fil)],
        { cwd: ROD, env: { ...process.env, ...env }, encoding: 'utf8' });

test('alle otte scripts isolerer databasen før de rører db/ eller services/', () => {
    for (const navn of SCRIPTS) {
        const src = fs.readFileSync(path.join(ROD, 'scripts', `${navn}.js`), 'utf8');
        const iso = src.indexOf("require('./helpers/isolated_db')");
        assert.ok(iso >= 0, `${navn}.js isolerer ikke databasen`);

        // Rækkefølgen er hele pointen: isolationen skal sætte DB_PATH FØR
        // db/database indlæses, ellers har getDb allerede valgt den rigtige fil.
        const foerste = src.search(/require\('\.\.\/(db|services|routes|shared)\//);
        if (foerste >= 0) {
            assert.ok(iso < foerste,
                `${navn}.js requirer ${src.slice(foerste, foerste + 40)}… før isolationen`);
        }
    }
});

test('et script rører ikke repoets data/ — heller ikke når filen mangler', () => {
    // Sentinel: hvis scriptet åbner repo-stien, bliver filen skabt.
    const sentinel = path.join(DATA, `_isolation_probe_${process.pid}.db`);
    for (const f of [sentinel, sentinel + '-wal', sentinel + '-shm']) fs.rmSync(f, { force: true });

    const r = kør('test-recipe-factor.js', { DB_PATH: sentinel });
    try {
        assert.match(r.stdout, /PASS/, `scriptet kørte ikke: ${r.stderr.slice(0, 300)}`);
        assert.strictEqual(fs.existsSync(sentinel), false,
            'scriptet skrev i repoets data/ — isolationen virker ikke');
        assert.match(r.stderr + r.stdout, /temp-database/,
            'isolationen skal sige det højt når den overstyrer en DB_PATH i repoets data/');
    } finally {
        for (const f of [sentinel, sentinel + '-wal', sentinel + '-shm']) fs.rmSync(f, { force: true });
    }
});

test('hjælperen: uden DB_PATH vælges en temp-database uden for repoet', () => {
    const env = { ...process.env };
    delete env.DB_PATH;
    const r = spawnSync(process.execPath,
        ['-e', `require(${JSON.stringify(HELPER)}); console.log(process.env.DB_PATH)`],
        { env, encoding: 'utf8' });
    const valgt = r.stdout.trim();
    assert.ok(valgt, 'DB_PATH blev ikke sat');
    assert.ok(!path.resolve(valgt).startsWith(DATA + path.sep), `${valgt} ligger i repoets data/`);
    assert.ok(path.resolve(valgt).startsWith(path.resolve(os.tmpdir())), `${valgt} ligger ikke i temp`);
});

test('hjælperen: en DB_PATH uden for repoet respekteres (til fejlsøgning)', () => {
    const egen = path.join(os.tmpdir(), `bon-egen-${process.pid}.db`);
    const r = spawnSync(process.execPath,
        ['-e', `require(${JSON.stringify(HELPER)}); console.log(process.env.DB_PATH)`],
        { env: { ...process.env, DB_PATH: egen }, encoding: 'utf8' });
    assert.strictEqual(r.stdout.trim(), egen);
});

test('hjælperen: temp-mappen ryddes op når processen slutter', () => {
    const env = { ...process.env };
    delete env.DB_PATH;
    const r = spawnSync(process.execPath,
        ['-e', `const h=require(${JSON.stringify(HELPER)});` +
               `require('fs').writeFileSync(h.dbPath(),'x'); console.log(h.dbPath())`],
        { env, encoding: 'utf8' });
    const valgt = r.stdout.trim();
    assert.ok(valgt);
    assert.strictEqual(fs.existsSync(valgt), false, 'temp-databasen blev liggende');
});
