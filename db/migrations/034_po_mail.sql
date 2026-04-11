-- Migration 034: Leverandørpost — kobling mellem mail_threads og purchase_orders
-- Tilføjer purchase_order_id FK på mail_threads + omvendt FK på purchase_orders
-- Tilføjer mail-tag prefix for indkøbsordrer (po-)

ALTER TABLE mail_threads
  ADD COLUMN purchase_order_id INTEGER REFERENCES purchase_orders(id);

CREATE INDEX idx_mail_threads_po ON mail_threads(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;

ALTER TABLE purchase_orders
  ADD COLUMN mail_thread_id INTEGER REFERENCES mail_threads(id);

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('mail_tag_purchase_order_prefix', 'po-', 'Mail-tag prefix for indkøbsordrer (#po-42)');
