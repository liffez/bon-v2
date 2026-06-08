-- 099_mail_unmatched_html.sql
-- Vis inline-billeder (CID) i UFORDELTE mails (CRM-indbakke).
-- Trådede mails fik HTML + inline-billeder i migration 094, men mail_unmatched
-- gemte kun body_text uden HTML/vedhæftninger — så CRM-indbakken viste den rå
-- [cid:...]-placeholder og ingen billeder.
--
-- 1) body_html på mail_unmatched.
-- 2) mail_attachments kan nu pege på enten en besked ELLER en ufordelt mail:
--    message_id gøres nullable + ny unmatched_id. Samme tabel → samme
--    inline-serve-endpoint (GET /api/attachments/mail/:id/inline) virker for begge.

ALTER TABLE mail_unmatched ADD COLUMN body_html TEXT;

CREATE TABLE mail_attachments_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER REFERENCES mail_messages(id),
    unmatched_id INTEGER REFERENCES mail_unmatched(id),
    filename     TEXT NOT NULL,
    mime_type    TEXT,
    size_bytes   INTEGER,
    file_path    TEXT,
    content_id   TEXT,
    is_inline    INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO mail_attachments_new
    (id, message_id, filename, mime_type, size_bytes, file_path, content_id, is_inline, created_at)
    SELECT id, message_id, filename, mime_type, size_bytes, file_path, content_id, is_inline, created_at
    FROM mail_attachments;

DROP TABLE mail_attachments;
ALTER TABLE mail_attachments_new RENAME TO mail_attachments;

CREATE INDEX IF NOT EXISTS idx_mail_attachments_msg ON mail_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_unmatched ON mail_attachments(unmatched_id);
