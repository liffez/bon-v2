-- 168_economic_no_discount_categories.sql
-- Den stående kunderabat må ikke ramme levering og gebyrer.
--
-- Baggrund (målt på Ables bogførte fakturaer, sep. 2026): e-conomics egen
-- prisgruppe fyrer IKKE gennem API'et — 12,5 % kom med på manuelt oprettede
-- fakturaer og 0 % på vores udkast til samme kunde. Rabatten skal derfor komme
-- fra bon (offer_discount_percent), og gør det nu. Men den lægges i dag på HVER
-- linje, så faktura 4194 gav 12,5 % rabat på miljøgebyret. Et gebyr skal ikke
-- rabatteres, og det skal en levering heller ikke.
--
-- Reglen er KATEGORI-styret, ikke hårdkodet: en ny gebyrtype koster en række i
-- Settings frem for en kodeændring. Samme mønster som economic_noninvoice_recipes
-- (149) og economic_amount_line_recipes (144). Kategorierne kommer fra Grocys
-- `grupper`-userfield og er eneste kilde — historiske stavevarianter normaliseres
-- væk af scripts/normalize-bon-line-categories.js.
--
-- '06 Emballage' er med i default'en efter beslutning 4. sep. 2026. Bemærk at det
-- er en ÆNDRING af hidtidig praksis: da Ables fakturaer blev tastet manuelt, fik
-- emballage 12,5 % som alt andet. Feltet kan derfor rulles tilbage i Settings uden
-- kodeændring hvis aftalen viser sig at være en anden.
--
-- Tom liste = rabat på alt (den gamle adfærd). Ugyldig JSON håndteres som tom af
-- parseren — en tastefejl i Settings må ikke kunne vælte en fakturering.

INSERT OR IGNORE INTO settings (key, value)
VALUES ('economic_no_discount_categories', '["x-Levering","x- Service","06 Emballage"]');
