-- ==========================================
-- 009_notification_client_reads.sql
-- Tilføj client_id til notification_reads og
-- gør user_id nullable (ingen auth endnu).
-- SQLite kan ikke ALTER COLUMN, så tabellen genskabes.
-- ==========================================

CREATE TABLE notification_reads_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id),
    user_id         INTEGER REFERENCES users(id),
    client_id       TEXT,
    read_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(notification_id, client_id)
);

INSERT INTO notification_reads_new (id, notification_id, user_id, read_at)
    SELECT id, notification_id, user_id, read_at FROM notification_reads;

DROP TABLE notification_reads;
ALTER TABLE notification_reads_new RENAME TO notification_reads;

CREATE INDEX idx_notif_reads_client ON notification_reads(client_id);
CREATE INDEX idx_notif_reads_notif  ON notification_reads(notification_id);
