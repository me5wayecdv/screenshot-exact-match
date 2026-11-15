-- AI-F5: durable idempotency claims for AI quota refunds.
-- Additive and safe to apply to an existing D1 database. The base schema
-- contains the same table for fresh installations.
CREATE TABLE IF NOT EXISTS ai_quota_refunds (
  refund_key TEXT PRIMARY KEY,
  claim_token TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  units INTEGER NOT NULL CHECK (units > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ai_quota_refunds_created_idx
  ON ai_quota_refunds(created_at);
