ALTER TABLE groups ADD COLUMN subscription_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN daily_limit_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN weekly_limit_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN default_validity_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE groups ADD COLUMN subscription_concurrency INTEGER NOT NULL DEFAULT 2;

CREATE TABLE subscription_slots (
  group_id INTEGER NOT NULL REFERENCES groups(id),
  vm_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (group_id, vm_id)
);
CREATE TABLE user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active',
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reset_at TEXT NOT NULL,
  assigned_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, group_id)
);
CREATE INDEX idx_subscriptions_user ON user_subscriptions(user_id, status, expires_at);
CREATE TABLE subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT,
  group_id INTEGER,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE subscription_reservations (
  request_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES user_subscriptions(id),
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_subscription_reservations_sub ON subscription_reservations(subscription_id);
CREATE TABLE subscription_ledger (
  request_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_subscription_ledger_sub ON subscription_ledger(subscription_id, created_at);
ALTER TABLE usage_logs ADD COLUMN subscription_id TEXT;
CREATE INDEX idx_usage_subscription_created ON usage_logs(subscription_id, created_at);

CREATE TABLE response_owners (
  response_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  vm_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
