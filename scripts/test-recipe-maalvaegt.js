#!/usr/bin/env node
/**
 * Målvægt — normen pr. kategori og afvigelsen pr. opskrift (§10.3).
 *
 * «Hvad sigter vi på at en sandwich vejer» er en norm for en SLAGS mad.
 * Den bor derfor pr. Grocy-kategori, sammen med DB%-målet, og kun en
 * afvigelse gemmes pr. opskrift — ellers ville en ændret norm ikke slå
 * igennem, og hver ret ville stå med et tal ingen huskede at have sat.
 *
 * Skemaet bygges af de RIGTIGE migrations, så en kolonne der flytter sig
 * fælder testen i stedet for at bestå mod en håndskrevet kopi.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations } = require('../db/migrate');
const { openDb } = require('../db/compat');

let pass = 0, fail = 0;
function ok(v, navn) {
    if (v) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + navn); }
    else   { fail++; console.log('  \x1b[31m✗\x1b[0m ' + navn); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maalvaegt-'));
const dbPath = path.join(tmp, 'test.db');
runMigrations(dbPath);
const db = openDb(dbPath);

const T = require('../services/recipeTargets');

const sætNorm = (kat, g) => db.prepare(
    `INSERT INTO recipe_db_targets (category, target_weight_g) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET target_weight_g = excluded.target_weight_g`).run(kat, g);
const override = (rid) => db.prepare(
    'SELECT target_weight_g FROM recipe_target_weights WHERE recipe_id = ?').get(rid);

// ── §1 Normen gælder når opskriften ikke afviger ──────────────
console.log('\n── §1 Normen pr. kategori ────────────────────────────────');
{
    sætNorm('01 Sandwich', 350);
    const r = T.målvægtFor(db, 91, '01 Sandwich');
    ok(r.target_weight_g === 350, 'en sandwich arver gruppens 350 g');
    ok(r.target_weight_source === 'category',
        'og kilden siges, så skærmen kan vise den som forslag frem for som en værdi');
    ok(r.target_weight_category_g === 350, 'normen følger med, så feltet kan vise den som placeholder');

    const uden = T.målvægtFor(db, 91, '99 Ukendt');
    ok(uden.target_weight_g === null && uden.target_weight_source === null,
        'en gruppe uden norm giver null — ikke 0. 0 g ville være en påstand');
}

// ── §2 En ret må afvige ───────────────────────────────────────
console.log('\n── §2 Afvigelsen pr. opskrift ────────────────────────────');
{
    T.gemMålvægt(db, 91, '01 Sandwich', 500, null);
    const r = T.målvægtFor(db, 91, '01 Sandwich');
    ok(r.target_weight_g === 500, 'en ret der afviger bruger sit eget tal');
    ok(r.target_weight_source === 'recipe', 'og siger at det er sat på RETTEN, ikke arvet');
    ok(r.target_weight_category_g === 350, 'normen er stadig med — man skal kunne se hvad man afviger fra');

    // Kontrolprøve: naboen i samme gruppe er urørt.
    ok(T.målvægtFor(db, 92, '01 Sandwich').target_weight_g === 350,
        'kontrol: en anden ret i samme gruppe arver stadig normen');
}

// ── §3 Kun afvigelsen gemmes ──────────────────────────────────
console.log('\n── §3 Kun afvigelsen gemmes ──────────────────────────────');
{
    T.gemMålvægt(db, 93, '01 Sandwich', 350, null);
    ok(override(93) === undefined,
        'et tal der ER normen gemmes ikke — ellers ville en ændret norm ikke slå igennem');

    T.gemMålvægt(db, 94, '01 Sandwich', 420, null);
    ok(override(94) && override(94).target_weight_g === 420, 'et afvigende tal gemmes');

    // Normen flyttes. Den der IKKE afveg, skal følge med.
    sætNorm('01 Sandwich', 400);
    ok(T.målvægtFor(db, 93, '01 Sandwich').target_weight_g === 400,
        'retten uden afvigelse følger normen når den flyttes');
    ok(T.målvægtFor(db, 94, '01 Sandwich').target_weight_g === 420,
        'og retten med en afvigelse bliver på sit eget tal');

    T.gemMålvægt(db, 94, '01 Sandwich', null, null);
    ok(override(94) === undefined && T.målvægtFor(db, 94, '01 Sandwich').target_weight_g === 400,
        'ryddes feltet, falder retten tilbage på normen — tomt betyder ikke «ingen målvægt»');

    T.gemMålvægt(db, 95, '01 Sandwich', 0, null);
    ok(override(95) === undefined, '0 er ikke en målvægt og gemmes ikke');
    T.gemMålvægt(db, 96, '01 Sandwich', 'vrøvl', null);
    ok(override(96) === undefined, 'og vrøvl gemmes heller ikke');
}

// ── §4 Dansk komma ────────────────────────────────────────────
console.log('\n── §4 Tastet med komma ───────────────────────────────────');
{
    T.gemMålvægt(db, 97, '01 Sandwich', '412,5', null);
    ok(override(97) && Math.abs(override(97).target_weight_g - 412.5) < 1e-9,
        '«412,5» læses som 412,5 — et dansk komma må ikke blive til et andet tal');
}

// ── §5 De to normer er uafhængige ─────────────────────────────
console.log('\n── §5 DB%-målet og målvægten lever hver for sig ──────────');
{
    // Migration 187 lempede target_pct til nullable netop for dette.
    db.prepare(`INSERT INTO recipe_db_targets (category, target_weight_g) VALUES ('02 Salat', 300)`).run();
    const r = db.prepare(`SELECT * FROM recipe_db_targets WHERE category = '02 Salat'`).get();
    ok(r.target_pct === null && r.target_weight_g === 300,
        'en kategori kan have en målvægt uden et DB%-mål');

    db.prepare(`UPDATE recipe_db_targets SET target_pct = 70 WHERE category = '02 Salat'`).run();
    ok(T.målvægtFor(db, 1, '02 Salat').target_weight_g === 300,
        'og et DB%-mål sat bagefter rører ikke målvægten');
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' PASS · ' + fail + ' FAIL\x1b[0m\n');
process.exit(fail ? 1 : 0);
