-- 110_economic_invoice.sql  (omnummereret fra 105 ifm. merge med main)
-- E-conomic faktura-integration (Spor 2).
-- Spec: docs/economics/CLAUDE_ECONOMIC_ADAPTER.md + CLAUDE_ECONOMIC_PLAN.md
--
-- Tre felter + RR-specifikke settings. Ingen miljøgebyr-setting: miljøgebyr er
-- en Grocy-recipe og kommer med som almindelig linje.

-- Leverings-varenr pr. køretøj (kun til det nye logistik-systems linjeløse
-- bon.delivery_price). Bruges ikke når levering allerede er en x-Levering-linje.
ALTER TABLE delivery_vehicles ADD COLUMN economic_product_number INTEGER;

-- Stående kunderabat på privatkunder. companies.discount_percent findes allerede;
-- customers manglede den. Begge bruges af trigger bons_seed_standing_discount (mig. 106)
-- — SKAL derfor eksistere FØR den trigger oprettes (105 < 106). REAL, default NULL
-- (= ingen rabat), matcher companies.discount_percent.
ALTER TABLE customers ADD COLUMN discount_percent REAL;

-- Udkast-tilstand på bonen. Sættes når et fakturaudkast er oprettet i e-conomic
-- (bonen vises overstreget i fakturerings-køen til den faktisk faktureres).
-- Re-send-guard: er economic_draft_number sat, bygges der ikke et nyt udkast.
ALTER TABLE bons ADD COLUMN economic_draft_number INTEGER;
ALTER TABLE bons ADD COLUMN economic_draft_at TEXT;

-- RR-specifikke konstanter (key/value i settings — ikke hardcoded, ikke .env).
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('economic_default_payment_terms_number', '1',
   'e-conomic paymentTermsNumber (Netto 8 dage). Sendes altid på fakturaudkast.'),
  ('economic_layout_number', '19',
   'e-conomic layoutNumber (DK std. m. bankoplys.).'),
  ('economic_delivery_fallback_product_number', '17',
   'e-conomic varenr for leveringslinje når bon har delivery_price uden et koblet køretøj.'),
  ('economic_oneoff_product_number', '',
   'Valgfrit e-conomic engangs-varenr. Bruges til linjer uden rigtigt recipe-nummer ved at overskrive tekst+beløb (engangsvarer). Tom = deaktiveret.'),
  ('economic_draft_url', '',
   'Valgfri URL-skabelon til at åbne en kladde i e-conomic ({nr}-pladsholder). Tom = vis kun kladde-nummeret.'),
  ('economic_invoice_url', '',
   'Valgfri URL-skabelon til at åbne en bogført faktura ({nr}=fakturanr, {ops}=economic_ops). Tom = intet link.'),
  ('economic_ops', '',
   'e-conomic ops-parameter til visfaktura.asp-links (hvis stabilt pr. agreement).');
