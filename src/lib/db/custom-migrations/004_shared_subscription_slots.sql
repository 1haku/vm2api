-- Keep existing bindings while allowing a slot to serve multiple plans.
-- The pair stays unique; published migrations 001-003 remain unchanged.
CREATE TABLE custom_subscription_slots_shared (
  group_id INTEGER NOT NULL REFERENCES groups(id),
  vm_id TEXT NOT NULL,
  PRIMARY KEY (group_id, vm_id)
);
INSERT INTO custom_subscription_slots_shared(group_id, vm_id)
SELECT group_id, vm_id FROM custom_subscription_slots;
DROP TABLE custom_subscription_slots;
ALTER TABLE custom_subscription_slots_shared RENAME TO custom_subscription_slots;
CREATE INDEX idx_custom_subscription_slots_vm ON custom_subscription_slots(vm_id);
