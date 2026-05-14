// services/mailService.js
// Thread-based mail: SMTP afsendelse + read-only IMAP polling + tag-routing
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

// ─── AUTO-IGNORE PATTERNS ───────────────────────────────
// Indgående mails der matcher disse mønstre indsættes direkte med
// status='ignored' (ikke 'open') så de aldrig vises i CRM Indbakke.
//
// Skal holdes synkront med db/migrations/066_cleanup_unmatched_mail.sql,
// der rydder eksisterende ophobning ved deploy.

const AUTO_IGNORE_FROM_PATTERNS = [
    /@hubspot\.com$/i,                  // HubSpot incl. alle subdomæner
    /@jotform\.com$/i,                  // Jotform form-notifikationer
    /^postmaster@/i,                    // Bounce-notifikationer
    /^Mailer-Daemon@/i,                 // Bounce-notifikationer (alt-stavning)
    /antispam@/i,                       // Antispam-systemer
    /@robot\.simply\.com$/i,            // Simply.com robot-mails
];

const AUTO_IGNORE_SUBJECT_PATTERNS = [
    /^Autosvar:/i,                      // Dansk out-of-office
    /^Out of Office:/i,                 // Engelsk out-of-office
    /^Automatic reply:/i,               // Engelsk auto-svar
];

function shouldAutoIgnore(fromAddr, subject) {
    if (fromAddr) {
        for (const pat of AUTO_IGNORE_FROM_PATTERNS) {
            if (pat.test(fromAddr)) return true;
        }
    }
    if (subject) {
        for (const pat of AUTO_IGNORE_SUBJECT_PATTERNS) {
            if (pat.test(subject)) return true;
        }
    }
    return false;
}

// ─── HELPERS ────────────────────────────────────────────

function getSetting(key) {
    return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

/**
 * Erstat {{variabel}} placeholders + append signatur.
 *
 * ctx er en valgfri kontekst der bruges til universelle variabler som {{booking_link}}:
 *   - customerId (eller vars.customer_id) — påkrævet for at booking_link rendres
 *   - userId — sælger der får tildelt token
 *   - bookingFlow — 'smagning' eller 'kontakt' (default: 'smagning')
 *   - bookingIntent — meeting_type-key der forvælges (kun smagning)
 *   - appendSignature — sæt false for at springe signatur over (fx subject)
 */
function renderTemplate(body, vars = {}, ctx = {}) {
    let result = body;

    // 1. Standard {{variabel}} substitution
    for (const [key, val] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val ?? '');
    }

    // 2. {{booking_link}} — universel: virker i ALLE skabeloner
    if (result.includes('{{booking_link}}')) {
        const customerId = ctx.customerId || vars.customer_id || null;
        const baseUrl = (getSetting('booking_public_url_base') || '').replace(/\/+$/, '');
        if (customerId && baseUrl) {
            const flow = ctx.bookingFlow || 'smagning';
            const ttlDays = parseInt(getSetting('booking_token_ttl_days') || '60');
            const token = generateBookingToken({
                customer_id: customerId,
                sales_user_id: ctx.userId || null,
                flow,
                intent_meeting_type_key: ctx.bookingIntent || null,
                ttl_days: ttlDays
            });
            // Kort URL — server-side redirect i routes/booking-redirect.js håndterer
            // open-tracking + 302 til tools-siden (baseret på token's flow-felt).
            const url = `${baseUrl}/b/${token}`;
            result = result.replace(/\{\{booking_link\}\}/g, url);
        } else {
            // Manglende customer_id eller base URL → fjern placeholder så mailen ikke får
            // en halv URL eller en synlig {{booking_link}}-streng.
            if (!baseUrl) {
                console.warn('[mail] {{booking_link}} sprunget over: booking_public_url_base er ikke sat');
            } else if (!customerId) {
                console.warn('[mail] {{booking_link}} sprunget over: customerId mangler i context');
            }
            result = result.replace(/\{\{booking_link\}\}/g, '');
        }
    }

    // 3. Signatur (kun body — ikke subject)
    if (ctx.appendSignature !== false) {
        const sig = getSetting('mail_signature');
        if (sig) {
            result += '\n\n--\n' + sig;
        }
    }
    return result;
}

/**
 * Generér (eller genbrug) et booking-token til mail-link.
 *
 * P4-idempotens: hvis der findes et eksisterende ubrugt token for samme
 * (customer, sælger, flow, intent) som ikke udløber inden N dage, genbruges det.
 * Det forhindrer at samme mail genereret 5 gange skaber 5 tokens.
 *
 * Synkron — node:sqlite + crypto.randomBytes er begge sync.
 */
function generateBookingToken({ customer_id, sales_user_id = null, flow = 'smagning', intent_meeting_type_key = null, ttl_days = 60 }) {
    if (!customer_id) throw new Error('generateBookingToken: customer_id er påkrævet');

    const db = getDb();

    // Slå intent op (key → id)
    let intentId = null;
    if (intent_meeting_type_key) {
        const mt = db.prepare('SELECT id FROM meeting_types WHERE key = ?').get(intent_meeting_type_key);
        intentId = mt?.id || null;
    }

    // Idempotens-tjek (P4): genbrug eksisterende ubrugt token hvis udløb > reuse-grænse
    const reuseMinDays = parseInt(getSetting('booking_token_reuse_min_days') || '7');
    const existing = db.prepare(`
        SELECT token FROM booking_tokens
        WHERE customer_id = ?
          AND COALESCE(sales_user_id, 0) = COALESCE(?, 0)
          AND flow = ?
          AND COALESCE(intent_meeting_type_id, 0) = COALESCE(?, 0)
          AND booking_activity_id IS NULL
          AND expires_at > datetime('now', '+' || ? || ' days')
        ORDER BY created_at DESC
        LIMIT 1
    `).get(customer_id, sales_user_id, flow, intentId, reuseMinDays);

    if (existing) return existing.token;

    // Ellers generér nyt token
    const token = crypto.randomBytes(8).toString('hex'); // 16 hex-tegn

    const customer = db.prepare('SELECT company_id FROM customers WHERE id = ?').get(customer_id);
    const expiresAt = new Date(Date.now() + ttl_days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(`
        INSERT INTO booking_tokens (token, customer_id, company_id, sales_user_id, flow,
            intent_meeting_type_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token, customer_id, customer?.company_id || null, sales_user_id, flow, intentId, expiresAt);

    return token;
}

// ─── SMTP ───────────────────────────────────────────────

/**
 * Opret SMTP-transport.
 * @param {string} prefix - 'smtp' (standard) eller 'smtp_kontakt'
 */
function createTransport(prefix = 'smtp') {
    // Test-mode: når NODE_ENV='test' eller en eksplicit mock er sat,
    // returnér en in-memory transport der opfanger sendMail-kald i _sentMails
    // i stedet for at lave faktisk SMTP-forbindelse. Bruges af test-runnere.
    if (_mockTransport) return _mockTransport;
    if (process.env.NODE_ENV === 'test') return _autoMockTransport;

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

// ─── Test-mode-guard ────────────────────────────────────
//
// Når NODE_ENV='test', erstatter mailService automatisk createTransport med
// en in-memory mock der pusher sendMail-options til _sentMails-bufferen.
// DB-rows (mail_threads + mail_messages) oprettes som normalt — mocken
// erstatter kun det udgående netværkskald.
//
// Test-runnere læser bufferen via routes/test-mail.js (GET /api/test/sent-mails).

let _mockTransport = null;
const _sentMails = [];

const _autoMockTransport = {
    sendMail: async (opts) => {
        _sentMails.push({
            ...opts,
            _capturedAt: new Date().toISOString()
        });
        return { messageId: `<auto-mock-${Date.now()}@test>` };
    },
    verify: async () => true
};

function _setMockTransport(mock) {
    _mockTransport = mock;
}

function _clearMockTransport() {
    _mockTransport = null;
}

function _getSentMails() {
    return _sentMails.slice();
}

function _clearSentMails() {
    _sentMails.length = 0;
}

/**
 * Send en mail via SMTP. Gemmer i mail_threads + mail_messages.
 */
async function sendMail({ to, subject, text, context, bonId = null, customerId = null, purchaseOrderId = null, supplierId = null, inReplyTo = null, references = null, smtpPrefix = 'smtp', userId = null, attachments = [] }) {
    const enabledKey = smtpPrefix === 'smtp_kontakt' ? 'smtp_kontakt_enabled' : 'smtp_enabled';
    if (getSetting(enabledKey) !== '1') {
        throw new Error(`SMTP (${smtpPrefix}) er ikke aktiveret`);
    }

    const transport = createTransport(smtpPrefix);
    if (!transport) throw new Error(`SMTP (${smtpPrefix}) ikke konfigureret`);

    // Build tag and inject into subject — kun hvis tagget ikke allerede er i subject
    // (skabeloner kan bruge {{tag}} direkte, så vi undgår dobbelt-tag)
    const tag = context ? buildTag(context) : '';
    const finalSubject = (tag && !subject.includes(tag)) ? `${tag} ${subject}` : subject;

    const from = getSetting(`${smtpPrefix}_from`) || getSetting(`${smtpPrefix}_user`);

    // Find or create thread
    const db = getDb();
    let threadId;

    if (purchaseOrderId) {
        const existing = db.prepare(
            `SELECT id FROM mail_threads WHERE purchase_order_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get(purchaseOrderId);
        threadId = existing?.id;
    } else if (supplierId) {
        const existing = db.prepare(
            `SELECT id FROM mail_threads WHERE supplier_id = ? AND purchase_order_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
        ).get(supplierId);
        threadId = existing?.id;
    } else if (bonId) {
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
            `INSERT INTO mail_threads (bon_id, customer_id, purchase_order_id, supplier_id, subject, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
        ).run(bonId, customerId, purchaseOrderId, supplierId, finalSubject);
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

    // Resolve attachments (attachment_id → file on disk)
    let resolvedAttachments = [];
    if (attachments.length > 0) {
        for (const att of attachments) {
            const row = db.prepare('SELECT file_name, file_path, file_type FROM attachments WHERE id = ?')
                .get(att.attachment_id);
            if (!row) throw new Error(`Vedhæftning ${att.attachment_id} ikke fundet`);
            if (!fs.existsSync(row.file_path)) throw new Error(`Fil ikke fundet på disk: ${row.file_name}`);
            const stat = fs.statSync(row.file_path);
            const mime = row.file_type === 'pdf' ? 'application/pdf'
                : row.file_type === 'image' ? 'image/png'
                : 'application/octet-stream';
            resolvedAttachments.push({
                path: row.file_path,
                filename: row.file_name,
                contentType: mime,
                size: stat.size
            });
        }
        // Update has_attachments flag
        db.prepare('UPDATE mail_messages SET has_attachments = 1 WHERE id = ?').run(messageDbId);
        // Insert mail_attachments rows for history
        for (const ra of resolvedAttachments) {
            db.prepare(`INSERT INTO mail_attachments (message_id, filename, file_path, mime_type, size_bytes, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))`)
                .run(messageDbId, ra.filename, ra.path, ra.contentType, ra.size);
        }
    }

    // Send via SMTP
    const mailOptions = {
        from,
        to,
        subject: finalSubject,
        text
    };
    if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
    if (references) mailOptions.references = references;
    if (resolvedAttachments.length > 0) {
        mailOptions.attachments = resolvedAttachments;
    }

    const info = await transport.sendMail(mailOptions);

    // Update message with SMTP messageId
    db.prepare(`UPDATE mail_messages SET message_id = ? WHERE id = ?`).run(info.messageId, messageDbId);

    // SSE broadcast
    broadcast('mail_sent', { bon_id: bonId, customer_id: customerId, purchase_order_id: purchaseOrderId, supplier_id: supplierId, thread_id: threadId });
    if (purchaseOrderId) {
        broadcast('po_mail_sent', { purchase_order_id: purchaseOrderId, thread_id: threadId });
    }
    if (supplierId && !purchaseOrderId) {
        broadcast('supplier_mail_sent', { supplier_id: supplierId, thread_id: threadId });
    }

    return { messageId: info.messageId, threadId, subject: finalSubject };
}

/**
 * Send mail fra skabelon.
 *
 * bookingFlow / bookingIntent videregives til renderTemplate så {{booking_link}}
 * kan generere et token bundet til kunde + sælger + flow + intent.
 */
async function sendFromTemplate({ templateKey, to, vars, bonId = null, customerId = null, purchaseOrderId = null, supplierId = null, context = null, userId = null, attachments = [], smtpPrefix = 'smtp', bookingFlow = 'smagning', bookingIntent = null }) {
    const tmpl = getDb().prepare('SELECT subject, body_text FROM mail_templates WHERE key = ?').get(templateKey);
    if (!tmpl) throw new Error(`Skabelon '${templateKey}' ikke fundet`);

    // Gør {{tag}} tilgængelig i skabeloner — genereres fra context via settings-prefix
    const enrichedVars = { ...vars };
    if (context && !enrichedVars.tag) {
        enrichedVars.tag = buildTag(context);
    }

    const renderCtx = { customerId, userId, bookingFlow, bookingIntent };

    // Subject må aldrig have signatur appended
    const subject = renderTemplate(tmpl.subject, enrichedVars, { ...renderCtx, appendSignature: false });
    const text    = renderTemplate(tmpl.body_text, enrichedVars, renderCtx);

    return sendMail({ to, subject, text, context, bonId, customerId, purchaseOrderId, supplierId, userId, attachments, smtpPrefix });
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

            let totalMsgs = 0;
            let uidSkipped = 0;

            for await (const msg of msgs) {
                totalMsgs++;
                try {
                    // UID-dedup er vores filter — IKKE Seen-flag
                    // (Bon v1 markerer mails som Seen, så vi kan ikke bruge det)

                    // Skip if UID already processed
                    const db = getDb();
                    const known = db.prepare(
                        `SELECT 1 FROM mail_messages WHERE imap_uid = ? AND mailbox = ?
                         UNION
                         SELECT 1 FROM mail_unmatched WHERE imap_uid = ? AND mailbox = ?`
                    ).get(msg.uid, user, msg.uid, user);
                    if (known) { uidSkipped++; continue; }

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
            console.log(`[mail] Poll ${user}: ${totalMsgs} total, ${uidSkipped} already known, ${newCount} new, ${errors} errors`);
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
    let purchaseOrderId = null;
    let supplierId = null;

    // 1. In-Reply-To matching
    if (inReplyTo && !threadId) {
        const ref = db.prepare(
            `SELECT thread_id FROM mail_messages WHERE message_id = ?`
        ).get(inReplyTo);
        if (ref) {
            threadId = ref.thread_id;
            // Load bon_id/customer_id/purchase_order_id/supplier_id from thread
            const thread = db.prepare(`SELECT bon_id, customer_id, purchase_order_id, supplier_id FROM mail_threads WHERE id = ?`).get(threadId);
            if (thread) {
                bonId = thread.bon_id;
                customerId = thread.customer_id;
                purchaseOrderId = thread.purchase_order_id;
                supplierId = thread.supplier_id;
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
        } else if (tagResult.routing === 'purchase_order') {
            const po = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(tagResult.purchaseOrderNumber);
            if (po) purchaseOrderId = po.id;
        } else if (tagResult.routing === 'supplier') {
            const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(tagResult.supplierNumber);
            if (sup) supplierId = sup.id;
        } else if (tagResult.routing === 'customer') {
            customerId = tagResult.customerNumber;
        }

        // Find or create thread if we have a match
        if (bonId || customerId || purchaseOrderId || supplierId) {
            // Try to find existing active thread
            if (purchaseOrderId) {
                const existing = db.prepare(
                    `SELECT id FROM mail_threads WHERE purchase_order_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
                ).get(purchaseOrderId);
                threadId = existing?.id;
            }
            if (!threadId && supplierId) {
                const existing = db.prepare(
                    `SELECT id FROM mail_threads WHERE supplier_id = ? AND purchase_order_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 1`
                ).get(supplierId);
                threadId = existing?.id;
            }
            if (!threadId && bonId) {
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
                    `INSERT INTO mail_threads (bon_id, customer_id, purchase_order_id, supplier_id, subject, status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
                ).run(bonId, customerId, purchaseOrderId, supplierId, subject);
                threadId = ins.lastInsertRowid;
            } else {
                db.prepare(`UPDATE mail_threads SET updated_at = datetime('now') WHERE id = ?`).run(threadId);
            }
        }
    }

    // 3. Unmatched — no thread, no tag
    if (!threadId) {
        const forwardInfo = parseForwardedSender(bodyText);
        const autoIgnore = shouldAutoIgnore(fromAddr, subject);

        // Indsæt direkte med status='ignored' for kendte spam/auto-afsendere,
        // så de ikke ophober sig i CRM Indbakke. Patterns matcher migration 066.
        db.prepare(
            `INSERT INTO mail_unmatched (imap_uid, mailbox, message_id, from_email, from_name, subject, body_text, received_at,
             parsed_email, parsed_name, parsed_company, status, handled_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(
            uid, mailbox, messageId, fromAddr, fromName, subject, bodyText, receivedAt,
            forwardInfo?.email || null, forwardInfo?.name || null, forwardInfo?.company || null,
            autoIgnore ? 'ignored' : 'open',
            autoIgnore ? new Date().toISOString() : null
        );

        if (autoIgnore) {
            console.log(`[mail] Auto-ignored: "${subject}" fra ${fromAddr}`);
            return;
        }

        // Count unmatched for SSE (kun 'open' tæller)
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

    // Look up bon_number for SSE payload
    let bonNumber = null;
    if (bonId) {
        const bon = db.prepare(`SELECT bon_number FROM bons WHERE id = ?`).get(bonId);
        if (bon) bonNumber = bon.bon_number;
    }

    // Look up supplier_name for PO SSE payload
    let supplierName = null;
    if (purchaseOrderId) {
        const po = db.prepare(`SELECT s.name FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id WHERE po.id = ?`).get(purchaseOrderId);
        if (po) supplierName = po.name;
    }

    // Look up supplier_name for free supplier-thread SSE
    let supplierStandaloneName = null;
    if (supplierId && !purchaseOrderId) {
        const s = db.prepare(`SELECT name FROM suppliers WHERE id = ?`).get(supplierId);
        if (s) supplierStandaloneName = s.name;
    }

    console.log(`[mail] 📨 Broadcasting mail_received: bon_id=${bonId}, bon_number=${bonNumber}, po=${purchaseOrderId}, supplier=${supplierId}, thread=${threadId}, unread=${unreadCount}`);
    broadcast('mail_received', { bon_id: bonId, bon_number: bonNumber, customer_id: customerId, purchase_order_id: purchaseOrderId, supplier_id: supplierId, thread_id: threadId, unread_count: unreadCount });

    if (purchaseOrderId) {
        broadcast('po_mail_received', { purchase_order_id: purchaseOrderId, thread_id: threadId, supplier_name: supplierName, unread_count: unreadCount });
    }
    if (supplierId && !purchaseOrderId) {
        broadcast('supplier_mail_received', { supplier_id: supplierId, thread_id: threadId, supplier_name: supplierStandaloneName, unread_count: unreadCount });
    }

    console.log(`[mail] Indgående mail → thread ${threadId} (bon=${bonId}, customer=${customerId}, po=${purchaseOrderId}, supplier=${supplierId})`);
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
                `INSERT INTO mail_attachments (message_id, filename, file_path, mime_type, size_bytes, created_at)
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

        // Ingen umiddelbar poll — vent til første interval (giver SSE-klienter tid til at connecte)
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

        pollingTimers.push(setInterval(() => pollMailbox(config).catch(err => console.error('[mail] kontakt-poll:', err.message)), interval));
        console.log(`[mail] Kontakt@-polling startet (hvert ${interval / 60000} min)`);
    }

    if (pollingTimers.length === 0) {
        console.log('[mail] Ingen IMAP-postkasser aktiveret');
    }
}

/**
 * Manuel poll af alle aktive postkasser.
 */
async function triggerPoll() {
    const configs = [];
    if (getSetting('imap_bon_enabled') === '1') {
        configs.push({
            host: getSetting('imap_bon_host'),
            port: getSetting('imap_bon_port'),
            user: getSetting('imap_bon_user'),
            password: process.env.IMAP_BON_PASSWORD || '',
            prefix: 'bon'
        });
    }
    if (getSetting('imap_kontakt_enabled') === '1') {
        configs.push({
            host: getSetting('imap_kontakt_host'),
            port: getSetting('imap_kontakt_port'),
            user: getSetting('imap_kontakt_user'),
            password: process.env.IMAP_KONTAKT_PASSWORD || '',
            prefix: 'kontakt'
        });
    }
    for (const cfg of configs) {
        try { await pollMailbox(cfg); }
        catch (err) { console.error(`[mail] triggerPoll ${cfg.prefix}:`, err.message); }
    }
}

module.exports = {
    sendMail,
    sendFromTemplate,
    startPolling,
    triggerPoll,
    renderTemplate,
    generateBookingToken,
    getPollState,
    // Test-mode-guard (kun til runner-brug)
    _setMockTransport,
    _clearMockTransport,
    _getSentMails,
    _clearSentMails,
    // Legacy compat
    parseTag: (subject) => {
        const r = parseSubject(subject);
        if (r.bonNumber) return { type: 'bon', ref: r.bonNumber };
        if (r.customerNumber) return { type: 'customer', ref: r.customerNumber };
        return { type: null, ref: null };
    }
};
