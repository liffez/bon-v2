-- Ugeoversigt: kapacitetsberegning settings
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('capacity_ratio_enabled',    'false', 'Vis detaljerede kapacitets-slots i ugeoversigt'),
  ('capacity_threshold_low',    '20',    'Under dette = ledig kapacitet (blå)'),
  ('capacity_threshold_green',  '35',    'Under dette = OK (grøn)'),
  ('capacity_threshold_yellow', '45',    'Under dette = advarsel (gul), over = rød'),
  ('production_start_time',     '08:00', 'Produktionsstart (tidligste tidspunkt for beregning)');
