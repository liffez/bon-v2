// services/mailService.js
// SMTP afsendelse + IMAP polling + tag-routing
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { getDb } = require('../db/database');
const { broadcast } = require('../shared/sse');

// ─── HELPERS ─────────────────────────────────────────────

function getSetting(key) {
    return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
}

/**
 * Parse #B{num} eller #K{num} tags fra email-emne.
 */
function parseTag(subject) {
    const bonTag  = process.env.MAIL_BON_TAG      || 'B';
    const custTag = process.env.MAIL_CUSTOMER_TAG || 'K';
    const bonMatch  = subject.match(new RegExp(`#${bonTag}(\\d+)`));
    const custMatch = subject.match(new RegExp(`#${custTag}(\\d+)`));
    if (bonMatch)  return { type: 'bon',      ref: parseInt(bonMatch[1]) };
    if (custMatch) return { type: 'customer', ref: parseInt(custMatch[1]) };
    return { type: null, ref: null };
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

// ─── SMTP ────────────────────────────────────────────────

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
 * Send en mail via SMTP.
 * Gemmer i bon_mails hvis bonId er angivet.
 */
async function sendMail({ to, subject, bodyText, bonId = null, smtpPrefix = 'smtp' }) {
    const enabledKey = smtpPrefix === 'smtp_kontakt' ? 'smtp_kontakt_enabled' : 'smtp_enabled';
    if (getSetting(enabledKey) !== '1') {
        throw new Error(`SMTP (${smtpPrefix}) er ikke aktiveret`);
    }

    const transport = createTransport(smtpPrefix);
    if (!transport) throw new Error(`SMTP (${smtpPrefix}) ikke konfigureret`);

    const from = getSetting(`${smtpPrefix}_from`) || getSetting(`${smtpPrefix}_user`);
    const info = await transport.sendMail({
        from,
        to,
        subject,
        text: bodyText
    });

    // Gem udgående mail i bon_mails
    if (bonId) {
        getDb().prepare(`
            INSERT INTO bon_mails (bon_id, message_id, from_address, to_address, subject, body_text, direction, is_read, received_at)
            VALUES (?, ?, ?, ?, ?, ?, 'outbound', 1, CURRENT_TIMESTAMP)
        `).run(bonId, info.messageId, from, to, subject, bodyText);
    }

    return info;
}

/**
 * Send mail fra skabelon.
 */
async function sendFromTemplate({ templateKey, to, vars, bonId = null }) {
    const tmpl = getDb().prepare('SELECT subject, body_text FROM mail_templates WHERE key = ?').get(templateKey);
    if (!tmpl) throw new Error(`Skabelon '${templateKey}' ikke fundet`);

    const subject  = renderTemplate(tmpl.subject, vars);
    const bodyText = renderTemplate(tmpl.body_text, vars);

    return sendMail({ to, subject, bodyText, bonId });
}

// ─── IMAP ────────────────────────────────────────────────

/**
 * Poll én IMAP-postkasse for ulæste mails.
 */
async function pollMailbox(config) {
    const { host, port, user, password, prefix } = config;

    if (!host || !user || !password) return;

    const client = new ImapFlow({
        host,
        port: parseInt(port || '993'),
        secure: true,
        auth: { user, pass: password },
        logger: false
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');

        try {
            const msgs = client.fetch({ seen: false }, {
                uid: true,
                envelope: true,
                source: false
            });

            for await (const msg of msgs) {
                try {
                    await processInboundMail(msg, prefix);
                    // Markér som læst
                    await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
                } catch (err) {
                    console.error(`[mail] Fejl ved behandling af mail UID=${msg.uid}:`, err.message);
                }
            }
        } finally {
            lock.release();
        }
    } catch (err) {
        console.error(`[mail] IMAP fejl (${user}):`, err.message);
    } finally {
        try { await client.logout(); } catch (_) {}
    }
}

/**
 * Behandl en enkelt indgående mail.
 */
function processInboundMail(msg, prefix) {
    const db = getDb();
    const env = msg.envelope;
    const subject    = env.subject || '';
    const fromAddr   = env.from?.[0]?.address || '';
    const toAddr     = env.to?.[0]?.address || '';
    const messageId  = env.messageId || null;
    const inReplyTo  = env.inReplyTo || null;
    const receivedAt = env.date || new Date();

    const tag = parseTag(subject);

    if (tag.type === 'bon') {
        // Find bon via bon-nummer
        const bon = db.prepare('SELECT id FROM bons WHERE bon_number = ?').get(String(tag.ref));
        if (!bon) {
            console.warn(`[mail] Bon #${tag.ref} ikke fundet — mail ignoreret`);
            return;
        }

        db.prepare(`
            INSERT INTO bon_mails (bon_id, message_id, in_reply_to, from_address, to_address, subject, direction, is_read, matched_by, received_at)
            VALUES (?, ?, ?, ?, ?, ?, 'inbound', 0, ?, ?)
        `).run(bon.id, messageId, inReplyTo, fromAddr, toAddr, subject, `tag:#B${tag.ref}`, receivedAt.toISOString());

        // Tæl ulæste
        const unread = db.prepare('SELECT COUNT(*) as n FROM bon_mails WHERE bon_id = ? AND is_read = 0').get(bon.id).n;
        broadcast('bon_updated', { id: bon.id, unread_mail_count: unread });

        console.log(`[mail] Indgående mail linket til bon #${tag.ref} (id=${bon.id})`);

    } else if (tag.type === 'customer') {
        db.prepare(`
            INSERT INTO customer_mails (customer_id, message_id, in_reply_to, from_address, to_address, subject, direction, is_read, matched_by, received_at)
            VALUES (?, ?, ?, ?, ?, ?, 'inbound', 0, ?, ?)
        `).run(tag.ref, messageId, inReplyTo, fromAddr, toAddr, subject, `tag:#K${tag.ref}`, receivedAt.toISOString());

        console.log(`[mail] Indgående mail linket til kunde #${tag.ref}`);

    } else {
        console.log(`[mail] Ulæst mail uden tag: "${subject}" fra ${fromAddr}`);
    }
}

// ─── POLLING ─────────────────────────────────────────────

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

module.exports = { sendMail, sendFromTemplate, startPolling, parseTag, renderTemplate };
