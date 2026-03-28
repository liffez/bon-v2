-- 018_mail_threads.sql
-- Mail-system: tråde, beskeder, vedhæftninger, ufordelt indbakke
-- Erstatter bon_mails + customer_mails med et fleksibelt tråd-system

-- Bevar gamle tabeller som backup
ALTER TABLE bon_mails RENAME TO _old_bon_mails;
ALTER TABLE customer_mails RENAME TO _old_customer_mails;

-- ── Mail-tråde ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    bon_id INTEGER REFERENCES bons(id),
    customer_id INTEGER REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'archived')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_threads_bon      ON mail_threads(bon_id);
CREATE INDEX IF NOT EXISTS idx_mail_threads_customer  ON mail_threads(customer_id);

-- ── Mail-beskeder ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES mail_threads(id),
    message_id TEXT,                    -- Email Message-ID header
    in_reply_to TEXT,                   -- Reply-chain tracking
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    from_email TEXT NOT NULL,
    from_name TEXT,
    to_email TEXT NOT NULL,
    to_name TEXT,
    cc TEXT,                            -- JSON array
    subject TEXT NOT NULL,
    body_text TEXT,
    body_html TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    imap_uid INTEGER,                   -- IMAP UID for dedup
    mailbox TEXT,                       -- Mailbox-konto (bon@/kontakt@)
    sent_at DATETIME,
    received_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mail_messages_thread  ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid   ON mail_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread  ON mail_messages(is_read, direction);
CREATE INDEX IF NOT EXISTS idx_mail_messages_imap    ON mail_messages(imap_uid, mailbox);

-- ── Vedhæftninger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES mail_messages(id),
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    file_path TEXT,                     -- Sti i data/attachments/
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Ufordelt indbakke ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_unmatched (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mailbox TEXT NOT NULL,              -- 'bon@...' eller 'kontakt@...'
    message_id TEXT,
    imap_uid INTEGER,
    from_email TEXT,
    from_name TEXT,
    subject TEXT,
    body_text TEXT,
    received_at DATETIME,
    parsed_name TEXT,                   -- Forward-parse resultater
    parsed_email TEXT,
    parsed_company TEXT,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'linked', 'ignored')),
    linked_customer_id INTEGER REFERENCES customers(id),
    linked_bon_id INTEGER REFERENCES bons(id),
    handled_by_user_id INTEGER REFERENCES users(id),
    handled_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_unmatched_status   ON mail_unmatched(status);
CREATE INDEX IF NOT EXISTS idx_mail_unmatched_imap     ON mail_unmatched(imap_uid, mailbox);

-- ── Mail tag prefixes i settings ────────────────────────────
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('mail_tag_bon_prefix', 'b-', 'Mail-tag prefix for bonner (#b-3001)');
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('mail_tag_offer_prefix', 't-', 'Mail-tag prefix for tilbud (#t-3001)');
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('mail_tag_customer_prefix', 'k-', 'Mail-tag prefix for kunder (#k-600)');
