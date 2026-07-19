// scripts/test-webhook-truth.js
// ============================================================
// Regressionstest for #363 — påstår svaret at webhooken blev sendt?
//
// routes/goods-receipts.js svarede `webhook_sent: true` / `webhook_dispatched:
// true` som HARDKODEDE literaler. Ingen af værdierne var udledt af noget.
//
// Værst var det når settingen manglede: goodsReceiptWebhook.send() lavede et
// TAVST early return — ingen log, ingen webhook_log-række, intet — mens routen
// svarede at fødevarekontrol-registreringen var nået frem til Whiteboard.
//
// Efter rettelsen kan svaret kun sige om vi FORSØGTE (kaldet er bevidst
// fire-and-forget, så en modtagelse ikke blokeres af et eksternt kald).
// Om Whiteboard modtog den, aflæses på goods_receipts.whiteboard_synced_at.
//
// Kør:
//   node --experimental-sqlite scripts/test-webhook-truth.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-webhook-truth-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;
// Test-mode-mocken i webhook-servicen må IKKE være aktiv her — vi tester
// præcis den rigtige sti, inkl. hvad der sker når settingen mangler.
delete process.env.NODE_ENV;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const webhook = require('../services/goodsReceiptWebhook');
const db = getDb();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const setUrl = (v) => {
    if (v === null) db.prepare(`DELETE FROM settings WHERE key = 'whiteboard_webhook_url'`).run();
    else db.prepare(`INSERT INTO settings (key, value) VALUES ('whiteboard_webhook_url', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v);
};
const logCount = () => db.prepare(`SELECT COUNT(*) AS n FROM webhook_log`).get().n;

// Minimal receipt-række (webhook-servicen læser felter direkte fra objektet)
const receipt = {
    id: 1, receipt_number: 'VR-TEST-001', supplier_name: 'Hørkram',
    date_check_ok: 1, labeling_check_ok: 1, packaging_check_ok: 1,
    has_deviation: 0, deviation_type: null, deviation_note: null, photo_path: null,
    temperature_cool_enabled: 0, temperature_frozen_enabled: 0,
};
db.prepare(`INSERT INTO goods_receipts (id, receipt_number, supplier_name, received_by_name, status)
            VALUES (1, 'VR-TEST-001', 'Hørkram', 'Tester', 'approved')`).run();

const _fetch = global.fetch;

(async () => {
    console.log('\nWebhook: siger svaret sandheden? (#363)\n');

    // ── S1: settingen mangler ──
    console.log('S1 · whiteboard_webhook_url er ikke sat');
    setUrl(null);
    ok(webhook.isConfigured() === false, `isConfigured() = false — fik ${webhook.isConfigured()}`);
    let r = await webhook.send(receipt, 'Tester');
    ok(r && r.status === 'not_configured',
        `send() melder 'not_configured' (returnerede tavst før) — fik '${r && r.status}'`);
    ok(!db.prepare(`SELECT whiteboard_synced_at FROM goods_receipts WHERE id = 1`).get().whiteboard_synced_at,
        'intet falsk synced-tidsstempel');

    // ── S2: konfigureret og Whiteboard svarer OK ──
    console.log('\nS2 · Whiteboard svarer 200');
    setUrl('http://whiteboard.test/hook');
    ok(webhook.isConfigured() === true, `isConfigured() = true — fik ${webhook.isConfigured()}`);
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
    const logBefore = logCount();
    r = await webhook.send(receipt, 'Tester');
    ok(r && r.status === 'sent', `send() melder 'sent' — fik '${r && r.status}'`);
    ok(!!db.prepare(`SELECT whiteboard_synced_at FROM goods_receipts WHERE id = 1`).get().whiteboard_synced_at,
        'whiteboard_synced_at sat');
    ok(logCount() === logBefore + 1, 'webhook_log fik en række');

    // ── S3: Whiteboard fejler ──
    console.log('\nS3 · Whiteboard svarer 500');
    db.prepare(`UPDATE goods_receipts SET whiteboard_synced_at = NULL WHERE id = 1`).run();
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    r = await webhook.send(receipt, 'Tester');
    ok(r && r.status === 'failed', `send() melder 'failed' — fik '${r && r.status}'`);
    ok(/500/.test(r.error || ''), `fejlen er med i svaret — fik '${r.error}'`);
    ok(!db.prepare(`SELECT whiteboard_synced_at FROM goods_receipts WHERE id = 1`).get().whiteboard_synced_at,
        'IKKE markeret som synced');

    // ── S4: netværket dør ──
    console.log('\nS4 · Whiteboard er utilgængelig');
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    r = await webhook.send(receipt, 'Tester');
    ok(r && r.status === 'failed', `send() melder 'failed' — fik '${r && r.status}'`);

    // ── S5: det routen svarer klienten ──
    console.log('\nS5 · Routens svar afspejler om vi forsøgte');
    setUrl(null);
    ok(webhook.isConfigured() === false,
        'uden setting → webhook_dispatched bliver false (var hardkodet true)');
    setUrl('http://whiteboard.test/hook');
    ok(webhook.isConfigured() === true, 'med setting → true');

    global.fetch = _fetch;
    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    try { require('fs').unlinkSync(TEST_DB); } catch { /* ligegyldigt */ }
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { global.fetch = _fetch; console.error('crash:', e); process.exit(2); });
