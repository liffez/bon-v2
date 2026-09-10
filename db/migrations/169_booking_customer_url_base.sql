-- 169: Skil kundernes base-URL fra appens.
--
-- booking_public_url_base hed "public", men er i praksis appens base-URL:
-- den bygger office-links i interne mails (bookingMatcher, web-orders) og
-- fallback for Lobo-webhooken (delivery). Da den blev sat til et pænt
-- kundedomæne, pegede sælgernes links ind i CRM på kundens kontaktformular.
--
-- Derfor to begreber i stedet for ét:
--   booking_public_url_base    → appen selv. Office, webhooks, alt internt.
--   booking_customer_url_base  → de sider kunder ser. Kun {{booking_link}}
--                                og URL-visningen i Settings.
--
-- Tom værdi betyder "brug app-basen", så opsætninger uden pænt domæne
-- opfører sig præcis som før.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('booking_customer_url_base', '', 'Kundevendt domæne for booking-siderne, fx https://kontakt.ristetrug.dk. Tom = brug booking_public_url_base');
