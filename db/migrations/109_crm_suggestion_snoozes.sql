-- ==========================================
-- 109_crm_suggestion_snoozes.sql
-- "Skjul" et smart-forslag midlertidigt (snooze), så slotten frigøres og de
-- næste i køen roterer ind. Per (kunde + forslagstype) — ikke kunden globalt.
-- Filtreres ud i GET /suggestions så længe snoozed_until > now.
-- Ref: docs/CLAUDE_CRM_TRIKS.md revision idé ②.
-- ==========================================

CREATE TABLE IF NOT EXISTS crm_suggestion_snoozes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customers(id),
    type          TEXT NOT NULL,                 -- suggestion-type, fx 'review_ask'
    snoozed_until DATETIME NOT NULL,
    created_by    INTEGER REFERENCES users(id),
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (customer_id, type)                    -- re-snooze opdaterer samme række
);

CREATE INDEX IF NOT EXISTS idx_crm_snooze_until ON crm_suggestion_snoozes(snoozed_until);
