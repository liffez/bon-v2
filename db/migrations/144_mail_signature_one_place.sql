-- 144: Mail-signatur ét sted
--
-- Signaturen (settings.mail_signature) lå i renderTemplate() og ramte derfor KUN
-- skabelon-mails sendt af serveren. Alle mails et menneske skriver — bon-mail,
-- CRM Kunde 360°, indbakke-svar, leverandørmail, svar på indkøbsordre — gik ud
-- uden. I driften: 409 udgående mails, 177 med signatur.
--
-- Signaturen appendes nu i sendMail(), altså ét sted for alle veje ind.
-- To ting skal ryddes for at det ikke giver dobbelt hilsen:

-- 1) Pr-skabelon-fravalg. Interne notifikationer går til os selv og skal ikke
--    slutte med firmaets adresse og telefonnummer.
ALTER TABLE mail_templates ADD COLUMN append_signature INTEGER NOT NULL DEFAULT 1;

UPDATE mail_templates SET append_signature = 0
 WHERE key IN ('web_order_owner_notification', 'booking_internal_notification');

-- 2) Skabeloner der selv bar en hilsen. De gav allerede dobbelt hilsen i drift
--    (verificeret på afsendt kundemail): skabelonens "Med venlig hilsen" fulgt af
--    signaturens egen. Halerne fjernes så signaturen er eneste kilde.
--
--    Suffix-matchet er bevidst eksakt: er en skabelon redigeret i Settings og
--    ser anderledes ud, rører vi den ikke — hellere uændret end forkert klippet.
UPDATE mail_templates
   SET body_text = substr(body_text, 1, length(body_text) - length(char(10) || char(10) || 'Med venlig hilsen' || char(10) || '{{firmanavn}}'))
 WHERE key = 'booking_confirmation'
   AND body_text LIKE '%' || char(10) || char(10) || 'Med venlig hilsen' || char(10) || '{{firmanavn}}';

UPDATE mail_templates
   SET body_text = substr(body_text, 1, length(body_text) - length(char(10) || char(10) || 'Med venlig hilsen' || char(10) || 'Ristet Rug'))
 WHERE key = 'order_email'
   AND body_text LIKE '%' || char(10) || char(10) || 'Med venlig hilsen' || char(10) || 'Ristet Rug';

UPDATE mail_templates
   SET body_text = substr(body_text, 1, length(body_text) - length(char(10) || char(10) || 'Med venlig hilsen'))
 WHERE key = 'web_order_confirmation'
   AND body_text LIKE '%' || char(10) || char(10) || 'Med venlig hilsen';

--    menu_svar og menu_total_proce (jeres egne, sendt fra bon-draweren) sluttede
--    med "DBH / Team Ristet Rug". De har hidtil slet ingen signatur fået, fordi
--    bon-draweren udfolder skabelonen i browseren og sender ren tekst. Nu får de
--    den — og så er hilsenen dobbelt. Ud med den.
--
--    Skabelonerne findes kun i drift, ikke i dev/test. Uden match sker der intet.
UPDATE mail_templates
   SET body_text = substr(body_text, 1, length(body_text) - length(char(10) || char(10) || 'DBH' || char(10) || 'Team Ristet Rug'))
 WHERE key IN ('menu_svar', 'menu_total_proce')
   AND body_text LIKE '%' || char(10) || char(10) || 'DBH' || char(10) || 'Team Ristet Rug';

UPDATE settings
   SET description = 'Afsendersignatur — tilføjes automatisk nederst i alle udgående mails (kan fravælges pr. skabelon)'
 WHERE key = 'mail_signature';
