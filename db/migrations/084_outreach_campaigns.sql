-- ==========================================
-- Migration 084 — Outreach-kampagner (Fase 1)
-- Cherry-pick leads fra eksisterende kunder/firmaer + manuel tilføjelse.
-- Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md
-- ==========================================

-- companies.tags — JSON-array, parallel til crm_customer_meta.tags.
-- NULL og "[]" behandles ens af frontend (ingen tags).
ALTER TABLE companies ADD COLUMN tags TEXT;

-- crm_activities.campaign_id — nullable FK til outreach_campaigns.
-- Eksisterende rækker får NULL (de havde pr. definition ingen kampagne).
-- Tilskrivning sker fra routes/crm.js POST /activity (kaldsstedet sender
-- campaign_id med når aktivitet logges fra kampagne-medlems-detalje).
-- Spec sektion 1.2.5.
ALTER TABLE crm_activities ADD COLUMN campaign_id INTEGER REFERENCES outreach_campaigns(id);
CREATE INDEX idx_crm_act_campaign ON crm_activities(campaign_id) WHERE campaign_id IS NOT NULL;

-- ==========================================
-- outreach_campaigns
-- ==========================================
CREATE TABLE outreach_campaigns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    owner_user_id   INTEGER REFERENCES users(id),
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at       DATETIME,
    notes           TEXT
);

CREATE INDEX idx_oc_active ON outreach_campaigns(is_active) WHERE is_active = 1;

-- ==========================================
-- campaign_members
-- Polymorf via nullable FK'er — én af company_id/customer_id skal være sat.
-- Matcher mønstret fra `bons` og `mail_threads`.
-- ==========================================
CREATE TABLE campaign_members (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id         INTEGER NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
    company_id          INTEGER REFERENCES companies(id),
    customer_id         INTEGER REFERENCES customers(id),
    member_status       TEXT NOT NULL DEFAULT 'lead'
                        CHECK (member_status IN ('lead', 'quote_sent', 'negotiating', 'won', 'lost')),
    lost_reason         TEXT,
    assigned_user_id    INTEGER REFERENCES users(id),
    notes               TEXT,
    added_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by_user_id    INTEGER REFERENCES users(id),
    last_activity_at    DATETIME,
    CHECK (company_id IS NOT NULL OR customer_id IS NOT NULL)
);

CREATE INDEX idx_cm_campaign ON campaign_members(campaign_id);
CREATE INDEX idx_cm_company  ON campaign_members(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_cm_customer ON campaign_members(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_cm_status   ON campaign_members(campaign_id, member_status);
CREATE INDEX idx_cm_assigned ON campaign_members(assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- ==========================================
-- Partial unique indexes — håndhæver dedup server-side.
-- SQLite's standard UNIQUE behandler NULL som distinct, så
-- UNIQUE(campaign_id, company_id, customer_id) tillader dubletter
-- når en af FK'erne er NULL. De tre partial indexes lukker det hul:
-- ==========================================

-- B2B uden specifik kontakt: kun ét medlem pr. firma pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_company_only
    ON campaign_members(campaign_id, company_id)
    WHERE customer_id IS NULL AND company_id IS NOT NULL;

-- Privatkunde (eller specifik kontakt uden firma): kun ét medlem pr. customer pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_customer_only
    ON campaign_members(campaign_id, customer_id)
    WHERE company_id IS NULL AND customer_id IS NOT NULL;

-- B2B med kontakt: kun ét medlem pr. (firma, kontakt)-par pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_both
    ON campaign_members(campaign_id, company_id, customer_id)
    WHERE company_id IS NOT NULL AND customer_id IS NOT NULL;
