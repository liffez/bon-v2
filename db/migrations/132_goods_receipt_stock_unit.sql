-- 132_goods_receipt_stock_unit.sql
-- ════════════════════════════════════════════════════════════
-- Gør det synligt HVAD der faktisk blev lagt på lager ved en varemodtagelse.
--
-- Hvorfor: `received_quantity` står i den enhed varen blev BESTILT i (Hørkram
-- leverer i kasser og poser), mens Grocy fører lageret i produktets lager-enhed
-- (typisk kilo). De to tal er ikke det samme, og indtil #358 blev det bestilte
-- tal skrevet råt til lageret — Brød Rug blev bestilt i kasser og lagt på som
-- kilo. To bekræftede tilfælde i drift (Spidskål 3. juni, Rødkål 18. maj).
--
-- Efter rettelsen konverterer serveren, og de to kolonner her gemmer resultatet,
-- så en modtagelse kan læses bagfra: "12,1875 Kasse → 15,84 Kilo". Uden dem er
-- konverteringen usynlig, og næste gang nogen undrer sig over et lagertal, skal
-- de gætte igen.
--
-- NULL betyder "modtaget før denne rettelse" — de rækker er ikke konverteret.
-- ════════════════════════════════════════════════════════════

ALTER TABLE goods_receipt_items ADD COLUMN stock_quantity REAL;
ALTER TABLE goods_receipt_items ADD COLUMN stock_unit TEXT;
