-- Pre-check for 20261110_parity_constraints.sql — RUN FIRST, against EACH
-- existing database (live qemmini-live-db AND staging qemmini-db), BEFORE
-- applying the migration. Do NOT apply the migration if any query below
-- returns rows. Do NOT run these against a fresh database (nothing to
-- violate there; the migration is a no-op on empty tables).
--
-- How to run (read-only; no writes):
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261110_parity_constraints.PRECHECK.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261110_parity_constraints.PRECHECK.sql
--
-- If a check returns rows: STOP. Fix the data explicitly (or decide with
-- the operator what to do with it) — NEVER silently deduplicate student
-- answers or attempts. The migration's unique indexes will fail on
-- violating data by design; that failure is the safety net, not a bug.
--
-- 1) Duplicate answers: one (submission, question) pair must have at
--    most one answer row. Any row here blocks
--    answers_submission_question_unique.
SELECT 'duplicate_answers' AS check_name,
  submission_id, question_id, COUNT(*) AS rows
FROM answers
GROUP BY submission_id, question_id
HAVING COUNT(*) > 1;

-- 2) Two in-progress attempts: one (assessment, student) pair must have
--    at most one 'in_progress' submission. Any row here blocks
--    submissions_one_in_progress_idx.
SELECT 'two_in_progress' AS check_name,
  assessment_id, student_id, COUNT(*) AS rows
FROM submissions
WHERE status = 'in_progress'
GROUP BY assessment_id, student_id
HAVING COUNT(*) > 1;

-- 3) Non-positive question marks: existing rows the new triggers do NOT
--    touch (triggers guard new writes only), but list them so the
--    operator can fix or accept them before relying on the constraint.
SELECT 'non_positive_marks' AS check_name,
  id, assessment_id, marks
FROM questions
WHERE marks <= 0;

-- 4) Sanity: row counts, so the operator knows the checks actually ran
--    against a populated database (all zeros on an empty DB is expected).
SELECT 'row_counts' AS check_name,
  (SELECT COUNT(*) FROM answers) AS answers,
  (SELECT COUNT(*) FROM submissions) AS submissions,
  (SELECT COUNT(*) FROM questions) AS questions;
