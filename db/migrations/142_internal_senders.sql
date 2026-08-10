-- 142_internal_senders.sql
--
-- Gør "intern afsender" til et begreb systemet kan styres med.
--
-- Baggrund: `info@ristetrug.dk` står i customers-tabellen som kunde 3005 under
-- firmaet Ristet Rug. Da Anne videresendte en kundemail til kontakt@, matchede
-- inbound-routingen derfor afsenderen mod OS SELV og lagde mailen i en tråd på
-- Ristet Rug (#k-3005). Den reelle afsender — kunden inde i den videresendte
-- besked — blev aldrig set, fordi forward-parseren først kører på den ufordelte
-- gren som mailen aldrig nåede.
--
-- Herefter springer routingen kunde-opslaget over for interne afsendere og
-- slår i stedet den videresendte afsender op. Listen er en setting, så nye
-- interne adresser (fx en ekstern bogholder der videresender) kan tilføjes
-- uden kodeændring.
--
-- Formatet er kommasepareret og accepterer begge former:
--   ristetrug.dk           → hele domænet er internt
--   bogholder@partner.dk   → kun den ene adresse
--
-- `companies.is_internal = 1` tæller som et ANDET, uafhængigt signal (se
-- services/internalIdentity.js) — så et firma markeret internt i CRM'et også
-- holdes ude af mail-routingen uden at skulle skrives ind her.

INSERT INTO settings (key, value)
SELECT 'internal_mail_domains',
       COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'mail_domain'), ''), 'ristetrug.dk')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'internal_mail_domains');
