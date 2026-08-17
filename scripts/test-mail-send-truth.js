// scripts/test-mail-send-truth.js
// ============================================================
// Regressionstest for #362 — ligner en fejlet mail stadig en sendt?
//
// mail_messages blev indsat med `sent_at = datetime('now')` cirka 45 linjer FØR
// `transport.sendMail()` blev kaldt, uden try/catch og uden kompenserende
// sletning. Fejlede SMTP — eller bare en manglende vedhæftning — overlevede
// rækken med udfyldt sent_at og message_id = NULL.
//
// Ingen steder opdagede det: `message_id IS NULL` optræder ét sted i hele
// repoet, og dér filtreres der på INDGÅENDE mail. Den fejlede afsendelse var
// altså ikke til at skelne fra en gennemført, heller ikke for et menneske.
//
// Det ramte booking- og web-ordrebekræftelser, som sendes fire-and-forget:
// kunden fik intet, og tråden sagde "sendt".
//
// Kør:
//   node --experimental-sqlite scripts/test-mail-send-truth.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-mail-truth-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const mail = require('../services/mailService');
const db = getDb();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
setSetting('smtp_enabled', '1');
setSetting('smtp_from', 'bon@ristetrug.dk');
setSetting('smtp_user', 'bon@ristetrug.dk');

const lastMsg = () => db.prepare(
    `SELECT id, sent_at, message_id, send_error, direction FROM mail_messages ORDER BY id DESC LIMIT 1`).get();
const msgCount = () => db.prepare(`SELECT COUNT(*) AS n FROM mail_messages`).get().n;

(async () => {
    console.log('\nMail: siger rækken sandheden om afsendelsen? (#362)\n');

    // ── S1: den lykkelige vej ──
    console.log('S1 · Vellykket afsendelse');
    mail._setMockTransport({ sendMail: async () => ({ messageId: '<abc@ristetrug.dk>' }) });
    await mail.sendMail({ to: 'kunde@example.com', subject: 'Test OK', text: 'hej' });
    let m = lastMsg();
    ok(!!m.sent_at, `sent_at er sat — fik '${m.sent_at}'`);
    ok(m.message_id === '<abc@ristetrug.dk>', `message_id gemt — fik '${m.message_id}'`);
    ok(m.send_error === null, `ingen send_error — fik ${JSON.stringify(m.send_error)}`);

    // ── S2: SMTP fejler ──
    console.log('\nS2 · SMTP fejler → rækken må IKKE ligne en sendt');
    mail._setMockTransport({ sendMail: async () => { throw new Error('SMTP 550 mailbox unavailable'); } });
    const before = msgCount();
    let threw = null;
    try { await mail.sendMail({ to: 'daarlig@example.com', subject: 'Test fejl', text: 'hej' }); }
    catch (e) { threw = e; }
    m = lastMsg();
    ok(!!threw, `fejlen bobler videre til kalderen — fik '${threw && threw.message}'`);
    ok(msgCount() === before + 1, 'rækken bevares som spor på forsøget');
    ok(m.sent_at === null, `sent_at er NULL (var udfyldt før rettelsen) — fik ${JSON.stringify(m.sent_at)}`);
    ok(m.message_id === null, 'message_id er NULL');
    ok(/550/.test(m.send_error || ''), `send_error forklarer hvorfor — fik '${m.send_error}'`);

    // ── S3: vedhæftning mangler — kastede FØR sendMail overhovedet blev nået ──
    console.log('\nS3 · Manglende vedhæftning → samme sandhed');
    mail._setMockTransport({ sendMail: async () => ({ messageId: '<x@y>' }) });
    threw = null;
    try {
        await mail.sendMail({ to: 'kunde@example.com', subject: 'Med bilag', text: 'hej',
                              attachments: [{ attachment_id: 999999 }] });
    } catch (e) { threw = e; }
    m = lastMsg();
    ok(!!threw, 'fejlen bobler videre');
    ok(m.sent_at === null, `sent_at er NULL — fik ${JSON.stringify(m.sent_at)}`);
    ok(/[Vv]edhæftning/.test(m.send_error || ''), `send_error nævner vedhæftningen — fik '${m.send_error}'`);

    // ── S4: beskeden forsvinder ikke ud af tråden ──
    console.log('\nS4 · En fejlet besked står stadig i tråden (sorteringen tåler NULL)');
    const tid = m.id && db.prepare(`SELECT thread_id FROM mail_messages WHERE id = ?`).get(m.id).thread_id;
    const rows = db.prepare(
        `SELECT id, sent_at FROM mail_messages WHERE thread_id = ?
         ORDER BY COALESCE(sent_at, received_at, created_at), id`).all(tid);
    ok(rows.some(r => r.id === m.id), `den fejlede besked er med i trådens ${rows.length} besked(er)`);

    // ── S5: den efterfølgende retry rydder sporet ──
    console.log('\nS5 · Lykkes et nyt forsøg, står der ikke en gammel fejl tilbage');
    mail._setMockTransport({ sendMail: async () => ({ messageId: '<retry@ok>' }) });
    await mail.sendMail({ to: 'kunde@example.com', subject: 'Igen', text: 'hej' });
    m = lastMsg();
    ok(!!m.sent_at && m.send_error === null, `sent_at sat, send_error ryddet — fik '${m.sent_at}' / ${JSON.stringify(m.send_error)}`);

    mail._clearMockTransport();
    console.log('\n─────────────────────────────────────────');
    console.log(fail === 0 ? `\x1b[32m${pass} PASS\x1b[0m · 0 FAIL` : `\x1b[32m${pass} PASS\x1b[0m · \x1b[31m${fail} FAIL\x1b[0m`);
    try { require('fs').unlinkSync(TEST_DB); } catch { /* ligegyldigt */ }
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
