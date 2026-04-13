-- Web orders: indbakke for bestillinger fra hjemmesidens formular
CREATE TABLE IF NOT EXISTS web_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status          TEXT NOT NULL DEFAULT 'ny'
                    CHECK (status IN ('ny', 'konverteret', 'afvist')),

    -- Kerneinformation fra formularen
    order_type      TEXT CHECK (order_type IN ('catering', 'pickup')),
    customer_name   TEXT,
    customer_email  TEXT,
    customer_phone  TEXT,
    company         TEXT,
    delivery_date   TEXT,
    delivery_time   TEXT,
    address_text    TEXT,
    address_lat     REAL,
    address_lon     REAL,
    address_postnr  TEXT,
    pax             INTEGER,
    wishes          TEXT,
    ean_info        TEXT,

    -- Rådata — hele JSON-body fra POST, så intet går tabt
    raw_data        TEXT NOT NULL,

    -- Kobling til bon når den oprettes
    bon_id          INTEGER REFERENCES bons(id),

    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_web_orders_status ON web_orders(status);
CREATE INDEX IF NOT EXISTS idx_web_orders_date   ON web_orders(delivery_date);

-- Mail-skabelon: auto-kvittering til kunden ved web-bestilling
INSERT OR IGNORE INTO mail_templates (key, label, subject, body_text) VALUES (
    'web_order_confirmation',
    'Web-bestilling kvittering',
    'Tak for din bestilling (#{{bonNummer}})',
    'Hej {{kundeNavn}},

Tak for din bestilling hos Ristet Rug! Vi har modtaget den og vender tilbage hurtigst muligt med bekræftelse og pris.

Bon-nummer: #{{bonNummer}}
Type: {{ordreType}}
Dato: {{leveringsDato}}
Tidspunkt: {{leveringsTid}}
Antal gæster: {{pax}}
{{adresseBlok}}
{{oenskerBlok}}

Du er velkommen til at svare på denne mail hvis du har spørgsmål.

Med venlig hilsen'
);

-- Settings: webhook secret
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('webhook_secret', '', 'Secret til validering af webhook-kald fra hjemmesiden (tomt = ingen validering)');
