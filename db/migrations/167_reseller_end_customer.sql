-- 167_reseller_end_customer.sql
-- ============================================================
-- Forhandlere: hvem betaler, og hvem skal maden ud til?
--
-- Able er et frokostbestillings-firma. De lægger ordren ind på VORES
-- bestillingsformular for deres egne kunder, og skriver slutkundens navn i
-- formularens Firma-felt — der er ikke noget andet felt at skrive det i.
--
-- Webhooken matcher firma på eksakt navn og opretter en ny firma-række når
-- navnet ikke findes. Hver skrivemåde bliver derfor sit eget firma:
-- "Systematic / able", "Systematic  (Able)", "Cisco / able", "Brunata / able",
-- "able ApS" … otte rækker i drift 27. august 2026. Bonnen lander på den
-- række, og så følger hverken e-conomic-kundenummeret, omsætningen eller den
-- stående rabat med — de sidder på Able.
--
-- To kolonner løser det:
--
--   companies.is_reseller   Bestiller firmaet for ANDRE? Sat på Able alene.
--                           Bruges af webhooken til at lægge bonnen på
--                           forhandleren i stedet for på det navn der blev
--                           tastet. Default 0 ⇒ alle andre firmaer opfører sig
--                           nøjagtigt som før.
--
--   bons.end_customer_name  Slutkunden, som fri tekst. Bevidst tekst og ikke
--                           en FK til companies: formularen giver os en streng,
--                           og et FK ville kræve at nogen manuelt koblede hver
--                           bon. Teksten er nok til at søge og filtrere på.
--                           Skal der senere aggregeres rigtig omsætning pr.
--                           slutkunde, lægges en kobling ved siden af — samme
--                           mønster som indbakkens parsed_email → kontaktpunkt.
--
-- Rækkefølgen betyder noget for rabatten: trigger `bons_seed_standing_discount`
-- (migration 111) læser discount_percent fra det firma bonnen ligger på. Så
-- længe bonnen lander på "Systematic / able" (rabat 0), kan Ables 12,5 % ikke
-- virke — uanset hvad der står på Able-rækken. Routingen er altså en
-- forudsætning for rabatten, ikke et selvstændigt pyntearbejde.
--
-- Ingen bagudfyldning: vi kan ikke vide hvilke af de gamle bons der havde en
-- slutkunde, og et gæt ud fra fri tekst i customer_wishes ville være netop den
-- slags data ingen bagefter kan skelne fra noget nogen har skrevet.
-- ============================================================

ALTER TABLE companies ADD COLUMN is_reseller INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bons ADD COLUMN end_customer_name TEXT;

CREATE INDEX IF NOT EXISTS idx_bons_end_customer
    ON bons(end_customer_name) WHERE end_customer_name IS NOT NULL;
