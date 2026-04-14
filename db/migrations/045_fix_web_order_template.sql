-- Fix mail-skabelon: brug korrekt tag-format (#b-XXXX) så IMAP-parser matcher svar
UPDATE mail_templates SET
    subject = 'Tak for din bestilling ({{bonNummer}}) #b-{{bonNummerTal}}',
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
