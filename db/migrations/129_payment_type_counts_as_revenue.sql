-- 129_payment_type_counts_as_revenue.sql
-- Betalingstyper der IKKE er omsætning (Modregning/Sponsorat).
--
-- #324 tilføjede Modregning (barter) + Sponsorat (sponsorship) og beholdt
-- bevidst bonnernes priser, så beløbet blev bevaret i rapporterne. Driften vil
-- have det modsatte: mad givet væk eller byttet er IKKE omsætning — men bonnen
-- (og dens ægte pris) skal stadig kunne findes.
--
-- Løsningen er data, ikke hardkodet kode: et flag pr. betalingstype. Rapporter,
-- dashboard, driftsregnskab, CRM-omsætning og opskrift-margin ganger krone-summer
-- med dette flag (0 → bidrager 0 kr), mens enheder/pax er urørt (en sponsoreret
-- event lavede stadig maden — den tæller i produktion/kapacitet).
--
-- Næste "gratis"-type koster én ny række + dette flag — ingen kodeændring.
-- Default 1 → alle eksisterende typer tæller som omsætning (uændret adfærd).

ALTER TABLE payment_types ADD COLUMN counts_as_revenue INTEGER NOT NULL DEFAULT 1;

UPDATE payment_types SET counts_as_revenue = 0 WHERE code IN ('barter', 'sponsorship');
