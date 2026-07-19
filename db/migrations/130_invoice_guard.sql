-- 130_invoice_guard.sql
-- Fakturavagt (#319): fang bons der markeres FAKTURERET/AFSLUTTET uden at der
-- nogensinde blev lavet en faktura.
--
-- Driften opdagede at en fast rutine markerede bons faktureret morgenen efter
-- levering — uden at der blev oprettet en kladde. Bonnen forlod faktureringskøen,
-- kunden fik aldrig en regning, og beløbet gemte sig under "Forfaldne" som om
-- kunden var en dårlig betaler.
--
-- SKÆRINGSDATO: uden den ville vagten lyse på hvert eneste historiske AFSLUTTET
-- bon fra før e-conomic — og så dør den med det samme (samme mekanisme som
-- #319 selv beskriver om arbejdslisten). Kun bons med delivery_date >= denne dato
-- vurderes.
--
-- 2026-06-27 er dagen den første e-conomic-kladde blev oprettet fra Bon v2 —
-- altså dér hvor "der findes ingen faktura" begynder at være et ægte signal
-- frem for blot fravær af en rutine. Målt på drifts-data giver den dato en
-- håndterbar liste, mens en måned tidligere giver et mangedoblet antal.
--
-- De ældre tilfælde er ikke glemt: de er et separat ENGANGS-oprydningsarbejde
-- (#319 forslag 1+2), ikke noget der skal stå og blinke permanent.
--
-- Justér i Settings → System → Fakturavagt hvis rutinen reelt startede en anden dag.

INSERT OR IGNORE INTO settings (key, value)
VALUES ('invoice_guard_from_date', '2026-06-27');
