// tests/inbox_handling.test.js
// ==========================================
// Samlet indbakke (CLAUDE_INDBAKKE.md) — service-niveau verifikation af den
// nye inbound-routing + handling_status-lifecycle i mailService.processInboundMail
// og sendMail. Bruger SYNTETISK kunde (T_INBOX_) + mock-transport. Rydder op i finally.
//
//   node --experimental-sqlite tests/inbox_handling.test.js
//   (DB_PATH kan pege på en kopi af dev-DB'en)
// ==========================================

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const { getDb } = require('../db/database');
const mail = require('../services/mailService');
const internal = require('../services/internalIdentity');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else { console.error('  ✗', msg); fail++; process.exitCode = 1; }
}

function parsedMail({ from, to, subject, text, messageId, inReplyTo = null }) {
    return {
        subject, text, messageId, inReplyTo,
        date: new Date(),
        from: { value: [{ address: from, name: 'Test Afsender' }] },
        to:   { value: [{ address: to }] },
        attachments: [],
    };
}

(async () => {
    const db = getDb();
    const TAG = 'T_INBOX_' + Date.now();
    const email = `${TAG.toLowerCase()}@example.com`.replace(/_/g, '');
    let customerId, threadId;

    // Mock SMTP så reply ikke rammer rigtige servere
    mail._setMockTransport({ sendMail: async () => ({ messageId: '<mock@test>' }) });
    // sendMail kræver smtp_enabled='1'
    const prevEnabled = db.prepare("SELECT value FROM settings WHERE key='smtp_enabled'").get()?.value;
    db.prepare("INSERT INTO settings (key,value) VALUES ('smtp_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('smtp_from','bon@ristetrug.dk') ON CONFLICT(key) DO UPDATE SET value='bon@ristetrug.dk'").run();

    try {
        // Synthetic kunde med email i contact_points (autoritativ kilde)
        customerId = db.prepare(
            `INSERT INTO customers (first_name, last_name, email) VALUES (?, 'Testesen', ?)`
        ).run(TAG, email).lastInsertRowid;
        db.prepare(
            `INSERT INTO contact_points (entity_type, entity_id, kind, value, is_primary, is_public, source)
             VALUES ('customer', ?, 'email', ?, 1, 0, 'manual')`
        ).run(customerId, email);

        // ── Test 1: findCustomerByEmail matcher contact_points ──
        console.log('\n[1] findCustomerByEmail');
        const found = mail.findCustomerByEmail(db, email.toUpperCase());
        assert(found && found.id === Number(customerId), 'kendt email → korrekt kunde (case-insensitivt)');

        // ── Test 2: inbound fra kendt kunde UDEN tag → ny tråd, aaben ──
        console.log('\n[2] kendt kunde uden tag → tråd');
        await mail.processInboundMail(parsedMail({
            from: email, to: 'bon@ristetrug.dk', subject: 'Frokost spørgsmål', text: 'Kan I levere?', messageId: '<in1@x>'
        }), 9001, 'bon@ristetrug.dk');
        const t = db.prepare(
            `SELECT * FROM mail_threads WHERE customer_id = ? ORDER BY id DESC LIMIT 1`
        ).get(customerId);
        threadId = t && t.id;
        assert(!!t, 'tråd oprettet for kendt kunde');
        assert(t && t.handling_status === 'aaben', 'handling_status = aaben');
        assert(t && t.has_unread === 1, 'has_unread = 1');
        assert(t && t.purchase_order_id == null && t.supplier_id == null, 'ikke PO/leverandør');

        // ── Test 3: afslut tråden, så inbound genåbner den ──
        console.log('\n[3] afsluttet tråd + nyt inbound → auto-genåbning');
        db.prepare(`UPDATE mail_threads SET handling_status='afsluttet', has_unread=0, snooze_until=datetime('now','+5 days') WHERE id=?`).run(threadId);
        await mail.processInboundMail(parsedMail({
            from: email, to: 'bon@ristetrug.dk', subject: 'Opfølgning', text: 'Et til spørgsmål', messageId: '<in2@x>'
        }), 9002, 'bon@ristetrug.dk');
        const t2 = db.prepare('SELECT * FROM mail_threads WHERE id=?').get(threadId);
        assert(t2.handling_status === 'aaben', 'genåbnet → aaben');
        assert(t2.snooze_until == null, 'snooze ryddet');
        assert(t2.has_unread === 1, 'has_unread = 1 igen');

        // ── Test 4: outbound (menneske-svar) → afventer_kunde ──
        console.log('\n[4] sendMail menneske-svar → afventer_kunde');
        await mail.sendMail({
            to: email, subject: 'Re: Opfølgning', text: 'Hej, ja det kan vi!',
            customerId, threadId, context: { type: 'customer', number: customerId }, userId: null,
        });
        const t3 = db.prepare('SELECT * FROM mail_threads WHERE id=?').get(threadId);
        assert(t3.handling_status === 'afventer_kunde', 'efter svar → afventer_kunde');
        const outMsg = db.prepare(`SELECT * FROM mail_messages WHERE thread_id=? AND direction='out' ORDER BY id DESC LIMIT 1`).get(threadId);
        assert(outMsg && outMsg.is_system === 0, 'menneske-svar: is_system = 0');
        assert(t3.last_outbound_at != null, 'last_outbound_at sat');

        // ── Test 5: is_system outbound → afsluttet ──
        console.log('\n[5] sendMail isSystem → afsluttet + is_system=1');
        await mail.sendMail({
            to: email, subject: 'Bekræftelse', text: 'Auto-bekræftelse', customerId, threadId, isSystem: true,
            context: { type: 'customer', number: customerId },
        });
        const t4 = db.prepare('SELECT * FROM mail_threads WHERE id=?').get(threadId);
        assert(t4.handling_status === 'afsluttet', 'auto-bekræftelse → afsluttet');
        const sysMsg = db.prepare(`SELECT * FROM mail_messages WHERE thread_id=? AND direction='out' ORDER BY id DESC LIMIT 1`).get(threadId);
        assert(sysMsg && sysMsg.is_system === 1, 'is_system = 1');

        // ── Test 6: ukendt afsender → IKKE tråd (forbliver mail_unmatched) ──
        console.log('\n[6] ukendt afsender → mail_unmatched (ikke tråd)');
        const unknownEmail = `ukendt${Date.now()}@nowhere-xyz.dk`;
        const umBefore = db.prepare(`SELECT COUNT(*) c FROM mail_unmatched WHERE from_email=?`).get(unknownEmail).c;
        await mail.processInboundMail(parsedMail({
            from: unknownEmail, to: 'kontakt@ristetrug.dk', subject: 'Hej', text: 'Ukendt', messageId: '<in3@x>'
        }), 9003, 'kontakt@ristetrug.dk');
        const umAfter = db.prepare(`SELECT COUNT(*) c FROM mail_unmatched WHERE from_email=?`).get(unknownEmail).c;
        const ghostThread = db.prepare(`SELECT COUNT(*) c FROM mail_threads WHERE subject='Hej' AND created_at > datetime('now','-1 minute')`).get().c;
        assert(umAfter === umBefore + 1, 'ukendt → mail_unmatched');
        assert(ghostThread === 0, 'ukendt → ingen tråd oprettet');

        // ── Test 7–10: intern videresendelse (migration 142) ──
        //
        // Regressionen der udløste det hele: huset står selv som kunde
        // (info@ristetrug.dk), så en videresendt kundemail matchede OS og
        // landede i en tråd på Ristet Rug — kunden inde i beskeden blev
        // aldrig set.
        console.log('\n[7] intern afsender uden videresendt afsender → ufordelt');
        const internalFrom = 'info@ristetrug.dk';
        assert(internal.isInternalEmail(db, internalFrom), 'eget domæne genkendes som internt');
        assert(!internal.isInternalEmail(db, email), 'kundens adresse er IKKE intern');

        const plainSubject = 'T_FWD_PLAIN_' + Date.now();
        await mail.processInboundMail(parsedMail({
            from: internalFrom, to: 'kontakt@ristetrug.dk', subject: plainSubject,
            text: 'Husk lige at ringe til dem.', messageId: '<int1@x>',
        }), 9101, 'kontakt@ristetrug.dk');
        const plainUm = db.prepare(`SELECT * FROM mail_unmatched WHERE subject=?`).get(plainSubject);
        const plainThread = db.prepare(`SELECT COUNT(*) c FROM mail_threads WHERE subject=?`).get(plainSubject).c;
        assert(!!plainUm, 'intern mail uden forward → mail_unmatched');
        assert(plainThread === 0, 'ingen tråd oprettet på os selv');

        console.log('\n[8] intern videresendelse af UKENDT afsender → ufordelt + parsed_*');
        const strangerEmail = `laerke${Date.now()}@cap-partner-test.eu`;
        const fwdSubject = 'T_FWD_NEW_' + Date.now();
        await mail.processInboundMail(parsedMail({
            from: internalFrom, to: 'kontakt@ristetrug.dk', subject: fwdSubject,
            messageId: '<int2@x>',
            text: [
                'Kan vi ikke løse den her?',
                '',
                '---------- Videresendt besked ----------',
                `Fra: Lærke Haumann Andersen <${strangerEmail}>`,
                'Emne: Catering d. 18-20 august',
                '',
                'Hej — jeg vil gerne have et tilbud.',
            ].join('\n'),
        }), 9102, 'kontakt@ristetrug.dk');
        const fwdUm = db.prepare(`SELECT * FROM mail_unmatched WHERE subject=?`).get(fwdSubject);
        assert(!!fwdUm, 'videresendt ukendt afsender → mail_unmatched');
        assert(fwdUm && fwdUm.parsed_email === strangerEmail, 'parsed_email = den reelle afsender');
        assert(fwdUm && /Lærke/.test(fwdUm.parsed_name || ''), 'parsed_name udfyldt');
        assert(fwdUm && fwdUm.parsed_company === 'Cap Partner Test', 'firma-gæt splitter på bindestreg');

        console.log('\n[9] intern videresendelse af KENDT kunde → kundens tråd');
        const knownFwdSubject = 'T_FWD_KNOWN_' + Date.now();
        // Tråden fra test 1–5 er 'afsluttet'; en videresendelse skal genåbne den
        // præcis som en direkte mail fra kunden ville.
        await mail.processInboundMail(parsedMail({
            from: internalFrom, to: 'kontakt@ristetrug.dk', subject: knownFwdSubject,
            messageId: '<int3@x>',
            text: [
                'Se lige nedenstående.',
                '',
                '---------- Videresendt besked ----------',
                `Fra: Test Kunde <${email}>`,
                '',
                'Kan I levere på fredag?',
            ].join('\n'),
        }), 9103, 'kontakt@ristetrug.dk');
        const knownUm = db.prepare(`SELECT COUNT(*) c FROM mail_unmatched WHERE subject=?`).get(knownFwdSubject).c;
        const t5 = db.prepare('SELECT * FROM mail_threads WHERE id=?').get(threadId);
        assert(knownUm === 0, 'kendt videresendt afsender → IKKE ufordelt');
        assert(t5.handling_status === 'aaben', 'kundens tråd genåbnet');
        const fwdMsg = db.prepare(
            `SELECT * FROM mail_messages WHERE thread_id=? AND direction='in' ORDER BY id DESC LIMIT 1`
        ).get(threadId);
        assert(fwdMsg && fwdMsg.subject === knownFwdSubject, 'beskeden bogført på kundens tråd');
        assert(fwdMsg && fwdMsg.from_email === internalFrom, 'afsenderfeltet bevarer hvem der videresendte');

        console.log('\n[10] svar på tråden går til kunden — ikke til os selv');
        // Seneste indgående besked er nu videresendelsen fra info@ristetrug.dk.
        // Uden filteret ville /threads/:id/reply sende svaret til os selv.
        const inboundRows = db.prepare(
            `SELECT from_email FROM mail_messages
              WHERE thread_id = ? AND direction = 'in' AND from_email IS NOT NULL
              ORDER BY id DESC LIMIT 20`
        ).all(threadId);
        const replyTo = (inboundRows.find(r => !internal.isInternalEmail(db, r.from_email)) || {}).from_email;
        assert(inboundRows[0].from_email === internalFrom, 'seneste indgående ER den interne videresendelse');
        assert(replyTo === email, 'modtager-valget springer den interne over → kunden');

    } finally {
        // Oprydning
        if (threadId) {
            db.prepare('DELETE FROM mail_messages WHERE thread_id=?').run(threadId);
            db.prepare('DELETE FROM mail_threads WHERE id=?').run(threadId);
        }
        if (customerId) {
            db.prepare(`DELETE FROM contact_points WHERE entity_type='customer' AND entity_id=?`).run(customerId);
            db.prepare('DELETE FROM customers WHERE id=?').run(customerId);
        }
        db.prepare(`DELETE FROM mail_unmatched WHERE subject='Hej' AND from_email LIKE 'ukendt%@nowhere-xyz.dk'`).run();
        // Videresendelses-testene (7–9) — både de ufordelte og et evt. lead
        // oprettet på den syntetiske cap-partner-test-adresse.
        db.prepare(`DELETE FROM mail_unmatched WHERE subject LIKE 'T_FWD_%'`).run();
        db.prepare(`DELETE FROM mail_threads WHERE subject LIKE 'T_FWD_%'`).run();
        if (prevEnabled === undefined) db.prepare("DELETE FROM settings WHERE key='smtp_enabled'").run();
        else db.prepare("UPDATE settings SET value=? WHERE key='smtp_enabled'").run(prevEnabled);
        mail._clearMockTransport();
        console.log(`\n${fail === 0 ? '✅' : '❌'} Indbakke-test: ${pass} pass, ${fail} fail`);
        console.log('🧹 Test-data ryddet op');
    }
})();
