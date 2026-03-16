-- 015: Dashboard settings
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('dashboard_countdown_enabled', '0',  '1 = vis nedtælling til næste pickup på kitchen dashboard'),
    ('dashboard_quiet_threshold',   '60', 'Stille-dag advarsel ved under X% af historisk gennemsnit');
