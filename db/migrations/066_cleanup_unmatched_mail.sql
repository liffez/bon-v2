-- 066_cleanup_unmatched_mail.sql
--
-- Engangs-oprydning af ophobede ufordelte mails (status='open' i mail_unmatched).
-- Markerer auto-afsendere som 'ignored' så de forsvinder fra CRM Indbakke-badget.
--
-- Patterns matcher præcis hvad scripts/cleanup-unmatched-mail.js gør, men her som
-- en migration så Hetzner får samme oprydning automatisk ved næste deploy.
--
-- Forventet effekt: ~1335 lokalt + tilsvarende på Hetzner → status 'ignored'.
-- Tilbage står ~62-77 ægte kundemails der skal gennemgås manuelt i CRM Indbakke.
--
-- Forebyggelse af fremtidig ophobning sker i services/mailService.js
-- (auto-ignore samme patterns ved IMAP import) — se denne migrations-besked.

UPDATE mail_unmatched
SET status = 'ignored',
    handled_at = CURRENT_TIMESTAMP
WHERE status = 'open'
  AND (
    -- HubSpot (gamle form-notifikationer + alle subdomæner)
    from_email LIKE '%hubspot.com'
    -- Jotform (gamle form-submissions)
    OR from_email LIKE '%@jotform.com'
    -- Bounce-systemer
    OR from_email LIKE 'postmaster@%'
    OR from_email LIKE 'Mailer-Daemon@%'
    OR from_email LIKE '%antispam@%'
    OR from_email LIKE '%@robot.simply.com'
    -- Auto-svar (typisk fra ferie/orlov-svar)
    OR subject LIKE 'Autosvar:%'
    OR subject LIKE 'Out of Office:%'
    OR subject LIKE 'Automatic reply:%'
  );
