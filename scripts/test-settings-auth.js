// scripts/test-settings-auth.js
// ============================================================
// Adgangskontrol på /api/settings.
//
// Baggrund: der findes INGEN global auth-gate i server.js — hver router sætter
// sin egen. routes/settings.js havde ingen, så enhver der kunne nå serveren
// kunne læse OG skrive vilkårlige indstillinger uden at logge ind. Tabellen
// styrer SMTP, webhook-secrets, nummerserier, session-varigheder og lagertræk,
// så det er et angreb på driften — ikke bare en informationslækage.
//
// Modellen der testes:
//   • uden login            → 401 på ALT
//   • inde-logget ikke-admin→ må læse; må kun skrive nøgler i allowlisten
//   • admin                 → må skrive alt
//
// Sidste case er den vigtigste: den fejler hvis nogen tilføjer en ny rute til
// filen uden auth. Den itererer over ruterne frem for at liste dem i hånden.
//
// In-process express med skiftelig fake-session. Isoleret temp-DB.
//
//   node --experimental-sqlite scripts/test-settings-auth.js
// ============================================================
'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-settings-auth-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const express = require('express');
const app = express();
app.use(express.json());

// Skiftelig session: sæt _session til null (ikke logget ind) eller et objekt.
let _session = null;
app.use((req, res, next) => { req.session = _session ? { ..._session } : {}; next(); });
app.use('/api/settings', require('../routes/settings'));

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);

const ANON    = null;
const KITCHEN = { userId: 2, userRole: 'kitchen' };
const ADMIN   = { userId: 1, userRole: 'admin' };

(async () => {
    const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/settings`;

    const call = async (session, method, path, body) => {
        _session = session;
        const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return res.status;
    };

    console.log('\n— Uden login: alt skal afvises —');
    check(await call(ANON, 'GET', '/') === 401, 'GET / → 401');
    check(await call(ANON, 'GET', '/locations') === 401, 'GET /locations → 401');
    check(await call(ANON, 'GET', '/delivery-icons') === 401, 'GET /delivery-icons → 401');
    check(await call(ANON, 'GET', '/duplicates') === 401, 'GET /duplicates → 401');
    check(await call(ANON, 'PATCH', '/smtp_host', { value: 'evil.example' }) === 401,
        'PATCH /smtp_host → 401 (kunne omdirigere udgående mail)');
    check(await call(ANON, 'PATCH', '/inventory_auto_deduct', { value: '1' }) === 401,
        'PATCH /inventory_auto_deduct → 401');
    check(await call(ANON, 'PATCH', '/webhook_secret', { value: 'kendt' }) === 401,
        'PATCH /webhook_secret → 401 (kunne forfalske webhooks)');

    console.log('\n— Uden login: intet blev skrevet —');
    const { getDb } = require('../db/database');
    const smtp = getDb().prepare(`SELECT value FROM settings WHERE key='smtp_host'`).get();
    check(smtp?.value !== 'evil.example', 'smtp_host uændret i databasen');

    console.log('\n— Inde-logget ikke-admin: må læse —');
    check(await call(KITCHEN, 'GET', '/') === 200, 'GET / → 200');
    check(await call(KITCHEN, 'GET', '/locations') === 200, 'GET /locations → 200');

    console.log('\n— Ikke-admin: må KUN skrive nøgler i allowlisten —');
    check(await call(KITCHEN, 'PATCH', '/show_prices_in_planning', { value: '1' }) === 200,
        'PATCH /show_prices_in_planning → 200 (køkkenets pris-toggle virker)');
    check(await call(KITCHEN, 'PATCH', '/reactivation_min_orders', { value: '3' }) === 200,
        'PATCH /reactivation_min_orders → 200 (CRM-listens tærskel virker)');
    check(await call(KITCHEN, 'PATCH', '/smtp_host', { value: 'evil.example' }) === 403,
        'PATCH /smtp_host → 403');
    check(await call(KITCHEN, 'PATCH', '/inventory_auto_deduct', { value: '1' }) === 403,
        'PATCH /inventory_auto_deduct → 403');
    check(getDb().prepare(`SELECT value FROM settings WHERE key='smtp_host'`).get()?.value !== 'evil.example',
        'smtp_host stadig uændret');

    console.log('\n— Admin: må skrive alt —');
    check(await call(ADMIN, 'PATCH', '/inventory_auto_deduct', { value: '1' }) === 200,
        'PATCH /inventory_auto_deduct → 200');
    check(getDb().prepare(`SELECT value FROM settings WHERE key='inventory_auto_deduct'`).get()?.value === '1',
        'værdien blev faktisk skrevet');
    check(await call(ADMIN, 'GET', '/role-permissions') === 200, 'GET /role-permissions → 200');

    // ── Regressionsvagt ────────────────────────────────────────────────────
    // Går filens egen router-stak igennem og kræver at HVER rute har mindst ét
    // middleware før handle(). Fejler hvis nogen tilføjer en rute uden auth —
    // det var præcis sådan hullet opstod (naboruterne havde auth, catch-all'en
    // blev glemt).
    console.log('\n— Regressionsvagt: ingen rute uden auth-middleware —');
    const stack = require('../routes/settings').stack.filter(l => l.route);
    let naked = [];
    for (const layer of stack) {
        const methods = Object.keys(layer.route.methods).join('|').toUpperCase();
        // handle() + evt. auth. 1 = kun handle → ingen auth-middleware.
        if (layer.route.stack.length < 2) naked.push(`${methods} ${layer.route.path}`);
    }
    check(naked.length === 0,
        naked.length ? `ruter uden auth: ${naked.join(', ')}` : `alle ${stack.length} ruter har auth-middleware`);

    server.close();
    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
