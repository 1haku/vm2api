-- Subscription keys keep their existing identity and share one quota/lease across resources.
ALTER TABLE custom_subscription_plans ADD COLUMN resource_preference TEXT NOT NULL DEFAULT 'slots_first';
ALTER TABLE custom_subscription_plans ADD COLUMN api_fallback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_subscription_plans ADD COLUMN resource_models TEXT NOT NULL DEFAULT '[]';
CREATE TABLE custom_subscription_api_endpoints (
  group_id INTEGER NOT NULL REFERENCES custom_subscription_plans(group_id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES api_endpoints(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, endpoint_id)
);
ALTER TABLE usage_logs ADD COLUMN custom_resource_kind TEXT;
ALTER TABLE usage_logs ADD COLUMN custom_resource_name TEXT;
