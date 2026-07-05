-- 120_bestilling_closed_dates.sql
-- Ferielukket / lukkedage på den offentlige bestillingsformular.
--
-- Værdi: JSON-array af intervaller. Hvert element:
--   { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "label": "Sommerferie" }
-- En enkelt lukkedag gemmes som from === to.
--
-- En leveringsdato er lukket hvis from <= dato <= to for et element
-- (ISO-datoer sammenlignes leksikografisk). Formularen spærrer datoen +
-- viser labelen; webhooken afviser bestillinger i perioden (server-guard).

INSERT INTO settings (key, value, description)
VALUES ('bestilling.closed_dates', '[]', 'Ferielukket/lukkedage (JSON-array af {from,to,label}) — spærrer leveringsdatoer i bestillingsformen')
ON CONFLICT(key) DO NOTHING;
