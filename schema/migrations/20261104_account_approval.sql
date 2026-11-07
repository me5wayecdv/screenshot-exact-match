-- Admin approval layer for new accounts (2026-11-04).
--
-- Run ONLY against existing D1 databases (live + staging) BEFORE
-- deploying code that reads auth_users.status and
-- teacher_profiles.phone/school: the new sign-in/session code queries
-- the status column on every authenticated call, so a deploy before
-- this migration breaks sign-in for everyone.
--
-- Fresh databases do NOT need this file: schema/d1-auth.sql already
-- declares auth_users.status and schema/d1-schema.sql already declares
-- teacher_profiles.phone/school, and running these ALTERs there fails
-- with "duplicate column name".
--
-- Safe to re-run? No: SQLite ALTER TABLE ADD COLUMN has no IF NOT
-- EXISTS. Run once per existing database, then verify with:
--   SELECT sql FROM sqlite_master WHERE name IN ('auth_users', 'teacher_profiles');
--   SELECT status, COUNT(*) FROM auth_users GROUP BY status;
--
-- Backfill rule: EVERY existing account becomes 'approved', so no
-- current user (including the operator admin) is locked out by the
-- new gate. Only accounts created after this migration start as
-- 'pending' (the sign-up code inserts 'pending' explicitly).
--
-- Operator note: any admin row created by hand AFTER this migration
-- must set status = 'approved' explicitly in its INSERT, or that
-- admin will sit in the pending queue and cannot sign in.

ALTER TABLE auth_users
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'approved', 'rejected'));

UPDATE auth_users SET status = 'approved';

ALTER TABLE teacher_profiles ADD COLUMN phone TEXT;
ALTER TABLE teacher_profiles ADD COLUMN school TEXT;

CREATE INDEX IF NOT EXISTS auth_users_status_idx ON auth_users(status, created_at DESC);
