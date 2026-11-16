-- Pre-check for 20261115_egyptian_phone_constraints.sql — RUN FIRST,
-- against EACH existing database (live qemmini-live-db AND staging
-- qemmini-db), BEFORE applying the migration. Do NOT apply the
-- migration if any query below returns rows you have not decided on.
-- Do NOT run these against a fresh database (nothing to violate
-- there; the migration is a no-op on empty tables).
--
-- How to run (read-only; no writes):
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261115_egyptian_phone_constraints.PRECHECK.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261115_egyptian_phone_constraints.PRECHECK.sql
--
-- What this checks: the parent phone (profiles.parent_phone) and the
-- teacher phone (teacher_profiles.phone) must be an Egyptian mobile in
-- the normalized +20… form (+20 + 010/011/012/015 + 8 digits). The
-- app has always normalized before writing, but the D1 port shipped
-- without the CHECK constraint the Supabase schema had, so a row may
-- still hold a local form ("010…") or something invalid.
--
-- If a check returns rows: STOP and decide explicitly.
-- - A local form ("01012345678" / "201012345678") is FIXABLE: update it
--   to the +20… form (the app does exactly this on the next save).
-- - Anything else (a foreign number, a typo, an empty string) needs a
--   decision from the operator — the number is the only way to reach
--   the parent, so it is never silently deleted.
-- The migration NEVER rewrites or deletes a phone number; it only
-- guards NEW writes (see the migration file).

-- 1) Parent phones that are not a normalized Egyptian mobile.
SELECT 'profiles.parent_phone' AS column_name,
  id AS row_id,
  parent_phone AS value
FROM profiles
WHERE parent_phone IS NOT NULL
  AND parent_phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';

-- 2) Teacher phones that are not a normalized Egyptian mobile.
SELECT 'teacher_profiles.phone' AS column_name,
  user_id AS row_id,
  phone AS value
FROM teacher_profiles
WHERE phone IS NOT NULL
  AND phone NOT GLOB '+201[0125][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]';

-- 3) How many students have no parent phone at all (NULL). These are
--    NOT blocked by the constraint (NULL is allowed) and the app asks
--    them for the number on their dashboard before they start an exam.
--    The count is here so the operator knows the size of the gap.
SELECT COUNT(*) AS students_without_parent_phone
FROM profiles
WHERE parent_phone IS NULL;
