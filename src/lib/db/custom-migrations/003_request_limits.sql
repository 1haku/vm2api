CREATE TABLE custom_user_request_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  concurrency INTEGER NOT NULL DEFAULT 5 CHECK (concurrency BETWEEN 0 AND 128),
  rpm_limit INTEGER NOT NULL DEFAULT 0 CHECK (rpm_limit BETWEEN 0 AND 1000000)
);
INSERT INTO custom_user_request_limits(user_id,concurrency)
SELECT id,CASE WHEN role='admin' THEN 0 ELSE concurrency END FROM users;

ALTER TABLE custom_subscription_plans ADD COLUMN group_rpm_limit INTEGER NOT NULL DEFAULT 0 CHECK (group_rpm_limit BETWEEN 0 AND 1000000);
ALTER TABLE custom_subscription_plans ADD COLUMN user_rpm_limit INTEGER NOT NULL DEFAULT 0 CHECK (user_rpm_limit BETWEEN 0 AND 1000000);

-- Accepted request starts only; all dimensions are checked before one row is inserted.
-- Retained for 60 seconds, independently of usage logs, key deletion and process restarts.
CREATE TABLE custom_request_rpm_events (
  request_id TEXT PRIMARY KEY,
  user_id TEXT,
  group_id INTEGER,
  started_at INTEGER NOT NULL
);
CREATE INDEX idx_custom_rpm_time ON custom_request_rpm_events(started_at);
CREATE INDEX idx_custom_rpm_user_time ON custom_request_rpm_events(user_id,started_at);
CREATE INDEX idx_custom_rpm_group_time ON custom_request_rpm_events(group_id,started_at);
CREATE INDEX idx_custom_rpm_user_group_time ON custom_request_rpm_events(user_id,group_id,started_at);
