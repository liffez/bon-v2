-- 027: Konfigurerbare pax-kategorier til legoklods-rapporten
INSERT OR IGNORE INTO settings (key, value, description) VALUES (
  'lego_pax_categories',
  '[{"key":"smaa","label":"Små","max_pax":20,"color":"#4a90d9","sort_order":1},{"key":"mellem","label":"Mellem","max_pax":80,"color":"#c49a45","sort_order":2},{"key":"store","label":"Store","max_pax":120,"color":"#6d4c16","sort_order":3},{"key":"events","label":"Events","max_pax":180,"color":"#7a9c54","sort_order":4},{"key":"festival","label":"Festival","max_pax":null,"color":"#d4652a","sort_order":5}]',
  'Pax-størrelseskategorier til legoklods-rapport (JSON-array med key, label, max_pax, color, sort_order). Festival matcher på price_category, resten på pax-grænser.'
);
