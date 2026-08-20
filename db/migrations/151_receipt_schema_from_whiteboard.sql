-- =============================================
-- Migration 151: varemodtagelsens skema kommer fra tavlen
--
-- ── Hvorfor ──
-- FVST-skemaet fandtes to steder. Whiteboard ejer definitionen i
-- registration_types.fields og kan redigeres i admin; Bon v2 havde en
-- HÅNDSKREVET kopi i shared/varemodtagelse.js:
--
--     _vmBuildTempRow('koel', '🧊', 'Kølevarer', 'max. 5°C', 4.5, 0.1, true, 4.7, 5)
--
-- De tal er tavlens skema, skrevet af i hånden. Rettede man grænseværdien i
-- admin, skete der ingenting her. To kopier af den samme sandhed driver fra
-- hinanden, og FVST-dokumentation er ikke et sted at have to sandheder.
--
-- Tavlen er nu eneste kilde. Bon henter skemaet gennem en maskindør
-- (GET /api/registration-types/schema, X-Webhook-Secret) og cacher det her.
--
-- ── Cachen er ikke en optimering, den er en garanti ──
-- Fødevarekontrollen er lovpligtig og må ALDRIG blokeres af at tavlen er nede
-- eller koblingen slukket. Samme princip som varemodtagelsen allerede følger
-- for Grocy: lageret kan fejle, dokumentationen skal igennem. Rækkefølgen er
-- tavlen → cache → indbygget kopi i koden.
-- =============================================

-- Hvilken vare blev temperaturen målt på?
--
-- FVST-loggen kunne fortælle AT der var målt 3,5 °C, men ikke HVAD der blev
-- målt på. Egne kolonner frem for extra_fields_json, fordi Bon v2 renderer
-- felterne rigere end tavlen kan: en liste over varerne på netop den
-- leverance. Værdien er varenavnet som tekst — ikke et Grocy-id — så tavlen
-- kan tage imod det uden også at skulle kende Grocy.
ALTER TABLE goods_receipts ADD COLUMN temperature_cool_product   TEXT;
ALTER TABLE goods_receipts ADD COLUMN temperature_frozen_product TEXT;

-- Felter Bon v2 ikke har en kolonne til.
--
-- Uden denne ville "tavlen ejer skemaet" kun gælde halvt: labels, grænser og
-- valgmuligheder ville slå igennem, men et HELT NYT felt tilføjet i admin
-- ville kræve en kodeændring og en migration her. Ukendte felter renderes
-- generisk, gemmes som JSON og sendes videre til tavlen — så et nyt felt
-- virker uden at nogen rører Bon v2.
--
-- Formen er {felt_id: værdi}. Kendte felter havner ALDRIG her; de har deres
-- egne kolonner, så rapporter og tests er upåvirkede.
ALTER TABLE goods_receipts ADD COLUMN extra_fields_json TEXT;

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('whiteboard_schema_cache', '',
   'Seneste skema hentet fra Whiteboard (JSON). Skrives af services/receiptSchema.js — redigér ikke i hånden.'),
  ('whiteboard_schema_cache_at', '',
   'Hvornår skemaet sidst blev hentet fra Whiteboard (ISO). Tom = aldrig hentet; så bruges den indbyggede kopi.');
