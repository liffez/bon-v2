// scripts/test-goods-receipt-webhook.js
// ============================================================
// Regressionstest for varemodtagelsens Whiteboard-kobling.
//
// Fejlen der gav anledning til testen: settings.whiteboard_webhook_url stod
// tom fra den dag den blev seedet. send() sprang stille over, API'et svarede
// alligevel "webhook_sent: true", og hver varemodtagelse forsvandt ud af
// Whiteboards FVST-log uden at nogen fik besked. Fem registreringer nåede
// aldrig frem, og køkkenet gik tilbage til Whiteboards egen formular.
//
// Testen låser tre ting fast:
//   1. En sluttet kobling RAPPORTERER at den er sluttet (ikke tavs succes)
//   2. Payloaden matcher Whiteboards skema-felter (FVST Skema 1)
//   3. whiteboard_synced_at sættes KUN ved 2xx — så backfill og gensend
//      aldrig kan lave dubletter i FVST-loggen
//
// Kør:
//   node --experimental-sqlite scripts/test-goods-receipt-webhook.js
// ============================================================

'use strict';

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Isoleret temp-DB — testen må aldrig røre dev- eller driftsdata.
const TMP_DB = path.join(os.tmpdir(), `wbtest-${process.pid}.db`);
process.env.DB_PATH  = TMP_DB;
process.env.NODE_ENV = 'development';   // 'test' ville mock'e send() væk

const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

// ── Minimal DB: kun det send() rører ──
const seed = new DatabaseSync(TMP_DB);
seed.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, description TEXT,
                           updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE goods_receipts (id INTEGER PRIMARY KEY, receipt_number TEXT,
                                 whiteboard_synced_at DATETIME);
    CREATE TABLE webhook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL,
                              payload TEXT NOT NULL, status_code INTEGER, error TEXT,
                              sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                              retry_count INTEGER NOT NULL DEFAULT 0);
    INSERT INTO settings (key, value) VALUES ('whiteboard_webhook_url', '');
    INSERT INTO goods_receipts (id, receipt_number) VALUES (1, 'VR-TEST-001');
`);
seed.close();

// getDb() ville køre migrationer mod temp-DB'en — vi vil kun have vores egen
// minimale tabelstruktur, så database-modulet stubbes med samme handle.
const db = new DatabaseSync(TMP_DB);
require.cache[require.resolve('../db/database')] = {
    id: require.resolve('../db/database'),
    filename: require.resolve('../db/database'),
    loaded: true,
    exports: { getDb: () => db },
};

const webhook = require('../services/goodsReceiptWebhook');

const RECEIPT = {
    id: 1,
    receipt_number: 'VR-TEST-001',
    supplier_name: 'Testleverandør',
    temperature_cool_enabled: 1,  temperature_cool_value: 4.2,
    temperature_frozen_enabled: 0, temperature_frozen_value: null,
    date_check_ok: 1, labeling_check_ok: 0, packaging_check_ok: 1,
    has_deviation: 1, deviation_type: 'supplier_contacted',
    deviation_note: 'Kølekæden brudt',
    photo_path: '/uploads/receipts/vr-1.jpg',
};

// Whiteboards felt-id'er, jf. whiteboard/db/migrations/020_ccp_unified_deviation_ui.sql
const SCHEMA_FIELDS = ['temperature', 'temperature_freezer', 'date_ok', 'label_ok',
                       'packaging_ok', 'photo', 'deviation', 'deviation_note'];
const META_KEYS = ['photo_path', 'bon_v2_receipt_id', 'bon_v2_receipt_number'];
const DEVIATION_OPTIONS = ['none', 'returned', 'accepted_no_risk', 'discarded',
                           'supplier_contacted', 'other'];

function setUrl(v) { db.prepare(`UPDATE settings SET value = ? WHERE key = 'whiteboard_webhook_url'`).run(v); }
function syncedAt() { return db.prepare(`SELECT whiteboard_synced_at s FROM goods_receipts WHERE id = 1`).get().s; }
function resetSynced() { db.prepare(`UPDATE goods_receipts SET whiteboard_synced_at = NULL WHERE id = 1`).run(); }
function logCount() { return db.prepare(`SELECT COUNT(*) c FROM webhook_log`).get().c; }

// Stub-modtager der svarer med den status vi beder om.
let lastPayload = null;
let replyStatus = 201;
const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        lastPayload = { url: req.url, json: JSON.parse(body) };
        res.writeHead(replyStatus, { 'Content-Type': 'application/json' });
        res.end('{"id":1}');
    });
});

(async () => {
    await new Promise(r => server.listen(0, r));
    const url = `http://127.0.0.1:${server.address().port}/api/events`;

    console.log('\n── Sluttet kobling rapporterer sig selv ──');
    {
        const r = await webhook.send(RECEIPT, 'Tester');
        ok(webhook.isConfigured() === false, 'isConfigured() er false når URL er tom');
        ok(r && r.ok === false && r.skipped === true, 'send() returnerer skipped (ikke tavs succes)');
        ok(r && r.reason === 'not_configured', 'skip-årsagen kan aflæses: not_configured');
        ok(syncedAt() === null, 'whiteboard_synced_at forbliver tom');
        ok(logCount() === 0, 'intet forsøg logges når der ikke sendes');
    }

    console.log('\n── Payload matcher Whiteboards skema ──');
    setUrl(url);
    {
        ok(webhook.isConfigured() === true, 'isConfigured() er true når URL er sat');
        const r = await webhook.send(RECEIPT, 'Tester');
        ok(r && r.ok === true, 'send() melder ok ved 201');
        ok(lastPayload.url === '/api/events', 'rammer /api/events');

        const p = lastPayload.json;
        ok(p.schema_name === 'varemodtagelse', 'schema_name = varemodtagelse');
        ok(p.user === 'Tester', 'user er modtagerens navn (whiteboard afviser tom user)');
        ok(p.supplier === 'Testleverandør', 'supplier følger med');

        const unknown = Object.keys(p.data).filter(k =>
            !SCHEMA_FIELDS.includes(k) && !META_KEYS.includes(k));
        ok(unknown.length === 0, 'ingen ukendte datanøgler' + (unknown.length ? ': ' + unknown : ''));
        ok(DEVIATION_OPTIONS.includes(p.data.deviation), 'deviation er en gyldig option-værdi');
        ok(p.data.deviation === 'supplier_contacted', 'deviation_type oversættes til whiteboards værdi');
        ok(p.data.label_ok === false && p.data.date_ok === true, 'FVST-tjek sendes som booleans');
        ok(p.data.temperature === 4.2, 'køletemperatur sendes når toggle er slået til');
        ok(!('temperature_freezer' in p.data), 'frysetemperatur udelades når toggle er slået fra');
        ok(String(p.data.photo_path).startsWith('https://'), 'foto sendes som absolut URL');

        ok(syncedAt() !== null, 'whiteboard_synced_at sættes ved 2xx');
        ok(logCount() === 1, 'forsøget logges');
    }

    console.log('\n── Fejl må ikke markeres som sendt ──');
    resetSynced();
    replyStatus = 503;
    {
        const r = await webhook.send(RECEIPT, 'Tester');
        ok(r && r.ok === false, 'send() melder fejl ved 503');
        ok(r && r.statusCode === 503, 'statuskoden kan aflæses');
        ok(syncedAt() === null, 'whiteboard_synced_at forbliver tom — så gensend virker');
        ok(logCount() === 2, 'også det mislykkede forsøg logges');
    }

    console.log('\n── Uopnåelig modtager ──');
    resetSynced();
    setUrl('http://127.0.0.1:1/api/events');   // port 1 = intet lytter
    {
        const r = await webhook.send(RECEIPT, 'Tester');
        ok(r && r.ok === false && !!r.error, 'netværksfejl rapporteres som fejl');
        ok(syncedAt() === null, 'stadig ikke markeret som sendt');
        ok(logCount() === 3, 'netværksfejlen logges så den kan ses i Settings');
    }

    console.log('\n── Bilaget bærer altid sin egen dato ──');
    // Whiteboard stempler datetime('now') på alt uden occurred_at. Første udgave
    // sendte feltet KUN ved baguddatering — det holdt så længe kaldet skete i
    // samme sekund som registreringen, men ved en gensendelse uger senere fik ti
    // modtagelser tilbage til 18. maj gensendelsesdagen i FVST-loggen.
    resetSynced();
    replyStatus = 201;
    setUrl(url);
    {
        const send = async (received_at, created_at) => {
            resetSynced();
            await webhook.send({ ...RECEIPT, received_at, created_at }, 'Tester');
            return lastPayload.json;
        };

        let p = await send('2026-08-11 09:00:00', '2026-08-11 09:00:00');
        ok(p.occurred_at === '2026-08-11T09:00:00Z',
            'almindelig modtagelse sender hele tidsstemplet som UTC');

        p = await send('2026-07-14 12:00:00', '2026-08-11 21:30:00');
        ok(p.occurred_at === '2026-07-14',
            'baguddateret bilag sender KUN datoen — klokkeslættet er opdigtet');

        // received_at og created_at skrives af samme sætning ved en normal
        // modtagelse, så de er ens uanset tidszone. Sammenlignede vi i stedet
        // med dagens danske dato, ville en modtagelse mellem midnat og kl. 2
        // se baguddateret ud — kolonnerne står i UTC, hvor det stadig er i går.
        p = await send('2026-08-10 22:30:00', '2026-08-10 22:30:00');
        ok(p.occurred_at === '2026-08-10T22:30:00Z',
            'modtagelse efter midnat dansk tid regnes ikke som baguddateret');

        p = await send('2026-07-14 12:00:00', null);
        ok(p.occurred_at === '2026-07-14T12:00:00Z',
            'uden created_at gættes der ikke på baguddatering — tidsstemplet sendes som det er');

        p = await send(null, null);
        ok(!('occurred_at' in p), 'uden received_at sendes intet — tavlen stempler selv');
    }

    console.log('\n── En omdirigering er ikke en succes ──');
    // Den fejl der kostede sytten registreringer: whiteboard.ristetrug.dk lå bag
    // en login-gate i nginx, som svarede 302 → bon.ristetrug.dk/login.html.
    // fetch() følger som standard en omdirigering og laver POST om til GET, så
    // kaldet endte på vores egen login-side med 200. response.ok var true,
    // receiptet blev stemplet som sendt, og webhook_log viste en pæn 200 — mens
    // FVST-loggen aldrig så leverancen.
    resetSynced();
    {
        const gate = http.createServer((req, res) => {
            res.writeHead(302, { location: 'https://bon.ristetrug.dk/login.html' });
            res.end();
        });
        await new Promise(r => gate.listen(0, r));
        setUrl(`http://127.0.0.1:${gate.address().port}/api/events`);

        const before = logCount();
        const r = await webhook.send(RECEIPT, 'Tester');
        ok(r && r.ok === false, 'send() melder fejl ved 302 — ikke tavs succes');
        ok(r && r.statusCode === 302, 'omdirigeringens statuskode kan aflæses');
        ok(/login\.html/.test(r.error || ''), 'fejlen navngiver hvor den blev sendt hen');
        ok(syncedAt() === null, 'whiteboard_synced_at forbliver tom — gensend virker stadig');
        ok(logCount() === before + 1, 'omdirigeringen logges så den kan ses i Settings');

        gate.close();
    }

    server.close();
    db.close();
    try { fs.unlinkSync(TMP_DB); } catch {}

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})().catch(err => {
    console.error('Testfejl:', err);
    try { server.close(); db.close(); fs.unlinkSync(TMP_DB); } catch {}
    process.exit(1);
});
