-- Migration 080: konfigurerbar match-tolerance for cashflow
-- ════════════════════════════════════════════════════════════
-- Bons.total_with_delivery ≠ den faktiske e-conomic-faktura, fordi
-- e-conomic tilføjer miljøgebyr (+29 kr ex moms = +36,25 inkl) og leveringen
-- på faktura kan være højere end Bon v2's standard 180 kr (op til +300 kr
-- ved længere afstande). Match-algoritmens ±2%-tolerance fanger ikke disse
-- afvigelser på små bons, så bank-deposits matches ikke automatisk.
--
-- Asymmetrisk fix: bank-amount må være OP TIL +extra_max kr højere end
-- cf_invoice.beloeb (men ikke lavere — gebyrer lægges altid til). Dette
-- supplerer ±pct%-tolerancen, ikke erstatter den.
-- ════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('cf_match_relative_tolerance_pct', '2.0',
   'Relativ match-tolerance i procent (default 2.0 = ±2%). Bank-amount må afvige fra cf_invoice.beloeb med dette procentvis.'),
  ('cf_match_extra_tolerance_max', '350',
   'Absolut max ekstra bank-amount over cf_invoice.beloeb (kr). Dækker miljøgebyr + variabel levering. Bank-amount er aldrig lavere end faktura.');
