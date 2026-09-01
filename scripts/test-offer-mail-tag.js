// scripts/test-offer-mail-tag.js
// ============================================================
// Et tilbud skal bære sit eget mail-tag (#t-), ikke bonnens (#b-).
//
// Sagen: T-28 blev sendt med emnet "#b-28 Tilbud T-28". Et tilbud ER en bon
// (is_offer = 1), og alle mail-veje satte derfor `type: 'bon'` på den.
// Konsekvensen er ikke kosmetisk — den er routingen:
//
//   · matchBonByTagNumber filtrerer bon-tags til is_offer = 0, så kundens
//     svar fandt ingenting og faldt ud i den ufordelte indbakke.
//   · Fandtes en RIGTIG bon med samme cifre, ville svaret lande på DEN.
//     Laveste bon i drift er cafe-64, så kollisionen begynder ved T-64.
//
// Hele #t--siden fandtes i forvejen (settingen, parseSubject, offer-grenen i
// matchBonByTagNumber) — den var bare uden for rækkevidde, fordi ingen
// afsender nogensinde satte type: 'offer'.
//
// Afsendelsen testes over HTTP mod den ægte rute, fordi det er dér typen
// udledes. Den indgående routing testes in-process mod processInboundMail.
//
// Kør:
//   node --experimental-sqlite scripts/test-offer-mail-tag.js
// ============================================================
'use strict';

const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-offer-tag-${Date.now()}.db`);
const PORT = 4341;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

process.env.DB_PATH  = TEST_DB;
process.env.NODE_ENV = 'test';   // → auto-mock SMTP, ingen rigtig post

require('../db/migrate').runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const db = getDb();

const setSetting = (k, v) => db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
setSetting('smtp_enabled', '1');
setSetting('smtp_from', 'bon@ristetrug.dk');
setSetting('smtp_user', 'bon@ristetrug.dk');

const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;

function makeCustomer() {
    return Number(db.prepare(
        `INSERT INTO customers (first_name, last_name, email) VALUES ('Katrine','Vinther','katrine@example.invalid')`
    ).run().lastInsertRowid);
}

function makeBon({ number, isOffer, customerId = null }) {
    const loc = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get()?.id;
    return Number(db.prepare(`
        INSERT INTO bons (bon_number, is_offer, order_date, delivery_date, status_id, location_id, customer_id, created_at)
        VALUES (?, ?, date('now'), date('now'), ?, ?, ?, datetime('now'))
    `).run(number, isOffer ? 1 : 0, statusId(isOffer ? 'TILBUD' : 'NY') || statusId('NY'), loc, customerId).lastInsertRowid);
}

const subjectsFor = (bonId) => db.prepare(`
    SELECT mm.subject FROM mail_messages mm
      JOIN mail_threads mt ON mm.thread_id = mt.id
     WHERE mt.bon_id = ? ORDER BY mm.id
`).all(bonId).map(r => r.subject);

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

// En indgående mail som IMAP ville have parset den.
let uidSeq = 700;
const inbound = (subject, extra = {}) => ({
    subject,
    messageId: `<in-${++uidSeq}@example.invalid>`,
    from: { value: [{ address: 'katrine@example.invalid', name: 'Katrine Vinther' }] },
    to:   { value: [{ address: 'bon@ristetrug.dk' }] },
    date: new Date('2026-09-01T10:00:00Z'),
    text: 'Hej Anne, tak for tilbuddet.',
    ...extra,
});

async function main() {
    const mail = require('../services/mailService');

    // Tilbud T-28 og en rigtig bon med SAMME cifre. Dét par er hele pointen:
    // uden en typeforskel i tagget kan de to ikke skilles ad.
    const kunde   = makeCustomer();
    const offer28 = makeBon({ number: 'T-28', isOffer: true, customerId: kunde });
    const bon28   = makeBon({ number: 'B28',  isOffer: false });
    // Og et tilbud UDEN en bon-tvilling — sådan ser drift ud i dag (T-21 mod
    // laveste bon cafe-64), hvor svaret bare forsvandt i den ufordelte indbakke.
    const offer21 = makeBon({ number: 'T-21', isOffer: true });

    // ── 1) Typen udledes af rækken ────────────────────────────────────
    console.log('\n1 · bonMailContext skelner tilbud fra bon');
    const cOffer = mail.bonMailContext(db, offer28);
    const cBon   = mail.bonMailContext(db, bon28);
    ok(cOffer?.type === 'offer', `T-28 → type 'offer' (fik '${cOffer?.type}')`);
    ok(cBon?.type === 'bon',     `B28 → type 'bon' (fik '${cBon?.type}')`);
    ok(cOffer?.number === 28 && cBon?.number === 28, 'begge har cifrene 28 — kun typen skiller dem');
    ok(mail.bonMailContext(db, 999999) === null, 'ukendt bon-id giver null i stedet for et tag på ingenting');

    const { buildTag } = require('../utils/mail-parser');
    ok(buildTag(cOffer) === '#t-28', `tilbuddets tag er #t-28 (fik '${buildTag(cOffer)}')`);
    ok(buildTag(cBon)   === '#b-28', `bonnens tag er #b-28 (fik '${buildTag(cBon)}')`);

    // ── 2) Afsendelse gennem den ægte rute ────────────────────────────
    console.log('\n2 · POST /api/bons/:id/mail sætter det rigtige tag');
    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);

    let serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, NODE_ENV: 'test', MAIL_POLL_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', d => {
        const s = d.toString();
        if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server-err] ' + s);
    });

    let offerThreadId = null;
    try {
        if (!await waitForServer()) throw new Error('Server startede ikke');
        if ((await http('POST', '/api/auth/pin', { pin: TEST_PIN })).status !== 200) throw new Error('Login fejlede');

        const rOffer = await http('POST', `/api/bons/${offer28}/mail`,
            { to: 'katrine@example.invalid', subject: 'Tilbud T-28', text: 'Hej Katrine' });
        ok(rOffer.status === 200, `tilbuddet sendes (status ${rOffer.status})`);
        offerThreadId = rOffer.data?.threadId || null;

        const sOffer = subjectsFor(offer28);
        ok(sOffer.some(s => s.includes('#t-28')), `emnet bærer #t-28 — fik '${sOffer[0]}'`);
        ok(!sOffer.some(s => s.includes('#b-28')), 'og IKKE #b-28, som ville pege på en rigtig bon');

        const rBon = await http('POST', `/api/bons/${bon28}/mail`,
            { to: 'kunde@example.invalid', subject: 'Bekræftelse på B28', text: 'Hej' });
        ok(rBon.status === 200, `den rigtige bon sendes (status ${rBon.status})`);
        const sBon = subjectsFor(bon28);
        ok(sBon.some(s => s.includes('#b-28')), `bonnens emne er uændret #b-28 — fik '${sBon[0]}'`);

        // ── 3) Svar fra indbakken bærer trådens egen type ─────────────
        console.log('\n3 · Svar fra indbakken på en tilbudstråd');
        if (offerThreadId) {
            // Svar-ruten henter modtageren fra seneste indgående afsender —
            // en bon-tråd har ingen email i sig selv. Så kunden skal have
            // skrevet først, præcis som når man svarer i indbakken.
            db.prepare(`
                INSERT INTO mail_messages (thread_id, direction, from_email, to_email, subject, body_text, received_at, mailbox)
                VALUES (?, 'in', 'katrine@example.invalid', 'bon@ristetrug.dk', 'SV: #t-28 Tilbud T-28', 'Ja tak', datetime('now'), 'bon@ristetrug.dk')
            `).run(offerThreadId);

            const rReply = await http('POST', `/api/mail/threads/${offerThreadId}/reply`, { body: 'Ja tak' });
            ok(rReply.status === 200, `svaret sendes (status ${rReply.status}${rReply.status !== 200 ? ' — ' + JSON.stringify(rReply.data) : ''})`);
            const sidsteUd = db.prepare(
                `SELECT subject FROM mail_messages WHERE thread_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1`
            ).get(offerThreadId)?.subject || '';
            ok(sidsteUd.includes('#t-28'), `svarets emne bærer #t-28 — fik '${sidsteUd}'`);
            ok(!sidsteUd.includes('#b-28'), 'og ikke bon-tagget');
        } else {
            ok(false, 'kunne ikke finde tilbuddets tråd — resten af gruppen kan ikke køres');
        }
    } finally {
        if (serverProc) { serverProc.kill('SIGTERM'); await new Promise(r => setTimeout(r, 400)); }
    }

    // ── 4) Kundens svar finder vej tilbage ────────────────────────────
    //
    // Tællingen er en DIFFERENCE, ikke et absolut tal: tråden bærer allerede
    // den indgående mail gruppe 3 svarede på.
    const inCount = (bid) => db.prepare(`
        SELECT COUNT(*) AS n FROM mail_messages mm JOIN mail_threads mt ON mm.thread_id = mt.id
         WHERE mt.bon_id = ? AND mm.direction = 'in'`).get(bid).n;

    console.log('\n4 · Indgående #t-28 lander på tilbuddet');
    let offerFoer = inCount(offer28), bonFoer = inCount(bon28);
    await mail.processInboundMail(inbound('SV: #t-28 Tilbud T-28'), ++uidSeq, 'bon@ristetrug.dk');
    ok(inCount(offer28) === offerFoer + 1, 'svaret lander på T-28');
    ok(inCount(bon28)   === bonFoer,       'og IKKE på bon B28, som bærer de samme cifre');

    // ── 5) Rigtige bons vinder stadig et bon-tag ──────────────────────
    //
    // Fallbacken i næste gruppe må aldrig kunne stjæle et gyldigt bon-tag.
    console.log('\n5 · Indgående #b-28 lander på den rigtige bon, ikke på tilbuddet');
    offerFoer = inCount(offer28); bonFoer = inCount(bon28);
    await mail.processInboundMail(inbound('SV: #b-28 Bekræftelse på B28'), ++uidSeq, 'bon@ristetrug.dk');
    ok(inCount(bon28)   === bonFoer + 1, 'bon-tagget gik til B28');
    ok(inCount(offer28) === offerFoer,   'og tilbuddet fik ikke en til');

    // ── 6) De tilbud der allerede er sendt med #b- ────────────────────
    console.log('\n6 · Gammelt #b--tag på et tilbud uden bon-tvilling');
    await mail.processInboundMail(inbound('SV: #b-21 Tilbud T-21'), ++uidSeq, 'bon@ristetrug.dk');
    const in21 = inCount(offer21);
    ok(in21 === 1, `svaret på T-21 finder tilbuddet (fandt ${in21})`);
    const unmatched21 = db.prepare(
        `SELECT COUNT(*) AS n FROM mail_unmatched WHERE subject LIKE '%#b-21%'`).get().n;
    ok(unmatched21 === 0, 'og ryger ikke i den ufordelte indbakke');

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} PASS · ${fail} FAIL\x1b[0m\n`);
    return fail === 0 ? 0 : 1;
}

main()
    .then(code => { try { fs.unlinkSync(TEST_DB); } catch {} process.exit(code); })
    .catch(err => { console.error(err); try { fs.unlinkSync(TEST_DB); } catch {} process.exit(1); });
