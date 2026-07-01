-- 115_cashflow_allocations.sql
-- ════════════════════════════════════════════════════════════
-- Pengestrøm §2.F — Split-allokering, universel kobling, to-akset status.
-- Spec: docs/economics/CLAUDE_PENGESTROEM.md §2.F.
--
-- Hvorfor: den nuværende model er stift 1-til-1 (cf_transactions.matched_invoice_id
-- = ÉN faktura; cf_invoices.bon_id = ÉN bon). Virkeligheden er mange-til-mange:
--   • Faktura 4112 → 1 indbetaling dækker 3 event-bons (split)
--   • Rater/aconto → N indbetalinger på 1 mål
--   • Zettle/MobilePay-batch → 1 indbetaling dækker N events (+ gebyr-linje)
--
-- cf_allocations kobler én banktransaktion til ét eller flere mål MED BELØB.
-- target_type:
--   'invoice' → cf_invoices.id (fakturanr, TEXT)
--   'bon'     → bons.id
--   'event'   → events.id
--   'fee'     → udbyder-gebyr (Zettle/MobilePay) som negativ linje, så brutto
--               vises pr. event mens Σ rammer det netto-beløb der ramte banken.
--
-- INVARIANT (håndhæves i kode, ikke skema): Σ amount pr. tx === tx.beloeb når
-- fuldt afstemt. Rest = uallokeret → tx er delvist afstemt (ikke skjult).
--
-- BAGUDKOMPAT: cf_transactions.matched_invoice_id DROPPES IKKE. Den bliver en
-- denormaliseret 1:1-hurtig-sti (præcis én invoice-allokering). Sandheden er
-- allokeringerne. Vi backfiller eksisterende matches → én cf_allocations-række.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cf_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES cf_transactions(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL CHECK (target_type IN ('invoice','bon','event','fee')),
  target_id      TEXT NOT NULL,        -- cf_invoices.id | bons.id | events.id | fee-kategori
  amount         REAL NOT NULL,        -- INCL moms; del af tx.beloeb (negativ ved kreditnota/gebyr)
  note           TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cf_alloc_tx     ON cf_allocations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_cf_alloc_target ON cf_allocations(target_type, target_id);

-- Backfill: hver eksisterende 1:1 invoice-match → én allokering på fakturaens beløb.
-- (Vi bruger tx.beloeb, ikke faktura-beløbet — det er pengene der reelt ramte banken.)
-- matched_event_id backfilles IKKE her: §E er ikke landet i denne branch endnu.
INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount)
  SELECT t.id, 'invoice', t.matched_invoice_id, t.beloeb
  FROM cf_transactions t
  WHERE t.matched_invoice_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM cf_allocations a WHERE a.transaction_id = t.id
    );
