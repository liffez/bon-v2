-- Fysiske enheder til lageroptælling (KØL-1, FRYS-2 etc.)
-- Erstatter localStorage-baseret lagring så enheder syncer mellem devices.

CREATE TABLE IF NOT EXISTS physical_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grocy_location_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  archived_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Unique på (location, name) blandt ikke-arkiverede — tillader reuse af arkiveret navn
CREATE UNIQUE INDEX IF NOT EXISTS idx_physical_units_active
  ON physical_units (grocy_location_id, name)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_physical_units_location
  ON physical_units (grocy_location_id);
