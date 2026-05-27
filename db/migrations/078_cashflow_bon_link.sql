-- Migration 078: kobl cf_invoices til bons via bon_id
-- ════════════════════════════════════════════════════════════
-- Cashflow-modulet havde indtil nu manuel faktura-indtastning som eneste
-- input. Når en bon markeres FAKTURERET i fakturering-viewet er der nu en
-- automatisk bro der opretter/opdaterer en cf_invoice — så pengestrøm-
-- modulets KPIer ikke længere er afhængige af dobbeltindtastning.
--
-- cf_invoices.bon_id er join-nøglen mellem en bon og dens auto-genererede
-- cashflow-faktura. NULL betyder manuelt oprettet (uændret flow).
-- ════════════════════════════════════════════════════════════

ALTER TABLE cf_invoices ADD COLUMN bon_id INTEGER REFERENCES bons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cf_inv_bon_id ON cf_invoices(bon_id);

-- Standard betalingsfrist for auto-genererede fakturaer (dage efter
-- delivery_date). Kan ændres i Settings.
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('cf_default_invoice_terms_days', '14',
   'Antal dage fra delivery_date til forfald på auto-genererede cf_invoices fra FAKTURERET-bons');
