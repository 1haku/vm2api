-- Summary-only ingress metrics; no request body or headers are stored here.
ALTER TABLE usage_logs ADD COLUMN custom_request_body_metrics TEXT;
