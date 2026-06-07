// scripts/test-mail-fk-guard.js
// ============================================================
// Regressions-test for mail-FK-guard (services/mailService.js processInboundMail).
//
// Bug: en indkommende mail tagget #k-NNN mod en IKKE-eksisterende kunde satte
// customerId = NNN uden at verificere kunden, hvorefter
//   INSERT INTO mail_threads (customer_id, ...) VALUES (NNN, ...)
// fejlede med "FOREIGN KEY constraint failed" og blokerede IMAP-pollen for den
// mail ved hvert poll.
//
// Fix: verificér kunden findes før customerId sættes (samme mønster som bon/
// PO/supplier). Findes kunden ikke → customerId forbliver null → mailen falder
// igennem til mail_unmatched i stedet for at crashe.
//
// Denne test beviser mekanismen direkte mod en isoleret temp-DB.
//
// Kør:
//   node --experimental-sqlite scripts/test-mail-fk-guard.js
// ============================================================

'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-mail-fk-${Date.now()}.db`);
const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { openDb } = require('../db/compat');
const db = openDb(TEST_DB);
db.exec('PRAGMA foreign_keys = ON');   // SKAL være til — som i app'en

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

console.log('\nMail-FK-guard regressionstest\n');

// Find en kunde-id der IKKE findes
const maxCust = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM customers').get().m;
const ghostCustomerId = maxCust + 99999;
ok(!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(ghostCustomerId), `kunde ${ghostCustomerId} findes ikke (test-forudsætning)`);

// S1: BUG — INSERT med ikke-eksisterende customer_id fejler med FK (det den gamle kode gjorde)
console.log('\nS1 · Den gamle kode: customer_id mod ukendt kunde → FK-fejl');
{
    let threw = false, msg = '';
    try {
        db.prepare(
            `INSERT INTO mail_threads (bon_id, customer_id, subject, status, created_at, updated_at)
             VALUES (NULL, ?, 'test', 'active', datetime('now'), datetime('now'))`
        ).run(ghostCustomerId);
    } catch (e) { threw = true; msg = e.message; }
    ok(threw && /FOREIGN KEY/i.test(msg), `INSERT med ghost-customer fejler med FOREIGN KEY (${threw ? msg.slice(0,40) : 'kastede IKKE'})`);
}

// S2: FIX-VEJ — guarden gør customerId = null når kunden ikke findes → INSERT lykkes
console.log('\nS2 · Fix-vejen: kunde verificeres → ikke fundet → customer_id = null → INSERT lykkes');
{
    // Replikér guard-logikken fra processInboundMail:
    let customerId = null;
    const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(ghostCustomerId);
    if (cust) customerId = cust.id;
    ok(customerId === null, 'guard sætter customerId = null for ukendt kunde');

    let threw = false;
    try {
        const r = db.prepare(
            `INSERT INTO mail_threads (bon_id, customer_id, subject, status, created_at, updated_at)
             VALUES (NULL, ?, 'test-fix', 'active', datetime('now'), datetime('now'))`
        ).run(customerId);
        db.prepare('DELETE FROM mail_threads WHERE id = ?').run(r.lastInsertRowid);  // ryd op
    } catch (e) { threw = true; }
    ok(!threw, 'INSERT med customer_id = null lykkes (mailen kan falde til unmatched)');
}

// S3: Sanity — INSERT med EN EKSISTERENDE kunde lykkes stadig (guarden bremser ikke gyldige)
console.log('\nS3 · Sanity: gyldig kunde verificeres OK og bruges');
{
    // Opret en testkunde
    const cid = db.prepare(
        `INSERT INTO customers (first_name, last_name, created_at) VALUES ('Test','Kunde', datetime('now'))`
    ).run().lastInsertRowid;
    let customerId = null;
    const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(cid);
    if (cust) customerId = cust.id;
    ok(customerId === cid, 'guard accepterer eksisterende kunde');
    let threw = false;
    try {
        const r = db.prepare(
            `INSERT INTO mail_threads (bon_id, customer_id, subject, status, created_at, updated_at)
             VALUES (NULL, ?, 'test-valid', 'active', datetime('now'), datetime('now'))`
        ).run(customerId);
        db.prepare('DELETE FROM mail_threads WHERE id = ?').run(r.lastInsertRowid);
    } catch (e) { threw = true; }
    ok(!threw, 'INSERT med gyldig customer_id lykkes');
    db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
}

console.log('\n─────────────────────────────────────────');
console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
db.close();
try { fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); } catch {}
process.exit(fail === 0 ? 0 : 1);
