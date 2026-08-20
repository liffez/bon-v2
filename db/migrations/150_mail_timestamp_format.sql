-- 150_mail_timestamp_format.sql
-- ════════════════════════════════════════════════════════════
-- Ét tidsstempel-format i mail-tabellerne (#488).
--
-- Indgående tidsstempler blev skrevet med JavaScripts toISOString()
-- (`2026-08-10T15:49:24.000Z`), udgående med SQLites datetime('now')
-- (`2026-08-10 15:53:19`). Begge er UTC — kun formatet skiller.
--
-- Men de sammenlignes som TEKST, og 'T' (0x54) sorterer efter ' ' (0x20).
-- Derfor lagde enhver tråd med indgående som seneste aktivitet sig over
-- enhver tråd med udgående fra samme dag, uanset klokkeslæt:
--
--   2026-08-10T15:49:24.000Z   ← lå øverst
--   2026-08-10 17:25:31        ← lå under, selvom den er 1½ time nyere
--
-- Datodelen er ens-formateret, så sorteringen var korrekt PÅ TVÆRS af dage.
-- Kun inden for en dag skred den — hvilket typisk er dér man kigger.
--
-- Konverteringen er ren formatering. At begge sider er UTC er efterprøvet på
-- driftsdata: afstanden mellem en mails received_at (ISO) og dens created_at
-- (mellemrum) på samme række er 0–7 minutter — nøjagtigt IMAP-pollingens
-- interval. Var den ene lokal tid, ville forskellen have været ±1–2 timer.
--
-- Idempotent: WHERE-klausulen rammer kun rækker der stadig har 'T'.
-- ════════════════════════════════════════════════════════════

UPDATE mail_messages
   SET received_at = REPLACE(REPLACE(SUBSTR(received_at, 1, 19), 'T', ' '), 'Z', '')
 WHERE received_at LIKE '%T%';

UPDATE mail_unmatched
   SET received_at = REPLACE(REPLACE(SUBSTR(received_at, 1, 19), 'T', ' '), 'Z', '')
 WHERE received_at LIKE '%T%';

UPDATE mail_unmatched
   SET handled_at = REPLACE(REPLACE(SUBSTR(handled_at, 1, 19), 'T', ' '), 'Z', '')
 WHERE handled_at LIKE '%T%';

UPDATE mail_threads
   SET last_inbound_at = REPLACE(REPLACE(SUBSTR(last_inbound_at, 1, 19), 'T', ' '), 'Z', '')
 WHERE last_inbound_at LIKE '%T%';
