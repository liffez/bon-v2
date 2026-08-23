-- 160_event_return_cost.sql
-- ════════════════════════════════════════════════════════════════════════
-- Returen skal ændre eventets VAREFORBRUG, ikke kun lageret (#534).
-- Spec: docs/CLAUDE_EVENT.md §18.9.
--
-- #537 (migration 157) gav returen et spor: hvad blev lagt tilbage, hvornår,
-- af hvem — så en dobbelt bogføring kan ses, og forslaget trækker det allerede
-- returnerede fra. Men `computeEventCost` summerer stadig kun prep-bonnernes
-- linjer, så eventets "Vareforbrug" er HVAD VI PAKKEDE, ikke hvad der blev
-- brugt. På Vig Festival: 42.260 kr pakket mod 28.942 kr solgt til kostpris.
--
--     faktisk vareforbrug = prep + top-up − retur (talt fysisk)
--
-- Tre kolonner oven på #537's tabel — ingen ny tabel, ingen ny sandhed om
-- HVAD der blev returneret. Kun hvad det var værd.
--
-- unit_cost/cost_total er SNAPSHOTS (samme princip som bon_lines.cost_price):
-- råvarepriser ændrer sig, og et afsluttet events regnskab må ikke skride
-- fordi nogen køber rødløg til en anden pris næste måned. Eksisterende rækker
-- får 0 — vi opfinder ikke en pris bagudrettet for varer der allerede er
-- bogført hjem.
--
-- `forced` markerer at værnet blev tilsidesat: der blev talt mere hjem end
-- pakket − solgt − allerede returneret, hvilket betyder at varer har forladt
-- HQ uden en top-up-bon. Bogfører man alligevel, skal sporet kunne findes.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE event_returns ADD COLUMN unit_cost  REAL;
ALTER TABLE event_returns ADD COLUMN cost_total REAL NOT NULL DEFAULT 0;
ALTER TABLE event_returns ADD COLUMN forced     INTEGER NOT NULL DEFAULT 0;

-- Fysisk optælling af grøntsager er upræcis. Uden en tolerance ville værnet
-- fyre på afrundingsstøj og gøre funktionen ubrugelig. 10 % af en lille
-- beregnet rest er stadig lille i absolutte tal, så det egentlige tilfælde —
-- varer hentet uden top-up-bon, hvor den beregnede rest er 0 — fyrer uanset.
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('event_return_tolerance_pct', '10',
   'Retur: hvor mange procent den fysisk talte rest må overstige den beregnede (pakket − solgt − allerede returneret) før bogføringen afvises. Talt væsentligt MERE betyder at varer har forladt HQ uden en top-up-bon — så ville en bogført retur lægge varer på lager der aldrig blev trukket.');
