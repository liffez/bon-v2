-- 166_event_rest_prep.sql
-- ════════════════════════════════════════════════════════════
-- REST-PREP: forecast-prep-bonnen holder RESTEN op til dagens mål.
-- Spec: docs/CLAUDE_EVENT.md §6 (forecast) — rest-prep beskrives i §20.
--
-- Problemet: på et event med event-ordre-kobling ligger der TO prep-bons pr.
-- dag — broens (kundernes forudbestillinger, vokser ved hver ordre) og office'
-- egen fra forecasten. Overlappet stod kun som fritekst i køkkeninfoen, så
-- begge blev talt fuldt med: ugeoversigt, kapacitet, top-up, retur — og
-- HQ-lagertrækket ved LEVERET. Målt i drift 2. sep 2026: 400 + 332 = 732
-- enheder registreret hvor der kun forlader huset 400.
--
-- Reglen (Leif, 26. aug 2026):
--     mål for dagen  =  max(forecast, forudbestilt)
--     rest-bonnen    =  mål − alt andet der allerede er preppet den dag
--
-- max() er "forecasten styrer, indtil de faktiske ordrer løber fra den" — så
-- behøver forecasten aldrig blive rettet automatisk bag office' ryg.
--
-- Hvorfor rest-bonnen genberegnes af sig selv frem for at blive rettet i
-- hånden: forudbestillinger kan komme ind helt frem til bestillingsfristen
-- (30. aug for eventet 2.-3. sep). En manuel rettelse er forældet dagen efter,
-- og så gentager præcis den drift der skabte problemet.
-- ════════════════════════════════════════════════════════════

-- ─── 1) Opt-in-flaget på bonnen ────────────────────────────────────────────
-- "Denne prep-bon holder resten op til dagens mål og må genberegnes."
--
-- Bevidst OPT-IN: en prep-bon office har sammensat i hånden må ikke pludselig
-- begynde at flytte sig. Flaget sættes i prep-modalen (slået til når dagen har
-- bro-ordrer) eller bagefter på en bon der allerede findes.
--
-- Genberegningen fryser af sig selv når bonnen forlader GODKENDT eller har
-- trukket lager — samme vagt som broen bruger på sin egen bon. Efter det er
-- bonnen køkkenets, og nye ordrer bliver til en top-up i stedet.
ALTER TABLE bons ADD COLUMN event_prep_auto_rest INTEGER NOT NULL DEFAULT 0;

-- Kun én auto-rest-bon pr. (event, pakkedag). To overlappende ville trække
-- hinanden fra og kunne svinge frem og tilbage; math'en skal være entydig.
-- Partielt indeks — rører ikke de tusindvis af bons uden flaget.
CREATE UNIQUE INDEX idx_event_rest_prep_unique
    ON bons(event_id, delivery_date)
    WHERE event_prep_auto_rest = 1;

-- ─── 2) Den oprindelige forecast bevares ───────────────────────────────────
-- Forecasten korrigeres løbende efterhånden som rigtige ordrer kommer ind.
-- Uden dette felt går "hvad gættede vi egentlig på?" tabt i det øjeblik tallet
-- rettes — og så kan eventet ikke evalueres bagefter.
--
-- NULL = aldrig korrigeret (så er expected_qty selv den oprindelige). Vi
-- backfiller bevidst IKKE eksisterende rækker: vi ved ikke om de er rettet,
-- og et gæt ville se ud som en måling. Feltet fyldes første gang et tal
-- FAKTISK ændrer sig.
ALTER TABLE event_forecast ADD COLUMN original_qty INTEGER;
