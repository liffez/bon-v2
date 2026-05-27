-- Migration 082: nulstil historiske match-støj (conf 1-49)
-- ════════════════════════════════════════════════════════════
-- Den oprindelige runMatchLogic registrerede matches helt ned til conf=40,
-- som betyder "samme beløb-størrelse, dage-diff > 14". Det er for løst som
-- beslutningsgrundlag — kunder med tilbagevendende betalinger (fx
-- Læderstræde 20 aps med ugentlige 1.300-1.700 kr-betalinger) fik 30+
-- "matches" registreret på samme faktura, fordi hver ny bankpostering
-- ramte conf=40 mod en gammel udestående faktura.
--
-- Konsekvens: "Sandsynlig betalt"-listen blev oversvømmet med fakturaer
-- der reelt ikke var sandsynligt betalt — bare havde støjmatches.
--
-- routes/cashflow.js er samtidig opdateret så fremtidige match-runs
-- kun registrerer matches >= 50. Denne migration rydder eksisterende
-- støj så listen ikke længere lider af det historiske rod.
-- ════════════════════════════════════════════════════════════

UPDATE cf_transactions
SET matched_invoice_id = NULL, match_confidence = 0
WHERE match_confidence > 0 AND match_confidence < 50;
