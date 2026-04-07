-- ==========================================
-- Firmaoplysninger til tilbud/faktura (lovkrav)
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('company_cvr', '41497487', 'CVR-nummer'),
  ('company_address', 'Prinsesse Charlottesgade 16, 2200 København N', 'Firmaadresse'),
  ('company_phone', '', 'Firmatelefon'),
  ('company_email', 'info@ristetrug.dk', 'Firma-email');
