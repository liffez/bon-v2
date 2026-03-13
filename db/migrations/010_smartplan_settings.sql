-- 010: Smartplan vagtplan-integration settings
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('smartplan_api_url', '', 'Smartplan API base URL'),
    ('smartplan_api_key', '', 'Smartplan API nøgle (hentes fra Smartplan → Indstillinger → API)'),
    ('smartplan_location_id', '', 'Smartplan lokation-ID (bruges til at filtrere vagter)');
