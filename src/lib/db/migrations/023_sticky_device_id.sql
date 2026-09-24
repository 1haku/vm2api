-- Parent session pointer for Haiku skill-routing hops. API key is only the tenant prefix.
ALTER TABLE sticky_sessions ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sticky_device ON sticky_sessions(device_id);
