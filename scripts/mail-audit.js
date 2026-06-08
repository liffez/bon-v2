#!/usr/bin/env node --experimental-sqlite
/**
 * scripts/mail-audit.js
 *
 * Diagnose-værktøj: "kom denne mail ind i Bon v2 — og hvor endte den?"
 *
 * Hver indgående mail havner ét af fire steder. Tre af dem er USYNLIGE i
 * CRM Indbakke (som kun viser ufordelte med status='open'):
 *
 *   1. TRÅD     — mailen bar et tag (#b-/#k-/#t-/#po-/#s-) og blev hægtet på
 *                 en bon/kunde/indkøbsordre/leverandør. Vises KUN under den
 *                 entitet (fx Kunde 360° → Mail), aldrig i Ufordelte.
 *   2. UFORDELT (open)    — intet match → synlig i CRM Indbakke.
 *   3. UFORDELT (ignored) — auto-ignoreret (HubSpot/Jotform/autosvar) ELLER
 *                 manuelt/sweep-ignoreret. Skjult.
 *   4. DROPPET  — Bon v1-mail (#Bon:) gemmes aldrig. Kan ikke ses her (kun
 *                 nævnt for fuldstændighed).
 *
 * Når en mail "mangler" er den næsten altid #1 eller #3 — ikke tabt.
 *
 * Brug:
 *   node --experimental-sqlite scripts/mail-audit.js
 *   node --experimental-sqlite scripts/mail-audit.js --mailbox kontakt@ristetrug.dk
 *   node --experimental-sqlite scripts/mail-audit.js --search 4455
 *   node --experimental-sqlite scripts/mail-audit.js --search jeudan.dk
 *   node --experimental-sqlite scripts/mail-audit.js --db /sti/til/bon.db
 *
 * Default-DB: $DB_PATH eller ../data/bon.db (samme som serveren).
 */

const path = require('path');
const { openDb } = require('../db/compat');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

const DB_PATH = arg('--db') || process.env.DB_PATH || path.join(__dirname, '../data/bon.db');
const MAILBOX = arg('--mailbox');
const SEARCH = arg('--search');

const db = openDb(DB_PATH);

const mailboxClause = MAILBOX ? ' AND mailbox = @mailbox' : '';
const mbParam = MAILBOX ? { mailbox: MAILBOX } : {};

// ── Entitet-label til en tråd ───────────────────────────────────────────
function threadLabel(t) {
    if (t.bon_id) {
        const b = db.prepare('SELECT bon_number FROM bons WHERE id = ?').get(t.bon_id);
        return `bon ${b ? b.bon_number : '#' + t.bon_id + ' (SLETTET)'}`;
    }
    if (t.customer_id) {
        const c = db.prepare('SELECT first_name, last_name, email FROM customers WHERE id = ?').get(t.customer_id);
        return c
            ? `kunde ${[c.first_name, c.last_name].filter(Boolean).join(' ')} <${c.email || '?'}>`
            : `kunde #${t.customer_id} (SLETTET)`;
    }
    if (t.purchase_order_id) {
        const po = db.prepare(
            'SELECT po.id, s.name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?'
        ).get(t.purchase_order_id);
        return po ? `indkøbsordre #${po.id} (${po.name || '?'})` : `PO #${t.purchase_order_id} (SLETTET)`;
    }
    if (t.supplier_id) {
        const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(t.supplier_id);
        return s ? `leverandør ${s.name}` : `leverandør #${t.supplier_id} (SLETTET)`;
    }
    return 'tråd UDEN entitet (forældreløs)';
}

const BOUNCE_RE = /postmaster@|mailer-daemon|undelivered mail|delivery (status notification|has failed)/i;

// ── SØG-tilstand: spor én bestemt mail på tværs af alle tabeller ─────────
if (SEARCH) {
    const like = `%${SEARCH}%`;
    console.log(`\n🔎 Søger efter "${SEARCH}" i alle mail-tabeller\n`);

    const um = db.prepare(
        `SELECT id, mailbox, status, substr(received_at,1,16) dt, from_email, subject
         FROM mail_unmatched
         WHERE subject LIKE ? OR from_email LIKE ? OR from_name LIKE ?
         ORDER BY received_at DESC`
    ).all(like, like, like);

    const msgs = db.prepare(
        `SELECT id, thread_id, direction, mailbox, is_read,
                substr(COALESCE(received_at, sent_at),1,16) dt, from_email, subject
         FROM mail_messages
         WHERE subject LIKE ? OR from_email LIKE ? OR from_name LIKE ?
         ORDER BY id`
    ).all(like, like, like);

    if (!um.length && !msgs.length) {
        console.log('  Ingen mails fundet. → mailen er enten ikke ingestet, en Bon v1-mail (#Bon:),');
        console.log('     eller ligger kun på IMAP-serveren (endnu ikke pollet).\n');
    }
    for (const m of msgs) {
        const t = db.prepare('SELECT bon_id, customer_id, purchase_order_id, supplier_id, status FROM mail_threads WHERE id = ?').get(m.thread_id);
        const dir = m.direction === 'in' ? '← indgående' : '→ udgående';
        const read = m.direction === 'in' ? (m.is_read ? 'læst' : 'ULÆST') : '';
        console.log(`  ✅ TRÅD ${m.thread_id} · ${dir} ${read}`);
        console.log(`     ${m.dt} · ${m.from_email}`);
        console.log(`     "${m.subject}"`);
        console.log(`     → ${t ? threadLabel(t) : 'tråd findes ikke'}`);
        console.log(`     Findes i: ${t && t.customer_id ? 'CRM → Kunde 360° → Mail-fanen' : t && t.bon_id ? 'bon-drawer → Mail / bons-liste (ulæst-filter)' : 'leverandør-/PO-visning'}\n`);
    }
    for (const m of um) {
        const where = m.status === 'open' ? 'SYNLIG i CRM Indbakke (Ufordelte)'
            : m.status === 'ignored' ? 'SKJULT (status=ignored)'
            : `status=${m.status}`;
        const flag = (m.status === 'ignored' && BOUNCE_RE.test(`${m.from_email} ${m.subject}`)) ? '  ⚠ BOUNCE skjult — bør være open (migration 067)' : '';
        console.log(`  📥 UFORDELT #${m.id} · ${m.mailbox} · ${where}${flag}`);
        console.log(`     ${m.dt} · ${m.from_email}`);
        console.log(`     "${m.subject}"\n`);
    }
    process.exit(0);
}

// ── OVERSIGT-tilstand ───────────────────────────────────────────────────
console.log(`\n📊 MAIL-AUDIT  (DB: ${DB_PATH})${MAILBOX ? `  ·  postkasse: ${MAILBOX}` : ''}\n`);

const mailboxes = MAILBOX
    ? [MAILBOX]
    : db.prepare(
        `SELECT mailbox FROM (
            SELECT mailbox FROM mail_unmatched WHERE mailbox IS NOT NULL
            UNION SELECT mailbox FROM mail_messages WHERE mailbox IS NOT NULL
         ) GROUP BY mailbox ORDER BY mailbox`
      ).all().map(r => r.mailbox);

for (const mb of mailboxes) {
    const threaded = db.prepare(
        `SELECT COUNT(*) n, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) unread
         FROM mail_messages WHERE direction = 'in' AND mailbox = ?`
    ).get(mb);
    const open = db.prepare(`SELECT COUNT(*) n FROM mail_unmatched WHERE status = 'open' AND mailbox = ?`).get(mb).n;
    const ignored = db.prepare(`SELECT COUNT(*) n FROM mail_unmatched WHERE status = 'ignored' AND mailbox = ?`).get(mb).n;
    const linked = db.prepare(`SELECT COUNT(*) n FROM mail_unmatched WHERE status = 'linked' AND mailbox = ?`).get(mb).n;
    const total = threaded.n + open + ignored + linked;

    console.log(`━━━ ${mb} ━━━  (${total} ingesteret i alt)`);
    console.log(`  ✅ TRÅD (tag-routet, synlig under entitet):  ${threaded.n}   ${threaded.unread ? `(${threaded.unread} ULÆSTE svar)` : ''}`);
    console.log(`  📥 UFORDELT open    (synlig i CRM Indbakke):  ${open}`);
    console.log(`  🚫 UFORDELT ignored (skjult):                 ${ignored}`);
    if (linked) console.log(`  🔗 UFORDELT linked  (manuelt koblet):         ${linked}`);

    // Advarsel: ulæste svar på tråde har ingen central indbakke
    if (threaded.unread > 0) {
        console.log(`     ⚠ ${threaded.unread} ulæste tråd-svar er IKKE i CRM Indbakke — kun under hver entitet.`);
    }

    // Advarsel: bounces der er blevet skjult
    const hiddenBounces = db.prepare(
        `SELECT id, substr(received_at,1,16) dt, from_email, subject
         FROM mail_unmatched WHERE status = 'ignored' AND mailbox = ?
           AND (from_email LIKE '%postmaster%' OR from_email LIKE '%mailer-daemon%'
                OR subject LIKE '%Undelivered%' OR subject LIKE '%Delivery Status%')`
    ).all(mb);
    if (hiddenBounces.length) {
        console.log(`     ⚠ ${hiddenBounces.length} BOUNCE(S) skjult som ignored — bør være open (migration 067):`);
        for (const b of hiddenBounces) console.log(`        #${b.id}  ${b.dt}  ${b.from_email}  "${b.subject}"`);
    }
    console.log('');
}

// ── Forældreløse tråde (entitet slettet → mail praktisk talt begravet) ───
const orphans = db.prepare(
    `SELECT t.id, t.bon_id, t.customer_id, t.purchase_order_id, t.supplier_id, COUNT(m.id) nmsg
     FROM mail_threads t JOIN mail_messages m ON m.thread_id = t.id
     WHERE (t.bon_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bons WHERE id = t.bon_id))
        OR (t.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = t.customer_id))
        OR (t.purchase_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = t.purchase_order_id))
        OR (t.supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id = t.supplier_id))
     GROUP BY t.id`
).all();
if (orphans.length) {
    console.log(`⚠ ${orphans.length} FORÆLDRELØSE tråd(e) — entiteten er slettet, mails er reelt usynlige:`);
    for (const o of orphans) console.log(`   tråd ${o.id} (${o.nmsg} mails) → ${threadLabel(o)}`);
    console.log('');
}

console.log('Tip: spor én bestemt mail med  --search <emne|afsender|tag>  (fx --search 4455)\n');
