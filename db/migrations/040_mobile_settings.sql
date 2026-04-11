-- 040: Mobile shell settings
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('mobile_pin_enabled',    'true', 'Tillad PIN-login fra mobilshell'),
  ('mobile_pin_min_length', '4',    'Minimum antal cifre i PIN');
