-- 175_smagning_status_og_vogn.sql
-- ---------------------------------------------------------------------------
-- En booket smagning er hverken ny eller uafklaret — og den skal køres ud.
--
-- Bonen blev oprettet som NY og uden vogn. Begge dele er forkerte for præcis
-- denne bon-type:
--
--   1. STATUS. NY betyder "der er landet noget, nogen skal tage stilling".
--      Men en smagning er fuldt afklaret i det sekund kunden trykker book:
--      menuen er fast, adressen er tastet, tidspunktet er et slot vi selv har
--      åbnet. Der er intet at afklare, så bonen skal ikke ligge i NY-bunken
--      og stjæle opmærksomhed fra de bestillinger der FAKTISK mangler noget.
--      GODKENDT som standard. Vil man alligevel se dem igennem først, sættes
--      VENTER (Venter info) i Settings — derfor en indstilling og ikke en
--      hårdkodet værdi.
--
--   2. VOGN. Vi kører selv smagsprøven ud (Volvo Duett). Uden vognen står
--      bonen som "Ikke planlagt endnu" i Logistik og på køkkenkortet, og
--      nogen skal huske at sætte den i hånden — på hver eneste smagning.
--      Vognen slås op på type = 'volvo' + is_internal, ikke på et hårdkodet
--      id: seeden i 057 giver ikke nogen garanti for hvilket id den fik.
--      Tom værdi = book ikke automatisk (det er et gyldigt valg).
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('booking_smagning_bon_status', 'GODKENDT'),
    ('booking_smagning_vehicle_id', '');

UPDATE settings
   SET value = COALESCE((SELECT CAST(id AS TEXT)
                           FROM delivery_vehicles
                          WHERE type = 'volvo' AND is_internal = 1 AND is_active = 1
                          ORDER BY sort_order, id
                          LIMIT 1), '')
 WHERE key = 'booking_smagning_vehicle_id'
   AND value = '';
