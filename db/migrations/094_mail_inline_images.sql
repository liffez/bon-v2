-- 094_mail_inline_images.sql
-- Spor inline (CID-refererede) billeder i mails så de kan vises i mail-visningen.
-- Indgående HTML-mails refererer billeder via <img src="cid:..."> hvor billedet
-- ligger som en relateret vedhæftning. Uden content_id kan vi ikke koble
-- cid-referencen til den gemte fil → billedet vises ikke.

ALTER TABLE mail_attachments ADD COLUMN content_id TEXT;
ALTER TABLE mail_attachments ADD COLUMN is_inline INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mail_attachments_msg ON mail_attachments(message_id);
