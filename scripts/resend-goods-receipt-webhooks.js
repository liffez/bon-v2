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
// --verify: ryd flaget på bilag der er stemplet "sendt" uden at være nået frem.
//
// whiteboard_synced_at sættes ud fra vores eget HTTP-svar, og det svar kan lyve.
// whiteboard.ristetrug.dk lå bag en login-gate i nginx der svarede 302 →
// login-siden → 200. fetch() fulgte omdirigeringen, response.ok var true, og
// sytten bilag blev stemplet som sendt uden nogensinde at nå frem.
//
// Vi GÆTTER ikke på hvilke det var. Vi spørger tavlen hvad den faktisk har:
// GET /api/events?schema=varemodtagelse leverer bon_v2_receipt_id på hver
// registrering. Er vores id ikke i den liste, kom bilaget aldrig frem, og
// flaget ryddes så gensendelse kan fange det.
//
// Brug:
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply --id 3
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply --from 2026-05-01
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --verify
//   node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --verify --apply
//
// Dry-run er default og laver hverken HTTP-kald eller DB-skrivning.
// Der tages ikke backup: den eneste kolonne der røres er whiteboard_synced_at.

require('dotenv').config();
const path = require('path');
const fs   = require('fs');

const args   = process.argv.slice(2);
const apply  = args.includes('--apply');
const verify = args.includes('--verify');

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

    if (verify) {
        await verifyAgainstWhiteboard(db, url);
        return;
    }

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

/**
 * Spørg tavlen hvilke bilag den faktisk har, og ryd flaget på dem den ikke har.
 *
 * Bemærk at vi kun rydder OPAD: et bilag der står som usendt får aldrig et
 * flag her. Scriptet kan altså ikke komme til at skjule noget der mangler.
 */
async function verifyAgainstWhiteboard(db, postUrl) {
    // Samme endpoint, men som liste. Beholder host + sti fra den konfigurerede
    // URL, så en localhost-kobling verificeres mod localhost.
    const listUrl = `${postUrl.replace(/\/+$/, '')}?schema=varemodtagelse`;

    let events;
    try {
        // redirect: 'manual' af samme grund som i selve webhooken — en
        // login-gate ville ellers svare 200 med en HTML-side, og vi ville
        // konkludere at tavlen har NUL bilag og rydde alle flag.
        const res = await fetch(listUrl, {
            headers: { Accept: 'application/json' },
            redirect: 'manual',
            signal: AbortSignal.timeout(20000),
        });

        if (res.status >= 300 && res.status < 400) {
            console.error(`\nTavlen omdirigerede til ${res.headers.get('location') || 'ukendt mål'}.`);
            console.error('Den ligger bag et login som scriptet ikke kan komme igennem.');
            console.error('Peg webhook-URL\'en på http://localhost:3847/api/events og kør igen.');
            process.exit(1);
        }
        if (!res.ok) {
            console.error(`\nTavlen svarede HTTP ${res.status}. Afbryder — vi rydder ikke flag på et usikkert svar.`);
            process.exit(1);
        }

        events = await res.json();
        if (!Array.isArray(events)) throw new Error('svaret er ikke en liste');
    } catch (err) {
        console.error(`\nKunne ikke hente registreringer fra tavlen: ${err.message}`);
        console.error('Afbryder — vi rydder ikke flag på et svar vi ikke forstår.');
        process.exit(1);
    }

    // Tavlen kan sagtens have registreringer fra sin egen formular; de har
    // intet bon_v2_receipt_id og siger derfor intet om vores bilag.
    const arrived = new Set();
    for (const e of events) {
        const id = e?.data?.bon_v2_receipt_id;
        if (id != null) arrived.add(Number(id));
    }

    if (events.length && arrived.size === 0) {
        console.error(`\nTavlen har ${events.length} varemodtagelse(r), men ingen med bon_v2_receipt_id.`);
        console.error('Det ligner et svar fra et andet system end forventet. Afbryder for en sikkerheds skyld.');
        process.exit(1);
    }

    console.log(`Tavlen har ${events.length} varemodtagelse(r), heraf ${arrived.size} fra Bon v2.\n`);

    // En tom tavle ser præcis ud som en forkert adresse. Svaret er ægte nok
    // til at vi tør fortsætte — men det skal siges, for det er den ene
    // situation hvor ALT bliver ryddet.
    if (events.length === 0) {
        console.log('⚠ Tavlen melder nul registreringer. Er det den rigtige adresse?');
        console.log(`  ${listUrl}\n`);
    }

    let sql = `SELECT * FROM goods_receipts WHERE whiteboard_synced_at IS NOT NULL`;
    const params = [];
    if (onlyId) { sql += ` AND id = ?`;            params.push(parseInt(onlyId)); }
    if (from)   { sql += ` AND received_at >= ?`;  params.push(from); }
    if (to)     { sql += ` AND received_at <= ?`;  params.push(to + ' 23:59:59'); }
    sql += ` ORDER BY received_at`;

    const flagged = db.prepare(sql).all(...params);
    const ghosts  = flagged.filter(r => !arrived.has(r.id));

    console.log(`${flagged.length} bilag står som sendt. ${ghosts.length} af dem findes ikke i tavlen.\n`);

    if (!ghosts.length) {
        console.log('Intet at rydde — alt der står som sendt er nået frem.');
        return;
    }

    for (const r of ghosts) {
        console.log(`  ${r.receipt_number}  ${String(r.received_at).slice(0, 16)}  ` +
                    `${r.supplier_name}  (stemplet sendt ${String(r.whiteboard_synced_at).slice(0, 16)})`);
    }

    if (!apply) {
        console.log('\nDry-run — intet ændret. Kør med --verify --apply for at rydde flaget.');
        return;
    }

    const stmt = db.prepare(`UPDATE goods_receipts SET whiteboard_synced_at = NULL WHERE id = ?`);
    for (const r of ghosts) stmt.run(r.id);

    console.log(`\n${ghosts.length} flag ryddet. Send dem med:`);
    console.log('  node --experimental-sqlite scripts/resend-goods-receipt-webhooks.js --apply');
}


