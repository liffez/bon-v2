// services/mailService.js
// Thread-based mail: SMTP afsendelse + read-only IMAP polling + tag-routing
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { broadcast } = require('../shared/sse');
const { parseSubject, parseForwardedSender, isBonV1, getPrefixes, buildTag } = require('../utils/mail-parser');

// ─── POLLING STATE ──────────────────────────────────────

const _pollState = {
    bon:     { lastPollAt: null, lastError: null, pollCount: 0 },
    kontakt: { lastPollAt: null, lastError: null, pollCount: 0 }
};

function getPollState() {
    return { ..._pollState };
}

// ─── HELPERS ────────────────────────────────────────────

function getSetting(key) {
    return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

/**
 * Erstat {{variabel}} placeholders + append signatur.
 */
function renderTemplate(body, vars) {
    let result = body;
    for (const [key, val] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val ?? '');
    }
    const sig = getSetting('mail_signature');
    if (sig) {
        result += '\n\n--\n' + sig;
    }
    return result;
}

// ─── SMTP ───────────────────────────────────────────────

/**
 * Opret SMTP-transport.
 * @param {string} prefix - 'smtp' (standard) eller 'smtp_kontakt'
 */
function createTransport(prefix = 'smtp') {
    const host = getSetting(`${prefix}_host`);
    const port = parseInt(getSetting(`${prefix}_port`) || '587');
    const user = getSetting(`${prefix}_user`);
    const passEnvKey = prefix === 'smtp_kontakt' ? 'SMTP_KONTAKT_PASSWORD' : 'SMTP_PASSWORD';
    const pass = process.env[passEnvKey] || '';

    if (!host || !user) return null;

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });
}

/**
 * Send en mail via SMTP. Gemmer i mail_threads + mail_messages.
 */
async function sendMail({ to, subject, text, context, bonId = null, customerId = null, inReplyTo = null, references = null, smtpPrefix = 'smtp', userId = null }) {
    const enabledKey = smtpPrefix === 'smtp_kontakt' ? 'smtp_kontakt_enabled' : 'smtp_enabled';
    if (getSetting(enabledKey) !== '1') {
        throw new Error(`SMTP (${smtpPrefix}) er ikke aktiveret`);
    }

    const transport = createTransport(smtpPrefix);
    if (!transport) throw new Error(`SMTP (${smtpPrefix}) ikke konfigureret`);

    // Build tag and inject into subject
    const tag = context ? buildTag(context) : '';
    const finalSubject = tag ? `${tag} ${subject}` : subject;

    const from = getSetting(`${smtpPrefix}_from`) || getSetting(`${smtpPrefix}_user`);

    // Find or create thread
    const db = getDb();
    let threadId;

    if (bonId) {
        const existing = db.prepare(
            `SELECT id FROM mail_threads WHERE bon_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get(bonId);
        threadId = existing?.id;
    } else if (customerId) {
        const existing = db.prepare(
            `SELECT id FROM mail_threads WHERE customer_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get(customerId);
        threadId = existing?.id;
    }

    if (!threadId) {
        const ins = db.prepare(
            `INSERT INTO mail_threads (bon_id, customer_id, subject, status, created_at, updated_at)
             VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`
        ).run(bonId, customerId, finalSubject);
        threadId = ins.lastInsertRowid;
    } else {
        db.prepare(`UPDATE mail_threads SET updated_at = datetime('now') WHERE id = ?`).run(threadId);
    }

    // Insert outbound message
    const msgIns = db.prepare(
        `INSERT INTO mail_messages (thread_id, direction, from_email, from_name, to_email, subject, body_text, message_id, in_reply_to, is_read, sent_at, created_by_user_id, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, NULL, ?, 1, datetime('now'), ?, datetime('now'))`
    ).run(threadId, from, null, to, finalSubject, text, inReplyTo, userId);
    const messageDbId = msgIns.lastInsertRowid;

    // Send via SMTP
    const mailOptions = {
        from,
        to,
        subject: finalSubject,
        text
    };
    if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
    if (references) mailOptions.references = references;

    const info = await transport.sendMail(mailOptions);

    // Update message with SMTP messageId
    db.prepare(`UPDATE mail_messages SET message_id = ? WHERE id = ?`).run(info.messageId, messageDbId);

    // SSE broadcast
    broadcast('mail_sent', { bon_id: bonId, customer_id: customerId, thread_id: threadId });

    return { messageId: info.messageId, threadId, subject: finalSubject };
}

/**
 * Send mail fra skabelon.
 */
async function sendFromTemplate({ templateKey, to, vars, bonId = null, customerId = null, context = null, userId = null }) {
    const tmpl = getDb().prepare('SELECT subject, body_text FROM mail_templates WHERE key = ?').get(templateKey);
    if (!tmpl) throw new Error(`Skabelon '${templateKey}' ikke fundet`);

    const subject = renderTemplate(tmpl.subject, vars);
    const text    = renderTemplate(tmpl.body_text, vars);

    return sendMail({ to, subject, text, context, bonId, customerId, userId });
}

// ─── IMAP ───────────────────────────────────────────────

/**
 * Poll én IMAP-postkasse. Read-only — ALDRIG flag-ændringer.
 */
async function pollMailbox(config) {
    const { host, port, user, password, prefix } = config;

    if (!host || !user || !password) return { newCount: 0, errors: 0 };

    const state = _pollState[prefix] || _pollState.bon;
    state.lastPollAt = new Date().toISOString();
    state.pollCount++;

    const portNum = parseInt(port || '993');
    const client = new ImapFlow({
        host,
        port: portNum,
        secure: portNum === 993,  // 993 = implicit TLS, 143 = STARTTLS
        auth: { user, pass: password },
        logger: false
    });

    let newCount = 0;
    let errors = 0;

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');

        try {
            const msgs = client.fetch('1:*', {
                uid: true,
                flags: true,
                envelope: true,
                source: true
            });

            for await (const msg of msgs) {
                try {
                    // Skip already-seen messages
                    if (msg.flags && msg.flags.has('\\Seen')) continue;

                    // Skip if UID already processed
                    const db = getDb();
                    const known = db.prepare(
                        `SELECT 1 FROM mail_messages WHERE imap_uid = ? AND mailbox = ?
                         UNION
                         SELECT 1 FROM mail_unmatched WHERE imap_uid = ? AND mailbox = ?`
                    ).get(msg.uid, user, msg.uid, user);
                    if (known) continue;

                    // Parse full message with simpleParser
                    const parsed = await simpleParser(msg.source);

                    // Skip Bon v1 mails
                    if (isBonV1(parsed.subject)) continue;

                    await processInboundMail(parsed, msg.uid, user);
                    newCount++;
                } catch (err) {
                    errors++;
                    console.error(`[mail] Fejl ved behandling af mail UID=${msg.uid}:`, err.message);
                }
            }

            // NEVER mark as Seen — read-only IMAP
        } finally {
            lock.release();
        }

        state.lastError = null;
    } catch (err) {
        state.lastError = err.message;
        console.error(`[mail] IMAP fejl (${user}):`, err.message);
    } finally {
        try { await client.logout(); } catch (_) {}
    }

    return { newCount, errors };
}

/**
 * Behandl en enkelt indgående mail (fra simpleParser output).
 */
async function processInboundMail(parsed, uid, mailbox) {
    const db = getDb();

    const subject     = parsed.subject || '';
    const messageId   = parsed.messageId || null;
    const inReplyTo   = parsed.inReplyTo || null;
    const refsRaw     = parsed.references;
    const references  = Array.isArray(refsRaw) ? refsRaw.join(' ') : (refsRaw || null);
    const fromAddr    = parsed.from?.value?.[0]?.address || '';
    const fromName    = parsed.from?.value?.[0]?.name || null;
    const toAddr      = parsed.to?.value?.[0]?.address || '';
    const receivedAt  = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
    const bodyText    = parsed.text || '';
    const bodyHtml    = parsed.html || null;
    const attachments = parsed.attachments || [];

    // Parse subject for tags
    const prefixes = getPrefixes();
    const tagResult = parseSubject(subject, prefixes);

    if (tagResult.routing === 'ignore') return;

    // ── Thread matching ──

    let threadId = null;
    let bonId = null;
    let customerId = null;

    // 1. In-Reply-To matching
    if (inReplyTo && !threadId) {
        const ref = db.prepare(
            `SELECT thread_id FROM mail_messages WHERE message_id = ?`
        ).get(inReplyTo);
        if (ref) {
            threadId = ref.thread_id;
            // Load bon_id/customer_id from thread
            const thread = db.prepare(`SELECT bon_id, customer_id FROM mail_threads WHERE id = ?`).get(threadId);
            if (thread) {
                bonId = thread.bon_id;
                customerId = thread.customer_id;
            }
        }
    }

    // 2. Tag matching
    if (!threadId) {
        if (tagResult.routing === 'bon' || tagResult.routing === 'bon+customer') {
            const bon = db.prepare('SELECT id FROM bons WHERE bon_number = ?').get(String(tagResult.bonNumber));
            if (bon) {
                bonId = bon.id;
                if (tagResult.customerNumber) customerId = tagResult.customerNumber;
            }
        } else if (tagResult.routing === 'offer') {
            const bon = db.prepare('SELECT id FROM bons WHERE bon_number = ? AND is_offer = 1').get(String(tagResult.offerNumber));
            if (bon) bonId = bon.id;
        } else if (tagResult.routing === 'customer') {
            customerId = tagResult.customerNumber;
        }

        // Find or create thread if we have a match
        if (bonId || customerId) {
            // Try to find existing active thread
            if (bonId) {
                const existing = db.prepare(
                    `SELECT id FROM mail_threads WHERE bon_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
                ).get(bonId);
                threadId = existing?.id;
            }
            if (!threadId && customerId) {
                const existing = db.prepare(
                    `SELECT id FROM mail_threads WHERE customer_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
                ).get(customerId);
                threadId = existing?.id;
            }

            if (!threadId) {
                const ins = db.prepare(
                    `INSERT INTO mail_threads (bon_id, customer_id, subject, status, created_at, updated_at)
                     VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`
                ).run(bonId, customerId, subject);
                threadId = ins.lastInsertRowid;
            } else {
                db.prepare(`UPDATE mail_threads SET updated_at = datetime('now') WHERE id = ?`).run(threadId);
            }
        }
    }

    // 3. Unmatched — no thread, no tag
    if (!threadId) {
        const forwardInfo = parseForwardedSender(bodyText);
        db.prepare(
            `INSERT INTO mail_unmatched (imap_uid, mailbox, message_id, from_email, from_name, subject, body_text, received_at,
             parsed_email, parsed_name, parsed_company, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(
            uid, mailbox, messageId, fromAddr, fromName, subject, bodyText, receivedAt,
            forwardInfo?.email || null, forwardInfo?.name || null, forwardInfo?.company || null
        );

        // Count unmatched for SSE
        const count = db.prepare(`SELECT COUNT(*) as n FROM mail_unmatched WHERE status = 'open'`).get().n;
        broadcast('mail_unmatched', { count });

        console.log(`[mail] Ulæst mail uden match: "${subject}" fra ${fromAddr}`);
        return;
    }

    // ── Insert message ──

    const msgIns = db.prepare(
        `INSERT INTO mail_messages (thread_id, direction, from_email, from_name, to_email, subject, body_text, body_html, message_id, in_reply_to, imap_uid, mailbox, is_read, received_at, created_at)
         VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`
    ).run(threadId, fromAddr, fromName, toAddr, subject, bodyText, bodyHtml, messageId, inReplyTo, uid, mailbox, receivedAt);
    const messageDbId = msgIns.lastInsertRowid;

    // Save attachments
    if (attachments.length > 0) {
        await saveAttachments(messageDbId, attachments, messageId);
    }

    // Count unread for SSE
    const unreadCount = db.prepare(
        `SELECT COUNT(*) as n FROM mail_messages WHERE thread_id = ? AND is_read = 0`
    ).get(threadId).n;

    broadcast('mail_received', { bon_id: bonId, customer_id: customerId, thread_id: threadId, unread_count: unreadCount });

    console.log(`[mail] Indgående mail → thread ${threadId} (bon=${bonId}, customer=${customerId})`);
}

/**
 * Gem vedhæftninger til disk + mail_attachments tabel.
 */
async function saveAttachments(messageDbId, attachments, emailMessageId) {
    // Sanitize messageId for use as directory name
    const safeName = (emailMessageId || String(messageDbId))
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 200);
    const dir = path.join(__dirname, '..', 'data', 'attachments', safeName);
    fs.mkdirSync(dir, { recursive: true });

    const db = getDb();

    for (const att of attachments) {
        const filename = att.filename || `attachment_${Date.now()}`;
        const filepath = path.join(dir, filename);

        try {
            fs.writeFileSync(filepath, att.content);

            db.prepare(
                `INSERT INTO mail_attachments (message_id, filename, filepath, content_type, size_bytes, created_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).run(messageDbId, filename, filepath, att.contentType || 'application/octet-stream', att.size || att.content.length);
        } catch (err) {
            console.error(`[mail] Fejl ved gem af vedhæftning "${filename}":`, err.message);
        }
    }
}

// ─── POLLING ────────────────────────────────────────────

let pollingTimers = [];

async function startPolling() {
    // Ryd evt. eksisterende timers
    pollingTimers.forEach(t => clearInterval(t));
    pollingTimers = [];

    // Bon@ postkasse
    if (getSetting('imap_bon_enabled') === '1') {
        const interval = parseInt(getSetting('imap_bon_interval') || '5') * 60 * 1000;
        const config = {
            host: getSetting('imap_bon_host'),
            port: getSetting('imap_bon_port'),
            user: getSetting('imap_bon_user'),
            password: process.env.IMAP_BON_PASSWORD || '',
            prefix: 'bon'
        };

        // Poll med det samme
        pollMailbox(config).catch(err => console.error('[mail] Første bon-poll fejl:', err.message));
        pollingTimers.push(setInterval(() => pollMailbox(config).catch(err => console.error('[mail] bon-poll:', err.message)), interval));
        console.log(`[mail] Bon@-polling startet (hvert ${interval / 60000} min)`);
    }

    // Kontakt@ postkasse
    if (getSetting('imap_kontakt_enabled') === '1') {
        const interval = parseInt(getSetting('imap_kontakt_interval') || '5') * 60 * 1000;
        const config = {
            host: getSetting('imap_kontakt_host'),
            port: getSetting('imap_kontakt_port'),
            user: getSetting('imap_kontakt_user'),
            password: process.env.IMAP_KONTAKT_PASSWORD || '',
            prefix: 'kontakt'
        };

        pollMailbox(config).catch(err => console.error('[mail] Første kontakt-poll fejl:', err.message));
        pollingTimers.push(setInterval(() => pollMailbox(config).catch(err => console.error('[mail] kontakt-poll:', err.message)), interval));
        console.log(`[mail] Kontakt@-polling startet (hvert ${interval / 60000} min)`);
    }

    if (pollingTimers.length === 0) {
        console.log('[mail] Ingen IMAP-postkasser aktiveret');
    }
}

module.exports = {
    sendMail,
    sendFromTemplate,
    startPolling,
    renderTemplate,
    getPollState,
    // Legacy compat (for routes/mail.js test endpoint)
    parseTag: (subject) => {
        const r = parseSubject(subject);
        if (r.bonNumber) return { type: 'bon', ref: r.bonNumber };
        if (r.customerNumber) return { type: 'customer', ref: r.customerNumber };
        return { type: null, ref: null };
    }
};
