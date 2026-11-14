CREATE TABLE IF NOT EXISTS service_device_activity (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  changes TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS service_device_activity_lookup
  ON service_device_activity(service_id, device_id, created_at DESC);
