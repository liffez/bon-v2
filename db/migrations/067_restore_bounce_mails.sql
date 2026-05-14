-- 067_restore_bounce_mails.sql
--
-- Korrektion til migration 066: bounces blev fejlagtigt markeret som ignored.
-- De er IKKE skraldepost — de er forretningskritiske signaler om at vi har
-- en kunde med forkert email. Hver "Undelivered Mail" fra postmaster betyder
-- at en bekræftelse eller faktura ikke nåede frem, og kunden skal kontaktes
-- med opdateret kontakt-info.
--
-- Denne migration sætter dem tilbage til 'open' så de vises i CRM Indbakke,
-- men kun hvis de blev ignoret af migration 066 (status='ignored' + handled_by_user_id IS NULL).
--
-- Mailservice.js har fjernet bounce-mønstrene fra AUTO_IGNORE_FROM_PATTERNS,
-- så fremtidige bounces lander direkte med status='open'.

UPDATE mail_unmatched
SET status = 'open',
    handled_at = NULL
WHERE status = 'ignored'
  AND handled_by_user_id IS NULL  -- kun auto-ignored, ikke håndteret manuelt
  AND (
    from_email LIKE 'postmaster@%'
    OR from_email LIKE 'Mailer-Daemon@%'
    OR from_email LIKE 'MAILER-DAEMON@%'
    OR from_email LIKE '%antispam@%'
    OR from_email LIKE '%@robot.simply.com'
  );
