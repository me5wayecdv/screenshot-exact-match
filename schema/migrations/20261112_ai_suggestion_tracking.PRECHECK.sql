-- Pre-check for 20261112_ai_suggestion_tracking.sql — RUN FIRST, against EACH
-- existing database (live qemmini-live-db AND staging qemmini-db),
-- BEFORE applying the migration. Do NOT apply if any query below
-- returns rows (other than the row-count sanity query at the end): it
-- means the migration was already applied (re-running it is harmless
-- in intent, but ALTER ... ADD COLUMN fails on the duplicate column —
-- so check first and skip if so).
--
-- How to run (read-only; no writes):
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261112_ai_suggestion_tracking.PRECHECK.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261112_ai_suggestion_tracking.PRECHECK.sql
--
-- 1) assessment_id must NOT exist yet.
SELECT 'assessment_id_exists' AS check_name, name
FROM pragma_table_info('ai_usage_events')
WHERE name = 'assessment_id';

-- 2) question_id must NOT exist yet.
SELECT 'question_id_exists' AS check_name, name
FROM pragma_table_info('ai_usage_events')
WHERE name = 'question_id';

-- 3) suggested_score must NOT exist yet.
SELECT 'suggested_score_exists' AS check_name, name
FROM pragma_table_info('ai_usage_events')
WHERE name = 'suggested_score';

-- 4) Sanity: row counts, so the operator knows the checks actually
--    ran against a populated database (all zeros on an empty DB is
--    expected).
SELECT 'row_counts' AS check_name,
  (SELECT COUNT(*) FROM submissions) AS submissions,
  (SELECT COUNT(*) FROM answers) AS answers,
  (SELECT COUNT(*) FROM ai_usage_events) AS ai_usage_events;
