-- 104_inbox_handling.sql
-- Samlet indbakke (CLAUDE_INDBAKKE.md): håndterings-status + snooze på mail_threads.
-- Additivt oven på migration 018 — opretter INGEN mail-tabeller, rører IKKE den
-- eksisterende mail_threads.status (active/closed/archived) som PO/leverandør-tråde
-- bruger. handling_status er en ny, isoleret dimension der kun gælder kunde/bon-tråde.

-- ── Håndterings-dimension på mail_threads ───────────────────────────
-- handling_status er NULL for PO/leverandør-tråde; sættes kun på kunde/bon-tråde.
ALTER TABLE mail_threads ADD COLUMN handling_status TEXT
    CHECK (handling_status IN ('aaben','afventer_kunde','afsluttet'));
ALTER TABLE mail_threads ADD COLUMN snooze_until     DATETIME;        -- NULL = ikke udsat; <= now → behandles som 'aaben'
ALTER TABLE mail_threads ADD COLUMN assigned_to      INTEGER REFERENCES users(id);  -- tildeling (UI bag flag)
ALTER TABLE mail_threads ADD COLUMN last_inbound_at  DATETIME;        -- pre-computed
ALTER TABLE mail_threads ADD COLUMN last_outbound_at DATETIME;        -- pre-computed ("hvornår svarede vi")
ALTER TABLE mail_threads ADD COLUMN has_unread       INTEGER NOT NULL DEFAULT 0;    -- pre-computed

-- is_system: 1 = auto-bekræftelse (booking-/web-ordre-mail o.l.), ikke menneske-svar
ALTER TABLE mail_messages ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mail_threads_handling ON mail_threads(handling_status);
CREATE INDEX IF NOT EXISTS idx_mail_threads_snooze   ON mail_threads(snooze_until);

-- ── Backfill: kun kunde/bon-tråde (PO/leverandør forbliver NULL) ─────
UPDATE mail_threads
SET handling_status = CASE
      WHEN status IN ('closed','archived') THEN 'afsluttet'
      WHEN EXISTS (SELECT 1 FROM mail_messages mm
                   WHERE mm.thread_id = mail_threads.id
                     AND mm.direction = 'in' AND mm.is_read = 0) THEN 'aaben'
      ELSE 'afsluttet' END
WHERE purchase_order_id IS NULL
  AND supplier_id IS NULL
  AND (bon_id IS NOT NULL OR customer_id IS NOT NULL);

-- ── Pre-compute timestamps + unread for de samme tråde ──────────────
UPDATE mail_threads SET
  last_inbound_at  = (SELECT MAX(COALESCE(mm.received_at, mm.created_at))
                        FROM mail_messages mm WHERE mm.thread_id = mail_threads.id AND mm.direction = 'in'),
  last_outbound_at = (SELECT MAX(COALESCE(mm.sent_at, mm.created_at))
                        FROM mail_messages mm WHERE mm.thread_id = mail_threads.id AND mm.direction = 'out'),
  has_unread       = CASE WHEN EXISTS (SELECT 1 FROM mail_messages mm
                                       WHERE mm.thread_id = mail_threads.id
                                         AND mm.direction = 'in' AND mm.is_read = 0)
                          THEN 1 ELSE 0 END
WHERE handling_status IS NOT NULL;

-- ── Settings ────────────────────────────────────────────────────────
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('inbox_snooze_default_days', '3', 'Standard rykker-interval for "Afventer kunde"');
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('inbox_assignment_enabled',  '0', '1 = vis tildeling + "Mine" i indbakke (flere brugere)');
