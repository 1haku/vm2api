-- Move mutable subscription settings out of upstream-owned groups.
-- Published migration 001 remains immutable; legacy columns are retained as
-- historical compatibility data and are no longer read or written by this fork.
CREATE TABLE custom_subscription_plans (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id),
  daily_limit_usd REAL NOT NULL DEFAULT 0,
  weekly_limit_usd REAL NOT NULL DEFAULT 0,
  default_validity_days INTEGER NOT NULL DEFAULT 30,
  subscription_concurrency INTEGER NOT NULL DEFAULT 2
);
INSERT INTO custom_subscription_plans
SELECT id,daily_limit_usd,weekly_limit_usd,default_validity_days,subscription_concurrency
FROM groups WHERE subscription_enabled=1;

ALTER TABLE subscription_slots RENAME TO custom_subscription_slots;
ALTER TABLE user_subscriptions RENAME TO custom_user_subscriptions;
ALTER TABLE subscription_events RENAME TO custom_subscription_events;
ALTER TABLE subscription_reservations RENAME TO custom_subscription_reservations;
-- Give ledger ordering an explicit integer primary key, preserved by VACUUM.
CREATE TABLE custom_subscription_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  subscription_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO custom_subscription_ledger(sequence,request_id,subscription_id,amount,created_at)
SELECT rowid,request_id,subscription_id,amount,created_at FROM subscription_ledger;
DROP TABLE subscription_ledger;
ALTER TABLE response_owners RENAME TO custom_response_owners;
-- Record the append-only ledger boundary so a reset and settlement in the
-- same millisecond remain ordered without deleting financial history.
ALTER TABLE custom_user_subscriptions ADD COLUMN reset_ledger_rowid INTEGER NOT NULL DEFAULT 0;

DROP INDEX idx_subscriptions_user;
DROP INDEX idx_subscription_reservations_sub;
DROP INDEX idx_usage_subscription_created;
CREATE INDEX idx_custom_subscriptions_user ON custom_user_subscriptions(user_id,status,expires_at);
CREATE INDEX idx_custom_reservations_sub ON custom_subscription_reservations(subscription_id);
CREATE INDEX idx_custom_ledger_sub ON custom_subscription_ledger(subscription_id,created_at);
CREATE INDEX idx_custom_usage_subscription_created ON usage_logs(subscription_id,created_at);
