-- 185_grocy_test_url.sql
-- ==========================================
-- Test-lokationen pegede på den UDFASEDE Grocy (#591 / #514).
--
--   grocytest.ristetrug.dk   → gammel instans på Linode — svarer 401 med vores nøgle
--   grocy-test.ristetrug.dk  → den nye på .202 — svarer 200
--
-- Uden nøgle svarer BEGGE 401, så en hurtig curl afslører det ikke. Serveren
-- bruger `locations.grocy_api_url` (ikke .env), så en frisk dev-DB ramte en
-- Grocy der afviser os, og alt Grocy-afhængigt fejlede stille: tomme lister i
-- opskrifter, lager, "Lav snart", råvarer og indkøb — ikke en fejlbesked.
--
-- Samme fejlklasse som HQ→grocycafe-fælden i CLAUDE.md: et navn overlever en
-- flytning, og opslaget svarer stadig — bare fra den gamle maskine.
--
-- Idempotent, og rører KUN den gamle værdi: har nogen sat en anden URL i hånden
-- (fx en lokal Grocy), står den urørt.
--
-- Trailer er bevidst IKKE med: `grocytrailer` (gammel) svarer 200, mens
-- `grocy-trailer` (ny) stadig 302'er til login fordi dens nginx-undtagelse for
-- /api mangler. At flytte den nu ville bytte noget der virker ud med et
-- login-redirect. Den flyttes når undtagelsen er på plads (#514).
-- ==========================================

UPDATE locations
   SET grocy_api_url = 'https://grocy-test.ristetrug.dk/api'
 WHERE code = 'test'
   AND grocy_api_url = 'https://grocytest.ristetrug.dk/api';
