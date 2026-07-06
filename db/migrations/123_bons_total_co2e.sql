-- 123_bons_total_co2e.sql
-- CO₂ F6 (#111) — frosset CO₂-aftryk pr. bon.
-- Spec: docs/CLAUDE_CO2.md §7 + §12 trin 6.
--
-- bon_lines.co2e er allerede et frosset snapshot pr. ENHED (recipe.Co2e ved
-- linje-oprettelse). Denne migration tilføjer den denormaliserede sum pr. bon:
--   bons.total_co2e = Σ(bon_lines.co2e × quantity)
-- Vedligeholdes af recalcBonTotalCo2e() (db/helpers.js) ved linje-ændringer —
-- samme steder som total_units. Frosset: ændres aldrig bagud når faktorer
-- opdateres, fordi bon_lines.co2e er frosset.

ALTER TABLE bons ADD COLUMN total_co2e REAL;

-- Backfill eksisterende bons ud fra deres (allerede frosne) linje-co2e.
UPDATE bons
   SET total_co2e = (
       SELECT COALESCE(SUM(bl.co2e * bl.quantity), 0)
         FROM bon_lines bl
        WHERE bl.bon_id = bons.id
   );
