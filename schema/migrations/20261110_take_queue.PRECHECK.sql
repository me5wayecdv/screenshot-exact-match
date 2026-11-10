-- Pre-check for 20261110_take_queue.sql — RUN FIRST, against EACH
-- existing database (live qemmini-live-db AND staging qemmini-db),
-- BEFORE applying the migration. Do NOT apply if any query below
-- returns rows: it means the migration was already applied (re-running
-- it is harmless in intent, but ALTER ... ADD COLUMN fails on the
-- duplicate column — so check first and skip if so).
--
-- How to run (read-only; no writes):
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261110_take_queue.PRECHECK.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261110_take_queue.PRECHECK.sql
--
-- 1) draft_seq must NOT exist yet.
SELECT 'draft_seq_exists' AS check_name, name
FROM pragma_table_info('submissions')
WHERE name = 'draft_seq';

-- 2) take_write_failures must NOT exist yet.
SELECT 'take_write_failures_exists' AS check_name, name
FROM sqlite_master
WHERE type = 'table' AND name = 'take_write_failures';

-- 3) Sanity: row counts, so the operator knows the checks actually
--    ran against a populated database (all zeros on an empty DB is
--    expected).
SELECT 'row_counts' AS check_name,
  (SELECT COUNT(*) FROM submissions) AS submissions,
  (SELECT COUNT(*) FROM answers) AS answers;
