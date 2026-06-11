-- 101_event_role.sql
-- Persistér event-rollen (prep/topup/sales/expense) på bonen.
--
-- Hidtil blev rollen udledt i classifyRole(): første produktionsbon = prep,
-- resten = top-up. Det gjorde det umuligt at have prep-bons for flere dage
-- på et flerdags-event — "+ Prep" på dag 2 landede under Top-up.
-- Generatoren kender rollen ved oprettelse, så vi gemmer den. NULL for
-- bons der ikke er event-genererede (eller oprettet før denne migration —
-- de klassificeres med en per-dato fallback-heuristik).

ALTER TABLE bons ADD COLUMN event_role TEXT
    CHECK (event_role IN ('prep','topup','sales','expense'));

-- Backfill eksisterende event-produktionsbons: første produktionsbon pr.
-- (event, delivery_date) = prep, efterfølgende samme dag = topup. Salg/udgift
-- udledes af fortegn på total_price.
UPDATE bons SET event_role = 'prep'
WHERE event_id IS NOT NULL AND event_role IS NULL
  AND price_category_id IN (SELECT id FROM price_categories WHERE code = 'produktion')
  AND id IN (
      SELECT MIN(b2.id) FROM bons b2
      WHERE b2.event_id = bons.event_id
        AND b2.delivery_date = bons.delivery_date
        AND b2.price_category_id IN (SELECT id FROM price_categories WHERE code = 'produktion')
      GROUP BY b2.event_id, b2.delivery_date
  );

UPDATE bons SET event_role = 'topup'
WHERE event_id IS NOT NULL AND event_role IS NULL
  AND price_category_id IN (SELECT id FROM price_categories WHERE code = 'produktion');

UPDATE bons SET event_role = CASE WHEN COALESCE(total_price, 0) < 0 THEN 'expense' ELSE 'sales' END
WHERE event_id IS NOT NULL AND event_role IS NULL;
