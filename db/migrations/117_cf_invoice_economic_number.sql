-- 117_cf_invoice_economic_number.sql
-- ════════════════════════════════════════════════════════════════════════
-- Pengestrøm §2.F.6 (forlængelse): gem e-conomics BOGFØRTE fakturanummer på
-- cf_invoices, så bank-indbetalinger kan kobles via nummeret i bankteksten
-- ("FAKTURA 3957" → cf_invoices.economic_number=3957 → matched_invoice_id).
--
-- cashflowReconcile henter allerede inv.bookedInvoiceNumber når den matcher en
-- bogført faktura mod en bon via overskriften — den gemmer den nu her. Det giver
-- et VERIFICERET bank↔faktura-link (nummer + beløb), i stedet for at folde de
-- historiske indbetalinger på ren dato-antagelse.
--
-- Nullable: fakturaer uden e-conomic-match (endnu) har NULL. Idempotent backfill
-- sker ved at køre reconcile med en tidlig `since`-dato.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE cf_invoices ADD COLUMN economic_number TEXT;
CREATE INDEX IF NOT EXISTS idx_cf_invoices_economic_number ON cf_invoices(economic_number);
