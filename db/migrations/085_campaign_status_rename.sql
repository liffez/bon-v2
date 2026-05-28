-- ==========================================
-- Migration 085 — Omdøb campaign_members.member_status: quote_sent → contacted
--
-- Begrundelse: "quote_sent" lyder som "specifikt sendt et tilbud", men dækker i
-- praksis alt initiativ ud til kunden (ringet, sendt tilbud, præsentation,
-- smagsprøver). "contacted" er mere præcist for den faktiske forretningsproces.
--
-- SQLite kan ikke ALTER CHECK direkte, så vi re-opretter tabellen.
-- Frontend-label ændres til "Kontaktet" + "Forhandling" → "Dialog" (kun label).
-- ==========================================

-- 1. Drop alle indexes på den gamle tabel (genskabes nedenfor)
DROP INDEX IF EXISTS idx_cm_campaign;
DROP INDEX IF EXISTS idx_cm_company;
DROP INDEX IF EXISTS idx_cm_customer;
DROP INDEX IF EXISTS idx_cm_status;
DROP INDEX IF EXISTS idx_cm_assigned;
DROP INDEX IF EXISTS idx_cm_uniq_company_only;
DROP INDEX IF EXISTS idx_cm_uniq_customer_only;
DROP INDEX IF EXISTS idx_cm_uniq_both;

-- 2. Opret ny tabel med opdateret CHECK
CREATE TABLE campaign_members_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id         INTEGER NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
    company_id          INTEGER REFERENCES companies(id),
    customer_id         INTEGER REFERENCES customers(id),
    member_status       TEXT NOT NULL DEFAULT 'lead'
                        CHECK (member_status IN ('lead', 'contacted', 'negotiating', 'won', 'lost')),
    lost_reason         TEXT,
    assigned_user_id    INTEGER REFERENCES users(id),
    notes               TEXT,
    added_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by_user_id    INTEGER REFERENCES users(id),
    last_activity_at    DATETIME,
    CHECK (company_id IS NOT NULL OR customer_id IS NOT NULL)
);

-- 3. Kopiér data — oversæt quote_sent → contacted under flugten
INSERT INTO campaign_members_new (
    id, campaign_id, company_id, customer_id, member_status, lost_reason,
    assigned_user_id, notes, added_at, added_by_user_id, last_activity_at
)
SELECT
    id, campaign_id, company_id, customer_id,
    CASE member_status
        WHEN 'quote_sent' THEN 'contacted'
        ELSE member_status
    END,
    lost_reason, assigned_user_id, notes, added_at, added_by_user_id, last_activity_at
FROM campaign_members;

-- 4. Drop gammel tabel og omdøb
DROP TABLE campaign_members;
ALTER TABLE campaign_members_new RENAME TO campaign_members;

-- 5. Genskab alle indexes
CREATE INDEX idx_cm_campaign ON campaign_members(campaign_id);
CREATE INDEX idx_cm_company  ON campaign_members(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_cm_customer ON campaign_members(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_cm_status   ON campaign_members(campaign_id, member_status);
CREATE INDEX idx_cm_assigned ON campaign_members(assigned_user_id) WHERE assigned_user_id IS NOT NULL;

CREATE UNIQUE INDEX idx_cm_uniq_company_only
    ON campaign_members(campaign_id, company_id)
    WHERE customer_id IS NULL AND company_id IS NOT NULL;

CREATE UNIQUE INDEX idx_cm_uniq_customer_only
    ON campaign_members(campaign_id, customer_id)
    WHERE company_id IS NULL AND customer_id IS NOT NULL;

CREATE UNIQUE INDEX idx_cm_uniq_both
    ON campaign_members(campaign_id, company_id, customer_id)
    WHERE company_id IS NOT NULL AND customer_id IS NOT NULL;

-- 6. Opdater eventuel reference i changelog (status_change-rows)
-- Bevarer historikken, men oversætter old/new-værdier så audit-trail er konsistent.
UPDATE changelog
SET old_value = 'contacted'
WHERE entity_type = 'campaign_member'
  AND action = 'status_change'
  AND field_name = 'member_status'
  AND old_value = 'quote_sent';
UPDATE changelog
SET new_value = 'contacted'
WHERE entity_type = 'campaign_member'
  AND action = 'status_change'
  AND field_name = 'member_status'
  AND new_value = 'quote_sent';
