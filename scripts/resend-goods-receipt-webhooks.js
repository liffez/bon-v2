// scripts/resend-goods-receipt-webhooks.js
//
// Sender varemodtagelser til Whiteboards FVST-log som aldrig nåede frem.
//
// Baggrund: settings.whiteboard_webhook_url stod tom fra den dag den blev
// seedet (migration 035, 11. april 2026). goodsReceiptWebhook.send() springer
// stille over når URL'en er tom — så hver registrering i Bon v2 blev gemt
// korrekt i databasen og forsvandt derefter ud af syne. Da koblingen blev
// tændt igen, lå de gamle registreringer stadig usendte.
//
// Scriptet sender KUN dem hvor whiteboard_synced_at IS NULL. Whiteboard
// afviser ikke dubletter, så en gensendelse af noget der allerede er nået
// frem, ville lægge samme leverance i FVST-loggen to gange. Derfor er det
// flaget — ikke en dato eller et skøn — der styrer hvad der sendes.
//
// Brug:
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply --id 3
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply --from 2026-05-01
//
// Dry-run er default og laver hverken HTTP-kald eller DB-skrivning.
// Der tages ikke backup: den eneste kolonne der røres er whiteboard_synced_at.

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const args  = process.argv.slice(2);
const apply = args.includes('--apply');

function argValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

const onlyId = argValue('--id');
const from   = argValue('--from');
const to     = argValue('--to');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

// Servicen henter selv sin DB via getDb() — peg singletonen på samme fil.
process.env.DB_PATH = DB_PATH;

if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

// NODE_ENV=test ville få send() til at mock'e sig selv og ikke sende noget.
if (process.env.NODE_ENV === 'test') {
    console.error('NODE_ENV=test — send() er mock\'et i testtilstand. Afbryder.');
    process.exit(2);
}

const { getDb } = require('../db/database');
const webhook   = require('../services/goodsReceiptWebhook');

(async () => {
    const db = getDb();

    const url = webhook.getWebhookUrl();
    if (!url) {
        console.error('whiteboard_webhook_url er tom — koblingen er slukket.');
        console.error('Sæt den under Indstillinger → Whiteboard, og kør så igen.');
        process.exit(1);
    }
    console.log(`Whiteboard: ${url}`);

    let sql = `SELECT * FROM goods_receipts WHERE whiteboard_synced_at IS NULL`;
    const params = [];
    if (onlyId) { sql += ` AND id = ?`;            params.push(parseInt(onlyId)); }
    if (from)   { sql += ` AND received_at >= ?`;  params.push(from); }
    if (to)     { sql += ` AND received_at <= ?`;  params.push(to + ' 23:59:59'); }
    sql += ` ORDER BY received_at`;

    const rows = db.prepare(sql).all(...params);

    if (!rows.length) {
        console.log('Ingen varemodtagelser mangler at blive sendt.');
        return;
    }

    console.log(`${rows.length} varemodtagelse(r) mangler i Whiteboard:\n`);
    for (const r of rows) {
        console.log(`  ${r.receipt_number}  ${String(r.received_at).slice(0, 16)}  ` +
                    `${r.supplier_name}  (${r.received_by_name || 'ukendt modtager'})`);
    }

    if (!apply) {
        console.log('\nDry-run — intet sendt. Kør med --apply for at sende.');
        return;
    }

    console.log('\nSender…\n');
    let ok = 0;
    const failed = [];

    for (const r of rows) {
        const userName = r.received_by_name
            || db.prepare(`SELECT name FROM users WHERE id = ?`).get(r.received_by)?.name
            || 'Ukendt';

        const result = await webhook.send(r, userName);
        if (result?.ok) {
            ok++;
            console.log(`  ✓ ${r.receipt_number}`);
        } else {
            failed.push(`${r.receipt_number}: ${result?.error || 'ukendt fejl'}`);
            console.log(`  ✗ ${r.receipt_number} — ${result?.error || 'ukendt fejl'}`);
        }
    }

    console.log(`\n${ok} sendt, ${failed.length} fejlede.`);
    if (failed.length) {
        console.log('\nFejlede (kan køres igen — flaget er kun sat på dem der lykkedes):');
        failed.forEach(f => console.log('  ' + f));
        process.exitCode = 1;
    }
})().catch(err => {
    console.error('Fejl:', err.message);
    process.exit(1);
});
