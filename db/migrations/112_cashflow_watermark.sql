-- 112_cashflow_watermark.sql
-- Pengestrøm delta B: vandmærke for e-conomic-afstemning.
-- Spec: docs/economics/CLAUDE_PENGESTROEM.md §2.A + §2.B.
--
-- cf_meta (key/value) findes allerede (mig. 047). Vi seeder kun vandmærke-nøglen.
-- economic_booked_until = seneste dato e-conomic har bogført til. Tom = afstem alt
-- ved første kørsel; services/cashflowReconcile.js rykker den frem efter hver synk.

INSERT OR IGNORE INTO cf_meta (key, value) VALUES ('economic_booked_until', '');
