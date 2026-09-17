-- 177 — Varemodtagelsen husker den pris den sendte til Grocy (#657)
--
-- Prisen bor i Grocy (stregkodens last_price) — Bon har ingen prisregister.
-- Her gemmes kun hvad der FAKTISK blev sendt med den enkelte leverance, så det
-- kan ses bagefter. NULL = ingen pris sendt; Grocy førte den forrige videre.
--
-- received_price er kr pr. lager-enhed, ex moms (moms-doktrinen §6b).
-- received_price_source er varenummeret prisen kom fra.

ALTER TABLE goods_receipt_items ADD COLUMN received_price REAL;
ALTER TABLE goods_receipt_items ADD COLUMN received_price_source TEXT;
