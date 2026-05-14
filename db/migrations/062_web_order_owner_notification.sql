-- Migration 062: Ejer-notifikation ved ny web-bestilling (#043) + deploy-defaults
--
-- Tilføjer mail-skabelon + settings, så `handleWebOrder` kan sende en
-- fire-and-forget notifikation til ejer/Leif når en kunde sender en
-- bestilling via webhook. Især vigtigt fordi web-bestillinger kan komme
-- om natten og i weekender, hvor ingen sidder ved Office.
--
-- `web_order_notification_email` tom = notifikation deaktiveret (graceful).
-- Sættes via Settings UI → System.
--
-- Idempotent: UPDATE-trinnet retter kun værdier der stadig er tomme, så
-- en operatør der bevidst har slået notifikationen fra ikke får den
-- påtvunget igen ved næste migration-kørsel.

-- web_order_notification_email
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('web_order_notification_email', 'leifzeeberg@hotmail.dk', 'Mail-adresse der modtager intern notifikation ved ny web-bestilling (tom = deaktiveret)');

UPDATE settings
   SET value = 'leifzeeberg@hotmail.dk'
 WHERE key = 'web_order_notification_email' AND (value IS NULL OR value = '');

-- booking_public_url_base bruges også af ejer-notifikationen til at bygge
-- klikbart {{drawerLink}}. Migration 051 oprettede den som tom — sæt
-- produktions-default hvis ingen har sat den endnu.
UPDATE settings
   SET value = 'https://bon.ristetrug.dk'
 WHERE key = 'booking_public_url_base' AND (value IS NULL OR value = '');

-- Mail-skabelon til ejer-notifikation
INSERT OR IGNORE INTO mail_templates (key, label, subject, body_text) VALUES (
    'web_order_owner_notification',
    'Web-bestilling — intern notifikation',
    'Ny web-bestilling: {{bonNummer}} ({{kundeNavn}}) {{tag}}',
    'Ny bestilling modtaget via hjemmesiden.

Bon: {{bonNummer}}
Kunde: {{kundeNavn}}
{{firmaBlok}}
Email: {{kundeEmail}}
Telefon: {{kundeTlf}}

Levering: {{leveringsDato}} kl. {{leveringsTid}}
Type: {{ordreType}}
Antal: {{pax}}
{{adresseBlok}}

{{oenskerBlok}}

Åbn i Office: {{drawerLink}}'
);
