-- 149_webhook_secret_to_env.sql
-- ════════════════════════════════════════════════════════════
-- Fjern den ubrugte settings-række `whiteboard_webhook_secret` (#460).
--
-- Rækken blev seedet i migration 035 (11. april 2026) og har stået tom og
-- ulæst lige siden — ét eneste sted i hele repoet nævner nøglen, og det er
-- den migration der oprettede den.
--
-- Hemmeligheden bor nu i .env som GOODS_RECEIPT_WEBHOOK_SECRET, af to grunde:
--
--   1. Modtageren har ingen Settings-side og SKAL have værdien i sin egen
--      .env. Lå den ene halvdel i browseren, kunne man skifte den her og
--      bryde koblingen — og først opdage det som 401'er i forsøgs-listen.
--   2. Alle andre hemmeligheder i Bon v2 bor i .env (SMTP, ORS, Hørkram).
--      Dev-databasen kopieres rundt til analyse; hemmeligheder bør ikke følge
--      med kopien.
--
-- Rækken slettes frem for at blive stående, fordi et tomt felt med præcis
-- det rigtige navn er en fælde: den næste der leder efter hemmeligheden
-- finder den her, udfylder den, og intet sker.
--
-- Sikkert at køre: kun tomme rækker rammes. Har nogen alligevel nået at
-- skrive en værdi, bliver den stående, så den ikke går tabt uden varsel.

DELETE FROM settings
WHERE key = 'whiteboard_webhook_secret'
  AND COALESCE(TRIM(value), '') = '';
