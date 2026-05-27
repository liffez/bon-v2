-- Migration 079: setting til auto-markering af gamle bons som betalt
-- ════════════════════════════════════════════════════════════
-- Følger op på #8/#10/#12/#13. Backfill afslørede at de fleste
-- historiske FAKTURERET-bons aldrig blev markeret BETALT (kun status-
-- skiftet til FAKTURERET blev sat). I virkeligheden er pengene modtaget,
-- men cf_invoices viser dem nu som forfaldne udestående over 10 mio kr.
--
-- syncCashflowInvoice tjekker dette setting: hvis delivery_date er ældre
-- end N dage (og status ikke er BETALT eller AFLYST), antages bonen
-- betalt (betalt=1, betalt_dato = delivery_date). Sat til 0 = deaktiveret.
-- ════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('cf_assume_paid_after_days', '90',
   'Antal dage efter delivery_date hvor en FAKTURERET/AFSLUTTET-bon automatisk antages betalt i cashflow. 0 = deaktiveret.');
