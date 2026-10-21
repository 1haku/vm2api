-- Independent daily reset markers leave weekly accounting and history intact.
ALTER TABLE custom_user_subscriptions ADD COLUMN daily_quota_reset_at TEXT;
ALTER TABLE custom_user_subscriptions ADD COLUMN daily_reset_ledger_rowid INTEGER NOT NULL DEFAULT 0;
