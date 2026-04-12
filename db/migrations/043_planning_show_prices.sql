-- Fase: Priser i planlægningsbon
-- Setting til at vise/skjule priskolonner i planlægningsbon

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('show_prices_in_planning', '0', 'Vis salgspris/kostpris/margin i planlægningsbon (0=skjult, 1=synlig)');
