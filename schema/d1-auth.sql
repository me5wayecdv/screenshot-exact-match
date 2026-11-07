-- Qemmini — custom auth tables for the Cloudflare-only stack (Phase 1)
-- ======================================================================
-- Replaces Supabase Auth (auth.users + its session/JWT machinery).
-- Apply BEFORE schema/d1-schema.sql (profiles and user_roles reference
-- auth_users). There is no JWT here: sessions are opaque random tokens
-- whose SHA-256 hash is stored; the raw token only ever exists in the
-- HttpOnly cookie and in memory during sign-in. See
-- src/lib/cloudflare-auth.ts for the rules these tables enforce.
--
-- SECURITY INVARIANTS (do not weaken without a security review):
--   * password_hash is NEVER a plaintext password and NEVER a home-made
--     hash. Format: pbkdf2-sha256$<iterations>$<salt>$<hash>, all
--     base64url except the iteration count. Salt is per-user, 16 bytes.
--   * auth_sessions stores ONLY the hash of the token (SHA-256, hex).
--     A database leak alone must not yield usable sessions.
--   * A session is valid only if revoked_at IS NULL AND expires_at is in
--     the future. Both conditions are checked on every session lookup.
--   * Emails are stored lowercased; the UNIQUE constraint is therefore
--     effectively case-insensitive. Sign-in must use the same lowering.
--   * password_hash may be NULL only for OAuth-linked accounts (see
--     MIGRATION-DESIGN.md §Google OAuth). A NULL hash can NEVER pass a
--     password check — the verifier returns false before any comparison.
--   * Admin accounts are NEVER created through sign-up. The sign-up
--     allowlist is ('school_teacher','tutor','student') only; creating an
--     admin requires an existing admin (Phase 2 function, not in Phase 1).
--   * Admin approval (2026-11-04): every new account is 'pending' until
--     an admin approves it; pending/rejected accounts cannot sign in
--     (enforced in signIn AND in session checks). Operator-created
--     admin rows MUST set status = 'approved' explicitly, or the
--     admin cannot sign in either. Existing accounts are backfilled
--     to 'approved' by migration 20261104_account_approval.sql.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  provider TEXT NOT NULL DEFAULT 'password' CHECK (provider IN ('password','google')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_sign_in_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected'))
);
CREATE INDEX IF NOT EXISTS auth_users_email_idx ON auth_users(email);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_token_idx ON auth_sessions(token_hash);
