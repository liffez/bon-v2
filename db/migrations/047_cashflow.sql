-- Cashflow-modul: banktransaktioner, fakturaer, metadata
-- Admin-only pengestrøms-overblik

CREATE TABLE IF NOT EXISTS cf_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dato DATE NOT NULL,
  tekst TEXT NOT NULL,
  beloeb REAL NOT NULL,          -- negativt = udgift
  saldo REAL,
  matched_invoice_id TEXT REFERENCES cf_invoices(id) ON DELETE SET NULL,
  match_confidence INTEGER DEFAULT 0,  -- 0-100
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(dato, tekst, beloeb)
);

CREATE TABLE IF NOT EXISTS cf_invoices (
  id TEXT PRIMARY KEY,            -- fakturanummer, fx "4821"
  kunde TEXT NOT NULL,
  beloeb REAL NOT NULL,
  forfald DATE NOT NULL,
  betalt INTEGER DEFAULT 0,       -- 0/1
  betalt_dato DATE,
  betalingstype TEXT,             -- 'ean' | 'bank' | 'kontant'
  noter TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cf_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Indekser for hurtige opslag
CREATE INDEX IF NOT EXISTS idx_cf_tx_dato ON cf_transactions(dato);
CREATE INDEX IF NOT EXISTS idx_cf_tx_matched ON cf_transactions(matched_invoice_id);
CREATE INDEX IF NOT EXISTS idx_cf_tx_confidence ON cf_transactions(match_confidence);
CREATE INDEX IF NOT EXISTS idx_cf_inv_forfald ON cf_invoices(forfald);
CREATE INDEX IF NOT EXISTS idx_cf_inv_betalt ON cf_invoices(betalt);
