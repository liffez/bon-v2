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
-- vurderes. Default er dagen migrationen kører, så vagten starter ren og kun
-- gælder fremad. Justér i Settings hvis e-conomic-rutinen startede en anden dag.

INSERT OR IGNORE INTO settings (key, value)
VALUES ('invoice_guard_from_date', date('now', 'localtime'));
