-- 122_smartplan_hq_location.sql
-- ════════════════════════════════════════════════════════════════════════
-- Lokations-split af Smartplan-vagter: HQ (Ristet Rug) vs. Festival & Events.
--
-- Smartplan modellerer de to vagtplaner som Lokationer ("Ristet Rug" og
-- "Festivaler og Events"). smartplanAdapter klassificerer hver vagt som
-- 'hq' | 'events' ud fra denne setting: vagter hvis location.title matcher
-- smartplan_hq_location = 'hq', alt andet = 'events'. Tom/ukendt lokation
-- falder til 'hq' (vises i den primære driftsvisning, skjules ikke).
--
-- Ændres her hvis HQ-lokationens navn i Smartplan ændrer sig. Bruges af
-- vagtplan-siden, dashboard-bemanding, kalender og ugeoversigt.
-- Driftsregnskabets lokations-kontering er et separat, senere spor.
-- ════════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('smartplan_hq_location', 'Ristet Rug',
   'Smartplan: navnet på HQ-lokationen. Vagter på denne lokation regnes som HQ (Ristet Rug); alle andre lokationer som Festival & Events. Tom/ukendt lokation regnes som HQ.');
