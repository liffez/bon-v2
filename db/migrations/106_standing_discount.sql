-- 106_standing_discount.sql
-- Aktiverer den stående kunderabat (companies/customers.discount_percent), som
-- indtil nu kun blev læst men aldrig anvendt. Spec: CLAUDE_ECONOMIC_ADAPTER.md → RABAT.
--
-- Beslutninger:
--   • Omfang: både firmaer og privatkunder.
--   • Eksplicit rabat vinner: WHEN-guarden rører IKKE en bon der allerede har en rabat.
--   • Snapshot: triggeren fyrer kun ved INSERT — satsen kopieres der og da, så senere
--     ændring af firmaets/kundens sats IKKE rører eksisterende bons. Ingen tilbagevirkende kraft.
--
-- offer_discount_percent er den ENE rabat-sandhed i systemet (recalcBonTotal regner totalen
-- ud fra den; e-conomic-adapteren sender den som discountPercentage pr. linje). DB-trigger
-- frem for en createBon()-helper, fordi den håndhæves for ALLE oprettelses-paths inkl.
-- seed.js / sync-v1.js / scripts / manuel SQL (jf. tech-debt #237).

CREATE TRIGGER IF NOT EXISTS bons_seed_standing_discount
AFTER INSERT ON bons
WHEN (NEW.offer_discount_percent IS NULL OR NEW.offer_discount_percent = 0)
BEGIN
    UPDATE bons SET offer_discount_percent = COALESCE(
        (SELECT discount_percent FROM companies WHERE id = NEW.company_id  AND discount_percent > 0),
        (SELECT discount_percent FROM customers WHERE id = NEW.customer_id AND discount_percent > 0),
        0
    ) WHERE id = NEW.id;
END;
