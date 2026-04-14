-- Fix mail-skabeloner: {{tag}} genereres fra context via settings-prefix
-- sendFromTemplate injecter {{tag}} fra buildTag(context)
-- sendMail prepender kun tag hvis det ikke allerede er i subject

-- Web-bestilling kvittering
UPDATE mail_templates SET
    subject = 'Tak for din bestilling ({{bonNummer}}) {{tag}}',
    body_text = 'Hej {{kundeNavn}},

Tak for din bestilling hos Ristet Rug! Vi har modtaget den og vender tilbage hurtigst muligt med en bekræftelse.

Bon-nummer: {{bonNummer}}
Type: {{ordreType}}
Dato: {{leveringsDato}}
Tidspunkt: {{leveringsTid}}
Antal gæster: {{pax}}
{{adresseBlok}}
{{oenskerBlok}}

Du er velkommen til at svare på denne mail hvis du har spørgsmål.

Med venlig hilsen'
WHERE key = 'web_order_confirmation';

-- Ordrebekræftelse (manuelt sendt fra bon-drawer)
UPDATE mail_templates SET
    subject = 'Bekræftelse af din bestilling ({{bonNummer}}) {{tag}}'
WHERE key = 'booking_confirmation';

-- Leverandør-ordremail (bruger allerede context korrekt via orders.js)
-- Ingen ændring nødvendig — tag prepend i sendMail håndterer det
