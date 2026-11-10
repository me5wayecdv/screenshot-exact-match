-- Qemmini — Cloudflare D1 schema (Phase 1, SQLite)
-- =================================================
-- Translation of the Supabase (Postgres) schema into D1/SQLite.
--
-- SOURCE OF TRUTH — read this before editing:
--   * The 25 migrations in the Supabase copy (supabase/migrations/*.sql)
--     only contain INCREMENTAL changes. The base tables (profiles,
--     assessments, questions, answers, submissions, assessment_assignments,
--     audit_log, user_roles, teacher_students, subjects) were created in
--     the original Lovable project and their DDL is NOT in this repo.
--     Their columns below are therefore derived from the generated client
--     types (src/integrations/supabase/types.ts, Tables Row definitions)
--     cross-checked against ALTER TABLE statements in the migrations.
--     If a column ever disagrees with the live database, the live database
--     wins and this file must be corrected — Phase 2 must run a live
--     schema dump comparison before any data migration.
--   * Tables created by migrations (teacher_groups, group_members,
--     group_exams, lessons, lesson_enrollments, teacher_profiles,
--     integrity_events, whatsapp_sends, handwritten_grades,
--     grade_review_requests, ai_usage_events, ai_training_examples,
--     ai_rate_limits, whatsapp_send_claims) are translated from their
--     migration DDL verbatim, modulo the type mapping below.
--   * DROPPED, deliberately NOT ported: schools, school_teachers, classes,
--     class_members (removed 2026-10-28, migration
--     20261028020000_remove_schools.sql). Do not re-add them.
--   * auth.users is NOT ported: Supabase Auth is replaced by the custom
--     auth tables in schema/d1-auth.sql (auth_users, auth_sessions).
--     Everywhere Postgres referenced auth.users(id), D1 references
--     auth_users(id). profiles.id IS the user id, exactly as in Supabase
--     (profiles.id = auth.users.id there; here profiles.id = auth_users.id).
--
-- TYPE MAPPING (Postgres -> SQLite):
--   uuid            -> TEXT (ids are crypto.randomUUID() strings; SQLite
--                      has no uuid type and no gen_random_uuid() — ids
--                      are generated in application code, never in SQL)
--   timestamptz/date-> TEXT, ISO 8601 UTC (e.g. 2026-11-03T20:00:00.000Z).
--                      Lexicographic comparison works for this format,
--                      which is what due_at/expires_at checks rely on.
--                      Application code MUST always write UTC ISO strings.
--   boolean         -> INTEGER CHECK IN (0,1)
--   jsonb / Json    -> TEXT containing a JSON string. SQLite JSON1
--                      functions exist, but queries in this codebase treat
--                      these as opaque payloads, so plain TEXT + JSON
--                      validation in application code is sufficient.
--   text[] (days)   -> TEXT containing a JSON array of strings.
--   number (scores)-> REAL for scores/marks (fractional possible),
--                      INTEGER for counts, positions, tokens, seconds.
--   serial (audit)  -> INTEGER PRIMARY KEY AUTOINCREMENT
--   numeric checks  -> CHECK constraints copied where they were explicit
--                      (e.g. duration_minutes > 0, max_attempts >= 1).
--
-- WHAT SQLITE CANNOT DO (handled in code, never silently dropped):
--   * RLS: there is NO row-level security in D1. Every table below is
--     readable by any server function that holds the binding. ALL access
--     control moves into server-function code (see MIGRATION-DESIGN.md
--     for the RLS -> code-check map). A server function that queries a
--     table without the documented owner/member check is a security bug.
--   * Security-definer RPCs: Postgres functions are gone. Each of the 38
--     RPCs becomes a server function that (1) validates the session,
--     (2) runs the documented ownership/membership check, (3) then runs
--     the SQL. No client code may ever call D1 directly.
--   * Postgres extensions / triggers: gen_random_uuid(), md5() join-code
--     defaults, clock_timestamp(), date_trunc() are all application-code
--     responsibilities now (see the notes on join codes below).
--   * Enums: Postgres enum types become TEXT + CHECK IN (...) lists.
--     The lists below are copied from types.ts Enums verbatim.
--   * Foreign keys: D1/SQLite enforces them only when
--     PRAGMA foreign_keys = ON is set on the connection. Server code
--     MUST set it (and Phase 2 must verify D1 honours it); application
--     ownership checks are the real security boundary regardless.
--   * Join codes: Postgres generated 6-char codes with md5(random())
--     and 12-char codes with md5(random()||clock_timestamp()). In D1
--     there is no default: application code generates them (12-char
--     uppercase hex from crypto randomness for groups/teacher codes,
--     6-char for lessons) and retries on UNIQUE violation.
--   * now(): Postgres DEFAULT now() becomes DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
--     which produces UTC ISO strings matching the timestamptz mapping.
--
-- APPLY ORDER: auth tables (d1-auth.sql) FIRST, then this file (FKs
-- reference auth_users and profiles). Run with foreign_keys ON.
-- D1 note: a single database on the Free plan is capped at 500 MB and
-- 10 GB on Paid; this schema stores no files — files live in R2.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- profiles
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  join_code TEXT UNIQUE,
  parent_phone TEXT,
  whatsapp_consent INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_consent IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (join_code IS NULL OR length(join_code) = 12)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('teacher','student','school_teacher','tutor','admin'))
);
-- NOTE: 'teacher' is a legacy value; application code maps it to
-- 'school_teacher' on read, exactly as the Supabase client did.

CREATE TABLE IF NOT EXISTS teacher_profiles (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  bio TEXT NOT NULL DEFAULT '',
  subjects_text TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  phone TEXT,
  school TEXT
);

-- ------------------------------------------------------------- subjects
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------- assessments
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  grade_level TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','closed','archived')),
  audience_mode TEXT NOT NULL DEFAULT 'explicit'
    CHECK (audience_mode IN ('auto_all','explicit')),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  starts_at TEXT,
  due_at TEXT,
  auto_whatsapp_send INTEGER NOT NULL DEFAULT 0 CHECK (auto_whatsapp_send IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS assessments_teacher_idx ON assessments(teacher_id, created_at DESC);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mcq','true_false','short_answer','written')),
  options TEXT NOT NULL DEFAULT '[]',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  marks REAL NOT NULL,
  position INTEGER NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS questions_assessment_idx ON questions(assessment_id, position);

-- question_keys is teacher-only data. It MUST never be selected by a
-- student-facing query; the code check (owner or admin) is the only
-- protection D1 offers, since there is no RLS.
CREATE TABLE IF NOT EXISTS question_keys (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  correct_answer TEXT NOT NULL,
  accepted_alternatives TEXT NOT NULL DEFAULT '[]',
  rubric TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assessment_assignments (
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (assessment_id, student_id)
);
CREATE INDEX IF NOT EXISTS assessment_assignments_student_idx
  ON assessment_assignments(student_id, assessment_id);

-- ------------------------------------------------------------ submissions
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('submitted','in_progress','awaiting_review','approved','released')),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  draft_seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  released_at TEXT,
  question_order TEXT,
  final_score REAL,
  total_possible REAL NOT NULL DEFAULT 0,
  teacher_feedback TEXT NOT NULL DEFAULT '',
  UNIQUE (assessment_id, student_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS submissions_student_idx ON submissions(student_id, assessment_id);

-- Phase 3: visible record of take-queue messages that failed after
-- all retries (ids + reason only — never answers, scores, or AI
-- feedback). The message itself is kept in the DLQ for replay.
CREATE TABLE IF NOT EXISTS take_write_failures (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  submission_id TEXT,
  message_type TEXT NOT NULL
    CHECK (message_type IN ('start','draft','submit')),
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS take_write_failures_created_idx
  ON take_write_failures(created_at DESC);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  response TEXT NOT NULL DEFAULT '',
  max_marks REAL NOT NULL,
  auto_score REAL,
  final_score REAL,
  ai_suggestion TEXT,
  feedback TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'not_graded'
    CHECK (review_status IN ('not_graded','auto_graded','ai_suggested','approved','rejected')),
  time_spent_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS answers_submission_idx ON answers(submission_id);

-- ------------------------------------------------------- teacher links
CREATE TABLE IF NOT EXISTS teacher_students (
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending','approved','rejected')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS teacher_students_teacher_status_idx
  ON teacher_students(teacher_id, status, requested_at DESC);

-- -------------------------------------------------------------- groups
CREATE TABLE IF NOT EXISTS teacher_groups (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  school_year TEXT NOT NULL DEFAULT '',
  days TEXT NOT NULL DEFAULT '[]',
  time_text TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  join_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES teacher_groups(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  PRIMARY KEY (group_id, student_id)
);
CREATE INDEX IF NOT EXISTS group_members_student_idx ON group_members(student_id, status);

CREATE TABLE IF NOT EXISTS group_exams (
  group_id TEXT NOT NULL REFERENCES teacher_groups(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, assessment_id)
);
CREATE INDEX IF NOT EXISTS group_exams_assessment_idx ON group_exams(assessment_id);

-- -------------------------------------------------------------- lessons
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  tutor_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  join_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS lesson_enrollments (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  enrolled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (lesson_id, student_id)
);

-- ------------------------------------------------------- grading / misc
CREATE TABLE IF NOT EXISTS grade_review_requests (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  teacher_response TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS handwritten_grades (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  assessment_id TEXT REFERENCES assessments(id) ON DELETE SET NULL,
  question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
  -- Linked enrolled student (nullable): NULL = paper with no account,
  -- shown as "—" as before. Set only to an APPROVED student of the
  -- teacher (enforced in saveHandwrittenGrade); the grade is then
  -- visible to that student immediately on save (final-on-save).
  student_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  student_name TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  corrected_text TEXT NOT NULL DEFAULT '',
  ai_suggested_score REAL,
  final_score REAL NOT NULL,
  max_marks REAL NOT NULL,
  ai_feedback TEXT,
  teacher_feedback TEXT NOT NULL DEFAULT '',
  ai_model TEXT,
  image_path TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- image_path is an R2 object key in the Cloudflare stack, NOT a
-- Supabase Storage path. Old Supabase paths must be re-mapped on import.
CREATE INDEX IF NOT EXISTS handwritten_grades_student_idx
  ON handwritten_grades(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integrity_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('tab_hidden','tab_visible','window_blur','window_focus','session_interrupted')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Legacy, write-frozen: Supabase revoked inserts into ai_training_examples
-- until a consent/minimisation workflow exists. Port the table so old rows
-- can be imported, but Phase 2 must NOT re-enable writes without that
-- workflow and an explicit product decision.
CREATE TABLE IF NOT EXISTS ai_training_examples (
  id TEXT PRIMARY KEY,
  question_text TEXT NOT NULL,
  student_answer_text TEXT NOT NULL,
  rubric_text TEXT,
  ai_suggested_score REAL NOT NULL,
  ai_feedback TEXT,
  teacher_final_score REAL NOT NULL,
  teacher_feedback TEXT,
  model_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS ai_rate_limits (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  minute_started_at TEXT NOT NULL,
  minute_units INTEGER NOT NULL DEFAULT 0 CHECK (minute_units >= 0),
  day_started_on TEXT NOT NULL,
  day_units INTEGER NOT NULL DEFAULT 0 CHECK (day_units >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_sends (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  error TEXT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_send_claims (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC, id DESC);

-- Parity constraints (2026-11-10, ported from the rebuild's
-- 0004_parity_constraints.sql; same statements also live in
-- schema/migrations/20261110_parity_constraints.sql for existing
-- databases — run the PRECHECK file there before applying).
-- Fresh databases get them from here; existing databases get them
-- from the migration. All statements are IF NOT EXISTS.
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
