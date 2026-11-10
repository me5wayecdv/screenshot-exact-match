-- Parity constraints (2026-11-10): additive data-integrity constraints
-- and workload indexes ported from the rebuild
-- (projects/qayyimni/app schema/migrations/0004_parity_constraints.sql).
-- These existed in the original PostgreSQL chain but never made it into
-- the old D1 translation.
--
-- What it adds:
-- - answers UNIQUE(submission_id, question_id): one answer per question
--   per submission.
-- - submissions one-in-progress partial unique index: at most one
--   in-progress attempt per (assessment, student).
-- - questions marks-positive triggers: marks must stay > 0 on INSERT
--   and on UPDATE of marks (SQLite cannot add a CHECK to an existing
--   table with ALTER TABLE, so triggers guard new writes).
-- - 9 workload indexes (auth_users, teacher_groups, grade reviews,
--   submissions x2, ai_usage_events, whatsapp_sends, lessons).
--
-- Safe to run? Only AFTER the pre-check passes — see
-- schema/migrations/20261110_parity_constraints.PRECHECK.sql. The
-- unique indexes FAIL if live data already violates them (duplicate
-- answers, or two in-progress attempts for the same student). NEVER
-- silently deduplicate student answers or attempts: fix the data (or
-- decide explicitly) before applying. The triggers only guard new
-- writes and never touch existing rows. All statements use IF NOT
-- EXISTS, so the file is idempotent and safe to re-run.
--
-- NOTE: auth_users_status_idx is already declared by
-- 20261104_account_approval.sql:37; it is repeated here (harmless,
-- IF NOT EXISTS) so this file is a complete port of the rebuild's
-- 0004 and stays correct on its own.
--
-- Fresh databases do NOT need this file: schema/d1-schema.sql
-- declares the same indexes and triggers at the end of the file.
--
-- Apply ONCE per existing database (live + staging) with, e.g.:
--   wrangler d1 execute qemmini-live-db --remote \
--     --file schema/migrations/20261110_parity_constraints.sql
--   wrangler d1 execute qemmini-db --remote \
--     --file schema/migrations/20261110_parity_constraints.sql
-- Verify with:
--   SELECT name FROM sqlite_master WHERE type = 'index'
--     AND name LIKE '%_idx' AND name IN (
--       'answers_submission_question_unique',
--       'submissions_one_in_progress_idx');
--   SELECT name FROM sqlite_master WHERE type = 'trigger'
--     AND name LIKE 'questions_marks_positive_%';

CREATE UNIQUE INDEX IF NOT EXISTS answers_submission_question_unique
  ON answers(submission_id, question_id);

CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_in_progress_idx
  ON submissions(assessment_id, student_id) WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS auth_users_status_idx
  ON auth_users(status, created_at DESC);
CREATE INDEX IF NOT EXISTS teacher_groups_teacher_idx
  ON teacher_groups(teacher_id);
CREATE INDEX IF NOT EXISTS grade_review_requests_student_created_idx
  ON grade_review_requests(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS grade_review_requests_teacher_created_idx
  ON grade_review_requests(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_assessment_status_submitted_idx
  ON submissions(assessment_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS submissions_student_status_submitted_idx
  ON submissions(student_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_teacher_created_idx
  ON ai_usage_events(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_sends_submission_status_idx
  ON whatsapp_sends(submission_id, status);
CREATE INDEX IF NOT EXISTS lessons_tutor_created_idx
  ON lessons(tutor_id, created_at DESC);

-- Preserve the original baseline CHECK (marks > 0), which SQLite cannot add to
-- an existing table with ALTER TABLE. These triggers guard new/imported writes.
CREATE TRIGGER IF NOT EXISTS questions_marks_positive_insert
BEFORE INSERT ON questions
WHEN NEW.marks <= 0
BEGIN
  SELECT RAISE(ABORT, 'question_marks_must_be_positive');
END;

CREATE TRIGGER IF NOT EXISTS questions_marks_positive_update
BEFORE UPDATE OF marks ON questions
WHEN NEW.marks <= 0
BEGIN
  SELECT RAISE(ABORT, 'question_marks_must_be_positive');
END;
