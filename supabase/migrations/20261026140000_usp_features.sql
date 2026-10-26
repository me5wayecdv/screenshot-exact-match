-- USP features migration: AI training examples (slice 1) +
-- exam integrity signals (slice 3) + WhatsApp parent reports (slice 4).
-- Apply AFTER supabase/migrations/20261026120000_take_grading.sql and
-- 20261026130000_segmentation.sql (reuses owns_assessment / is_teacher_of).
-- No enum (ALTER TYPE) changes in this file, so no transaction-block caveat.

-- ============ Slice 1: anonymized fine-tuning dataset ============

-- ai_training_examples: anonymized future fine-tuning dataset.
-- One row per ACCEPTED or EDITED AI grading suggestion (never on Reject),
-- pairing the AI suggestion with the teacher's final values side by side.
-- ANONYMIZED BY DESIGN: no student name, no student id, no teacher id,
-- no school id. Identity is used only by RLS to gate inserts, never stored.
-- NO training pipeline is built here. Before any training use, this data
-- must be used only with proper consent, and free-text answers must be
-- scrubbed for personal data (a student could have typed a name into an
-- answer). Intended later phase: LoRA fine-tune of an Arabic-capable open
-- model on this table.
-- migration file (supabase/migrations/<timestamp>_usp_features.sql).

create table if not exists public.ai_training_examples (
  id uuid primary key default gen_random_uuid(),
  question_text text not null,
  rubric_text text,
  student_answer_text text not null,
  ai_suggested_score numeric not null,
  ai_feedback text,
  teacher_final_score numeric not null,
  teacher_feedback text,
  model_name text,
  created_at timestamptz not null default now()
);

alter table public.ai_training_examples enable row level security;

-- Teachers/tutors/admins may append rows (their identity is checked by
-- RLS but never stored in the row itself).
create policy "ai_training_examples_insert_teacher" on public.ai_training_examples
  for insert to authenticated
  with check (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
        and user_roles.role in ('school_teacher', 'tutor', 'admin', 'teacher')
    )
  );

-- Only admins may read the dataset (future training export).
create policy "ai_training_examples_select_admin" on public.ai_training_examples
  for select to authenticated
  using (
    exists (
      select 1 from public.user_roles
      where user_roles.user_id = auth.uid()
        and user_roles.role = 'admin'
    )
  );

grant insert, select on public.ai_training_examples to authenticated;

-- ============ Slice 3: exam integrity signals ============

-- Slice 3 — exam integrity signals (no webcam, no keystroke logging, no
-- screen capture, no fingerprinting). Signals for the teacher only; never
-- an automatic penalty. Apply AFTER the base migration
-- (drizzle/migrations/0000_migration.sql) and the take+grading migration
-- (20261026120000_take_grading.sql); order relative to the segmentation
-- migration does not matter (no dependency on it).
-- COORDINATOR: merge this into the single USP migration file (this file is
-- the same content as the SQL block in NOTES.md — use one source, not both).

create table public.integrity_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  event_type text not null check (event_type in ('tab_hidden', 'tab_visible', 'window_blur', 'window_focus')),
  question_id uuid references public.questions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.integrity_events(submission_id);
grant select, insert on public.integrity_events to authenticated;
grant all on public.integrity_events to service_role;
alter table public.integrity_events enable row level security;

-- Student inserts events only for their own, unreleased submissions.
-- (Events are buffered on the take page and flushed right after the
-- submission row is created, while status = 'awaiting_review'.)
create policy "student inserts own integrity events" on public.integrity_events for insert to authenticated
  with check (exists (
    select 1 from public.submissions s
    where s.id = submission_id and s.student_id = auth.uid() and s.status <> 'released'
  ));

-- Teacher reads events only for their own assessments' submissions.
-- (public.owns_assessment is defined in the base migration.)
create policy "teacher reads own integrity events" on public.integrity_events for select to authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_id and public.owns_assessment(s.assessment_id)
  ));

-- Per-question time (seconds, visible-time only) on the existing answers rows.
alter table public.answers
  add column if not exists time_spent_seconds integer not null default 0
  check (time_spent_seconds >= 0);
-- No new grants/policies: answers already grants select/insert/update to
-- authenticated (take+grading migration) and its row policies are unchanged.

-- Persisted per-student shuffled question order (array of question ids).
alter table public.submissions
  add column if not exists question_order jsonb null;
-- No new grants/policies: the order is written in the same insert that
-- creates the submission (covered by "student creates own submission").

-- ============ Slice 4: WhatsApp parent reports ============

-- Slice 4: WhatsApp parent reports.
-- Parent contact on the student profile + per-assessment auto-send flag
-- + immutable audit table for sends.

-- 1. Parent contact fields on profiles. Visibility follows the profile
-- row itself: the existing "read own profile" policy already lets the
-- student and their linked teachers SELECT these columns (no new
-- SELECT policy needed); grants already cover select/update.
alter table public.profiles
  add column if not exists parent_phone text,
  add column if not exists whatsapp_consent boolean not null default false;

-- E.164: "+" + 8-15 digits, first digit after "+" non-zero. NULL means
-- "no parent number on file". Enforced in the DB so no client path can
-- store a malformed number even if client validation is bypassed.
alter table public.profiles
  add constraint profiles_parent_phone_e164
  check (parent_phone is null or parent_phone ~ '^\+[1-9][0-9]{7,14}$');

-- Teacher edit: same visibility pattern as the profile row — a teacher
-- linked to the student (teacher_students) may update that student's
-- profile row. Students editing their own row are already covered by
-- "update own profile". No new grant needed (update already granted).
create policy "teacher updates linked student parent contact"
  on public.profiles for update to authenticated
  using (public.is_teacher_of(auth.uid(), id))
  with check (public.is_teacher_of(auth.uid(), id));

-- 2. Per-assessment auto-send toggle (default OFF). Assessments grants
-- and the "teacher manages assessments" policy already cover owner
-- updates; no new policy needed.
alter table public.assessments
  add column if not exists auto_whatsapp_send boolean not null default false;

-- 3. Audit table: one row per send ATTEMPT (manual resends and auto
-- sends each append a row; failures are rows too, so they stay visible).
create table public.whatsapp_sends (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  sent_at timestamptz not null default now(),
  status text not null check (status in ('sent', 'failed', 'skipped')),
  trigger text not null check (trigger in ('manual', 'auto')),
  message_id text,
  error text
);
create index on public.whatsapp_sends(submission_id);
grant select, insert on public.whatsapp_sends to authenticated;
grant all on public.whatsapp_sends to service_role;
alter table public.whatsapp_sends enable row level security;

-- Teachers read sends for their OWN assessments' submissions (owner-only
-- by RLS, same pattern as the report page: another teacher's sends load
-- as empty, not as data).
create policy "teacher reads own assessments sends"
  on public.whatsapp_sends for select to authenticated
  using (exists (
    select 1 from public.submissions s
    join public.assessments a on a.id = s.assessment_id
    where s.id = submission_id and a.teacher_id = auth.uid()
  ));

-- Insert for the server function's RLS fallback path (the primary path
-- uses the service-role client, which bypasses RLS). No update/delete
-- policies for authenticated: the audit log is append-only from clients.
create policy "teacher inserts own assessments sends"
  on public.whatsapp_sends for insert to authenticated
  with check (exists (
    select 1 from public.submissions s
    join public.assessments a on a.id = s.assessment_id
    where s.id = submission_id and a.teacher_id = auth.uid()
  ));
