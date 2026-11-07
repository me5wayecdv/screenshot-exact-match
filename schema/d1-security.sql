-- Qemmini — Phase 2 security tables for the Cloudflare-only stack.
-- Apply AFTER schema/d1-auth.sql and schema/d1-schema.sql.
--
-- login_attempts: rate limiting only. Rows are bookkeeping, never
-- authentication evidence: a row never grants access, and the
-- check counts failures in a sliding window (see
-- src/lib/cloudflare-security.ts). Prune old rows on a schedule;
-- unbounded growth here is a storage bug, not a security feature.
-- password_reset_tokens: hashed expiring single-use tokens ONLY.
-- The raw token is NEVER stored (only its SHA-256 hash), NEVER
-- logged, and is delivered to the user only through an email
-- provider (not wired in this copy — see MIGRATION-DESIGN.md).
-- A token row with used_at set or expires_at in the past is dead
-- regardless of what else a caller claims.
-- Sessions are revoked in bulk by revoke-all (password change,
-- password reset, admin revocation): auth_sessions.revoked_at is
-- set for every session of the user except, optionally, the
-- session performing the change (caller decides; reset always
-- revokes all, including the caller, because there is no caller
-- session in a reset flow).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT 'unknown',
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0,1))
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx
  ON login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx
  ON login_attempts(ip, attempted_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('reset','set-password')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens(user_id, expires_at);
