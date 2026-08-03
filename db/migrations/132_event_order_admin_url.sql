-- 132_event_order_admin_url.sql
-- Global URL til event-order-3's admin (event-broen, docs/CLAUDE_EVENT_BON_BRIDGE.md).
-- Bruges af en link-knap i office event-detaljen. Tom værdi = knappen skjules.
INSERT OR IGNORE INTO settings (key, value) VALUES ('event_order_admin_url', '');
