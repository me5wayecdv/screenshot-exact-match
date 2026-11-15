-- Additive D1 migration: per-student lesson join-code brute-force protection.
CREATE TABLE IF NOT EXISTS lesson_join_rate_limits (
  student_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_join_rate_limits_updated_idx
  ON lesson_join_rate_limits(updated_at);
