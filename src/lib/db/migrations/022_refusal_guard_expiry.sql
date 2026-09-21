-- 022_refusal_guard_expiry — 5xx pause rows expire; content-filter rows stay.
ALTER TABLE refusal_guards ADD COLUMN expires_at TEXT;
