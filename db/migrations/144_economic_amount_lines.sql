-- 144_economic_amount_lines.sql
-- Beløbslinjer på e-conomic-fakturaen (Rabat / Engangsbeløb).
--
-- Problem: de tre x-Service-opskrifter er tastet med KRONERNE I ANTAL-FELTET
-- og ±1 som pris:
--
--   recipe 135 · quantity 11600 · unit_price -1,00 · line_total -11.600
--   recipe   8 · quantity  2000 · unit_price -1,00 · special_request "bil"
--   recipe   7 · quantity   823 · unit_price  1,00 · special_request "Prisjustering"
--
-- Sendt råt bliver det til "11.600 stk à -0,80 kr" på kundens faktura. Beløbet
-- er rigtigt, men linjen kan ikke sendes ud.
--
-- Løsning: opskrifterne her foldes sammen til antal 1 + linjesummen som pris
-- (services/economicInvoice.js). Samme mønster som unit_count_extra_recipes —
-- en udpeget liste frem for at gætte ud fra kategori eller pris.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('economic_amount_line_recipes',
   '[7,8,135]',
   'JSON-array af Grocy recipe-id hvis bon-linjer er BELØBSLINJER: kronerne står i quantity og prisen er ±1. På fakturaen bliver de til antal 1 med linjesummen som pris (Rabat 8/135, Engangsbeløb 7).');

-- Engangsvaren er nu oprettet i e-conomic (111 "Engangsbeløb / Diverse").
-- Kun hvis feltet stadig er tomt — en værdi sat i hånden skal ikke overskrives.
UPDATE settings
   SET value = '111'
 WHERE key = 'economic_oneoff_product_number'
   AND COALESCE(TRIM(value), '') = '';
