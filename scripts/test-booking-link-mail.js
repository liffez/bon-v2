// scripts/test-booking-link-mail.js
// ============================================================
// {{booking_link}} skal virke fra bon-mailen — og fejle SYNLIGT når den ikke kan.
//
// Sagen: bon-draweren og bon-kortet folder skabelonen ud i BROWSEREN og sender
// resultatet til serveren som fritekst (`text`), ikke som `templateKey`. Ingen
// frontend har nogensinde sendt templateKey til POST /api/bons/:id/mail. Den rute
// renderede ikke fritekst, så et {{booking_link}} gik afsted til kunden som RÅ
// TEKST — pladsholderen selv, midt i mailen.
//
// Og i den ene sti hvor serveren DA rendrede (test-mailen), blev en uopløselig
// pladsholder slettet i stilhed: mailen gik ud med et hul, og afsenderen fik
// intet at vide. Samme fejlklasse som #305/#319 — handlingen påstod at være
// lykkedes, mens bivirkningen aldrig fyrede.
//
// Reglerne der testes:
//   1. Fritekst fra bon-mailen rendres server-side med bonens kunde som kontekst.
//   2. Uopløseligt link → 400 med en besked afsenderen kan handle på. INGEN mail.
//   3. Test-mailen (som pr. definition ingen kunde har) sender stadig — med en
//      synlig markering, aldrig en tom plads og aldrig en opdigtet URL.
//
// Kør:  node --experimental-sqlite scripts/test-booking-link-mail.js
// ============================================================
'use strict';

const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-booking-link-${Date.now()}.db`);
const PORT = 4343;
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
setSetting('smtp_kontakt_enabled', '1');
setSetting('smtp_kontakt_from', 'kontakt@ristetrug.dk');
setSetting('smtp_kontakt_user', 'kontakt@ristetrug.dk');
setSetting('booking_customer_url_base', 'https://kontakt.ristetrug.dk');

const statusId = (code) => db.prepare(`SELECT id FROM status_definitions WHERE code = ?`).get(code)?.id;

function makeCustomer(email) {
    return Number(db.prepare(
        `INSERT INTO customers (first_name, last_name, email) VALUES ('Lærke','Andersen', ?)`
    ).run(email).lastInsertRowid);
}

function makeBon({ number, customerId = null }) {
    const loc = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get()?.id;
    return Number(db.prepare(`
        INSERT INTO bons (bon_number, is_offer, order_date, delivery_date, status_id, location_id, customer_id, created_at)
        VALUES (?, 0, date('now'), date('now'), ?, ?, ?, datetime('now'))
    `).run(number, statusId('NY'), loc, customerId).lastInsertRowid);
}

const bodiesFor = (bonId) => db.prepare(`
    SELECT mm.body_text, mm.subject FROM mail_messages mm
      JOIN mail_threads mt ON mm.thread_id = mt.id
     WHERE mt.bon_id = ? ORDER BY mm.id
`).all(bonId);

const countAllMails = () => db.prepare(`SELECT COUNT(*) c FROM mail_messages`).get().c;

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
    const res = await fetch(BASE + url, {
        method, headers, redirect: 'manual',
        body: body == null ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data, location: res.headers.get('location') };
}

const SHORT_URL_RE = /https:\/\/kontakt\.ristetrug\.dk\/b\/[0-9a-f]{16}/;

async function main() {
    const mail = require('../services/mailService');

    // ── 1) renderTemplate: strict som standard ────────────────────────
    console.log('\n1 · renderTemplate sletter ikke længere i stilhed');
    const kunde = makeCustomer('laerke@example.invalid');

    let threw = null;
    try {
        mail.renderTemplate('Book her: {{booking_link}}', {}, {});   // ingen kunde
    } catch (e) { threw = e; }
    ok(threw !== null, 'uden kunde KASTER den (før: pladsholderen blev slettet uden en lyd)');
    ok(threw && threw.code === 'booking_link_unresolvable', `fejlen bærer koden booking_link_unresolvable (fik '${threw && threw.code}')`);
    ok(threw && /kunde/i.test(threw.message), 'beskeden siger at der mangler en kunde');

    setSetting('booking_customer_url_base', '');
    setSetting('booking_public_url_base', '');
    let threwUrl = null;
    try { mail.renderTemplate('{{booking_link}}', {}, { customerId: kunde }); } catch (e) { threwUrl = e; }
    ok(threwUrl && threwUrl.code === 'booking_link_unresolvable', 'uden URL-base kaster den også');
    ok(threwUrl && /Settings/.test(threwUrl.message), 'og peger på Settings, hvor URL-basen sættes');
    setSetting('booking_customer_url_base', 'https://kontakt.ristetrug.dk');

    const good = mail.renderTemplate('Book her: {{booking_link}}', {}, { customerId: kunde });
    ok(SHORT_URL_RE.test(good), `med kunde bliver den en rigtig kort URL — fik '${good}'`);
    ok(!good.includes('{{booking_link}}'), 'ingen rest af pladsholderen');

    // ── 2) Lenient: kun til test-mail ─────────────────────────────────
    console.log('\n2 · Test-mail: synlig markering, aldrig et opdigtet link');
    const len = mail.renderTemplate('Book her: {{booking_link}}', {}, { lenientBookingLink: true });
    ok(!len.includes('{{booking_link}}'), 'pladsholderen står ikke rå tilbage');
    ok(len.includes(mail.BOOKING_LINK_TEST_MARKER), 'markeringen er sat i stedet');
    ok(!/https?:\/\//.test(len), 'markeringen ligner IKKE en URL — ingen mailklient kan gøre den klikbar');
    ok(len.trim() !== 'Book her:', 'og pladsen efterlades ikke tom');

    // ── 3) Kontrolprøve: tekst uden booking_link er urørt ─────────────
    console.log('\n3 · Kontrolprøve');
    const plain = 'Hej Lærke\n\nHer er linket: https://kontakt.ristetrug.dk/book/smagning';
    ok(mail.renderTemplate(plain, {}, {}) === plain, 'tekst uden {{booking_link}} går uændret igennem, uden kontekst');

    // ── 4) Gennem den ægte rute ───────────────────────────────────────
    console.log('\n4 · POST /api/bons/:id/mail — fritekst rendres server-side');
    const bonMedKunde = makeBon({ number: 'B901', customerId: kunde });
    const bonUdenKunde = makeBon({ number: 'B902', customerId: null });

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    let adminId;
    if (admin) { db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id); adminId = admin.id; }
    else adminId = Number(db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN).lastInsertRowid);

    const serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB, NODE_ENV: 'test', MAIL_POLL_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', d => {
        const s = d.toString();
        if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server-err] ' + s);
    });

    try {
        if (!await waitForServer()) throw new Error('Server startede ikke');
        if ((await http('POST', '/api/auth/pin', { pin: TEST_PIN })).status !== 200) throw new Error('Login fejlede');

        // Præcis det bon-draweren sender: fritekst, INTET templateKey.
        const r1 = await http('POST', `/api/bons/${bonMedKunde}/mail`, {
            to: 'laerke@example.invalid',
            subject: 'Link til gratis frokost for 2',
            text: 'Hej Lærke\n\n  → Book her:\n  {{booking_link}}\n\nTeam Ristet Rug'
        });
        ok(r1.status === 200, `mailen sendes (status ${r1.status})`);

        const sent = bodiesFor(bonMedKunde);
        ok(sent.length === 1, 'præcis én mail gemt');
        const body = sent[0]?.body_text || '';
        ok(!body.includes('{{booking_link}}'), 'REGRESSIONEN: den rå pladsholder gik IKKE ud til kunden');
        ok(SHORT_URL_RE.test(body), `body bærer en rigtig kort URL — fik '${(body.match(/\S*kontakt\.ristetrug\.dk\S*/) || ['ingen'])[0]}'`);

        // Tokenet skal pege på bonens kunde og på den der sendte.
        //
        // Ingen URL i body'en betyder at rettelsen ovenfor er væk. Så skal de
        // følgende asserts FEJLE, ikke kaste: en stak-udskrift ser ud som et
        // brudt testscript i stedet for en fanget fejl, og resten af testen —
        // inklusive opsummeringen — når aldrig at køre.
        const token = (body.match(SHORT_URL_RE) || [''])[0].split('/b/')[1] || null;
        const tRow = token ? db.prepare(`SELECT * FROM booking_tokens WHERE token = ?`).get(token) : null;
        ok(!!tRow, 'tokenet findes i booking_tokens');
        ok(tRow?.customer_id === kunde, 'tokenet er bundet til BONENS kunde');
        ok(tRow?.sales_user_id === adminId, 'og til den indloggede sælger');
        ok(tRow?.flow === 'smagning', "flow er 'smagning'");

        // URL'en er ikke bare velformet — den virker.
        const red = token ? await http('GET', `/b/${token}`) : { status: 0, location: null };
        ok(red.status === 302, `det korte link redirecter (status ${red.status})`);
        ok((red.location || '').includes('/book/smagning'), `og lander på smagnings-siden — fik '${red.location}'`);

        // Emnet renderes også.
        const r2 = await http('POST', `/api/bons/${bonMedKunde}/mail`, {
            to: 'laerke@example.invalid', subject: 'Book: {{booking_link}}', text: 'Hej'
        });
        ok(r2.status === 200, 'mail med link i EMNET sendes');
        const subj = bodiesFor(bonMedKunde).map(r => r.subject).join(' | ');
        ok(!subj.includes('{{booking_link}}'), 'emnet bærer heller ikke en rå pladsholder');

        // ── 5) Bon uden kunde: synlig fejl, ingen mail ────────────────
        console.log('\n5 · Uopløseligt link fejler synligt — og sender ingenting');
        const før = countAllMails();
        const r3 = await http('POST', `/api/bons/${bonUdenKunde}/mail`, {
            to: 'nogen@example.invalid', subject: 'Test', text: 'Book: {{booking_link}}'
        });
        ok(r3.status === 400, `bon uden kunde afvises med 400 (fik ${r3.status})`);
        ok(r3.data?.code === 'booking_link_unresolvable', 'svaret bærer koden');
        ok(/kunde/i.test(r3.data?.error || ''), `beskeden forklarer hvad der mangler — fik '${r3.data?.error}'`);
        ok(countAllMails() === før, 'og INGEN mail blev gemt eller sendt');

        // Uden link går samme bon fint igennem — fejlen rammer kun det den skal.
        const r4 = await http('POST', `/api/bons/${bonUdenKunde}/mail`, {
            to: 'nogen@example.invalid', subject: 'Test', text: 'Helt almindelig mail'
        });
        ok(r4.status === 200, 'samme bon UDEN booking-link sendes fint (status ' + r4.status + ')');

        // ── 6) Test-mailen sender stadig ──────────────────────────────
        console.log('\n6 · Send test på en skabelon med booking-link');
        db.prepare(`INSERT INTO mail_templates (key, label, subject, body_text)
                    VALUES ('send_smags_link','Send Smags link','Link til gratis frokost for 2',
                            'Hej {{kundeNavn}}\n\n  → Book her:\n  {{booking_link}}\n\nTeam Ristet Rug')`).run();
        const r5 = await http('POST', '/api/mail/test', { to: 'anne@example.invalid', templateKey: 'send_smags_link' });
        ok(r5.status === 200, `test-mailen sendes trods manglende kunde (status ${r5.status})`);
        const testBody = db.prepare(`SELECT body_text FROM mail_messages ORDER BY id DESC LIMIT 1`).get()?.body_text || '';
        ok(testBody.includes(mail.BOOKING_LINK_TEST_MARKER), 'test-mailen viser markeringen i stedet for et link');
        ok(!testBody.includes('{{booking_link}}'), 'og ikke den rå pladsholder');

        // ── 7) sendFromTemplate udleder kunden af bonId ──────────────
        // Web-ordrens bekræftelse kalder sendFromTemplate med bonId og UDEN
        // customerId. Uden udledningen ville et {{booking_link}} i den skabelon
        // kaste — og kunden ville slet ingen bekræftelse få.
        console.log('\n7 · sendFromTemplate finder kunden via bonen');
        db.prepare(`INSERT INTO mail_templates (key, label, subject, body_text)
                    VALUES ('t_bon_link','Bon-link','Emne','Book: {{booking_link}}')`).run();
        const førT = countAllMails();
        const rt = await http('POST', `/api/bons/${bonMedKunde}/mail`, {
            to: 'laerke@example.invalid', templateKey: 't_bon_link'
        });
        ok(rt.status === 200, `skabelon-afsendelse med kun bonId virker (status ${rt.status})`);
        ok(countAllMails() === førT + 1, 'mailen blev sendt, ikke afvist');
        const tplBody = db.prepare(`SELECT body_text FROM mail_messages ORDER BY id DESC LIMIT 1`).get()?.body_text || '';
        ok(SHORT_URL_RE.test(tplBody), 'linket blev lavet ud fra bonens kunde');
        const tplToken = (tplBody.match(SHORT_URL_RE) || [''])[0].split('/b/')[1] || null;
        const tplRow = tplToken ? db.prepare(`SELECT customer_id FROM booking_tokens WHERE token = ?`).get(tplToken) : null;
        ok(tplRow?.customer_id === kunde, 'og bundet til netop dén kunde');

    } finally {
        serverProc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} PASS · ${fail} FAIL`);
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); } catch {}
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); try { fs.unlinkSync(TEST_DB); } catch {}; process.exit(1); });
