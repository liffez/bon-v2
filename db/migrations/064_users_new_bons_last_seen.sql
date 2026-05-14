-- ==========================================
-- 064_users_new_bons_last_seen.sql
-- Mobile "Nye"-listen: per-bruger timestamp
-- for hvornår brugeren sidst åbnede Nye-tabben
-- eller trykkede "Marker alle læst".
-- ==========================================

ALTER TABLE users ADD COLUMN new_bons_last_seen_at DATETIME;

-- Index på bons.created_at — Nye-listen sorterer på dette
CREATE INDEX IF NOT EXISTS idx_bons_created_at
    ON bons(created_at);

-- Partial index på ulæste indkommende mails — Nye-listen filtrerer på dette.
-- (bon_mails-tabellen er renamet til _old_bon_mails; ny arkitektur bruger
--  mail_messages joined mod mail_threads med bon_id NOT NULL.)
CREATE INDEX IF NOT EXISTS idx_mail_messages_unread_in
    ON mail_messages(received_at)
    WHERE is_read = 0 AND direction = 'in';
