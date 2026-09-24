ALTER TABLE sticky_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticky_sessions ADD COLUMN slot_index INTEGER;
