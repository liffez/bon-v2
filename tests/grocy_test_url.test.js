// tests/grocy_test_url.test.js
// ============================================================
// #591 / #514 — test-lokationen pegede på den udfasede Grocy.
//
//   grocytest.ristetrug.dk   gammel (Linode)  → 401 med vores nøgle
//   grocy-test.ristetrug.dk  ny (.202)        → 200
//
// Serveren læser URL'en fra `locations`, ikke fra .env, så en frisk dev-DB
// ramte en Grocy der afviser os — og alt Grocy-afhængigt viste tomme lister
// i stedet for en fejl.
//
// Skemaet bygges af de RIGTIGE migrations i en temp-DB (som quote_convert),
// så testen fanger det hvis seed eller migration flytter sig igen.
//
// Kør:  node --experimental-sqlite --test tests/grocy_test_url.test.js
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations } = require('../db/migrate');

const NY = 'https://grocy-test.ristetrug.dk/api';
const GAMMEL = 'https://grocytest.ristetrug.dk/api';
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocy-url-'));
    const db = runMigrations(path.join(dir, 'bon.db'), MIGRATIONS);
    return { db, dir };
}
const url = (db, code) =>
    db.prepare('SELECT grocy_api_url FROM locations WHERE code = ?').get(code)?.grocy_api_url;

test('en frisk database peger på den nye grocy-test', () => {
    const { db, dir } = freshDb();
    assert.strictEqual(url(db, 'test'), NY);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('den aktive lokation i en frisk database er Test — aldrig produktion', () => {
    const { db, dir } = freshDb();
    const id = db.prepare(`SELECT value FROM settings WHERE key = 'default_grocy_location_id'`).get().value;
    const row = db.prepare('SELECT code FROM locations WHERE id = ?').get(Number(id));
    assert.strictEqual(row.code, 'test', 'en ny installation må ikke skrive i produktions-Grocy');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('migrationen retter en eksisterende række med den gamle URL', () => {
    const { db, dir } = freshDb();
    // Genskab tilstanden fra før: databasen er ældre end rettelsen.
    db.prepare('UPDATE locations SET grocy_api_url = ? WHERE code = ?').run(GAMMEL, 'test');
    const sql = fs.readFileSync(path.join(MIGRATIONS, '185_grocy_test_url.sql'), 'utf8');
    db.exec(sql);
    assert.strictEqual(url(db, 'test'), NY);
    db.exec(sql);                                  // idempotent
    assert.strictEqual(url(db, 'test'), NY);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('en håndsat URL røres ikke (fx en lokal Grocy)', () => {
    const { db, dir } = freshDb();
    const egen = 'http://localhost:9283/api';
    db.prepare('UPDATE locations SET grocy_api_url = ? WHERE code = ?').run(egen, 'test');
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '185_grocy_test_url.sql'), 'utf8'));
    assert.strictEqual(url(db, 'test'), egen, 'migrationen må kun rette den gamle værdi');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('trailer og cafe er urørte — trailer flyttes først når nginx-undtagelsen findes (#514)', () => {
    const { db, dir } = freshDb();
    assert.strictEqual(url(db, 'trailer'), 'https://grocytrailer.ristetrug.dk/api');
    assert.strictEqual(url(db, 'hq'), 'https://grocy-hq.ristetrug.dk/api');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });

    // Den gamle URL er den ene vagt, koden den anden. Hver for sig er de nok;
    // fjernes BEGGE, flytter migrationen trailer med — og trailer virker i dag.
    const sql = fs.readFileSync(path.join(MIGRATIONS, '185_grocy_test_url.sql'), 'utf8');
    const where = sql.slice(sql.indexOf('WHERE'));
    assert.ok(/code\s*=\s*'test'/.test(where), 'migrationen skal kun ramme test-lokationen');
    assert.ok(!/trailer|cafe|'hq'/.test(where), 'kun test-rækken må flyttes her');
});

test('ingen kilde peger længere på den udfasede grocytest', () => {
    const rod = path.join(__dirname, '..');
    for (const f of ['db/migrations/001_core.sql', '.env.test.example']) {
        const s = fs.readFileSync(path.join(rod, f), 'utf8');
        assert.ok(!/https:\/\/grocytest\.ristetrug\.dk/.test(s), `${f} peger stadig på grocytest`);
    }
    // CLAUDE.md må nævne navnet (det gør den, som advarsel) — men ikke som den vi bruger.
    const md = fs.readFileSync(path.join(rod, 'CLAUDE.md'), 'utf8');
    assert.ok(/Under udvikling bruges \*\*grocy-test\*\*/.test(md), 'CLAUDE.md peger næste person forkert');
});
