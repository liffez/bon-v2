-- ==========================================
-- 004_crm.sql
-- Nano-CRM: kundemeta, aktiviteter,
-- custom fields, ufordelte mails, tilbudsfelter
-- ==========================================

-- ==========================================
-- CRM KUNDEMETA
-- ==========================================
-- Udvidet CRM-info oven på eksisterende customers.
-- Separat tabel så vi ikke rører kernedata.

CREATE TABLE crm_customer_meta (
    customer_id     INTEGER PRIMARY KEY REFERENCES customers(id),
    owner_user_id   INTEGER REFERENCES users(id),
    stage           TEXT NOT NULL DEFAULT 'active'
                    CHECK (stage IN ('lead', 'active', 'dormant', 'vip')),
    tags            TEXT,                   -- JSON array, fx ["økologi","stor kunde"]
    marketing_consent INTEGER NOT NULL DEFAULT 0,
    do_not_contact  INTEGER NOT NULL DEFAULT 0,
    last_contact_at DATETIME,              -- Opdateres ved ny aktivitet
    next_followup_at DATETIME,             -- Næste planlagte opfølgning
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_crm_meta_stage    ON crm_customer_meta(stage);
CREATE INDEX idx_crm_meta_owner    ON crm_customer_meta(owner_user_id);
CREATE INDEX idx_crm_meta_followup ON crm_customer_meta(next_followup_at);

-- ==========================================
-- CRM AKTIVITETER
-- ==========================================
-- Eksplicitte customer_id + bon_id i stedet for
-- polymorphic entity_type/entity_id pattern.
-- En aktivitet kan knyttes til BÅDE kunde OG bon.

CREATE TABLE crm_activities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER REFERENCES customers(id),
    bon_id          INTEGER REFERENCES bons(id),
    type            TEXT NOT NULL
                    CHECK (type IN (
                        'call',         -- Opkald
                        'meeting',      -- Møde
                        'task',         -- Opgave
                        'note',         -- Intern note
                        'followup',     -- Opfølgning
                        'offer_sent',   -- Tilbud sendt
                        'email_in',     -- Mail modtaget
                        'email_out'     -- Mail sendt
                    )),
    text            TEXT NOT NULL,
    due_at          DATETIME,               -- Deadline (opgaver/opfølgning)
    done_at         DATETIME,               -- Afsluttet tidspunkt
    owner_user_id   INTEGER REFERENCES users(id),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Mindst én skal være sat
    CHECK (customer_id IS NOT NULL OR bon_id IS NOT NULL)
);

CREATE INDEX idx_crm_act_customer   ON crm_activities(customer_id);
CREATE INDEX idx_crm_act_bon        ON crm_activities(bon_id);
CREATE INDEX idx_crm_act_owner_due  ON crm_activities(owner_user_id, due_at);
CREATE INDEX idx_crm_act_type       ON crm_activities(type);
CREATE INDEX idx_crm_act_pending    ON crm_activities(owner_user_id, done_at)
    WHERE done_at IS NULL;  -- Partial index: kun uafsluttede

-- ==========================================
-- CUSTOM FIELDS (EAV-pattern)
-- ==========================================
-- Tilføj CRM-felter uden nye migrationer

CREATE TABLE crm_custom_fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN ('customer', 'company', 'bon')),
    key         TEXT NOT NULL,
    label       TEXT NOT NULL,
    field_type  TEXT NOT NULL
                CHECK (field_type IN ('text', 'number', 'date', 'bool', 'select')),
    options_json TEXT,                  -- For select: ["option1","option2"]
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    UNIQUE(entity_type, key)
);

CREATE TABLE crm_custom_values (
    entity_type         TEXT NOT NULL,
    entity_id           INTEGER NOT NULL,
    field_id            INTEGER NOT NULL REFERENCES crm_custom_fields(id),
    value_text          TEXT,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id),
    PRIMARY KEY (entity_type, entity_id, field_id)
);

-- ==========================================
-- UFORDELTE MAILS
-- ==========================================
-- Arbejdsindbakke for mails der ikke automatisk
-- kunne matches til en bon eller kunde.

CREATE TABLE crm_unmatched_emails (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email          TEXT,
    from_name           TEXT,
    subject             TEXT,
    received_at         DATETIME,
    body_text           TEXT,
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'linked', 'ignored')),
    linked_customer_id  INTEGER REFERENCES customers(id),
    linked_bon_id       INTEGER REFERENCES bons(id),
    created_by_user_id  INTEGER REFERENCES users(id),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_unmatched_status   ON crm_unmatched_emails(status);
CREATE INDEX idx_unmatched_customer ON crm_unmatched_emails(linked_customer_id);

-- ==========================================
-- TILBUDSFELTER PÅ BONS
-- ==========================================
-- Tilbud = bon med is_offer = 1.
-- Giver fuldt status-flow til tilbud, men isoleret
-- fra normale bonner via partial index.

ALTER TABLE bons ADD COLUMN is_offer         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bons ADD COLUMN offer_status     TEXT
    CHECK (offer_status IN ('draft', 'sent', 'won', 'lost', 'expired'));
ALTER TABLE bons ADD COLUMN offer_sent_at    DATETIME;
ALTER TABLE bons ADD COLUMN offer_valid_until DATE;

CREATE INDEX idx_bons_offer ON bons(is_offer, offer_status)
    WHERE is_offer = 1;

-- ==========================================
-- VIEWS
-- ==========================================

-- Mine åbne opgaver
CREATE VIEW v_my_tasks_today AS
SELECT
    a.id,
    a.type,
    a.text,
    a.due_at,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    b.bon_number
FROM crm_activities a
LEFT JOIN customers c ON a.customer_id = c.id
LEFT JOIN bons b ON a.bon_id = b.id
WHERE a.done_at IS NULL
ORDER BY a.due_at ASC;

-- Tilbudspipeline
CREATE VIEW v_offer_pipeline AS
SELECT
    b.id,
    b.bon_number,
    b.offer_status,
    b.offer_sent_at,
    b.offer_valid_until,
    b.total_price,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name AS company_name
FROM bons b
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.is_offer = 1
    AND b.offer_status NOT IN ('won', 'lost', 'expired')
ORDER BY b.offer_valid_until ASC;

-- Kunder der ikke har bestilt i 60+ dage
CREATE VIEW v_dormant_customers AS
SELECT
    c.id,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
    c.email,
    co.name AS company_name,
    MAX(b.delivery_date) AS last_order_date,
    CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since
FROM customers c
LEFT JOIN companies co ON c.company_id = co.id
LEFT JOIN bons b ON b.customer_id = c.id
WHERE c.is_active = 1
GROUP BY c.id
HAVING days_since > 60 OR last_order_date IS NULL
ORDER BY days_since DESC;
