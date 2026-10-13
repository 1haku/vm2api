-- Existing plans keep their independent seven-day cycle.
ALTER TABLE custom_subscription_plans ADD COLUMN weekly_reset_mode TEXT NOT NULL DEFAULT 'independent' CHECK (weekly_reset_mode IN ('independent','slot'));
ALTER TABLE custom_subscription_plans ADD COLUMN weekly_reset_vm_id TEXT;
ALTER TABLE custom_subscription_plans ADD COLUMN weekly_window_start TEXT;
ALTER TABLE custom_subscription_plans ADD COLUMN weekly_window_end TEXT;
ALTER TABLE custom_subscription_plans ADD COLUMN weekly_source_account TEXT;
