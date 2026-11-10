-- Phase 3 (Cloudflare Queues for the take write path): the consumer
-- needs a monotonic draft counter on submissions and a visible
-- failed-writes record. Additive only; safe to apply on a populated
-- DB.
--
-- APPLY TO BOTH DATABASES via the D1 console BEFORE the deploy that
-- carries the queue consumer (the consumer reads draft_seq and writes
-- take_write_failures; without this migration it fails and every
-- queued message lands in the DLQ). Order: run the PRECHECK first,
-- then this file, on staging (qemmini-db) AND live (qemmini-live-db).
--
-- No data is modified or deleted. draft_seq defaults to 0, which
-- means "no draft applied yet" for every existing submission — the
-- first queued draft after deploy starts from seq 1.

ALTER TABLE submissions ADD COLUMN draft_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS take_write_failures (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  submission_id TEXT,
  message_type TEXT NOT NULL
    CHECK (message_type IN ('start','draft','submit')),
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS take_write_failures_created_idx
  ON take_write_failures(created_at DESC);
