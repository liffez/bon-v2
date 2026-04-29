-- Migration 052: Leverandør-mail (supplier-threads parallelt med PO-tråde)
-- Mail_threads kan nu være knyttet til en leverandør (uden specifik PO).
-- Bruges fra Indkøb-tabben + Settings → Leverandører til generel kommunikation.

ALTER TABLE mail_threads
  ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);

CREATE INDEX idx_mail_threads_supplier ON mail_threads(supplier_id)
  WHERE supplier_id IS NOT NULL;

-- Tag-prefix for supplier-mail (parallelt med 'b-', 't-', 'k-', 'po-')
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('mail_tag_supplier_prefix', 's-', 'Mail-tag prefix for leverandør-tråde');
