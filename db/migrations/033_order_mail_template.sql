-- 033: Mail-skabelon til leverandør-bestilling
-- Bruges af routes/orders.js ved send_email=true

INSERT OR IGNORE INTO mail_templates (key, label, subject, body_text) VALUES
('order_email', 'Bestilling til leverandør',
 'Bestilling fra Ristet Rug · {{dato}}',
 'Hej {{leverandoer}},

Hermed bestilling fra Ristet Rug:

{{vareliste}}

Ønsket levering: {{leveringsdato}}

Med venlig hilsen
Ristet Rug');
