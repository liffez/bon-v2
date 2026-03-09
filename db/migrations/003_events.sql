-- ==========================================
-- 003_events.sql
-- Mail, flyver/notifikationer, geo,
-- leverings-events, changelog, vedhæftninger
-- ==========================================

-- ==========================================
-- MAIL (bon-korrespondance)
-- ==========================================

CREATE TABLE bon_mails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id      INTEGER NOT NULL REFERENCES bons(id),
    message_id  TEXT,           -- Email Message-ID header
    in_reply_to TEXT,           -- Email In-Reply-To header (reply-chain)
    from_address TEXT,
    to_address  TEXT,
    subject     TEXT,
    body_text   TEXT,
    body_html   TEXT,
    direction   TEXT NOT NULL
                CHECK (direction IN ('inbound', 'outbound')),
    is_read     INTEGER NOT NULL DEFAULT 0,
    is_flagged  INTEGER NOT NULL DEFAULT 0,  -- Kræver handling
    received_at DATETIME,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bon_mails_bon        ON bon_mails(bon_id);
CREATE INDEX idx_bon_mails_message_id ON bon_mails(message_id);

-- ==========================================
-- FLYVER / NOTIFIKATIONER
-- ==========================================
-- Flyvere er beskeder der sendes ved ændringer
-- på en bon. De blinker i øverste venstre hjørne
-- for alle andre end afsenderen, og forsvinder
-- først når de er klikket (læst).
-- I v2 logges beskederne så man kan se historikken.

CREATE TABLE notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id          INTEGER REFERENCES bons(id),    -- NULL = systembesked
    type            TEXT NOT NULL DEFAULT 'flyver'
                    CHECK (type IN ('flyver', 'status_change', 'reminder', 'system')),
    message         TEXT NOT NULL,
    priority        TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('normal', 'urgent')),
    sent_by_user_id INTEGER REFERENCES users(id),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tracker hvem der har set/klikket flyveren
CREATE TABLE notification_reads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    read_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(notification_id, user_id)
);

CREATE INDEX idx_notifications_bon      ON notifications(bon_id);
CREATE INDEX idx_notifications_created  ON notifications(created_at);
CREATE INDEX idx_notif_reads_user       ON notification_reads(user_id);
CREATE INDEX idx_notif_reads_notif      ON notification_reads(notification_id);

-- ==========================================
-- GEO / LEVERING
-- ==========================================

CREATE TABLE geo_calculations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id          INTEGER NOT NULL REFERENCES bons(id),
    address_id      INTEGER NOT NULL REFERENCES addresses(id),
    distance_meters REAL,
    duration_seconds REAL,
    route_geojson   TEXT,           -- Rutedata til kortvisning
    calculated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_geo_bon ON geo_calculations(bon_id);

CREATE TABLE delivery_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id              INTEGER NOT NULL REFERENCES bons(id),
    event_type          TEXT NOT NULL
                        CHECK (event_type IN
                            ('booked', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled')),
    provider            TEXT,           -- byekspressen | taxa | intern
    external_reference  TEXT,           -- Booking-ID hos budfirma
    notes               TEXT,
    user_id             INTEGER REFERENCES users(id),
    event_time          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_events_bon ON delivery_events(bon_id);

-- ==========================================
-- CHANGELOG (audit trail)
-- ==========================================
-- Alle ændringer logges automatisk.
-- Bruges til historik-view og til at se hvad
-- der er sket med en bon eller kunde.

CREATE TABLE changelog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,  -- bon | customer | company | quote
    entity_id   INTEGER NOT NULL,
    action      TEXT NOT NULL
                CHECK (action IN ('create', 'update', 'delete', 'status_change')),
    field_name  TEXT,           -- Hvilket felt blev ændret
    old_value   TEXT,
    new_value   TEXT,
    user_id     INTEGER REFERENCES users(id),
    notes       TEXT,           -- Valgfri kommentar
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_changelog_entity  ON changelog(entity_type, entity_id);
CREATE INDEX idx_changelog_created ON changelog(created_at);

-- ==========================================
-- VEDHÆFTNINGER
-- ==========================================

CREATE TABLE attachments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type         TEXT NOT NULL,  -- bon | company | customer | quote
    entity_id           INTEGER NOT NULL,
    file_name           TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    file_type           TEXT,           -- image | pdf | document
    description         TEXT,
    uploaded_by_user_id INTEGER REFERENCES users(id),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);
