-- 133_event_bridge_secret.sql
-- Delt secret til event-broen (docs/CLAUDE_EVENT_BON_BRIDGE.md). Tom = endpoints
-- er ubeskyttede (secret håndhæves kun når den er sat). Settbar i Settings → System.
INSERT OR IGNORE INTO settings (key, value) VALUES ('event_bridge_secret', '');
