-- Split out of 20261031220000 so the approved phone fix ships independently
-- of the pending late-joiner audience decision (auto-assign stays frozen
-- there until the user answers). SQL below is verbatim from the approved,
-- tested finding-5 change.

-- Parent phone: Egyptian mobile only, and required for students.
-- 1. Tighten the CHECK from generic E.164 to Egyptian mobile
--    (+20 followed by 010/011/012/015 and 8 more digits). Existing NULLs
--    are preserved (still allowed); the app gate prompts students to add
--    one instead of rewriting or deleting existing data.
alter table public.profiles drop constraint if exists profiles_parent_phone_e164;
alter table public.profiles
  add constraint profiles_parent_phone_egyptian
  check (parent_phone is null or parent_phone ~ '^\+20(10|11|12|15)[0-9]{8}$') not valid;
-- NOT VALID: pre-existing rows with older formats are never scanned, rewritten
-- or deleted by this migration. New writes (and any later edit of a row) must
-- satisfy the Egyptian format, matching the app-level gate.

-- 2. Signup trigger stores a valid Egyptian parent phone from student
--    signup metadata; anything else is stored as NULL (never trusted
--    blindly from client metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.app_role;
begin
  r := case
    when new.raw_user_meta_data->>'role' in ('school_teacher', 'teacher') then 'school_teacher'::public.app_role
    when new.raw_user_meta_data->>'role' = 'tutor' then 'tutor'::public.app_role
    else 'student'::public.app_role end;
  insert into public.profiles (id, full_name, join_code, parent_phone)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when r in ('school_teacher', 'tutor') then upper(substr(md5(random()::text || new.id::text), 1, 6)) else null end,
          case when r = 'student' and coalesce(new.raw_user_meta_data->>'parent_phone', '') ~ '^\+20(10|11|12|15)[0-9]{8}$'
            then new.raw_user_meta_data->>'parent_phone' else null end);
  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type) values (new.id, r::text) on conflict do nothing;
  end if;
  return new;
end $$;

-- 3. Required enforcement: a student without a parent phone on file
--    cannot START an exam attempt until it is added (the dashboard
--    shows the contact form; existing rows are untouched). Raised as
--    parent_phone_required, mapped to a friendly message in the UI.
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
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.parent_phone is not null) then
    raise exception 'parent_phone_required';
  end if;
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
