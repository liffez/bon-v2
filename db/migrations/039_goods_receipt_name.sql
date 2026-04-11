-- Migration 039: Gem modtager-navn som tekst (ikke FK)
ALTER TABLE goods_receipts ADD COLUMN received_by_name TEXT;
