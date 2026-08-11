// tests/mail_signature.test.js
// ==========================================
// Mail-signatur ét sted (migration 144).
//
// Før: signaturen lå i renderTemplate() og ramte kun skabelon-mails. Alt et
// menneske selv skrev — bon-mail, CRM, indbakke-svar, leverandørmail — gik ud
// uden. Og de skabeloner der SELV bar en hilsen gav kunden to.
//
// Testen kører mod en KOPI af DB'en (DB_PATH), bruger mock-transport og rydder
// op efter sig. Den rører ingen rigtige mailservere.
//
//   node --experimental-sqlite tests/mail_signature.test.js
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const { getDb } = require('../db/database');
const mail = require('../services/mailService');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else { console.error('  ✗', msg); fail++; process.exitCode = 1; }
}

const SIG = 'Med venlig hilsen\nRistet Rug\nPrinsesse Charlottesgade 16\nTlf: +45 22 95 88 45';
const TAG = 'T_SIG_' + Date.now();

(async () => {
    const db = getDb();
    const created = { customerId: null, templateKeys: [] };
    const prev = {};

    function setSetting(key, val) {
        prev[key] = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
        db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, val);
    }

    try {
        mail._setMockTransport({ sendMail: async () => ({ messageId: `<${TAG}@test>` }) });
        setSetting('mail_signature', SIG);
        setSetting('smtp_enabled', '1');
        setSetting('smtp_kontakt_enabled', '1');
        setSetting('smtp_from', 'bon@ristetrug.dk');

        // ── 1. applySignature — ren funktion ────────────────────
        console.log('\n1. applySignature');

        const once = mail.applySignature('Hej Anne\n\nTak for ordren.');
        assert(once.endsWith(SIG), 'signaturen sættes på');
        assert(once.split('Prinsesse Charlottesgade').length === 2, 'kun én gang');
        assert(once.includes('\n\n--\n'), 'adskilt med mail-konventionens --');

        assert(mail.applySignature(once) === once,
            'en tekst der ALLEREDE har signaturen får den ikke igen (svar-på-svar)');

        assert(mail.applySignature('Hej\r\n\r\n--\r\n' + SIG.replace(/\n/g, '\r\n')).split('Ristet Rug').length === 2,
            'genkender signaturen selv når teksten bærer \\r\\n fra en textarea');

        const placed = mail.applySignature('Hej\n\n{{signatur}}\n\nPS: vi ses');
        assert(placed.includes(SIG) && placed.endsWith('PS: vi ses'),
            '{{signatur}} styrer placeringen — ikke nederst');
        assert(!placed.includes('{{signatur}}'), 'placeholderen efterlades ikke i teksten');
        assert(placed.split('Ristet Rug').length === 2, '{{signatur}} giver heller ikke dobbelt');

        assert(mail.applySignature('Hej', false) === 'Hej', 'fravalg respekteres');

        setSetting('mail_signature', '');
        assert(mail.applySignature('Hej') === 'Hej', 'tom signatur i settings = uændret mail');
        assert(mail.applySignature('Hej {{signatur}}').trim() === 'Hej',
            'tom signatur fjerner stadig placeholderen');
        setSetting('mail_signature', SIG);

        // ── 2. renderTemplate signerer IKKE længere ─────────────
        console.log('\n2. renderTemplate er en ren tekst-udfolder');
        const rendered = mail.renderTemplate('Hej {{navn}}', { navn: 'Anne' });
        assert(rendered === 'Hej Anne', 'ingen signatur fra renderTemplate');

        // ── 3. Fri-tekst-mail (det flow der før gik ud uden) ────
        console.log('\n3. Fri-tekst-mail får signatur');
        const cust = db.prepare(
            `INSERT INTO customers (first_name, last_name, email, created_at)
             VALUES (?, 'Testsen', ?, datetime('now'))`
        ).run(TAG, TAG.toLowerCase() + '@example.com');
        created.customerId = cust.lastInsertRowid;

        const sent = await mail.sendMail({
            to: TAG.toLowerCase() + '@example.com',
            subject: TAG + ' fri tekst',
            text: 'Hej Anne\n\nHer er tilbuddet.',
            customerId: created.customerId,
            context: { type: 'customer', number: created.customerId },
            smtpPrefix: 'smtp_kontakt',
        });
        const stored = db.prepare('SELECT body_text, subject FROM mail_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1')
            .get(sent.threadId);
        assert(stored.body_text.endsWith(SIG), 'sendMail signerer fri tekst');
        assert(!stored.subject.includes('Ristet Rug\nPrinsesse'), 'emnet signeres aldrig');
        assert(stored.body_text.split('Prinsesse Charlottesgade').length === 2,
            'historikken viser præcis det kunden fik — én signatur');

        // ── 4. Skabeloner ───────────────────────────────────────
        console.log('\n4. Skabelon-fravalg');
        for (const [key, appendSig] of [[TAG + '_paa', 1], [TAG + '_fra', 0]]) {
            db.prepare(`INSERT INTO mail_templates (key, label, subject, body_text, append_signature, updated_at)
                        VALUES (?, ?, ?, 'Besked til {{navn}}', ?, CURRENT_TIMESTAMP)`)
                .run(key, key, 'Emne ' + key, appendSig);
            created.templateKeys.push(key);
        }

        const withSig = await mail.sendFromTemplate({
            templateKey: TAG + '_paa', to: 'x@example.com', vars: { navn: 'Anne' },
            customerId: created.customerId, context: { type: 'customer', number: created.customerId },
        });
        const withoutSig = await mail.sendFromTemplate({
            templateKey: TAG + '_fra', to: 'x@example.com', vars: { navn: 'Anne' },
            customerId: created.customerId, context: { type: 'customer', number: created.customerId },
        });
        // Begge mails havner i kundens ÉNE aktive tråd, så der skal slås op på
        // emnet — ikke på "seneste besked i tråden".
        const bodyOf = (r) => db.prepare(
            `SELECT body_text FROM mail_messages
              WHERE thread_id = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1`
        ).get(r.threadId, '%' + r.subject.slice(-12) + '%').body_text;
        assert(bodyOf(withSig).endsWith(SIG), 'append_signature=1 → signatur');
        assert(!bodyOf(withoutSig).includes('Prinsesse Charlottesgade'),
            'append_signature=0 → ingen signatur (interne notifikationer)');

        // ── 5. Migration 144 ryddede de dobbelte hilsener ───────
        console.log('\n5. Skabeloner bærer ikke deres egen hilsen længere');
        const dbl = db.prepare(
            `SELECT key, body_text FROM mail_templates
              WHERE key IN ('booking_confirmation','order_email','web_order_confirmation')`
        ).all();
        for (const t of dbl) {
            assert(!/Med venlig hilsen[^\n]*(\n\{\{firmanavn\}\}|\nRistet Rug)?\s*$/.test(t.body_text),
                `${t.key} slutter ikke længere med sin egen hilsen`);
        }
        // menu_svar/menu_total_proce findes kun i drift — testes hvis de er der.
        const menus = db.prepare(
            `SELECT key, body_text FROM mail_templates WHERE key IN ('menu_svar','menu_total_proce')`
        ).all();
        for (const t of menus) {
            assert(!/DBH\s*\n\s*Team Ristet Rug\s*$/.test(t.body_text),
                `${t.key} slutter ikke længere med "DBH / Team Ristet Rug"`);
        }
        if (!menus.length) console.log('  – menu-skabeloner findes ikke i denne DB (kun drift)');

        const internals = db.prepare(
            `SELECT key, append_signature FROM mail_templates
              WHERE key IN ('web_order_owner_notification','booking_internal_notification')`
        ).all();
        for (const t of internals) {
            assert(t.append_signature === 0, `${t.key} har signaturen fravalgt`);
        }

    } finally {
        // Oprydning — testdata må ikke blive liggende
        const db2 = getDb();
        if (created.customerId) {
            const threads = db2.prepare('SELECT id FROM mail_threads WHERE customer_id = ?').all(created.customerId);
            for (const t of threads) {
                db2.prepare('DELETE FROM mail_messages WHERE thread_id = ?').run(t.id);
                db2.prepare('DELETE FROM mail_threads WHERE id = ?').run(t.id);
            }
            db2.prepare('DELETE FROM customers WHERE id = ?').run(created.customerId);
        }
        for (const k of created.templateKeys) {
            db2.prepare('DELETE FROM mail_templates WHERE key = ?').run(k);
        }
        for (const [k, v] of Object.entries(prev)) {
            if (v === null) db2.prepare('DELETE FROM settings WHERE key = ?').run(k);
            else db2.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
        }
        mail._clearMockTransport();
    }

    console.log(`\n${pass} PASS · ${fail} FAIL`);
})();
