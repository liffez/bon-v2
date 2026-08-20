// scripts/test-mail-timestamp-format.js
// ============================================================
// #488 — ét tidsstempel-format i mail-tabellerne.
//
// Indgående tidsstempler blev skrevet med toISOString()
// (`2026-08-10T15:49:24.000Z`), udgående med datetime('now')
// (`2026-08-10 15:53:19`). Begge UTC — men sammenlignet som TEKST sorterer
// 'T' efter ' ', så en tråd med indgående som seneste aktivitet lagde sig
// over enhver tråd med udgående fra samme dag, uanset klokkeslæt.
//
// Testen kører mod en isoleret temp-DB bygget af de RIGTIGE migrations, så en
// kolonne der flytter sig får den til at fejle i stedet for at bestå mod en
// håndskrevet kopi af skemaet.
//
//   node --experimental-sqlite scripts/test-mail-timestamp-format.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-tsformat-${Date.now()}.db`);

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}

// Samme ORDER BY som GET /api/mail/threads bruger.
const THREAD_ORDER = 'COALESCE(mt.last_inbound_at, mt.last_outbound_at, mt.updated_at) DESC';

async function main() {
    process.env.DB_PATH = TEST_DB;
    require('../db/migrate').runMigrations(TEST_DB);
    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const { sqlTime } = require('../db/helpers');

    try {
        // ── 1) sqlTime: formatet ────────────────────────────────────
        console.log('\n— sqlTime —');
        const t = sqlTime(new Date('2026-08-10T15:49:24.000Z'));
        assert(t === '2026-08-10 15:49:24', `ISO → SQLite-format (${t})`);
        assert(!/[TZ]/.test(t), 'hverken T eller Z tilbage');
        assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlTime()),
            'uden argument giver samme form for nu');
        assert(sqlTime('ikke en dato') === null, 'ugyldig dato giver null frem for "Invalid Date"');

        // Samme skala som datetime('now') — ellers ville sammenligning være meningsløs
        const nuJs = sqlTime();
        const nuSql = db.prepare(`SELECT datetime('now') AS n`).get().n;
        const spread = Math.abs(
            (Date.parse(nuJs.replace(' ', 'T') + 'Z') - Date.parse(nuSql.replace(' ', 'T') + 'Z')) / 1000);
        assert(spread < 5, `sqlTime() og datetime('now') er samme tidsskala (${spread}s fra hinanden)`);

        // ── 2) Sorteringen: den fejl issuet beskriver ───────────────
        console.log('\n— Sortering inden for samme dag —');
        const st = db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get().id;
        const loc = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get().id;
        const cust = Number(db.prepare(
            `INSERT INTO customers (first_name) VALUES ('Sorterings-Test')`).run().lastInsertRowid);

        // To tråde samme dag: den ene sidst rørt af en INDGÅENDE kl. 10:45,
        // den anden af en UDGÅENDE kl. 17:25. Den udgående er nyest.
        const inbound = Number(db.prepare(`
            INSERT INTO mail_threads (subject, customer_id, handling_status, last_inbound_at, updated_at)
            VALUES ('Indgående 10:45', ?, 'aaben', ?, ?)`
        ).run(cust, '2026-08-10 10:45:54', '2026-08-10 10:45:54').lastInsertRowid);
        const outbound = Number(db.prepare(`
            INSERT INTO mail_threads (subject, customer_id, handling_status, last_outbound_at, updated_at)
            VALUES ('Udgående 17:25', ?, 'aaben', ?, ?)`
        ).run(cust, '2026-08-10 17:25:31', '2026-08-10 17:25:31').lastInsertRowid);

        const order = db.prepare(
            `SELECT mt.id FROM mail_threads mt WHERE mt.customer_id = ? ORDER BY ${THREAD_ORDER}`
        ).all(cust).map(r => r.id);
        assert(order[0] === outbound,
            'den nyeste ligger øverst, uanset om seneste aktivitet var ind- eller udgående');

        // Med det gamle format ville rækkefølgen vende — vis at det ER fejlen
        db.prepare(`UPDATE mail_threads SET last_inbound_at = ? WHERE id = ?`)
          .run('2026-08-10T10:45:54.000Z', inbound);
        const brudt = db.prepare(
            `SELECT mt.id FROM mail_threads mt WHERE mt.customer_id = ? ORDER BY ${THREAD_ORDER}`
        ).all(cust).map(r => r.id);
        assert(brudt[0] === inbound,
            'og med ISO-formatet vender den om — det var præcis fejlen (#488)');
        db.prepare(`UPDATE mail_threads SET last_inbound_at = ? WHERE id = ?`)
          .run('2026-08-10 10:45:54', inbound);

        // ── 3) Migrationen har ryddet skemaet ──────────────────────
        console.log('\n— Ingen ISO-rester i mail-tabellerne —');
        const rester = [
            ['mail_messages', 'received_at'],
            ['mail_unmatched', 'received_at'],
            ['mail_unmatched', 'handled_at'],
            ['mail_threads', 'last_inbound_at'],
        ];
        for (const [tbl, col] of rester) {
            const n = db.prepare(`SELECT COUNT(*) n FROM ${tbl} WHERE ${col} LIKE '%T%'`).get().n;
            assert(n === 0, `${tbl}.${col} har ingen ISO-rester`);
        }

        // ── 3b) Migrationen rammer HVER gren ───────────────────────
        // Uden data i hver tabel beviser tjekket ovenfor kun at tomme tabeller
        // er tomme — fjernes en UPDATE fra migrationen, opdages det ikke.
        console.log('\n— Hver tabel i migrationen bliver faktisk rettet —');
        const isoRaw = '2026-08-11T08:11:17.000Z';
        const isoOk  = '2026-08-11 08:11:17';
        const tIso = Number(db.prepare(`
            INSERT INTO mail_threads (subject, customer_id, handling_status, last_inbound_at)
            VALUES ('ISO-tråd', ?, 'aaben', ?)`).run(cust, isoRaw).lastInsertRowid);
        const umIso = Number(db.prepare(`
            INSERT INTO mail_unmatched (mailbox, from_email, subject, received_at, handled_at, status)
            VALUES ('kontakt@ristetrug.dk', 'a@b.invalid', 'ISO-mail', ?, ?, 'ignored')`
        ).run(isoRaw, isoRaw).lastInsertRowid);

        const MIG = fs.readFileSync(path.join(__dirname, '../db/migrations/150_mail_timestamp_format.sql'), 'utf8');
        db.exec(MIG);

        assert(db.prepare('SELECT last_inbound_at v FROM mail_threads WHERE id=?').get(tIso).v === isoOk,
            'mail_threads.last_inbound_at konverteres');
        assert(db.prepare('SELECT received_at v FROM mail_unmatched WHERE id=?').get(umIso).v === isoOk,
            'mail_unmatched.received_at konverteres');
        assert(db.prepare('SELECT handled_at v FROM mail_unmatched WHERE id=?').get(umIso).v === isoOk,
            'mail_unmatched.handled_at konverteres');

        // ── 4) Migrationen bevarer tidspunktet ─────────────────────
        console.log('\n— Konvertering flytter ikke tiden —');
        const bon = Number(db.prepare(
            `INSERT INTO bons (bon_number, order_date, delivery_date, status_id, location_id)
             VALUES ('T-TS-1', date('now'), date('now'), ?, ?)`).run(st, loc).lastInsertRowid);
        const th = Number(db.prepare(
            `INSERT INTO mail_threads (subject, bon_id, handling_status) VALUES ('x', ?, 'aaben')`
        ).run(bon).lastInsertRowid);
        const raw = '2026-08-10T15:49:24.000Z';
        db.prepare(`
            INSERT INTO mail_messages (thread_id, direction, from_email, to_email, subject, received_at)
            VALUES (?, 'in', 'a@b.invalid', 'kontakt@ristetrug.dk', 'x', ?)`).run(th, raw);
        db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/150_mail_timestamp_format.sql'), 'utf8'));
        const efter = db.prepare(
            `SELECT received_at FROM mail_messages WHERE thread_id = ?`).get(th).received_at;
        assert(efter === '2026-08-10 15:49:24', `formatet er skiftet (${efter})`);
        assert(Date.parse(efter.replace(' ', 'T') + 'Z') === Date.parse(raw),
            'og tidspunktet er nøjagtig det samme — konverteringen er ren formatering');

        // ── 5) Idempotens ──────────────────────────────────────────
        db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/150_mail_timestamp_format.sql'), 'utf8'));
        assert(db.prepare(`SELECT received_at FROM mail_messages WHERE thread_id = ?`).get(th).received_at === efter,
            'anden kørsel af migrationen ændrer intet');

        // ── 6) Den ÆGTE skrivesti ──────────────────────────────────
        // Alt ovenfor kan bestå selvom mailService stadig skriver ISO — kun et
        // kald gennem processInboundMail beviser at formatet er rettet dér
        // hvor mails faktisk lander.
        console.log('\n— processInboundMail skriver rigtigt format —');
        const mail = require('../services/mailService');
        const parsed = {
            subject: 'Format-test uden tag',
            text: 'hej',
            messageId: '<format-test@example.invalid>',
            inReplyTo: null,
            date: new Date('2026-08-12T07:30:11.000Z'),
            from: { value: [{ address: 'ukendt@format-test.invalid', name: 'Format Test' }] },
            to:   { value: [{ address: 'kontakt@ristetrug.dk' }] },
            attachments: [],
        };
        await mail.processInboundMail(parsed, 4242, 'kontakt@ristetrug.dk');
        const row = db.prepare(
            `SELECT received_at FROM mail_unmatched WHERE message_id = ?`
        ).get('<format-test@example.invalid>');
        assert(!!row, 'mailen blev gemt (ukendt afsender → ufordelt)');
        assert(row && row.received_at === '2026-08-12 07:30:11',
            `received_at skrives i SQLite-format (${row && row.received_at})`);
        assert(row && !/[TZ]/.test(row.received_at || ''),
            'ingen T eller Z i det der faktisk lander i databasen');

    } finally {
        try { db.close(); } catch {}
        for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(TEST_DB + suf); } catch {} }
    }

    finish();
}

function finish() {
    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
