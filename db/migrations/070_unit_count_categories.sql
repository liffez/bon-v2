-- 070_unit_count_categories.sql
-- Definerer hvilke Grocy-kategorier (grupper-userfield) der tæller med i
-- bons.total_units. Grocy er master for selve listen af mulige kategorier;
-- denne setting udvælger hvilke der skal regnes med som "enheder".
--
-- Regel: kun sandwich, slider og salat tæller som enheder.
-- Kager, drikke, emballage, levering og tilbehør tæller IKKE med.
--
-- Defaultværdien matcher kategorier der eksisterer i nuværende data
-- (inkl. historiske stavevarianter uden tal-prefix og "Burger" som synonym
-- for slider). Listen redigeres i Settings → System → Enheds-kategorier.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('unit_count_categories',
   '["01 Sandwich","02 Salat","04 Slider","Burger","Slider","Salat"]',
   'JSON-array af Grocy grupper-værdier der tæller som enheder i bons.total_units. Kun disse kategorier summeres når antal enheder beregnes — kager, drikke, emballage, levering og tilbehør udelukkes. Redigeres i Settings → System → Enheds-kategorier.');
