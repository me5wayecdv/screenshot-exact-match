-- Egyptian phone constraints (2026-11-15): the parent phone
-- (profiles.parent_phone) and the teacher phone (teacher_profiles.phone)
-- must be an Egyptian mobile in the normalized +20… form.
--
-- Background: the Supabase schema had
--   CHECK (parent_phone is null or parent_phone ~ '^\+20(10|11|12|15)[0-9]{8}$')
-- but that constraint was LOST in the D1 port — schema/d1-schema.sql
-- had a bare `parent_phone TEXT`. The app-level checks (normalize +
-- isValidEgyptianMobile) came back with the D1 signup flow, but a
-- direct write could still store "010…" or garbage, and the WhatsApp
-- send path then rejected the number at the last moment.
--
-- What it adds:
-- - profiles_parent_phone_egyptian_insert: a NEW profile row must
--   carry NULL or a normalized Egyptian mobile.
-- - profiles_parent_phone_egyptian_update: the phone may only CHANGE
--   to a normalized Egyptian mobile.
-- - teacher_profiles_phone_egyptian_insert / _update: the same rule
--   for the teacher's own phone.
--
-- Why triggers and not CHECK constraints: SQLite cannot add a CHECK
-- constraint to an existing table (ALTER TABLE ADD CONSTRAINT does not
-- exist), so a live database gets BEFORE INSERT/UPDATE triggers. A
-- fresh database gets the real CHECK constraints from
-- schema/d1-schema.sql — same rule, enforced by the engine.
--
-- Legacy rows are NOT touched: the UPDATE trigger only fires when the
-- phone value actually CHANGES, so editing another column of a row
-- that still holds an old-format number keeps working (this is the
-- same "NOT VALID" semantics the Supabase migration used: existing
-- rows are never scanned, rewritten or deleted).
--
-- Safe to run? Only AFTER the pre-check passes — see
-- schema/migrations/20261115_egyptian_phone_constraints.PRECHECK.sql.
-- The migration NEVER rewrites or deletes a phone number; it only
-- guards new writes. All statements use IF NOT EXISTS, so the file is
-- idempotent and safe to re-run.
--
-- Fresh databases do NOT need this file: schema/d1-schema.sql
-- declares the same rule as CHECK constraints.
--
-- Apply ONCE per existing database (live + staging) with, e.g.:
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261115_egyptian_phone_constraints.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261115_egyptian_phone_constraints.sql
-- Verify with:
--   SELECT name FROM sqlite_master WHERE type = 'trigger'
--     AND name LIKE '%_egyptian_%';
--   -- a bad write must fail:
--   INSERT INTO profiles (id, full_name, parent_phone)
--     VALUES ('phone-check', 'Check', '01012345678');
--   -- (use a real auth_users id, and delete the row afterwards)

CREATE TRIGGER IF NOT EXISTS profiles_parent_phone_egyptian_insert
BEFORE INSERT ON profiles
FOR EACH ROW
WHEN NEW.parent_phone IS NOT NULL
  AND NEW.parent_phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid_egyptian_parent_phone');
END;

CREATE TRIGGER IF NOT EXISTS profiles_parent_phone_egyptian_update
BEFORE UPDATE OF parent_phone ON profiles
FOR EACH ROW
WHEN NEW.parent_phone IS NOT OLD.parent_phone
  AND NEW.parent_phone IS NOT NULL
  AND NEW.parent_phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid_egyptian_parent_phone');
END;

CREATE TRIGGER IF NOT EXISTS teacher_profiles_phone_egyptian_insert
BEFORE INSERT ON teacher_profiles
FOR EACH ROW
WHEN NEW.phone IS NOT NULL
  AND NEW.phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid_egyptian_teacher_phone');
END;

CREATE TRIGGER IF NOT EXISTS teacher_profiles_phone_egyptian_update
BEFORE UPDATE OF phone ON teacher_profiles
FOR EACH ROW
WHEN NEW.phone IS NOT OLD.phone
  AND NEW.phone IS NOT NULL
  AND NEW.phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid_egyptian_teacher_phone');
END;
