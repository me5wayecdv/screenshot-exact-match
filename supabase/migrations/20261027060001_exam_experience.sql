-- §6 exam experience, part 2 of 2 — run AFTER 20261027060000_exam_status.sql.
--
-- Design (full rationale in docs/exam-experience.md):
-- - Attempt lifecycle is enforced by SECURITY DEFINER functions, not by
--   client checks: start_attempt / save_draft / submit_attempt. The old
--   direct client-side submission insert path is retired by the take page.
-- - Timer: expires_at is computed SERVER-side at start (started_at +
--   duration_minutes). save_draft refuses edits after expiry or after
--   due_at; submit stays allowed so a slow network cannot nuke frozen
--   answers. due_at blocks NEW starts but never retro-cancels a started
--   attempt.
-- - Windows: starts_at/due_at are enforced at start_attempt, not just
--   in the UI.
-- - Attempts: at most one in_progress attempt per student+assessment
--   (partial unique index); a new attempt needs count < max_attempts.
-- - Grading treats each submitted attempt as its own submission; the
--   report page shows the latest released attempt per student.
-- - Session interruption is a distinct integrity event type, recorded
--   when a student resumes an interrupted in-progress attempt.

-- 1. Teacher-side attempt settings on assessments.
alter table public.assessments
  add column if not exists duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  add column if not exists starts_at timestamptz,
  add column if not exists max_attempts integer not null default 1 check (max_attempts >= 1);

-- 2. Attempt bookkeeping on submissions.
alter table public.submissions
  add column if not exists attempt_number integer not null default 1 check (attempt_number >= 1),
  add column if not exists started_at timestamptz,
  add column if not exists expires_at timestamptz;
update public.submissions set started_at = coalesce(started_at, submitted_at) where started_at is null;
alter table public.submissions drop constraint if exists submissions_assessment_id_student_id_key;
alter table public.submissions add constraint submissions_assessment_student_attempt_unique unique (assessment_id, student_id, attempt_number);
create unique index if not exists submissions_one_in_progress_idx on public.submissions (assessment_id, student_id) where status = 'in_progress';

-- 3. Session-interruption event type.
alter table public.integrity_events drop constraint if exists integrity_events_event_type_check;
alter table public.integrity_events add constraint integrity_events_event_type_check check (event_type in ('tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'session_interrupted'));

-- 4. start_attempt: resume an in-progress attempt, or create a new one.
-- Raises on: assessment_not_found, not_published, not_assigned,
-- not_started, past_due, no_attempts_left. Returns the submission id.
create or replace function public.start_attempt(_assessment uuid, _question_order jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a record;
  existing uuid;
  used int;
begin
  select * into a from public.assessments where id = _assessment;
  if a.id is null then raise exception 'assessment_not_found'; end if;
  if a.status <> 'published' then raise exception 'not_published'; end if;
  if not exists (select 1 from public.assessment_assignments aa where aa.assessment_id = _assessment and aa.student_id = auth.uid()) then
    raise exception 'not_assigned';
  end if;
  if a.starts_at is not null and now() < a.starts_at then raise exception 'not_started'; end if;
  if a.due_at is not null and now() > a.due_at then raise exception 'past_due'; end if;
  select id into existing from public.submissions
    where assessment_id = _assessment and student_id = auth.uid() and status = 'in_progress'
    order by attempt_number desc limit 1;
  if existing is not null then return existing; end if;
  select count(*) into used from public.submissions
    where assessment_id = _assessment and student_id = auth.uid();
  if used >= coalesce(a.max_attempts, 1) then raise exception 'no_attempts_left'; end if;
  insert into public.submissions (assessment_id, student_id, status, attempt_number, started_at, expires_at, question_order, total_possible)
  values (_assessment, auth.uid(), 'in_progress', used + 1, now(),
    case when a.duration_minutes is not null then now() + (a.duration_minutes || ' minutes')::interval else null end,
    _question_order,
    (select coalesce(sum(marks), 0) from public.questions where assessment_id = _assessment))
  returning id into existing;
  return existing;
end $$;

-- 5. save_draft: upsert draft answers into an in-progress attempt.
-- _answers is a JSON array of {question_id, response, time_spent_seconds}.
-- Edits freeze at expiry (expires_at) and at the window end (due_at);
-- max_marks is always taken from the question, never from the client.
-- Returns false (no raise) when the attempt is not the caller's draft.
create or replace function public.save_draft(_submission uuid, _answers jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  s record;
  a record;
begin
  select * into s from public.submissions where id = _submission;
  if s.id is null or s.student_id <> auth.uid() then return false; end if;
  if s.status <> 'in_progress' then return false; end if;
  select * into a from public.assessments where id = s.assessment_id;
  if s.expires_at is not null and now() > s.expires_at then return false; end if;
  if a.due_at is not null and now() > a.due_at then return false; end if;
  insert into public.answers (submission_id, question_id, response, max_marks, review_status, time_spent_seconds)
  select _submission, (e->>'question_id')::uuid, coalesce(e->>'response', ''), q.marks, 'not_graded',
    greatest(0, coalesce((e->>'time_spent_seconds')::int, 0))
  from jsonb_array_elements(_answers) e
  join public.questions q on q.id = (e->>'question_id')::uuid and q.assessment_id = s.assessment_id
  on conflict (submission_id, question_id) do update
    set response = excluded.response, time_spent_seconds = excluded.time_spent_seconds;
  return true;
end $$;

-- 6. submit_attempt: flip a draft to awaiting_review. Allowed even after
-- expiry/window end because edits are already frozen by then; rejecting
-- here would only destroy frozen work on a slow network.
-- Returns false when the attempt is not the caller's draft.
create or replace function public.submit_attempt(_submission uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select * into s from public.submissions where id = _submission;
  if s.id is null or s.student_id <> auth.uid() then return false; end if;
  if s.status <> 'in_progress' then return false; end if;
  update public.submissions set status = 'awaiting_review', submitted_at = now() where id = _submission;
  return true;
end $$;

grant execute on function public.start_attempt(uuid, jsonb) to authenticated;
grant execute on function public.save_draft(uuid, jsonb) to authenticated;
grant execute on function public.submit_attempt(uuid) to authenticated;
