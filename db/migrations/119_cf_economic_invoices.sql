-- 119_cf_economic_invoices.sql
-- ════════════════════════════════════════════════════════════════════════
-- Pengestrøm §2.F.6: spejl af e-conomics BOGFØRTE fakturaer (nummer + beløb).
--
-- Hvorfor: en bank-indbetaling med "FAKTURA 3700" i teksten er en faktura-betaling.
-- Tidligere kunne vi kun genkende den hvis e-conomic-fakturaen var bundet til en
-- Bon-v2-bon (via bon-nr i overskriften) OG bon-beløbet matchede. Men indbetalingen
-- er lig FAKTURAENS beløb (kan dække flere bons / have levering lagt til i e-conomic),
-- så samlefakturaer og justerede fakturaer faldt fra.
--
-- Med dette spejl genkender vi en indbetaling som afregnet faktura blot ved at
-- nummeret findes som et rigtigt bogført e-conomic-fakturanr — uden bon-kobling.
-- Så folder "kan ikke matches"-listen de afregnede væk og viser kun ægte undtagelser.
--
-- Fyldes af cashflowReconcile.reconcile (upsert pr. bogført faktura). KUN læsning
-- fra e-conomic. booked_no = e-conomics eget fakturanummer (IKKE bon-nr).
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cf_economic_invoices (
    booked_no     TEXT PRIMARY KEY,   -- e-conomics bookedInvoiceNumber (som tekst)
    date          TEXT,               -- bogføringsdato
    gross_amount  REAL,               -- bruttobeløb (incl moms) — det kunden betaler
    remainder     REAL,               -- 0 = betalt
    heading       TEXT,               -- overskrift (indeholder typisk bon-nr)
    updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cf_economic_invoices_date ON cf_economic_invoices(date);
