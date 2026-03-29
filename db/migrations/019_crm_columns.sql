-- ==========================================
-- 019_crm_columns.sql
-- CRM udvidelser: is_internal, result/sentiment
-- på crm_activities, service-call views
-- ==========================================

-- ==========================================
-- IS_INTERNAL på bons og companies
-- ==========================================
ALTER TABLE bons ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;

-- ==========================================
-- GENSKAB crm_activities med service_call +
-- result + sentiment kolonner
-- ==========================================
-- SQLite kan ikke ALTER CHECK constraints,
-- så vi bruger rename-copy pattern.

ALTER TABLE crm_activities RENAME TO _old_crm_activities;

CREATE TABLE crm_activities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER REFERENCES customers(id),
    bon_id          INTEGER REFERENCES bons(id),
    type            TEXT NOT NULL
                    CHECK (type IN (
                        'call',
                        'service_call',
                        'meeting',
                        'task',
                        'note',
                        'followup',
                        'offer_sent',
                        'email_in',
                        'email_out'
                    )),
    result          TEXT
                    CHECK (result IS NULL OR result IN (
                        'reached',
                        'no_answer',
                        'busy',
                        'voicemail',
                        'callback',
                        'email_instead'
                    )),
    sentiment       TEXT
                    CHECK (sentiment IS NULL OR sentiment IN (
                        'positive',
                        'neutral',
                        'negative'
                    )),
    text            TEXT NOT NULL,
    due_at          DATETIME,
    done_at         DATETIME,
    owner_user_id   INTEGER REFERENCES users(id),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (customer_id IS NOT NULL OR bon_id IS NOT NULL)
);

-- Kopiér data fra gammel tabel (result/sentiment bliver NULL)
INSERT INTO crm_activities (id, customer_id, bon_id, type, text, due_at, done_at, owner_user_id, created_at)
SELECT id, customer_id, bon_id, type, text, due_at, done_at, owner_user_id, created_at
FROM _old_crm_activities;

DROP TABLE _old_crm_activities;

-- Genskab indexes
CREATE INDEX idx_crm_act_customer   ON crm_activities(customer_id);
CREATE INDEX idx_crm_act_bon        ON crm_activities(bon_id);
CREATE INDEX idx_crm_act_owner_due  ON crm_activities(owner_user_id, due_at);
CREATE INDEX idx_crm_act_type       ON crm_activities(type);
CREATE INDEX idx_crm_act_pending    ON crm_activities(owner_user_id, done_at)
    WHERE done_at IS NULL;
CREATE INDEX idx_crm_act_result     ON crm_activities(result)
    WHERE result IS NOT NULL;

-- ==========================================
-- VIEWS til CRM stats
-- ==========================================

-- Service-kald ventende: leverede bons uden service_call aktivitet
CREATE VIEW IF NOT EXISTS v_service_calls_pending AS
SELECT
    b.id AS bon_id, b.bon_number, b.delivery_date, b.delivery_time,
    b.pax, b.total_units, b.total_price,
    c.id AS customer_id,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    c.phone AS customer_phone,
    co.name AS company_name,
    CAST(julianday('now') - julianday(b.delivery_date) AS INTEGER) AS days_since_delivery
FROM bons b
JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
JOIN status_definitions sd ON b.status_id = sd.id
WHERE sd.code IN ('LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET')
    AND b.is_internal = 0
    AND julianday('now') - julianday(b.delivery_date) BETWEEN 0 AND 7
    AND NOT EXISTS (
        SELECT 1 FROM crm_activities a
        WHERE a.bon_id = b.id AND a.type = 'service_call'
    );

-- Callbacks ventende: aktiviteter med result=callback og ikke done
CREATE VIEW IF NOT EXISTS v_callbacks_pending AS
SELECT
    a.id AS activity_id, a.customer_id, a.bon_id, a.text, a.created_at,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    c.phone AS customer_phone,
    co.name AS company_name,
    b.bon_number
FROM crm_activities a
JOIN customers c ON a.customer_id = c.id
LEFT JOIN companies co ON c.company_id = co.id
LEFT JOIN bons b ON a.bon_id = b.id
WHERE a.result = 'callback' AND a.done_at IS NULL
ORDER BY a.created_at ASC;

-- Svære at nå: kunder med 3+ mislykkede forsøg inden for 14 dage
CREATE VIEW IF NOT EXISTS v_hard_to_reach AS
SELECT
    c.id AS customer_id,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    c.phone AS customer_phone,
    co.name AS company_name,
    COUNT(a.id) AS failed_attempts,
    MAX(a.created_at) AS last_attempt
FROM crm_activities a
JOIN customers c ON a.customer_id = c.id
LEFT JOIN companies co ON c.company_id = co.id
WHERE a.type IN ('call', 'service_call')
    AND a.result NOT IN ('reached', 'callback')
    AND a.created_at >= date('now', '-14 days')
GROUP BY c.id
HAVING failed_attempts >= 3
ORDER BY failed_attempts DESC;

-- Ugentlig opkaldsstatistik
CREATE VIEW IF NOT EXISTS v_call_stats_weekly AS
SELECT
    strftime('%Y-W%W', created_at) AS week,
    COUNT(*) AS total_calls,
    SUM(CASE WHEN result = 'reached' THEN 1 ELSE 0 END) AS reached_count,
    ROUND(100.0 * SUM(CASE WHEN result = 'reached' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 0) AS reach_rate
FROM crm_activities
WHERE type IN ('call', 'service_call')
GROUP BY week
ORDER BY week DESC;
