CREATE TABLE custom_weekly_quota_notify (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX custom_weekly_quota_notify_expiry ON custom_weekly_quota_notify(expires_at);
