-- 028_v1_sync.sql
-- Kolonner til at spore v1-oprindelse ved data-sync

ALTER TABLE bons ADD COLUMN v1_id INTEGER;
ALTER TABLE bons ADD COLUMN sync_source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bons_v1_id ON bons(v1_id) WHERE v1_id IS NOT NULL;

ALTER TABLE companies ADD COLUMN v1_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_v1_id ON companies(v1_id) WHERE v1_id IS NOT NULL;

ALTER TABLE customers ADD COLUMN v1_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_v1_id ON customers(v1_id) WHERE v1_id IS NOT NULL;

ALTER TABLE addresses ADD COLUMN v1_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_addresses_v1_id ON addresses(v1_id) WHERE v1_id IS NOT NULL;

-- Settings til sync-tidspunkter
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('v1_sync_last_run', '', 'Seneste v1 data-sync (ISO dato)');
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('v1_mail_sync_last_run', '', 'Seneste v1 mail-sync (ISO dato)');
