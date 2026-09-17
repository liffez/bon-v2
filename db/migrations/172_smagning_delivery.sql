-- 172_smagning_delivery.sql
-- ---------------------------------------------------------------------------
-- En smagning er en LEVERING, ikke et møde hos os.
--
-- Booking-modulet er bygget som "kunden kommer forbi": bekræftelsen siger
-- "Hos os: <vores adresse>", og formularen spørger aldrig hvor kunden er.
-- Virkeligheden er en anden — køkkenet pakker en smagsprøve, og vi kører
-- den ud til kunden på dagen. Uden en adresse kan hverken bekræftelsen,
-- køkkenet eller Logistik gøre deres arbejde.
--
--   1. needs_delivery_address  — pr. mødetype. "Andet" er en uforpligtende
--      snak der fint kan tages på telefon og skal ikke spørge om en adresse.
--   2. crm_activities.delivery_address_id — bookingens EGEN adresse. Ligger
--      her og ikke kun på bonen, fordi bon-oprettelsen er best-effort: den
--      må aldrig kunne vælte kundens booking, og så skal adressen overleve
--      at den fejlede.
--   3. Indstillingerne — menu, betalingstype og priskategori vælges i
--      Settings, ikke i kode. Køkkenet skal kunne ændre smagsprøvens indhold
--      uden en udrulning.
-- ---------------------------------------------------------------------------

ALTER TABLE meeting_types ADD COLUMN needs_delivery_address INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_activities ADD COLUMN delivery_address_id INTEGER REFERENCES addresses(id);

-- Smagninger leveres. Gennemgang/Andet gør ikke.
UPDATE meeting_types SET needs_delivery_address = 1
 WHERE key IN ('smagning', 'smagning_gennemgang');

INSERT OR IGNORE INTO settings (key, value) VALUES
    -- Slå auto-oprettelsen fra uden en kodeændring hvis den driller.
    ('booking_smagning_create_bon', '1'),

    -- Standard-smagsprøven som menu_items — samme form som web-bestillingen
    -- sender, så resolveMenuItemLines kan bruges direkte. Tom = ingen linjer;
    -- retterne vælges i Settings → Booking — Smagsprøve.
    ('booking_smagning_menu', '[]'),

    -- Hvilken betalingstype bonnen får. 'sponsorship' (Sponsorat) har
    -- counts_as_revenue = 0, så bonnen bidrager 0 i omsætning og rapporter
    -- mens enheder og pax tæller som de skal — maden bliver jo lavet.
    -- Peges mod en anden type i Settings hvis huset har sin egen.
    ('booking_smagning_payment_type', 'sponsorship'),

    -- Priskategori for linjernes snapshot. Den ægte pris bliver stående, så
    -- man kan se hvad smagsprøverne koster — præcis som for Sponsorat.
    ('booking_smagning_price_category', 'catering');
