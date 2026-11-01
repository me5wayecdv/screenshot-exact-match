-- Backend security and scale hardening.
-- Apply after 20261031044544_add_teacher_assistant_usage_kind.sql.
-- This migration is intentionally additive except for tightening grants and
-- replacing existing policy/function bodies. It is not applied automatically.

-- 1) SECURITY DEFINER RPCs must never inherit PostgreSQL's default PUBLIC
-- EXECUTE grant. In particular, auth.uid() is NULL for anon, so checks using
-- `some_user_id <> auth.uid()` are not safe by themselves.
revoke all on function public.has_role(uuid, public.app_role), public.is_teacher_of(uuid, uuid),
  public.owns_assessment(uuid), public.assigned_published(uuid), public.is_school_member(uuid),
  public.is_school_teacher(uuid), public.is_lesson_member(uuid), public.same_school(uuid),
  public.join_school(text), public.enroll_lesson(text), public.my_students(),
  public.handle_new_user(), public.log_handwritten_grade() from public, anon;
grant execute on function public.has_role(uuid, public.app_role), public.is_teacher_of(uuid, uuid),
  public.owns_assessment(uuid), public.assigned_published(uuid), public.is_school_member(uuid),
  public.is_school_teacher(uuid), public.is_lesson_member(uuid), public.same_school(uuid),
  public.join_school(text), public.enroll_lesson(text), public.my_students() to authenticated;
grant execute on function public.has_role(uuid, public.app_role), public.is_teacher_of(uuid, uuid),
  public.owns_assessment(uuid), public.assigned_published(uuid), public.is_school_member(uuid),
  public.is_school_teacher(uuid), public.is_lesson_member(uuid), public.same_school(uuid),
  public.join_school(text), public.enroll_lesson(text), public.my_students() to service_role;

-- Prevent direct role enumeration through the helper used by RLS policies.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.user_roles ur
    where ur.user_id = _user_id and ur.role = _role
      and (ur.user_id = auth.uid() or exists (
        select 1 from public.user_roles caller_role
        where caller_role.user_id = auth.uid() and caller_role.role = 'admin'
      ))
  )
$$;

create or replace function public.is_teacher_of(_teacher uuid, _student uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.teacher_students ts
    where ts.teacher_id = _teacher and ts.student_id = _student
      and (auth.uid() = _teacher or auth.uid() = _student or exists (
        select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'
      ))
  )
$$;

revoke all on function public.start_attempt(uuid, jsonb) from public, anon;
revoke all on function public.save_draft(uuid, jsonb) from public, anon;
revoke all on function public.submit_attempt(uuid) from public, anon;
revoke all on function public.resolve_review_request(uuid, text) from public, anon;
grant execute on function public.start_attempt(uuid, jsonb) to authenticated;
grant execute on function public.save_draft(uuid, jsonb) to authenticated;
grant execute on function public.submit_attempt(uuid) to authenticated;
grant execute on function public.resolve_review_request(uuid, text) to authenticated;

create or replace function public.save_draft(_submission uuid, _answers jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  s record;
  a record;
  answer_count integer;
begin
  if auth.uid() is null then return false; end if;
  if jsonb_typeof(_answers) <> 'array' then return false; end if;
  answer_count := jsonb_array_length(_answers);
  if answer_count > 200 then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(_answers) e
    where jsonb_typeof(e) <> 'object'
      or length(coalesce(e->>'response', '')) > 20000
      or coalesce((e->>'time_spent_seconds')::numeric, 0) > 86400
  ) then return false; end if;

  select * into s from public.submissions where id = _submission for update;
  if s.id is null or s.student_id is distinct from auth.uid() then return false; end if;
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
exception when others then
  return false;
end $$;

create or replace function public.submit_attempt(_submission uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if auth.uid() is null then return false; end if;
  select * into s from public.submissions where id = _submission for update;
  if s.id is null or s.student_id is distinct from auth.uid() then return false; end if;
  if s.status <> 'in_progress' then return false; end if;
  update public.submissions set status = 'awaiting_review', submitted_at = now() where id = _submission;
  return true;
end $$;

create or replace function public.resolve_review_request(_id uuid, _response text)
returns boolean language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null or length(coalesce(_response, '')) > 5000 then return false; end if;
  select * into r from public.grade_review_requests where id = _id for update;
  if r.id is null or r.teacher_id is distinct from auth.uid() then return false; end if;
  update public.grade_review_requests
    set status = 'resolved', teacher_response = coalesce(_response, ''), resolved_at = now()
    where id = _id;
  return true;
end $$;

-- Bound and validate the shuffle payload, and serialize same-student starts
-- so parallel requests resume one attempt instead of racing a unique index.
create or replace function public.start_attempt(_assessment uuid, _question_order jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a record;
  existing uuid;
  used integer;
  question_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if jsonb_typeof(_question_order) <> 'array' or jsonb_array_length(_question_order) > 200 then
    raise exception 'invalid_question_order';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(_assessment::text || ':' || auth.uid()::text, 0));
  select * into a from public.assessments where id = _assessment;
  if a.id is null then raise exception 'assessment_not_found'; end if;
  if a.status <> 'published' then raise exception 'not_published'; end if;
  if not exists (
    select 1 from public.assessment_assignments aa
    where aa.assessment_id = _assessment and aa.student_id = auth.uid()
  ) then raise exception 'not_assigned'; end if;
  if a.starts_at is not null and now() < a.starts_at then raise exception 'not_started'; end if;
  if a.due_at is not null and now() > a.due_at then raise exception 'past_due'; end if;

  select count(*) into question_count from public.questions where assessment_id = _assessment;
  if jsonb_array_length(_question_order) <> question_count
    or (select count(distinct value) from jsonb_array_elements_text(_question_order)) <> question_count
    or exists (
      select 1 from jsonb_array_elements_text(_question_order) order_item
      where not exists (
        select 1 from public.questions q
        where q.assessment_id = _assessment and q.id::text = order_item.value
      )
    ) then raise exception 'invalid_question_order'; end if;

  select id into existing from public.submissions
  where assessment_id = _assessment and student_id = auth.uid() and status = 'in_progress'
  order by attempt_number desc limit 1;
  if existing is not null then return existing; end if;
  select count(*) into used from public.submissions
  where assessment_id = _assessment and student_id = auth.uid();
  if used >= coalesce(a.max_attempts, 1) then raise exception 'no_attempts_left'; end if;
  insert into public.submissions (
    assessment_id, student_id, status, attempt_number, started_at, expires_at, question_order, total_possible
  ) values (
    _assessment, auth.uid(), 'in_progress', used + 1, now(),
    case when a.duration_minutes is not null then now() + (a.duration_minutes || ' minutes')::interval else null end,
    _question_order,
    (select coalesce(sum(marks), 0) from public.questions where assessment_id = _assessment)
  ) returning id into existing;
  return existing;
end $$;

-- 2) Enforce the target role for teacher-join codes. Prevent clients from
-- mutating join_code; profile editing still supports name and parent contact.
revoke update on public.profiles from public, anon, authenticated;
grant update (full_name, parent_phone, whatsapp_consent) on public.profiles to authenticated;
-- Join codes are credentials: linked teachers may read student contact data,
-- never their join code. Users fetch only their own code via the RPC below.
revoke select on public.profiles from public, anon, authenticated;
grant select (id, full_name, created_at, parent_phone, whatsapp_consent)
  on public.profiles to authenticated;
create or replace function public.my_join_code()
returns text language sql stable security definer set search_path = public as $$
  select p.join_code from public.profiles p
  where p.id = auth.uid() and auth.uid() is not null
    and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'tutor') or public.has_role(auth.uid(), 'teacher'))
$$;
revoke all on function public.my_join_code() from public, anon;
grant execute on function public.my_join_code() to authenticated;

create or replace function public.join_teacher(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'student') then
    raise exception 'only_students';
  end if;
  if _code is null or length(trim(_code)) > 32 then raise exception 'invalid_code'; end if;
  select p.id into t
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id
  where p.join_code = upper(trim(_code))
    and ur.role in ('school_teacher', 'tutor', 'teacher');
  if t is null then raise exception 'invalid_code'; end if;
  insert into public.teacher_students(teacher_id, student_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;

create or replace function public.join_school(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if auth.uid() is null or not (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'admin')) then
    raise exception 'only_school_teachers';
  end if;
  if _code is null or length(trim(_code)) > 32 then raise exception 'invalid_code'; end if;
  select id into s from public.schools where join_code = upper(trim(_code));
  if s is null then raise exception 'invalid_code'; end if;
  insert into public.school_teachers(school_id, teacher_id) values (s, auth.uid()) on conflict do nothing;
  return s;
end $$;

create or replace function public.enroll_lesson(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'student') then raise exception 'only_students'; end if;
  if _code is null or length(trim(_code)) > 32 then raise exception 'invalid_code'; end if;
  select id into l from public.lessons where join_code = upper(trim(_code));
  if l is null then raise exception 'invalid_code'; end if;
  insert into public.lesson_enrollments(lesson_id, student_id) values (l, auth.uid()) on conflict do nothing;
  return l;
end $$;
revoke all on function public.join_teacher(text) from public, anon;
grant execute on function public.join_teacher(text) to authenticated;

-- Raise the entropy of teacher and lesson codes from 24 to 48 bits.
update public.profiles p
set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
from public.user_roles ur
where ur.user_id = p.id
  and ur.role in ('school_teacher', 'tutor', 'teacher')
  and length(coalesce(p.join_code, '')) < 12;
update public.lessons
set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
where length(join_code) < 12;
alter table public.lessons alter column join_code
  set default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
update public.schools
set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
where length(join_code) < 12;
alter table public.schools alter column join_code
  set default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

-- Future signup codes follow the same high-entropy format; signup metadata
-- cannot elevate the role, and only teachers/tutors receive a profile code.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.app_role;
begin
  r := case
    when new.raw_user_meta_data->>'role' in ('school_teacher', 'teacher') then 'school_teacher'::public.app_role
    when new.raw_user_meta_data->>'role' = 'tutor' then 'tutor'::public.app_role
    else 'student'::public.app_role
  end;
  insert into public.profiles (id, full_name, join_code)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    case when r in ('school_teacher', 'tutor')
      then upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
      else null
    end
  );
  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type) values (new.id, r::text) on conflict do nothing;
  end if;
  return new;
end $$;

-- Constrain all join-code values and prevent clients from choosing predictable
-- codes during lesson/school creation or changing a code later.
alter table public.profiles add constraint profiles_join_code_entropy_check
  check (join_code is null or join_code ~ '^[A-F0-9]{12}$') not valid;
alter table public.lessons add constraint lessons_join_code_entropy_check
  check (join_code ~ '^[A-F0-9]{12}$') not valid;
alter table public.schools add constraint schools_join_code_entropy_check
  check (join_code ~ '^[A-F0-9]{12}$') not valid;
update public.profiles set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  where join_code is not null and join_code !~ '^[A-F0-9]{12}$';
update public.lessons set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  where join_code !~ '^[A-F0-9]{12}$';
update public.schools set join_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  where join_code !~ '^[A-F0-9]{12}$';
alter table public.profiles validate constraint profiles_join_code_entropy_check;
alter table public.lessons validate constraint lessons_join_code_entropy_check;
alter table public.schools validate constraint schools_join_code_entropy_check;

revoke insert, update on public.lessons from public, anon, authenticated;
grant insert (tutor_id, title, description, subject_id), update (title, description, subject_id)
  on public.lessons to authenticated;
revoke insert, update on public.schools from public, anon, authenticated;
grant insert (name), update (name) on public.schools to authenticated;

-- 3) Fix the misqualified teacher_id reference in the RLS policy; the old
-- expression resolved to a.teacher_id = a.teacher_id (always true).
drop policy if exists "student creates review requests" on public.grade_review_requests;
create policy "student creates review requests" on public.grade_review_requests for insert to authenticated
  with check (
    student_id = auth.uid()
    and exists (
      select 1 from public.submissions s
      join public.assessments a on a.id = s.assessment_id
      where s.id = grade_review_requests.submission_id
        and s.student_id = auth.uid()
        and s.status = 'released'
        and a.teacher_id = grade_review_requests.teacher_id
    )
    and (
      grade_review_requests.question_id is null
      or exists (
        select 1 from public.questions q
        join public.submissions s2 on s2.assessment_id = q.assessment_id
        where q.id = grade_review_requests.question_id
          and s2.id = grade_review_requests.submission_id
      )
    )
  );

-- 4) Stop collecting raw student answers in the future-training table until
-- a consent, minimization and retention workflow exists.
drop policy if exists "ai_training_examples_insert_teacher" on public.ai_training_examples;
revoke insert on public.ai_training_examples from public, authenticated, anon;
-- No persisted consent/retention metadata exists for the legacy dataset, so
-- remove rows that cannot be proven consented rather than silently retaining them.
delete from public.ai_training_examples;

-- 5) Atomic AI quota: 30 weighted units/minute and 500/day per authenticated
-- user. One row per user; old counters are reset in-place, so the limiter
-- itself does not grow with time. Units represent image pages or a generation
-- cost weight, not raw tokens.
create table if not exists public.ai_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  minute_started_at timestamptz not null,
  minute_units integer not null default 0 check (minute_units >= 0),
  day_started_on date not null,
  day_units integer not null default 0 check (day_units >= 0),
  updated_at timestamptz not null default now()
);
alter table public.ai_rate_limits enable row level security;
revoke all on public.ai_rate_limits from public, anon, authenticated;
grant all on public.ai_rate_limits to service_role;

create or replace function public.consume_ai_rate_quota(_units integer default 1)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_minute timestamptz;
  v_day date;
  v_row public.ai_rate_limits%rowtype;
begin
  if v_user is null or _units is null or _units < 1 or _units > 20 then return false; end if;
  v_minute := date_trunc('minute', v_now);
  v_day := (v_now at time zone 'UTC')::date;
  insert into public.ai_rate_limits(user_id, minute_started_at, minute_units, day_started_on, day_units)
  values (v_user, v_minute, 0, v_day, 0) on conflict (user_id) do nothing;
  select * into v_row from public.ai_rate_limits where user_id = v_user for update;
  if v_row.minute_started_at <> v_minute then
    v_row.minute_started_at := v_minute;
    v_row.minute_units := 0;
  end if;
  if v_row.day_started_on <> v_day then
    v_row.day_started_on := v_day;
    v_row.day_units := 0;
  end if;
  if v_row.minute_units + _units > 30 or v_row.day_units + _units > 500 then return false; end if;
  update public.ai_rate_limits set
    minute_started_at = v_minute,
    minute_units = v_row.minute_units + _units,
    day_started_on = v_day,
    day_units = v_row.day_units + _units,
    updated_at = v_now
  where user_id = v_user;
  return true;
end $$;
revoke all on function public.consume_ai_rate_quota(integer) from public, anon;
grant execute on function public.consume_ai_rate_quota(integer) to authenticated;

-- 6) Indexes for tenant-filtered inboxes and timeline workloads.
create index if not exists grade_review_requests_student_created_idx
  on public.grade_review_requests(student_id, created_at desc);
create index if not exists grade_review_requests_teacher_created_idx
  on public.grade_review_requests(teacher_id, created_at desc);
create index if not exists submissions_assessment_status_submitted_idx
  on public.submissions(assessment_id, status, submitted_at desc);
create index if not exists submissions_student_status_submitted_idx
  on public.submissions(student_id, status, submitted_at desc);
create index if not exists ai_usage_events_teacher_created_idx
  on public.ai_usage_events(teacher_id, created_at desc);
create index if not exists whatsapp_sends_submission_status_idx
  on public.whatsapp_sends(submission_id, status);
create index if not exists lessons_tutor_created_idx
  on public.lessons(tutor_id, created_at desc);

create or replace function public.teacher_dashboard_summary()
returns table(
  active_assessment_count bigint,
  pending_submission_count bigint,
  student_count bigint,
  released_submission_count bigint
)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from public.assessments a
       where a.teacher_id = auth.uid() and a.status = 'published'),
    (select count(*) from public.submissions s join public.assessments a on a.id = s.assessment_id
       where a.teacher_id = auth.uid() and s.status in ('awaiting_review', 'approved')),
    (select count(*) from public.teacher_students ts where ts.teacher_id = auth.uid()),
    (select count(*) from public.submissions s join public.assessments a on a.id = s.assessment_id
       where a.teacher_id = auth.uid() and s.status = 'released')
  where auth.uid() is not null
    and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'teacher'))
$$;
revoke all on function public.teacher_dashboard_summary() from public, anon;
grant execute on function public.teacher_dashboard_summary() to authenticated;

-- Bounded grading inbox. Submissions are returned only for assessments owned
-- by the caller; limit is hard-capped at 51 to support a 50-row page + lookahead.
create or replace function public.teacher_grading_page(_status text, _offset integer default 0, _limit integer default 31)
returns setof public.submissions
language sql stable security definer set search_path = public as $$
  select s.*
  from public.submissions s
  join public.assessments a on a.id = s.assessment_id
  where auth.uid() is not null
    and a.teacher_id = auth.uid()
    and _status in ('awaiting_review', 'released')
    and s.status::text = _status
  order by s.submitted_at desc, s.id desc
  offset greatest(coalesce(_offset, 0), 0)
  limit greatest(1, least(coalesce(_limit, 31), 51))
$$;
revoke all on function public.teacher_grading_page(text, integer, integer) from public, anon;
grant execute on function public.teacher_grading_page(text, integer, integer) to authenticated;

-- Aggregate tutor summaries in SQL instead of downloading every enrollment.
create or replace function public.teacher_analytics_question_stats(_assessment uuid)
returns table(
  question_id uuid,
  answered bigint,
  graded bigint,
  avg_pct numeric,
  full_credit_pct numeric
)
language sql stable security definer set search_path = public as $$
  select
    q.id,
    count(a.id) filter (where s.id is not null),
    count(coalesce(a.final_score, a.auto_score)) filter (where s.id is not null),
    avg(case when s.id is not null and coalesce(a.final_score, a.auto_score) is not null and q.marks > 0
      then coalesce(a.final_score, a.auto_score) / q.marks * 100 end),
    case when count(coalesce(a.final_score, a.auto_score)) filter (where s.id is not null) > 0
      then 100.0 * count(*) filter (
        where s.id is not null and coalesce(a.final_score, a.auto_score) >= q.marks
      ) / count(coalesce(a.final_score, a.auto_score)) filter (where s.id is not null)
      else null end
  from public.questions q
  join public.assessments own on own.id = q.assessment_id and own.teacher_id = auth.uid()
  left join public.answers a on a.question_id = q.id
  left join public.submissions s on s.id = a.submission_id and s.assessment_id = q.assessment_id
  where q.assessment_id = _assessment and auth.uid() is not null
  group by q.id
$$;

create or replace function public.teacher_analytics_student_page(
  _assessment uuid, _offset integer default 0, _limit integer default 51
)
returns table(student_id uuid, full_name text, released bigint, avg_pct numeric)
language sql stable security definer set search_path = public as $$
  select s.student_id, p.full_name, count(*)::bigint,
    avg(s.final_score / s.total_possible * 100)
  from public.submissions s
  join public.assessments own on own.id = s.assessment_id and own.teacher_id = auth.uid()
  join public.profiles p on p.id = s.student_id
  where s.assessment_id = _assessment and s.status = 'released'
    and s.final_score is not null and s.total_possible > 0 and auth.uid() is not null
  group by s.student_id, p.full_name
  order by p.full_name, s.student_id
  offset greatest(coalesce(_offset, 0), 0)
  limit greatest(1, least(coalesce(_limit, 51), 51))
$$;

create or replace function public.teacher_analytics_group_stats(
  _assessment uuid, _offset integer default 0, _limit integer default 51
)
returns table(group_id uuid, name text, students bigint, avg_pct numeric)
language sql stable security definer set search_path = public as $$
  select l.id, l.title, count(distinct s.student_id),
    avg(s.final_score / s.total_possible * 100)
  from public.lessons l
  left join public.lesson_enrollments e on e.lesson_id = l.id
  left join public.submissions s on s.assessment_id = _assessment and s.student_id = e.student_id
    and s.status = 'released' and s.final_score is not null and s.total_possible > 0
  where l.tutor_id = auth.uid() and auth.uid() is not null
    and exists (select 1 from public.assessments a where a.id = _assessment and a.teacher_id = auth.uid())
  group by l.id
  order by l.created_at desc, l.id desc
  offset greatest(coalesce(_offset, 0), 0)
  limit greatest(1, least(coalesce(_limit, 51), 51))
$$;

create or replace function public.teacher_analytics_overview(_assessment_ids uuid[])
returns table(assessment_id uuid, released bigint, avg_pct numeric)
language sql stable security definer set search_path = public as $$
  select a.id, count(s.id) filter (
      where s.status = 'released' and s.final_score is not null and s.total_possible > 0
    ),
    avg(s.final_score / s.total_possible * 100) filter (
      where s.status = 'released' and s.final_score is not null and s.total_possible > 0
    )
  from public.assessments a
  left join public.submissions s on s.assessment_id = a.id
  where a.teacher_id = auth.uid() and auth.uid() is not null
    and coalesce(array_length(_assessment_ids, 1), 0) <= 100
    and a.id = any(coalesce(_assessment_ids, '{}'::uuid[]))
  group by a.id
$$;

revoke all on function public.teacher_analytics_question_stats(uuid) from public, anon;
revoke all on function public.teacher_analytics_student_page(uuid, integer, integer) from public, anon;
revoke all on function public.teacher_analytics_group_stats(uuid, integer, integer) from public, anon;
revoke all on function public.teacher_analytics_overview(uuid[]) from public, anon;
grant execute on function public.teacher_analytics_question_stats(uuid) to authenticated;
grant execute on function public.teacher_analytics_student_page(uuid, integer, integer) to authenticated;
grant execute on function public.teacher_analytics_group_stats(uuid, integer, integer) to authenticated;
grant execute on function public.teacher_analytics_overview(uuid[]) to authenticated;

create or replace function public.tutor_dashboard_summary()
returns table(lesson_count bigint, student_count bigint, published_assessment_count bigint)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from public.lessons l where l.tutor_id = auth.uid()),
    (select count(distinct e.student_id)
       from public.lessons l join public.lesson_enrollments e on e.lesson_id = l.id
       where l.tutor_id = auth.uid()),
    (select count(*) from public.assessments a
       where a.teacher_id = auth.uid() and a.status = 'published')
  where auth.uid() is not null and public.has_role(auth.uid(), 'tutor')
$$;

create or replace function public.tutor_lesson_enrollment_counts(_lesson_ids uuid[])
returns table(lesson_id uuid, student_count bigint)
language sql stable security definer set search_path = public as $$
  select l.id, count(e.student_id)
  from public.lessons l
  left join public.lesson_enrollments e on e.lesson_id = l.id
  where l.tutor_id = auth.uid()
    and coalesce(array_length(_lesson_ids, 1), 0) <= 50
    and l.id = any(coalesce(_lesson_ids, '{}'::uuid[]))
  group by l.id
  limit 50
$$;
revoke all on function public.tutor_dashboard_summary() from public, anon;
revoke all on function public.tutor_lesson_enrollment_counts(uuid[]) from public, anon;
grant execute on function public.tutor_dashboard_summary() to authenticated;
grant execute on function public.tutor_lesson_enrollment_counts(uuid[]) to authenticated;

-- 7) Auto-send idempotency claims are private server bookkeeping. Existing
-- successful sends are backfilled so migration does not trigger duplicates.
create table if not exists public.whatsapp_send_claims (
  submission_id uuid primary key references public.submissions(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  completed boolean not null default false
);
alter table public.whatsapp_send_claims enable row level security;
revoke all on public.whatsapp_send_claims from public, anon, authenticated;
grant all on public.whatsapp_send_claims to service_role;
insert into public.whatsapp_send_claims(submission_id, completed)
select distinct submission_id, true from public.whatsapp_sends where status = 'sent'
on conflict (submission_id) do nothing;

create or replace function public.claim_whatsapp_send(_submission uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare claimed uuid;
begin
  if auth.role() <> 'service_role' then return false; end if;
  if exists (select 1 from public.whatsapp_sends where submission_id = _submission and status = 'sent') then
    insert into public.whatsapp_send_claims(submission_id, claimed_at, completed)
    values (_submission, now(), true) on conflict (submission_id) do update set completed = true;
    return false;
  end if;
  insert into public.whatsapp_send_claims(submission_id, claimed_at, completed)
  values (_submission, now(), false)
  on conflict (submission_id) do update
    set claimed_at = excluded.claimed_at
    where public.whatsapp_send_claims.completed = false
      and public.whatsapp_send_claims.claimed_at < now() - interval '15 minutes'
  returning submission_id into claimed;
  return claimed is not null;
end $$;

create or replace function public.finish_whatsapp_send(
  _submission uuid,
  _status text,
  _trigger text,
  _message_id text default null,
  _error text default null,
  _retryable boolean default false
)
returns boolean language plpgsql security definer set search_path = public as $$
declare claim public.whatsapp_send_claims%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required'; end if;
  if _status not in ('sent', 'failed', 'skipped') or _trigger not in ('manual', 'auto') then
    raise exception 'invalid_send_audit';
  end if;
  select * into claim from public.whatsapp_send_claims
    where submission_id = _submission and completed = false for update;
  if claim.submission_id is null then return false; end if;

  -- Audit and claim completion/release happen in the same transaction.
  insert into public.whatsapp_sends(submission_id, status, trigger, message_id, error)
  values (_submission, _status, _trigger, _message_id, left(_error, 500));
  if _status = 'sent' or not _retryable then
    update public.whatsapp_send_claims set completed = true, claimed_at = now()
      where submission_id = _submission;
  else
    delete from public.whatsapp_send_claims where submission_id = _submission;
  end if;
  return true;
end $$;
revoke all on function public.claim_whatsapp_send(uuid) from public, anon, authenticated;
revoke all on function public.finish_whatsapp_send(uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_send(uuid) to service_role;
grant execute on function public.finish_whatsapp_send(uuid, text, text, text, text, boolean) to service_role;
revoke insert on public.whatsapp_sends from authenticated, anon;
