-- Image generation is opt-in per user; existing users stay disabled.
CREATE TABLE custom_user_image_permissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
