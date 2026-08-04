-- 134_event_order_base_url.sql
-- Base-URL til event-order-3 (event-broen). Bruges til "Opdater menu i event-ordre"-
-- knappen, der trigger øjeblikkelig menu-refresh i stedet for 10-min-cachen.
-- Tom = knappen skjules. Settbar i Settings → System.
INSERT OR IGNORE INTO settings (key, value) VALUES ('event_order_base_url', '');
