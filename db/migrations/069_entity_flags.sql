-- Migration 069: entity_flags + flag_acks
--
-- Stående/engangs-påmindelser ("flags") på kunder og firmaer, der hejses
-- ved bon-oprettelse og bon-åbning i office. Polymorf tabel (entity_type =
-- company | customer) i samme stil som contact_points.
--
-- Spec: docs/CLAUDE_KUNDE_FLAGS.md
--
-- Designnoter:
--   • Aktive flag = dismissed_at IS NULL. Partial index dækker hot path.
--   • "Set" = per-bon-ack (flag_acks-row, flag lever videre).
--   • "Gjort" = permanent dismiss (sætter dismissed_at + dismissed_on_bon_id).
--   • UNIQUE(flag_id, bon_id) på flag_acks → UPSERT-idempotent.

-- ==========================================
-- entity_flags
-- ==========================================

CREATE TABLE entity_flags (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type           TEXT NOT NULL
                              CHECK (entity_type IN ('company', 'customer')),
    entity_id             INTEGER NOT NULL,
    title                 TEXT NOT NULL,
    body                  TEXT,
    created_by_user_id    INTEGER REFERENCES users(id),
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dismissed_at          DATETIME,
    dismissed_by_user_id  INTEGER REFERENCES users(id),
    dismissed_on_bon_id   INTEGER REFERENCES bons(id),
    dismiss_note          TEXT
);

-- Partial index: kun aktive flag (hot path — bruges af bon-drawer + bons-list)
CREATE INDEX idx_eflags_active
    ON entity_flags(entity_type, entity_id)
    WHERE dismissed_at IS NULL;

-- Full index for historik-queries (Kunde 360° med include_dismissed=1)
CREATE INDEX idx_eflags_entity
    ON entity_flags(entity_type, entity_id);

-- ==========================================
-- flag_acks: per-bon "Set"-handling
--
-- Bruges til at vise "Set på bon #B3201, #B3219" på kundekortet, og til at
-- afgøre om "Set"/"Gjort"-knapperne stadig skal vises på en bon (acked_on_this_bon).
-- ==========================================

CREATE TABLE flag_acks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_id           INTEGER NOT NULL REFERENCES entity_flags(id),
    bon_id            INTEGER NOT NULL REFERENCES bons(id),
    acked_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acked_by_user_id  INTEGER REFERENCES users(id),
    note              TEXT,
    UNIQUE(flag_id, bon_id)
);

CREATE INDEX idx_flag_acks_bon  ON flag_acks(bon_id);
CREATE INDEX idx_flag_acks_flag ON flag_acks(flag_id);
