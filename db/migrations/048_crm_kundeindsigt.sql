-- ==========================================
-- 048_crm_kundeindsigt.sql
-- RFM scoring, activity purposes, company
-- enrichment columns, personal companies
-- ==========================================

-- ==========================================
-- ACTIVITY PURPOSES (konfigurerbar opslagstabel)
-- ==========================================
CREATE TABLE IF NOT EXISTS activity_purposes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    emoji       TEXT,
    description TEXT,
    is_system   INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('opfoelgning',    'Opfølgning',    '🔁', 'Generel opfølgning på tidligere kontakt',    1, 10),
    ('nyt_lead',       'Nyt lead',      '👤', 'Første kontakt med ny potentiel kunde',       1, 20),
    ('salgsfrokost',   'Salgsfrokost',  '🥗', 'Tilbud om eller afholdelse af salgsfrokost', 1, 30),
    ('saesonoutreach', 'Sæson',         '🌸', 'Sæsonbaseret outreach: jul, sommer, påske',  1, 40),
    ('re_aktivering',  'Re-aktivering', '💤', 'Genoptagelse af kontakt til sovende kunde',  1, 50),
    ('service',        'Service',       '🔧', 'Serviceopkald efter levering',               1, 60);

-- ==========================================
-- purpose_id PÅ crm_activities
-- ==========================================
ALTER TABLE crm_activities ADD COLUMN purpose_id INTEGER REFERENCES activity_purposes(id);

-- ==========================================
-- COMPANY ENRICHMENT KOLONNER
-- ==========================================
ALTER TABLE companies ADD COLUMN branch TEXT;
ALTER TABLE companies ADD COLUMN branch_source TEXT;
ALTER TABLE companies ADD COLUMN branch_updated_at DATETIME;
ALTER TABLE companies ADD COLUMN cvr_enriched_at DATETIME;
ALTER TABLE companies ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN employee_count INTEGER;
ALTER TABLE companies ADD COLUMN company_type TEXT;

CREATE INDEX idx_companies_branch ON companies(branch);
CREATE INDEX idx_companies_personal ON companies(is_personal) WHERE is_personal = 1;

-- ==========================================
-- RFM CONFIG (key/value med defaults)
-- ==========================================
CREATE TABLE IF NOT EXISTS rfm_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    label       TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO rfm_config (key, value, label) VALUES
    ('w_r',             '35',  'Recency-vægt (%)'),
    ('w_f',             '40',  'Frequency-vægt (%)'),
    ('w_m',             '25',  'Monetary-vægt (%)'),
    ('vip_pct',         '15',  'VIP-tærskel (top %)'),
    ('aktiv_pct',       '50',  'Aktiv-tærskel (top %)'),
    ('recency_days',    '180', 'Recency cutoff (dage)'),
    ('monetary_mode',   'pax', 'Monetary-mål: pax eller revenue'),
    ('lookback_months', '24',  'Kun ordrer inden for N måneder');

-- ==========================================
-- RFM SCORES (materialiseret, per company)
-- ==========================================
CREATE TABLE IF NOT EXISTS rfm_scores (
    company_id          INTEGER PRIMARY KEY REFERENCES companies(id),
    order_count         INTEGER NOT NULL DEFAULT 0,
    total_guests        INTEGER NOT NULL DEFAULT 0,
    avg_guests          REAL NOT NULL DEFAULT 0,
    total_revenue       REAL NOT NULL DEFAULT 0,
    avg_order_value     REAL NOT NULL DEFAULT 0,
    days_since_last     INTEGER,
    first_order_date    TEXT,
    last_order_date     TEXT,
    r_score             INTEGER NOT NULL DEFAULT 0,
    f_score             INTEGER NOT NULL DEFAULT 0,
    m_score             INTEGER NOT NULL DEFAULT 0,
    rfm_total           INTEGER NOT NULL DEFAULT 0,
    stage               TEXT CHECK (stage IN ('lead', 'active', 'dormant', 'vip')),
    stage_locked        INTEGER NOT NULL DEFAULT 0,
    stage_locked_by     INTEGER REFERENCES users(id),
    stage_locked_at     TEXT,
    computed_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_rfm_stage ON rfm_scores(stage);
CREATE INDEX idx_rfm_total ON rfm_scores(rfm_total DESC);
