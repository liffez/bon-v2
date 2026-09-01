const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, getUserId, transaction } = require('../db/helpers');
const { requireAuth, requireModule } = require('../shared/auth');
const { sendFromTemplate, sendMail, refetchUnmatchedMail, bonMailContext } = require('../services/mailService');
const { broadcast } = require('../shared/sse');
const { createPrivateLead } = require('../services/leadCreate');
const { isInternalEmail } = require('../services/internalIdentity');
const { logChange, sqlTime } = require('../db/helpers');
const { syncPrimaryCache, validateContactValue } = require('../shared/contactPoints');

// Er den videresendte afsender vores egen adresse?
//
// Sker oftere end man tror: en ordrebekræftelse fra bon@ bliver videresendt
// videre, og forward-blokken peger dermed tilbage på os selv. Så er der intet
// at vælge imellem, og indbakken skal ikke tilbyde "opret som lead" på vores
// egen postkasse. Frontenden kender ikke listen over interne domæner — derfor
// afgøres det her.
function markParsedInternal(db, row) {
    return row.parsed_email && isInternalEmail(db, row.parsed_email) ? 1 : 0;
}

// Kender vi allerede afsenderen? (#482)
//
// #478 sørger for at en kobling HUSKER adressen — men kun anden gang. Første
// gang en kendt kunde skriver fra en adresse vi ikke har på dem, står man med
// præcis det valg Anne stod med: koble manuelt eller arkivere. Systemet ved
// faktisk hvem det er; det sagde bare ingenting.
//
// Slår op på afsenderen, og på den VIDERESENDTE afsender når mailen kom via en
// kollega — dér er det kunden inde i beskeden der er interessant, ikke kollegaen.
// Vi foreslår aldrig en intern adresse: huset står selv som kunde (info@ = 3005),
// så uden det værn ville hver videresendelse foreslå Ristet Rug.
//
// `cache` deles inden for ét request — en arkiv-søgning kan give hundredvis af
// rækker fra de samme få afsendere.
function suggestCustomerFor(db, um, cache) {
    const tryOne = (email, via) => {
        if (!email || isInternalEmail(db, email)) return null;
        const key = email.toLowerCase();
        if (!cache.has(key)) cache.set(key, lookupCustomerByEmail(db, key) || null);
        const c = cache.get(key);
        if (!c) return null;
        return {
            id: c.customer_id,
            name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(),
            company_name: c.company_name || null,
            email,
            via,
        };
    };
    return tryOne(um.from_email, 'sender') || tryOne(um.parsed_email, 'forwarded') || null;
}

function broadcastUnmatchedCount(db) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM mail_unmatched WHERE status = 'open'`).get();
    broadcast('mail_unmatched', { count: row?.c || 0 });
}

// Bogfør en indgående besked på en kunde/bon-tråd — samme regel som
// mailService.processInboundMail's auto-genåbning (CLAUDE_INDBAKKE.md §3).
// SKAL kaldes når link-flowet flytter en ufordelt mail ind i en tråd: uden
// handling_status er tråden usynlig i HELE indbakken (alle chips + søgning
// filtrerer på `handling_status IS NOT NULL`) og /threads/:id/reply svarer 404.
//
//   markRead=false → mailen er stadig ulæst arbejde: 'aaben' + has_unread.
//   markRead=true  → mailen håndteres i samme kald (svar/opret-lead): sæt kun
//                    handling_status hvis den mangler, så et allerede sendt svar
//                    ikke bliver trukket tilbage til 'aaben'.
//
// PO-/leverandør-tråde røres aldrig (de har bevidst handling_status = NULL).
function markThreadInbound(db, threadId, receivedAt, { markRead = false } = {}) {
    const t = db.prepare(
        `SELECT bon_id, customer_id, purchase_order_id, supplier_id, handling_status
           FROM mail_threads WHERE id = ?`
    ).get(threadId);
    if (!t) return;
    if (t.purchase_order_id || t.supplier_id) return;

    const at = receivedAt || sqlTime();
    if (markRead) {
        db.prepare(`
            UPDATE mail_threads
               SET handling_status = COALESCE(handling_status, 'aaben'),
                   last_inbound_at = ?, status = 'active'
             WHERE id = ?`).run(at, threadId);
    } else {
        db.prepare(`
            UPDATE mail_threads
               SET handling_status = 'aaben', snooze_until = NULL, has_unread = 1,
                   last_inbound_at = ?, status = 'active'
             WHERE id = ?`).run(at, threadId);
    }

    const now = db.prepare(`SELECT handling_status, has_unread FROM mail_threads WHERE id = ?`).get(threadId);
    broadcast('mail_thread_updated', {
        thread_id: Number(threadId),
        handling_status: now?.handling_status || null,
        has_unread: now?.has_unread ? 1 : 0,
    });
}

// Resolér entitet + label for en tråd — bruges af den samlede indbakke så
// tråd-svar (kunde/bon/PO/leverandør) kan vises og linkes.
function threadEntity(db, t) {
    if (t.bon_id) {
        const b = db.prepare(`
            SELECT b.bon_number, b.total_units, b.pax,
                   c.first_name, c.last_name,
                   co.name AS company_name
            FROM bons b
            LEFT JOIN customers c  ON c.id  = b.customer_id
            LEFT JOIN companies co ON co.id = b.company_id
            WHERE b.id = ?`).get(t.bon_id);
        const cname = b ? [b.first_name, b.last_name].filter(Boolean).join(' ').trim() : '';
        return {
            type: 'bon', id: t.bon_id,
            label: b ? ('Bon ' + b.bon_number) : ('Bon #' + t.bon_id),
            email: null,
            customer_name: cname || null,
            company_name: b ? (b.company_name || null) : null,
            units: b ? (b.total_units || 0) : 0,
            pax: b ? (b.pax || 0) : 0,
        };
    }
    if (t.customer_id) {
        const c = db.prepare(`
            SELECT c.first_name, c.last_name, c.email, co.name AS company_name
            FROM customers c LEFT JOIN companies co ON co.id = c.company_id
            WHERE c.id = ?`).get(t.customer_id);
        const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ').trim() : '';
        return {
            type: 'customer', id: t.customer_id,
            label: name || ('Kunde #' + t.customer_id),
            email: c ? c.email : null,
            company_name: c ? (c.company_name || null) : null,
        };
    }
    if (t.purchase_order_id) {
        const po = db.prepare('SELECT po.id, s.name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?').get(t.purchase_order_id);
        return { type: 'purchase_order', id: t.purchase_order_id, label: po ? ('Indkøbsordre #' + po.id + (po.name ? ' · ' + po.name : '')) : ('PO #' + t.purchase_order_id), email: null };
    }
    if (t.supplier_id) {
        const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(t.supplier_id);
        return { type: 'supplier', id: t.supplier_id, label: s ? s.name : ('Leverandør #' + t.supplier_id), email: null };
    }
    return { type: 'none', id: null, label: 'Tråd uden entitet', email: null };
}

// GET /api/mail/templates — tilgængelig for alle auth'd brugere
router.get('/templates', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare('SELECT id, key, label, subject, body_text, append_signature, updated_at FROM mail_templates ORDER BY id').all();
    res.json(rows);
}));

router.get('/templates/:key', requireAuth(), handle((req, res) => {
    const tmpl = getDb().prepare('SELECT * FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });
    res.json(tmpl);
}));

// POST /api/mail/templates (admin) — opret ny skabelon
router.post('/templates', requireAuth('admin'), handle((req, res) => {
    const { key, label, subject, body_text } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'key og label er påkrævet' });

    // Validér key-format (kun a-z, _, -)
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
        return res.status(400).json({ error: 'key skal være lowercase bogstaver, tal, _ eller - (start med bogstav)' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(key);
    if (existing) return res.status(409).json({ error: 'Skabelon med denne nøgle findes allerede' });

    db.prepare(`
        INSERT INTO mail_templates (key, label, subject, body_text, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(key, label, subject || '', body_text || '');

    const created = db.prepare('SELECT * FROM mail_templates WHERE key = ?').get(key);
    res.status(201).json(created);
}));

// DELETE /api/mail/templates/:key (admin) — slet skabelon
router.delete('/templates/:key', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    // Beskyt system-skabeloner
    const SYSTEM_KEYS = ['booking_confirmation', 'web_order_confirmation', 'order_email'];
    if (SYSTEM_KEYS.includes(req.params.key)) {
        return res.status(400).json({ error: 'System-skabeloner kan ikke slettes' });
    }

    const tmpl = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });

    db.prepare('DELETE FROM mail_templates WHERE key = ?').run(req.params.key);
    res.json({ ok: true });
}));

// PATCH /api/mail/templates/:key (admin)
router.patch('/templates/:key', requireAuth('admin'), handle((req, res) => {
    const { label, subject, body_text, append_signature } = req.body;
    const db = getDb();
    const tmpl = db.prepare('SELECT id FROM mail_templates WHERE key = ?').get(req.params.key);
    if (!tmpl) return res.status(404).json({ error: 'Skabelon ikke fundet' });

    const updates = [];
    const params = [];
    if (label !== undefined)     { updates.push('label = ?');     params.push(label); }
    if (subject !== undefined)   { updates.push('subject = ?');   params.push(subject); }
    if (body_text !== undefined) { updates.push('body_text = ?'); params.push(body_text); }
    if (append_signature !== undefined) {
        updates.push('append_signature = ?');
        params.push(append_signature ? 1 : 0);
    }

    if (updates.length === 0) return res.json({ ok: true });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.key);
    db.prepare(`UPDATE mail_templates SET ${updates.join(', ')} WHERE key = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM mail_templates WHERE key = ?').get(req.params.key);
    res.json(updated);
}));

// Admin-only endpoints below
router.post('/test', requireAuth('admin'), handle(async (req, res) => {
    const { to, templateKey } = req.body;
    if (!to) return res.status(400).json({ error: 'to er påkrævet' });

    const key = templateKey || 'booking_confirmation';

    // Dækker alle variabler skabelonerne kan bruge (jf. TEMPLATE_VARS i
    // settings/index.html + _buildMailVars i bon_kort.js/bon_drawer.js).
    // renderTemplate lader ukendte {{variabler}} stå som literal tekst, så
    // test-mailen skal kende dem alle for at vise en realistisk forhåndsvisning.
    const dummyVars = {
        kundeNavn: 'Test Kunde',
        bonNummer: '9999',
        firmanavn: 'Ristet Rug',
        telefon: '22 95 88 45',
        pax: '25',
        ekstraInfo: 'Dette er en testmail.',

        leveringsDato: '2026-01-01',
        leveringsTidspunkt: '12:00',
        leveringsTid: '12:00',
        leveringsAdresse: 'Testvej 42, 2200 København N',
        postnummer: '2200',
        adresseBlok: 'Testvej 42\n2200 København N',
        ordreType: 'Levering',
        oenskerBlok: 'Ingen særlige ønsker',

        menuUdenPriser: '25× Grisen på Rug\n10× Falaflen\n8× Tunsalat',
        menuMedPriser: '25× Grisen på Rug  2.350,00 kr\n10× Falaflen  940,00 kr\n8× Tunsalat  752,00 kr',
        totalPris: '4.042,00 kr',
        totalExMoms: '3.233,60 kr',
        momsBeloeb: '808,40 kr',
        co2PerLinje: 'Grisen på Rug: 0,42 kg CO₂e × 25 = 10.50',
        co2Total: '12,50 kg CO₂e',
        co2Transport: '0,90 kg',
        co2MedTransport: '13,40 kg CO₂e',
        leveringsMetode: 'By-expressen',

        leverandoer: 'Hørkram',
        vareliste: '2× Rugbrød\n5× Smør\n3× Pålæg',
        dato: '2026-01-01',
        leveringsdato: '2026-01-03'
    };

    try {
        const info = await sendFromTemplate({ templateKey: key, to, vars: dummyVars });
        res.json({ ok: true, messageId: info.messageId });
    } catch (mailErr) {
        return res.status(400).json({ error: mailErr.message });
    }
}));

/* ── SAMLET INDBAKKE (mail_threads) ───────────────────────── */
// CLAUDE_INDBAKKE.md. Kunde/bon-tråde med handling_status (aaben/afventer_kunde/
// afsluttet) + snooze. PO/leverandør-tråde (handling_status IS NULL) lækker aldrig
// ind her. Identitet altid fra session. requireAuth() (ikke admin) så office + mobil
// CRM begge kan bruge indbakken — samme præcedens som PATCH /message/:id/read.

function _initials(name) {
    if (!name) return '?';
    const p = String(name).trim().split(/\s+/).filter(Boolean);
    const s = (p[0]?.[0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '');
    return s.toUpperCase() || '?';
}

// Byg list-rækken: afsender-visning, kilde (bon@/kontakt@), sendt-stempel, link, assignee.
function formatThreadRow(db, t) {
    const ent = threadEntity(db, t);
    const latest = db.prepare(
        `SELECT from_email, from_name, subject, mailbox, COALESCE(received_at, sent_at, created_at) AS at
         FROM mail_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1`
    ).get(t.id) || {};
    const lastOut = db.prepare(
        `SELECT u.name AS user_name FROM mail_messages mm LEFT JOIN users u ON u.id = mm.created_by_user_id
         WHERE mm.thread_id = ? AND mm.direction = 'out' ORDER BY mm.id DESC LIMIT 1`
    ).get(t.id);
    const mailbox = latest.mailbox || '';
    const src = mailbox.toLowerCase().includes('kontakt') ? 'kontakt' : 'bon';
    // "from" = den menneskelige modpart. For bon-tråde er ent.label "Bon B4096"
    // (vises som chip via link), så her foretrækkes kunde-/firmanavn.
    let from;
    if (ent.type === 'bon') from = ent.customer_name || ent.company_name || ent.label;
    else if (ent.type !== 'none') from = ent.label;
    else from = latest.from_name || latest.from_email || '(ukendt afsender)';
    let assignee = null;
    if (t.assigned_to) {
        const u = db.prepare('SELECT name FROM users WHERE id = ?').get(t.assigned_to);
        if (u) assignee = { id: t.assigned_to, name: u.name, initials: _initials(u.name) };
    }
    return {
        id: t.id,
        subject: t.subject || latest.subject || '(uden emne)',
        from,
        email: ent.email || latest.from_email || null,
        src,
        handling_status: t.handling_status,
        snoozed: !!t.snoozed,
        snooze_until: t.snooze_until || null,
        has_unread: !!t.has_unread,
        last_inbound_at: t.last_inbound_at || null,
        last_outbound_at: t.last_outbound_at || null,
        last_outbound_by: lastOut ? (lastOut.user_name || null) : null,
        time: t.last_inbound_at || t.last_outbound_at || latest.at || null,
        link: ent.type === 'none' ? null : {
            type: ent.type, id: ent.id, label: ent.label,
            customer_name: ent.customer_name || null,
            company_name: ent.company_name || null,
            units: ent.units || null,
            pax: ent.pax || null,
        },
        assignee
    };
}

const SNOOZED_SQL = "(mt.snooze_until IS NOT NULL AND mt.snooze_until > datetime('now'))";

// GET /api/mail/threads?status=&mailbox=&q=&limit=
router.get('/threads', requireAuth(), handle((req, res) => {
    const db = getDb();
    const status = req.query.status || 'aabne';
    const mailbox = req.query.mailbox;     // 'bon' | 'kontakt'
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);

    const where = ['mt.handling_status IS NOT NULL'];
    const args = [];

    if (q) {
        const like = '%' + q + '%';
        where.push(`(mt.subject LIKE ? OR EXISTS (SELECT 1 FROM mail_messages mm
                     WHERE mm.thread_id = mt.id AND (mm.body_text LIKE ? OR mm.from_email LIKE ? OR mm.from_name LIKE ?)))`);
        args.push(like, like, like, like);
    } else {
        if (status === 'aabne')         where.push(`mt.handling_status = 'aaben' AND NOT ${SNOOZED_SQL}`);
        else if (status === 'udsat')    where.push(SNOOZED_SQL);
        else if (status === 'kunde')    where.push(`mt.handling_status = 'afventer_kunde' AND NOT ${SNOOZED_SQL}`);
        else if (status === 'luk')      where.push(`mt.handling_status = 'afsluttet'`);
        else if (status === 'ikke_knyttet') where.push(`mt.bon_id IS NULL AND mt.customer_id IS NULL AND NOT ${SNOOZED_SQL}`);
        else if (status === 'mine')   { where.push(`mt.handling_status = 'aaben' AND mt.assigned_to = ? AND NOT ${SNOOZED_SQL}`); args.push(getUserId(req)); }
        // 'alle' → ingen ekstra
    }
    if (mailbox) {
        where.push(`EXISTS (SELECT 1 FROM mail_messages mm WHERE mm.thread_id = mt.id AND mm.mailbox LIKE ?)`);
        args.push('%' + mailbox + '%');
    }

    const rows = db.prepare(`
        SELECT mt.*, ${SNOOZED_SQL} AS snoozed
        FROM mail_threads mt
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(mt.last_inbound_at, mt.last_outbound_at, mt.updated_at) DESC
        LIMIT ?
    `).all(...args, limit);

    res.json(rows.map(t => formatThreadRow(db, t)));
}));

// GET /api/mail/threads/count?scope=open — badge-tal (åbne, ikke-snoozede)
router.get('/threads/count', requireAuth(), handle((req, res) => {
    const db = getDb();
    const row = db.prepare(
        `SELECT COUNT(*) AS c FROM mail_threads mt
         WHERE mt.handling_status = 'aaben' AND NOT ${SNOOZED_SQL}`
    ).get();
    res.json({ count: row?.c || 0 });
}));

// GET /api/mail/threads/counts — tal til alle filter-chips (inkl. ufordelt)
router.get('/threads/counts', requireAuth(), handle((req, res) => {
    const db = getDb();
    const row = db.prepare(`
        SELECT
          SUM(CASE WHEN handling_status = 'aaben'         AND NOT ${SNOOZED_SQL} THEN 1 ELSE 0 END) AS aabne,
          SUM(CASE WHEN ${SNOOZED_SQL}                                          THEN 1 ELSE 0 END) AS udsat,
          SUM(CASE WHEN handling_status = 'afventer_kunde' AND NOT ${SNOOZED_SQL} THEN 1 ELSE 0 END) AS kunde,
          SUM(CASE WHEN handling_status = 'afsluttet'                           THEN 1 ELSE 0 END) AS luk,
          COUNT(*)                                                                                  AS alle
        FROM mail_threads mt WHERE mt.handling_status IS NOT NULL
    `).get();
    const um = db.prepare(`SELECT COUNT(*) AS c FROM mail_unmatched WHERE status = 'open'`).get();
    // Kun menneske-arkiverede — se /mail/inbox for hvorfor spamfilteret holdes ude.
    const ark = db.prepare(
        `SELECT COUNT(*) AS c FROM mail_unmatched WHERE status = 'ignored' AND handled_by_user_id IS NOT NULL`
    ).get();
    res.json({
        aabne: row.aabne || 0, udsat: row.udsat || 0, kunde: row.kunde || 0,
        luk: row.luk || 0, alle: row.alle || 0, ufordelt: um.c || 0, arkiv: ark.c || 0,
    });
}));

// GET /api/mail/threads/:id — tråd + beskeder. Markerer inbound læst.
router.get('/threads/:id', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const t = db.prepare(`SELECT mt.*, ${SNOOZED_SQL} AS snoozed FROM mail_threads mt WHERE mt.id = ?`).get(id);
    if (!t || t.handling_status == null) return res.status(404).json({ error: 'Tråd ikke fundet' });

    const messages = db.prepare(`
        SELECT id, direction, is_system, from_email, from_name, to_email, subject,
               body_text, body_html, has_attachments, mailbox,
               COALESCE(received_at, sent_at, created_at) AS at, created_by_user_id,
               sent_at, send_error
        FROM mail_messages WHERE thread_id = ? ORDER BY COALESCE(received_at, sent_at, created_at), id
    `).all(id);
    const attStmt = db.prepare(
        `SELECT id, filename, mime_type, size_bytes, content_id, is_inline
         FROM mail_attachments WHERE message_id = ? ORDER BY id`
    );
    const userStmt = db.prepare('SELECT name FROM users WHERE id = ?');
    for (const m of messages) {
        m.attachments = m.has_attachments ? attStmt.all(m.id) : [];
        m.sent_by = m.created_by_user_id ? (userStmt.get(m.created_by_user_id)?.name || null) : null;
    }

    // Markér inbound læst (åbning = læst, men IKKE håndteret)
    const upd = db.prepare(`UPDATE mail_messages SET is_read = 1 WHERE thread_id = ? AND direction = 'in' AND is_read = 0`).run(id);
    if (upd.changes > 0 || t.has_unread) {
        db.prepare(`UPDATE mail_threads SET has_unread = 0 WHERE id = ?`).run(id);
        broadcast('mail_thread_updated', { thread_id: id, handling_status: t.handling_status, has_unread: 0 });
        broadcast('mail_read', { thread_id: id, bon_id: t.bon_id, customer_id: t.customer_id });
    }

    res.json({ thread: formatThreadRow(db, { ...t, has_unread: 0 }), messages });
}));

// Byg reply-context (tag) for en tråd
function threadReplyContext(db, t) {
    // bonMailContext skelner tilbud (#t-) fra bon (#b-) — et svar fra
    // indbakken på en tilbudstråd skal bære tilbuddets eget tag.
    if (t.bon_id) return bonMailContext(db, t.bon_id);
    if (t.customer_id) return { type: 'customer', number: t.customer_id };
    return null;
}

// POST /api/mail/threads/:id/reply { body, remind_days? }
router.post('/threads/:id/reply', requireAuth(), handle(async (req, res) => {
    const id = parseInt(req.params.id);
    const { body, remind_days } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body er påkrævet' });

    const db = getDb();
    const userId = getUserId(req);
    const t = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(id);
    if (!t || t.handling_status == null) return res.status(404).json({ error: 'Tråd ikke fundet' });

    // Modtager: seneste indgående afsender, ellers entitetens email.
    //
    // Interne afsendere springes over. En videresendt kundemail bogføres på
    // kunden med kollegaens adresse som afsender (mailService.resolveEffectiveSender)
    // — uden dette filter ville et svar gå til os selv i stedet for til kunden.
    const ent = threadEntity(db, t);
    const inbound = db.prepare(
        `SELECT from_email, mailbox FROM mail_messages
          WHERE thread_id = ? AND direction = 'in' AND from_email IS NOT NULL
          ORDER BY id DESC LIMIT 20`
    ).all(id);
    const latestExternal = inbound.find(m => !isInternalEmail(db, m.from_email));
    const to = (latestExternal && latestExternal.from_email) || ent.email;
    if (!to) return res.status(400).json({ error: 'Kan ikke finde en modtager-adresse for tråden' });

    const lastMailbox = db.prepare(`SELECT mailbox FROM mail_messages WHERE thread_id = ? AND mailbox IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
    const smtpPrefix = (lastMailbox && String(lastMailbox.mailbox).toLowerCase().includes('kontakt')) ? 'smtp_kontakt' : 'smtp';

    const result = await sendMail({
        to,
        subject: 'Re: ' + (t.subject || ''),
        text: body,
        context: threadReplyContext(db, t),
        bonId: t.bon_id || null,
        customerId: t.customer_id || null,
        threadId: id,            // svar går garanteret til DENNE tråd
        smtpPrefix,
        userId,
    });

    // sendMail har sat afventer_kunde for kunde/bon-tråde. Sæt snooze + (for NULL-tråde)
    // også handling_status eksplicit, så svar-flowet er ensartet uanset entitet.
    const remindDays = parseInt(remind_days);
    const setSnooze = Number.isInteger(remindDays) && remindDays > 0;
    db.prepare(`
        UPDATE mail_threads
           SET handling_status = 'afventer_kunde',
               snooze_until = ${setSnooze ? `datetime('now', '+' || ? || ' days')` : 'NULL'}
         WHERE id = ?
    `).run(...(setSnooze ? [remindDays, id] : [id]));

    broadcast('mail_thread_updated', { thread_id: id, handling_status: 'afventer_kunde', has_unread: 0 });
    res.json({ ok: true, thread_id: id, message_id: result.messageId, snoozed: setSnooze });
}));

// PATCH /api/mail/threads/:id { handling_status?, snooze_days?, snooze_until?, assigned_to? }
router.patch('/threads/:id', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const t = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(id);
    if (!t || t.handling_status == null) return res.status(404).json({ error: 'Tråd ikke fundet' });

    const { handling_status, snooze_days, snooze_until, assigned_to } = req.body || {};
    const sets = [];
    const args = [];

    if (handling_status !== undefined) {
        if (!['aaben', 'afventer_kunde', 'afsluttet'].includes(handling_status)) {
            return res.status(400).json({ error: 'Ugyldig handling_status' });
        }
        sets.push('handling_status = ?'); args.push(handling_status);
        // Afslut rydder snooze; genåbning rydder også snooze
        if (handling_status === 'afsluttet' || handling_status === 'aaben') {
            sets.push('snooze_until = NULL');
        }
    }
    if (snooze_days !== undefined) {
        const d = parseInt(snooze_days);
        if (!Number.isInteger(d) || d <= 0) return res.status(400).json({ error: 'snooze_days skal være > 0' });
        sets.push(`snooze_until = datetime('now', '+' || ? || ' days')`); args.push(d);
    } else if (snooze_until !== undefined) {
        sets.push('snooze_until = ?'); args.push(snooze_until || null);
    }
    if (assigned_to !== undefined) { sets.push('assigned_to = ?'); args.push(assigned_to || null); }

    if (!sets.length) return res.json({ ok: true });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE mail_threads SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const updated = db.prepare(`SELECT mt.*, ${SNOOZED_SQL} AS snoozed FROM mail_threads mt WHERE mt.id = ?`).get(id);
    broadcast('mail_thread_updated', { thread_id: id, handling_status: updated.handling_status, has_unread: !!updated.has_unread });
    res.json({ ok: true, thread: formatThreadRow(db, updated) });
}));

// POST /api/mail/threads/:id/move   { customer_id } | { bon_id }
//
// Retteventilen. requireAuth() og ikke admin: den der opdager at en mail sidder
// forkert, skal kunne rette det med det samme — ikke vente på nogen.
router.post('/threads/:id/move', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const t = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(id);
    if (!t || t.handling_status == null) return res.status(404).json({ error: 'Tråd ikke fundet' });

    // Leverandør- og indkøbsordre-tråde har deres egen tilknytning og hører
    // ikke til en kunde. De flyttes ikke herfra.
    if (t.purchase_order_id || t.supplier_id) {
        return res.status(400).json({ error: 'Leverandør- og ordretråde kan ikke flyttes til en kunde' });
    }

    const { customer_id, bon_id } = req.body || {};
    // moveThreadOwner validerer FØR den skriver, så en afvisning efterlader
    // transaktionen tom — der er intet at rulle tilbage.
    let result;
    transaction(db, () => {
        result = moveThreadOwner(db, t, {
            customerId: customer_id != null ? parseInt(customer_id) : null,
            bonId:      bon_id      != null ? parseInt(bon_id)      : null,
        }, getUserId(req));
    });
    if (result.error) return res.status(400).json({ error: result.error });

    broadcast('mail_thread_updated', { thread_id: id, handling_status: t.handling_status, has_unread: !!t.has_unread });
    const updated = db.prepare(`SELECT mt.*, ${SNOOZED_SQL} AS snoozed FROM mail_threads mt WHERE mt.id = ?`).get(id);
    res.json({ ...result, thread: formatThreadRow(db, updated) });
}));

// POST /api/mail/threads/:id/create-bon — prefill til bon-draweren (+ valgfri knytning)
router.post('/threads/:id/create-bon', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const t = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(id);
    if (!t || t.handling_status == null) return res.status(404).json({ error: 'Tråd ikke fundet' });

    // Valgfri knytning: når draweren har gemt bonen sender den bon_id retur
    if (req.body && req.body.bon_id) {
        const bonId = parseInt(req.body.bon_id);
        const bon = db.prepare('SELECT id FROM bons WHERE id = ?').get(bonId);
        if (bon) {
            db.prepare(`UPDATE mail_threads SET bon_id = ?, updated_at = datetime('now') WHERE id = ?`).run(bonId, id);
            broadcast('mail_thread_updated', { thread_id: id, handling_status: t.handling_status, has_unread: !!t.has_unread });
            return res.json({ ok: true, linked: true, bon_id: bonId });
        }
    }

    // Prefill: kendt kunde (+ firma) ellers seneste indgående afsender
    let prefill = { customer_id: null, company_id: null, name: null, email: null };
    if (t.customer_id) {
        const c = db.prepare(`
            SELECT c.id, c.first_name, c.last_name, c.email, c.company_id, co.name AS company_name
            FROM customers c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?
        `).get(t.customer_id);
        if (c) prefill = {
            customer_id: c.id, company_id: c.company_id || null,
            name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(), email: c.email || null,
            company_name: c.company_name || null,
        };
    } else {
        const latestIn = db.prepare(
            `SELECT from_email, from_name FROM mail_messages WHERE thread_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`
        ).get(id);
        if (latestIn) {
            const c = latestIn.from_email ? lookupCustomerByEmail(db, latestIn.from_email) : null;
            if (c) prefill = { customer_id: c.customer_id, company_id: null, name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim(), email: c.email };
            else prefill = { customer_id: null, company_id: null, name: latestIn.from_name || null, email: latestIn.from_email || null };
        }
    }
    res.json({ ok: true, prefill });
}));

/* ── UFORDELT INDBAKKE ────────────────────────────────────── */

// ─── BOUNCE-DETECTION HELPERS ─────────────────────────────
// Bounce-mails fra postmaster/Mailer-Daemon/antispam er kritiske: hver
// indikerer en kunde med forkert email. Vi parser den fejlede modtager
// ud af body og slår op om vi har en kunde med den email — så office
// kan kontakte kunden hurtigt for at få den korrekte adresse.

const BOUNCE_FROM_RE = /^(postmaster@|Mailer-Daemon@|MAILER-DAEMON@|.*antispam@|.*@robot\.simply\.com)/i;

function isBounceMail(fromEmail) {
    return !!fromEmail && BOUNCE_FROM_RE.test(fromEmail);
}

// Find den fejlede modtager-adresse i bounce-body. Prøver flere formater
// i prioritetsrækkefølge (DSN > Postfix > "to <email>" > sidste fallback).
function parseBouncedRecipient(bodyText) {
    if (!bodyText) return null;

    // 1. DSN-format (RFC 3464): "Final-Recipient: rfc822; user@example.com"
    let m = bodyText.match(/Final-Recipient:\s*rfc822;?\s*([^\s<>]+@[^\s<>]+)/i);
    if (m) return m[1].trim().toLowerCase();

    // 2. Original-Recipient: rfc822;...
    m = bodyText.match(/Original-Recipient:\s*rfc822;?\s*([^\s<>]+@[^\s<>]+)/i);
    if (m) return m[1].trim().toLowerCase();

    // 3. Postfix-format: "<user@example.com>: host..." (i starten af linje)
    m = bodyText.match(/\n\s*<([^\s<>]+@[^\s<>]+)>\s*:/i);
    if (m) return m[1].trim().toLowerCase();

    // 4. "could not be delivered to user@example.com"
    m = bodyText.match(/could not be delivered to[:\s]*<?([^\s<>,]+@[^\s<>,]+)>?/i);
    if (m) return m[1].trim().toLowerCase().replace(/[.,;]$/, '');

    // 5. "kunne ikke leveres til user@example.com" (dansk)
    m = bodyText.match(/kunne ikke leveres til[:\s]*<?([^\s<>,]+@[^\s<>,]+)>?/i);
    if (m) return m[1].trim().toLowerCase().replace(/[.,;]$/, '');

    // 6. Fallback: første <email> i body der IKKE er vores egen domæne
    const allEmails = bodyText.match(/<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/gi) || [];
    for (const e of allEmails) {
        const clean = e.replace(/[<>]/g, '').toLowerCase();
        if (!clean.includes('ristetrug.dk') && !clean.includes('simply.com') &&
            !clean.includes('hubspot.com') && !clean.includes('mailer-daemon')) {
            return clean;
        }
    }

    return null;
}

// Slå kunde op via email — bruger både customers.email (cache) og
// contact_points (autoritativ kilde).
function lookupCustomerByEmail(db, email) {
    if (!email) return null;
    // Først contact_points (mere komplet)
    const cp = db.prepare(`
        SELECT cp.entity_id AS customer_id, c.first_name, c.last_name, c.phone, c.email,
               co.name AS company_name
        FROM contact_points cp
        JOIN customers c ON c.id = cp.entity_id
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE cp.entity_type = 'customer'
          AND cp.kind = 'email'
          AND LOWER(cp.value) = ?
          AND cp.is_active = 1 AND c.is_active = 1
        LIMIT 1
    `).get(email.toLowerCase());
    if (cp) return cp;

    // Fallback til legacy customers.email
    const c = db.prepare(`
        SELECT c.id AS customer_id, c.first_name, c.last_name, c.phone, c.email,
               co.name AS company_name
        FROM customers c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE LOWER(c.email) = ? AND c.is_active = 1
        LIMIT 1
    `).get(email.toLowerCase());
    return c || null;
}

router.get('/unmatched', requireModule('crm'), handle(async (req, res) => {
    const status = req.query.status || 'open';
    const db = getDb();
    const where = ['status = ?'];
    const args = [status];

    if (req.query.from_date) {
        where.push('COALESCE(received_at, created_at) >= ?');
        args.push(req.query.from_date);
    }
    if (req.query.mailbox) {
        where.push('mailbox LIKE ?');
        args.push('%' + req.query.mailbox + '%');
    }

    const items = db.prepare(`
        SELECT * FROM mail_unmatched WHERE ${where.join(' AND ')} ORDER BY COALESCE(received_at, created_at) DESC
    `).all(...args);

    // Vedhæftninger (inkl. inline CID-billeder) til mail-visningen
    const attStmt = db.prepare(
        `SELECT id, filename, mime_type, size_bytes, content_id, is_inline
         FROM mail_attachments WHERE unmatched_id = ? ORDER BY id`
    );

    // Enrich bounces med fejlet modtager + kunde-lookup
    const sugCache = new Map();
    for (const item of items) {
        item.attachments = attStmt.all(item.id);
        item.has_attachments = item.attachments.length > 0 ? 1 : 0;
        item.parsed_is_internal = markParsedInternal(db, item);
        item.suggested_customer = suggestCustomerFor(db, item, sugCache);
        if (isBounceMail(item.from_email)) {
            item.is_bounce = true;
            const recipient = parseBouncedRecipient(item.body_text);
            if (recipient) {
                item.bounce_recipient = recipient;
                const customer = lookupCustomerByEmail(db, recipient);
                if (customer) {
                    item.bounce_customer_id = customer.customer_id;
                    item.bounce_customer_name = [customer.first_name, customer.last_name]
                        .filter(Boolean).join(' ').trim();
                    item.bounce_customer_phone = customer.phone || null;
                    item.bounce_customer_company = customer.company_name || null;
                }
            }
        }
    }

    res.json(items);
}));

// GET /api/mail/inbox — SAMLET indbakke: ufordelte mails (status='open') +
// ALLE ulæste indgående tråd-svar (kunde/bon/PO/leverandør). Sikrer at intet
// indgående mail kan "forsvinde" ind i en entitets-visning uden også at være
// synligt ét centralt sted. Hvert item har `kind` ('unmatched'|'thread') og en
// unik `key` (kollision mellem mail_unmatched.id og mail_messages.id undgås).
router.get('/inbox', requireModule('crm'), handle((req, res) => {
    const db = getDb();
    const mailbox = req.query.mailbox;      // 'bon' | 'kontakt' | undefined
    const fromDate = req.query.from_date;
    const q = (req.query.q || '').trim();
    const items = [];

    // ── 1. Ufordelte / arkiverede ──
    //
    // `status` (open | archived | all) styrer hvad listen viser. Arkivet er med
    // vilje IKKE alt med status='ignored': af 1.434 arkiverede er de 1.422
    // spamfiltreret automatisk (migration 066 + shouldAutoIgnore), og de ville
    // drukne de 12 en kollega selv har lagt væk. Listen viser derfor kun det et
    // menneske har arkiveret — men SØGNINGEN går gennem alt, så en mail der er
    // frafiltreret ved en fejl stadig kan findes (#479).
    // Kolonner prefixes med um. — joinet til users deler bl.a. created_at.
    const HUMAN_ARCHIVED = "um.status = 'ignored' AND um.handled_by_user_id IS NOT NULL";
    const isArchive = req.query.status === 'archived';
    const umStatus = isArchive              ? HUMAN_ARCHIVED
                   : req.query.status === 'all' ? '1=1'
                   : "um.status = 'open'";
    // Søger man i arkivet, åbnes der for ALT arkiveret — også det spamfilteret tog.
    const umWhere = [q && isArchive ? "um.status = 'ignored'" : umStatus];
    const umArgs = [];
    if (q) {
        const like = '%' + q + '%';
        umWhere.push('(um.subject LIKE ? OR um.from_email LIKE ? OR um.from_name LIKE ? OR um.body_text LIKE ?)');
        umArgs.push(like, like, like, like);
    }
    if (fromDate) { umWhere.push('COALESCE(um.received_at, um.created_at) >= ?'); umArgs.push(fromDate); }
    if (mailbox)  { umWhere.push('um.mailbox LIKE ?'); umArgs.push('%' + mailbox + '%'); }
    // Hvem lagde den væk? Findes allerede i handled_by_user_id, men blev aldrig
    // vist nogen steder — så var det umuligt at spørge hinanden hvad der skete.
    const unmatched = db.prepare(
        `SELECT um.*, u.name AS handled_by_name
           FROM mail_unmatched um
           LEFT JOIN users u ON u.id = um.handled_by_user_id
          WHERE ${umWhere.join(' AND ')}`
    ).all(...umArgs);
    const attUm = db.prepare(
        `SELECT id, filename, mime_type, size_bytes, content_id, is_inline
         FROM mail_attachments WHERE unmatched_id = ? ORDER BY id`
    );
    const sugCache = new Map();
    for (const m of unmatched) {
        m.attachments = attUm.all(m.id);
        m.has_attachments = m.attachments.length ? 1 : 0;
        m.parsed_is_internal = markParsedInternal(db, m);
        m.suggested_customer = suggestCustomerFor(db, m, sugCache);
        if (isBounceMail(m.from_email)) {
            m.is_bounce = true;
            const recipient = parseBouncedRecipient(m.body_text);
            if (recipient) {
                m.bounce_recipient = recipient;
                const customer = lookupCustomerByEmail(db, recipient);
                if (customer) {
                    m.bounce_customer_id = customer.customer_id;
                    m.bounce_customer_name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
                    m.bounce_customer_phone = customer.phone || null;
                    m.bounce_customer_company = customer.company_name || null;
                }
            }
        }
        // Frontenden skal kunne skelne "jeg lagde den væk" fra "filteret tog den" —
        // ellers ligner et fejlfiltreret spamfund en bevidst beslutning.
        m.archived_by_human = m.status === 'ignored' && m.handled_by_user_id != null ? 1 : 0;
        m.auto_filtered = m.status === 'ignored' && m.handled_by_user_id == null ? 1 : 0;
        items.push({ kind: 'unmatched', key: 'u' + m.id, sort_at: m.received_at || m.created_at, ...m });
    }

    // ── 2. Ulæste tråd-svar (indgående, ulæst, aktiv tråd) ──
    //
    // Springes over når kalderen kigger i arkivet: dér er spørgsmålet "hvor blev
    // den mail af", og ulæste tråd-svar er en anden slags arbejde.
    if (isArchive) {
        items.sort((a, b) => String(b.sort_at || '').localeCompare(String(a.sort_at || '')));
        return res.json(items);
    }
    const tWhere = ["mm.direction = 'in'", 'mm.is_read = 0', "mt.status = 'active'"];
    const tArgs = [];
    if (fromDate) { tWhere.push('COALESCE(mm.received_at, mm.created_at) >= ?'); tArgs.push(fromDate); }
    if (mailbox)  { tWhere.push('mm.mailbox LIKE ?'); tArgs.push('%' + mailbox + '%'); }
    const threadMsgs = db.prepare(`
        SELECT mm.id AS message_id, mm.thread_id, mm.from_email, mm.from_name, mm.subject,
               mm.body_text, mm.body_html, mm.received_at, mm.created_at, mm.mailbox,
               mt.bon_id, mt.customer_id, mt.purchase_order_id, mt.supplier_id
        FROM mail_messages mm
        JOIN mail_threads mt ON mt.id = mm.thread_id
        WHERE ${tWhere.join(' AND ')}
    `).all(...tArgs);
    const attMsg = db.prepare(
        `SELECT id, filename, mime_type, size_bytes, content_id, is_inline
         FROM mail_attachments WHERE message_id = ? ORDER BY id`
    );
    for (const m of threadMsgs) {
        const ent = threadEntity(db, m);
        m.attachments = attMsg.all(m.message_id);
        m.has_attachments = m.attachments.length ? 1 : 0;
        items.push({
            kind: 'thread', key: 'm' + m.message_id, sort_at: m.received_at || m.created_at,
            entity_type: ent.type, entity_id: ent.id, entity_label: ent.label, entity_email: ent.email,
            ...m
        });
    }

    // Nyeste først (string-sammenligning på ISO-timestamps er kronologisk korrekt)
    items.sort((a, b) => String(b.sort_at || '').localeCompare(String(a.sort_at || '')));
    res.json(items);
}));

// PATCH /api/mail/message/:id/read — markér ét indgående tråd-svar som læst.
// Generisk (virker for kunde/bon/PO/leverandør) så den samlede indbakke kan
// rydde et item uden at kende entitets-typen. Broadcaster mail_read så badges
// + de dedikerede visninger opdaterer.
// requireAuth() (ikke admin): den delte indbakke vises også i mobilens "Nyt"-tab,
// så alle roller skal kunne markere en indgående mail læst. Selve link-flowet
// (opret tråd/kunde) forbliver admin via PATCH /unmatched/:id.
router.patch('/message/:id/read', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ugyldigt id' });
    const db = getDb();
    const msg = db.prepare(`
        SELECT mm.id, mm.thread_id, mt.bon_id, mt.customer_id, mt.purchase_order_id, mt.supplier_id
        FROM mail_messages mm JOIN mail_threads mt ON mt.id = mm.thread_id
        WHERE mm.id = ?
    `).get(id);
    if (!msg) return res.status(404).json({ error: 'Besked ikke fundet' });

    db.prepare(`UPDATE mail_messages SET is_read = 1 WHERE id = ? AND direction = 'in'`).run(id);

    broadcast('mail_read', {
        message_id: id, thread_id: msg.thread_id,
        bon_id: msg.bon_id, customer_id: msg.customer_id,
        purchase_order_id: msg.purchase_order_id, supplier_id: msg.supplier_id
    });
    res.json({ ok: true });
}));

router.patch('/unmatched/:id', requireModule('crm'), handle(async (req, res) => {
    const id = parseInt(req.params.id);
    const { status, linked_customer_id, linked_bon_id } = req.body;
    const db = getDb();
    const userId = getUserId(req);

    if (status === 'linked') {
        // Create thread + message from unmatched
        const um = db.prepare('SELECT * FROM mail_unmatched WHERE id = ?').get(id);
        if (!um) return res.status(404).json({ error: 'Ikke fundet' });

        const threadId = db.prepare(`
            INSERT INTO mail_threads (subject, bon_id, customer_id, handling_status)
            VALUES (?, ?, ?, 'aaben')
        `).run(um.subject || '', linked_bon_id || null, linked_customer_id || null).lastInsertRowid;

        // Indsættes ulæst → tråden er nyt, uhåndteret arbejde i indbakken.
        insertMessageFromUnmatched(db, um, Number(threadId), { isRead: 0 });

        db.prepare(`
            UPDATE mail_unmatched SET status = 'linked', linked_customer_id = ?, linked_bon_id = ?, handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(linked_customer_id || null, linked_bon_id || null, userId, id);

        // Beskeden er indsat ulæst → tråden er nyt, uhåndteret arbejde i indbakken.
        markThreadInbound(db, Number(threadId), um.received_at);

        // Husk hvem adressen tilhører (#478). "Link til Bon" tæller også: bonen
        // kender sin kunde, og det er kunden mailen reelt handler om.
        let learnFor = linked_customer_id || null;
        if (!learnFor && linked_bon_id) {
            learnFor = db.prepare('SELECT customer_id FROM bons WHERE id = ?')
                .get(linked_bon_id)?.customer_id || null;
        }
        const learned = learnFor
            ? learnFromUnmatched(db, um, learnFor, userId,
                linked_customer_id ? 'kobling fra indbakken' : 'kobling til bon fra indbakken')
            : { learned: false, reason: 'ingen_kunde' };

        broadcastUnmatchedCount(db);
        res.json({ ok: true, thread_id: Number(threadId), learned_email: learned.learned ? learned.email : null });
    } else if (status === 'ignored') {
        db.prepare(`
            UPDATE mail_unmatched SET status = 'ignored', handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(userId, id);
        broadcastUnmatchedCount(db);
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'status skal være linked eller ignored' });
    }
}));

// POST /api/mail/unmatched/:id/dismiss — markér ufordelt mail som håndteret
// (status='ignored'). Adskilt fra den admin-only PATCH /unmatched/:id så
// mobilens "Nyt"-tab kan rydde ufordelt kontakt@-post uden at åbne det fulde
// link-flow (opret tråd/kunde) for ikke-admin-roller. For ufordelt post er
// "markér læst" = "håndteret", da tabellen ingen is_read-kolonne har.
router.post('/unmatched/:id/dismiss', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ugyldigt id' });
    const db = getDb();
    const userId = getUserId(req);
    const um = db.prepare(`SELECT id FROM mail_unmatched WHERE id = ? AND status = 'open'`).get(id);
    if (!um) return res.status(404).json({ error: 'Ikke fundet eller allerede håndteret' });
    db.prepare(`
        UPDATE mail_unmatched SET status = 'ignored', handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(userId, id);
    broadcastUnmatchedCount(db);
    res.json({ ok: true });
}));

// POST /api/mail/unmatched/:id/restore — fortryd en arkivering (#479).
//
// Uden den var arkivering en envejsdør: mail 1458 (en bestilling på 43 kuverter
// med 8 madhensyn) blev arkiveret ved et fejlklik og kunne kun hentes tilbage
// med SQL. Enhver mailklient kan fortryde; det skal denne også.
//
// requireAuth() og ikke admin — den der arkiverede skal kunne rette op med det
// samme, ikke vente på nogen. Auto-filtreret spam kan også gendannes: filteret
// tager fejl indimellem, og det er billigere at få en spam-mail tilbage i
// indbakken end at miste en kundemail.
router.post('/unmatched/:id/restore', requireAuth(), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const um = db.prepare(`SELECT id, status, subject FROM mail_unmatched WHERE id = ?`).get(id);
    if (!um) return res.status(404).json({ error: 'Mail ikke fundet' });
    if (um.status === 'linked') {
        return res.status(400).json({ error: 'Mailen er koblet til en kunde eller bon og ligger allerede i en tråd' });
    }
    if (um.status === 'open') return res.json({ ok: true, already: true });

    db.prepare(
        `UPDATE mail_unmatched SET status = 'open', handled_by_user_id = NULL, handled_at = NULL WHERE id = ?`
    ).run(id);
    broadcastUnmatchedCount(db);
    res.json({ ok: true });
}));

// POST /api/mail/unmatched/:id/refetch — hent mailen igen fra serveren for at
// få body_html + inline-billeder (mails gemt før migration 099 mangler dem).
router.post('/unmatched/:id/refetch', requireModule('crm'), handle(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ugyldigt id' });
    try {
        const result = await refetchUnmatchedMail(id);
        res.json(result);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
}));

// POST /api/mail/unmatched/bulk — bulk-ignorering af flere mails ad gangen
router.post('/unmatched/bulk', requireModule('crm'), handle(async (req, res) => {
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'ids skal være et ikke-tomt array' });
    }
    if (action !== 'ignored') {
        return res.status(400).json({ error: 'action skal være "ignored" (kun bulk-ignore understøttes)' });
    }

    const cleanIds = ids.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n > 0);
    if (!cleanIds.length) return res.status(400).json({ error: 'ingen gyldige ids' });

    const db = getDb();
    const userId = getUserId(req);
    const placeholders = cleanIds.map(() => '?').join(',');
    const result = db.prepare(`
        UPDATE mail_unmatched
        SET status = 'ignored', handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders}) AND status = 'open'
    `).run(userId, ...cleanIds);

    broadcastUnmatchedCount(db);
    res.json({ ok: true, updated: result.changes });
}));

// ─── Opret lead / svar fra indbakken ────────────────────────

// Del et fri-tekst afsendernavn op i fornavn/efternavn. Tom → createPrivateLead
// falder tilbage til email-prefikset.
function splitName(fromName) {
    const n = (fromName || '').trim();
    if (!n) return { firstName: '', lastName: '' };
    const parts = n.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

// Knyt en ufordelt mail til en kundes aktive tråd — opretter tråden hvis den ikke
// findes (samme find-or-create-logik som mailService.sendMail bruger på customer_id),
// indsætter den oprindelige mail som indgående besked og markerer den linket.
// Idempotent: en allerede-linket mail genindsættes ikke.
// Flyt en ufordelt mail ind i en tråd som rigtig besked.
//
// ÉN vej for alle link-flows (Link til Kunde/Bon, Opret lead, Svar). Var
// tidligere duplikeret, og kopierne drev fra hinanden: create-lead/reply-vejen
// tabte både body_html og vedhæftningerne, så en ansøgning med PDF endte som
// ren tekst uden fil på kunden. Ændr her — ikke i kaldstederne.
function insertMessageFromUnmatched(db, um, threadId, { isRead = 0 } = {}) {
    const newMsgId = db.prepare(`
        INSERT INTO mail_messages (thread_id, message_id, direction, from_email, from_name, to_email, subject, body_text, body_html, is_read, imap_uid, mailbox, received_at)
        VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(threadId, um.message_id, um.from_email, um.from_name, um.to_email || um.mailbox,
           um.subject, um.body_text, um.body_html, isRead ? 1 : 0,
           um.imap_uid, um.mailbox, um.received_at).lastInsertRowid;

    // Vedhæftninger (inkl. inline CID-billeder) følger med over på beskeden,
    // så de fortsat kan ses — og så body_html'ens cid:-referencer stadig peger
    // på en fil vi kan servere.
    const moved = db.prepare(
        `UPDATE mail_attachments SET message_id = ?, unmatched_id = NULL WHERE unmatched_id = ?`
    ).run(Number(newMsgId), um.id);
    if (moved.changes > 0) {
        db.prepare(`UPDATE mail_messages SET has_attachments = 1 WHERE id = ?`).run(Number(newMsgId));
    }

    return Number(newMsgId);
}

// Lær afsenderens adresse på kunden.
//
// En kobling er den eneste gang et menneske fortæller systemet at DENNE adresse
// hører til DENNE kunde. Indtil #478 blev den viden kastet væk: kunde 4520 blev
// oprettet uden email, en videresendt mail blev koblet til hende — og hendes to
// egne svar dagen efter (det ene med hele bestillingen) faldt ud i den ufordelte
// indbakke igen, fordi afsender-opslaget i mailService trin 3a intet havde at
// slå op på.
//
// Konservativt med vilje. Vi TILFØJER en adresse, vi flytter aldrig en nogen
// har valgt: har kunden allerede en primær email, bliver den nye ikke-primær.
// Fem tilfælde hvor vi holder os helt væk — hver med sin grund:
//
//   ugyldig       vi gemmer ikke noget vi ikke kan sende til
//   intern        vores egne adresser må aldrig blive en kundes kontaktpunkt
//                 (det var netop dét der sendte kundemail ind på Ristet Rug selv)
//   findes        allerede lært; intet at gøre
//   deaktiveret   nogen har fjernet den bevidst — det skal respekteres
//   optaget       adressen står på en ANDEN kunde; to ejere gør routingen
//                 tvetydig (findCustomerByEmail tager LIMIT 1), så hellere lade
//                 mailen være ufordelt end at rute den forkert i stilhed
//
// Returnerer { learned, reason } — kalderen kan sige det videre, men skal aldrig
// vælte koblingen af den grund. At lære adressen er en gevinst, ikke en betingelse.
function learnSenderEmail(db, customerId, rawEmail, userId, sourceLabel, { reactivate = false } = {}) {
    if (!customerId || !rawEmail) return { learned: false, reason: 'ingen_data' };

    const v = validateContactValue('email', rawEmail);
    if (!v.ok) return { learned: false, reason: 'ugyldig' };
    const email = v.normalized;

    if (isInternalEmail(db, email)) return { learned: false, reason: 'intern' };

    const existing = db.prepare(
        `SELECT id, is_active FROM contact_points
          WHERE entity_type = 'customer' AND entity_id = ? AND kind = 'email'
            AND LOWER(value) = ? LIMIT 1`
    ).get(customerId, email);
    if (existing) {
        // En deaktiveret adresse er bevidst fjernet og genoplives ikke af sig selv.
        // Undtagelsen er en flytning: dér HAR nogen sagt at adressen hører til her.
        if (!existing.is_active && reactivate) {
            db.prepare(
                `UPDATE contact_points SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            ).run(existing.id);
            logChange({
                entityType: 'customer', entityId: customerId,
                action: 'contact_point_update', fieldName: 'email',
                newValue: email, userId,
                notes: `genaktiveret ved ${sourceLabel || 'flytning'}`,
            });
            return { learned: true, reactivated: true, email, primary: false };
        }
        return { learned: false, reason: existing.is_active ? 'findes' : 'deaktiveret' };
    }

    const owner = db.prepare(
        `SELECT cp.entity_id AS id FROM contact_points cp
           JOIN customers c ON c.id = cp.entity_id
          WHERE cp.entity_type = 'customer' AND cp.kind = 'email'
            AND LOWER(cp.value) = ? AND cp.is_active = 1 AND c.is_active = 1
            AND cp.entity_id != ?
          LIMIT 1`
    ).get(email, customerId)
      || db.prepare(
        `SELECT id FROM customers
          WHERE LOWER(email) = ? AND is_active = 1 AND id != ? LIMIT 1`
    ).get(email, customerId);
    if (owner) return { learned: false, reason: 'optaget', otherCustomerId: owner.id };

    // Primær kun hvis kunden ingen har — den situation der forårsagede #478.
    const hasPrimary = db.prepare(
        `SELECT 1 FROM contact_points
          WHERE entity_type = 'customer' AND entity_id = ? AND kind = 'email'
            AND is_primary = 1 AND is_active = 1 LIMIT 1`
    ).get(customerId);
    const isPrimary = hasPrimary ? 0 : 1;

    db.prepare(
        `INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_public, is_primary, notes)
         VALUES ('customer', ?, 'email', ?, 'mail', 0, ?, ?)`
    ).run(customerId, email, isPrimary, 'Lært da en mail blev koblet til kunden');

    if (isPrimary) syncPrimaryCache(db, 'customer', customerId, 'email');

    logChange({
        entityType: 'customer', entityId: customerId,
        action: 'contact_point_create', fieldName: 'email',
        newValue: email, userId,
        notes: `lært fra ${sourceLabel || 'indbakke-kobling'}`
            + ` source=mail public=0 primary=${isPrimary}`,
    });

    return { learned: true, primary: !!isPrimary, email };
}

// Hvilken adresse på en ufordelt mail hører til kunden?
//
// Normalt afsenderen. Undtagelsen er den interne videresendelse: står kollegaen
// som afsender, er det den VIDERESENDTE adresse der er kundens — spejler
// resolveEffectiveSender i mailService, så de to steder ikke driver fra hinanden.
// learnSenderEmail afviser interne adresser i forvejen; her vælger vi bare den
// rigtige at tilbyde den.
function learnFromUnmatched(db, um, customerId, userId, sourceLabel) {
    const first = learnSenderEmail(db, customerId, um.from_email, userId, sourceLabel);
    if (first.learned || first.reason === 'findes') return first;
    if (um.parsed_email) {
        const viaForward = learnSenderEmail(db, customerId, um.parsed_email, userId,
            (sourceLabel || 'indbakke-kobling') + ' (videresendt afsender)');
        if (viaForward.learned || viaForward.reason === 'findes') return viaForward;
    }
    return first;
}

function linkUnmatchedToCustomer(db, um, customerId, userId) {
    let thread = db.prepare(
        `SELECT id FROM mail_threads WHERE customer_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
    ).get(customerId);
    let threadId = thread?.id;

    if (!threadId) {
        threadId = db.prepare(
            `INSERT INTO mail_threads (customer_id, subject, status, handling_status, created_at, updated_at)
             VALUES (?, ?, 'active', 'aaben', datetime('now'), datetime('now'))`
        ).run(customerId, um.subject || '').lastInsertRowid;
    } else {
        db.prepare(`UPDATE mail_threads SET updated_at = datetime('now') WHERE id = ?`).run(threadId);
    }

    if (um.status !== 'linked') {
        // Indsættes læst: mailen håndteres her og nu.
        insertMessageFromUnmatched(db, um, Number(threadId), { isRead: 1 });
        db.prepare(`
            UPDATE mail_unmatched
               SET status = 'linked', linked_customer_id = ?, handled_by_user_id = ?, handled_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(customerId, userId, um.id);

        // Beskeden indsættes læst (den håndteres her og nu), men tråden skal
        // stadig have en handling_status for at være synlig i indbakken.
        // markRead=true → et allerede sendt svar ('afventer_kunde') bevares.
        markThreadInbound(db, Number(threadId), um.received_at, { markRead: true });

        // Koblingen fortæller os hvem adressen tilhører — husk den (#478).
        learnFromUnmatched(db, um, customerId, userId, 'kobling fra indbakken');
    }

    return Number(threadId);
}

// ── Flyt en tråd til den rigtige kunde eller bon (#481) ──────────────
//
// Den eneste ægte blindgyde i indbakken: en tråd der er havnet forkert kunne
// ikke flyttes. `PATCH /threads/:id` tager status, udsættelse og tildeling —
// ikke ejerskab. Opdagede man fejlen, var der intet at gøre ved den.
//
// Flytningen tager de LÆRTE adresser med. Uden det led ville rettelsen kun
// virke én gang: #478 skrev afsenderens adresse på den forkerte kunde da
// tråden blev koblet, og næste mail fra samme person ville lande samme forkerte
// sted igen — nu helt uden at nogen rørte ved den. En retteventil der lader
// fejlkilden stå, cementerer fejlen i stedet for at rette den.
//
// Kun kontaktpunkter med `source = 'mail'` flyttes. Alt andet (manuelt
// indtastet, fra CVR, fra en formular) har et menneske eller en ekstern kilde
// stået inde for, og det er ikke vores at flytte rundt på.
function moveThreadOwner(db, thread, target, userId) {
    const before = { customer_id: thread.customer_id, bon_id: thread.bon_id };
    let customerId = null, bonId = null, label = '';

    if (target.bonId != null) {
        const bon = db.prepare(
            `SELECT b.id, b.bon_number, b.customer_id FROM bons b WHERE b.id = ?`
        ).get(target.bonId);
        if (!bon) return { error: 'Bon ikke fundet' };
        bonId = bon.id;
        // Bonen kender sin kunde — så tråden også dukker op på kundekortet.
        customerId = bon.customer_id || null;
        label = 'bon ' + bon.bon_number;
    } else if (target.customerId != null) {
        const c = db.prepare(
            `SELECT id, first_name, last_name FROM customers WHERE id = ? AND is_active = 1`
        ).get(target.customerId);
        if (!c) return { error: 'Kunde ikke fundet' };
        customerId = c.id;
        bonId = null;   // en kundetråd hænger ikke fast i den gamle bon
        label = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || ('kunde ' + c.id);
    } else {
        return { error: 'Angiv customer_id eller bon_id' };
    }

    if (before.customer_id === customerId && before.bon_id === bonId) {
        return { error: 'Tråden ligger allerede dér' };
    }

    db.prepare(
        `UPDATE mail_threads SET customer_id = ?, bon_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(customerId, bonId, thread.id);

    // ── Tag de lærte adresser med ──
    // Den gamle ejer er kunden på tråden; var det en bon-tråd, er det bonens kunde.
    const fromCustomerId = before.customer_id
        || (before.bon_id
            ? db.prepare('SELECT customer_id FROM bons WHERE id = ?').get(before.bon_id)?.customer_id
            : null);

    const senders = db.prepare(
        `SELECT DISTINCT LOWER(from_email) AS email FROM mail_messages
          WHERE thread_id = ? AND direction = 'in' AND from_email IS NOT NULL AND from_email != ''`
    ).all(thread.id).map(r => r.email);

    const moved = [];
    for (const email of senders) {
        if (isInternalEmail(db, email)) continue;

        // Fjern gættet fra den gamle kunde — deaktivér, slet ikke: sporet skal
        // kunne ses, og #478 genopliver ikke en deaktiveret adresse af sig selv.
        let removed = false;
        if (fromCustomerId && fromCustomerId !== customerId) {
            const cp = db.prepare(
                `SELECT id FROM contact_points
                  WHERE entity_type = 'customer' AND entity_id = ? AND kind = 'email'
                    AND LOWER(value) = ? AND source = 'mail' AND is_active = 1 LIMIT 1`
            ).get(fromCustomerId, email);
            if (cp) {
                db.prepare(
                    `UPDATE contact_points SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
                ).run(cp.id);
                syncPrimaryCache(db, 'customer', fromCustomerId, 'email');
                logChange({
                    entityType: 'customer', entityId: fromCustomerId,
                    action: 'contact_point_update', fieldName: 'email',
                    oldValue: email, userId,
                    notes: `fjernet — mailtråden blev flyttet til ${label}`,
                });
                removed = true;
            }
        }

        const learned = customerId
            ? learnSenderEmail(db, customerId, email, userId, 'flytning af mailtråd', { reactivate: true })
            : { learned: false, reason: 'ingen_kunde' };

        if (removed || learned.learned) {
            moved.push({ email, removed_from: removed ? fromCustomerId : null, added: !!learned.learned });
        }
    }

    logChange({
        entityType: 'mail_thread', entityId: thread.id,
        action: 'thread_moved', fieldName: 'owner',
        oldValue: before.bon_id ? ('bon:' + before.bon_id) : (before.customer_id ? ('kunde:' + before.customer_id) : null),
        newValue: bonId ? ('bon:' + bonId) : ('kunde:' + customerId),
        userId,
        notes: moved.length
            ? `${moved.length} lært adresse${moved.length === 1 ? '' : 'r'} fulgte med`
            : null,
    });

    return { ok: true, customer_id: customerId, bon_id: bonId, label, moved_addresses: moved };
}

// Hvilken afsender skal en ufordelt mail behandles som?
//
// `use_parsed` vælger den VIDERESENDTE afsender (mail_unmatched.parsed_*) i
// stedet for den der ramte postkassen. Det er kollegaen der har trykket
// videresend, men kunden der står inde i beskeden — og det er kunden vi vil
// oprette og svare. Kolonnerne har været udfyldt siden migration 018 uden at
// blive læst noget sted.
function unmatchedSender(db, um, useParsed) {
    if (useParsed) {
        if (!um.parsed_email) return { error: 'Mailen har ingen videresendt afsender at bruge' };
        // En cachet klient kan nå at bede om det efter listen er ændret — vi
        // opretter aldrig vores egen postkasse som kunde.
        if (isInternalEmail(db, um.parsed_email)) {
            return { error: 'Den videresendte afsender er en af vores egne adresser' };
        }
        return {
            email: um.parsed_email,
            name: um.parsed_name || null,
            company: um.parsed_company || null,
            forwardedBy: um.from_email || null,
        };
    }
    if (!um.from_email) return { error: 'Mailen har ingen afsender-email' };
    return { email: um.from_email, name: um.from_name || null, company: null, forwardedBy: null };
}

// POST /api/mail/unmatched/:id/create-lead   { use_parsed? }
// Opret afsenderen som privat lead (kunde uden firma) og knyt mailen til den nye kunde.
router.post('/unmatched/:id/create-lead', requireModule('crm'), handle((req, res) => {
    const id = parseInt(req.params.id);
    const db = getDb();
    const userId = getUserId(req);

    const um = db.prepare('SELECT * FROM mail_unmatched WHERE id = ?').get(id);
    if (!um) return res.status(404).json({ error: 'Mail ikke fundet' });

    const sender = unmatchedSender(db, um, !!req.body?.use_parsed);
    if (sender.error) return res.status(400).json({ error: sender.error });

    const { firstName, lastName } = splitName(sender.name);
    // Firma-gættet er domænebaseret og derfor kun et spor — det gemmes som note
    // på leadet så den der samler op kan slå det rigtige firma op og koble til.
    const notes = [
        sender.company ? `Firma (gættet ud fra maildomæne): ${sender.company}` : null,
        sender.forwardedBy ? `Videresendt af ${sender.forwardedBy}` : null,
    ].filter(Boolean).join('\n') || null;

    let customerId, threadId, created;
    transaction(db, () => {
        const lead = createPrivateLead(db, {
            firstName, lastName, email: sender.email, notes,
            userId, sourceLabel: sender.forwardedBy ? 'opret-lead-fra-videresendt-mail' : 'opret-lead-fra-mail',
        });
        customerId = lead.customerId;
        created = lead.created;
        threadId = linkUnmatchedToCustomer(db, um, customerId, userId);
    });

    broadcastUnmatchedCount(db);
    broadcast('crm_stage_changed', { source: 'inbox_lead' });
    res.json({ ok: true, customer_id: customerId, thread_id: threadId, created });
}));

// POST /api/mail/unmatched/:id/reply  { subject?, text, use_parsed? }
// Send et svar til afsenderen. Knytter mailen til en kunde først (opretter lead
// hvis den ikke allerede er linket) så svaret bliver tråd-historik.
//
// `use_parsed` svarer den VIDERESENDTE afsender i stedet for kollegaen der
// trykkede videresend. Modtageren vælges altså aldrig frit — kun mellem de to
// adresser mailen selv indeholder.
router.post('/unmatched/:id/reply', requireModule('crm'), handle(async (req, res) => {
    const id = parseInt(req.params.id);
    const { subject, text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text er påkrævet' });

    const db = getDb();
    const userId = getUserId(req);

    const um = db.prepare('SELECT * FROM mail_unmatched WHERE id = ?').get(id);
    if (!um) return res.status(404).json({ error: 'Mail ikke fundet' });

    const sender = unmatchedSender(db, um, !!req.body?.use_parsed);
    if (sender.error) return res.status(400).json({ error: sender.error });

    // 1) Sørg for at afsenderen findes som kunde (opret lead hvis nødvendig).
    //    Vi linker IKKE mailen endnu — så hvis afsendelsen fejler, bliver den
    //    liggende i indbakken og kan prøves igen.
    let customerId = um.linked_customer_id || null;
    if (!customerId) {
        transaction(db, () => {
            const { firstName, lastName } = splitName(sender.name);
            const lead = createPrivateLead(db, {
                firstName, lastName, email: sender.email,
                userId, sourceLabel: 'svar-fra-indbakke',
            });
            customerId = lead.customerId;
        });
    }

    // 2) Send svaret — sendMail finder/opretter kundens aktive tråd og tilføjer outbound.
    //    Svar fra samme mailbox som mailen kom ind på (kontakt@ ellers bon@).
    const smtpPrefix = (um.mailbox && um.mailbox.toLowerCase().includes('kontakt')) ? 'smtp_kontakt' : 'smtp';
    const replySubject = (subject && String(subject).trim()) || ('Re: ' + (um.subject || ''));
    const result = await sendMail({
        to: sender.email,
        subject: replySubject,
        text,
        customerId,
        context: { type: 'customer', number: customerId },
        smtpPrefix,
        userId,
    });

    // 3) Afsendelsen lykkedes — knyt nu den oprindelige mail ind i samme tråd og
    //    markér den håndteret (indgående besked sorteres før svaret pga. received_at).
    transaction(db, () => {
        linkUnmatchedToCustomer(db, um, customerId, userId);
    });

    broadcastUnmatchedCount(db);
    broadcast('crm_stage_changed', { source: 'inbox_reply' });
    res.json({ ok: true, customer_id: customerId, thread_id: result.threadId, message_id: result.messageId });
}));

/* ── POLL KONTROL ─────────────────────────────────────────── */

router.post('/poll', requireAuth('admin'), handle(async (req, res) => {
    const { triggerPoll, getPollState } = require('../services/mailService');
    if (typeof triggerPoll === 'function') {
        await triggerPoll();
    }
    res.json({ ok: true, state: getPollState() });
}));

// POST /api/mail/test-sse — test broadcast (admin, midlertidigt)
router.post('/test-sse', requireAuth('admin'), handle(async (req, res) => {
    const { broadcast } = require('../shared/sse');
    const db = getDb();
    // Brug en bon fra i dag hvis muligt (så badge kan ses i kitchen today)
    const bon = db.prepare(`SELECT id, bon_number FROM bons WHERE delivery_date = date('now') LIMIT 1`).get()
             || db.prepare(`SELECT id, bon_number FROM bons LIMIT 1`).get();
    broadcast('mail_received', { bon_id: bon ? bon.id : 50, bon_number: bon ? bon.bon_number : '0000', customer_id: null, thread_id: 2, unread_count: 5 });
    res.json({ ok: true, broadcasted: 'mail_received' });
}));

router.get('/status', requireAuth('admin'), handle(async (req, res) => {
    const { getPollState } = require('../services/mailService');
    res.json(getPollState());
}));

module.exports = router;
