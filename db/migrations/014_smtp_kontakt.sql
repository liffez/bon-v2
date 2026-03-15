-- ==========================================
-- 014_smtp_kontakt.sql
-- Udgående SMTP for kontakt@-postkasse
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('smtp_kontakt_host',     '',              'SMTP server for kontakt@ (fx mail.simply.com)'),
    ('smtp_kontakt_port',     '587',           'SMTP port for kontakt@ (587=STARTTLS, 465=SSL)'),
    ('smtp_kontakt_user',     '',              'SMTP brugernavn for kontakt@'),
    ('smtp_kontakt_from',     '',              'Afsenderadresse (fx kontakt@ristetrug.dk)'),
    ('smtp_kontakt_enabled',  '0',             '1 = udgående kontakt@ mail aktiv');
