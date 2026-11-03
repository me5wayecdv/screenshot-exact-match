-- Enrollment approval (2026-11-03).
--
-- Problem: typing a join code linked a student to a teacher instantly, which
-- put every student the teacher had never met into "my students", into the
-- publish audience, and into gradeable work. A teacher is not expected to know
-- every name in advance, so the fix is not a one-by-one gate without an exit,
-- it is: requests arrive pending, the teacher sees the names, and can approve
-- one, or all of them, in a single click.
--
-- Model:
--   teacher_students.status: 'pending' | 'approved' | 'rejected'
--   - Existing rows are grandfathered as 'approved' (the column default), so
--     nothing that already works breaks on the deploy.
--   - join_teacher inserts 'pending' and no longer assigns any assessment.
--   - decide_enrollment / approve_all_enrollments are the only ways to become
--     'approved'; approval then assigns the teacher's open "everyone" exams.
--   - A rejected student may ask again: joining flips only a rejected row back
--     to pending, never an approved one, and never downgrades a pending one.
--
-- Everything that means "this student is mine" now means
-- status = 'approved': the roster, publishing, audience counts, profile
-- visibility. Pending students have no assignment rows, so the existing
-- assignment-based RLS already stops them from seeing any exam.

alter table public.teacher_students
  add column if not exists status text not null default 'approved',
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists decided_at timestamptz;

alter table public.teacher_students
  drop constraint if exists teacher_students_status_check;
alter table public.teacher_students
  add constraint teacher_students_status_check
  check (status in ('pending', 'approved', 'rejected'));

create index if not exists teacher_students_teacher_status_idx
  on public.teacher_students (teacher_id, status, requested_at desc);

-- ---------------------------------------------------------------- helpers ---

-- The one definition of "linked": approved only. Security definer so policies
-- and RPCs can use it without widening any table read.
create or replace function public.is_approved_student(_teacher uuid, _student uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.teacher_students ts
    where ts.teacher_id = _teacher and ts.student_id = _student and ts.status = 'approved'
  )
$$;
revoke all on function public.is_approved_student(uuid, uuid) from public, anon;
grant execute on function public.is_approved_student(uuid, uuid) to authenticated;

create or replace function public.is_teacher_of(_teacher uuid, _student uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.teacher_students ts
    where ts.teacher_id = _teacher and ts.student_id = _student
      and ts.status = 'approved'
      and (auth.uid() = _teacher or auth.uid() = _student or exists (
        select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'
      ))
  )
$$;

-- ------------------------------------------------------------ join (student) --

create or replace function public.join_teacher(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t uuid;
  n text;
begin
  if not public.has_role(auth.uid(),'student') then raise exception 'only_students'; end if;
  -- A request without a name is a request the teacher cannot judge.
  select trim(coalesce(full_name,'')) into n from public.profiles where id = auth.uid();
  if coalesce(n,'') = '' then raise exception 'name_required'; end if;
  select id into t from public.profiles where join_code = upper(trim(_code));
  if t is null then raise exception 'invalid_code'; end if;
  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = t and ur.role in ('school_teacher', 'tutor', 'teacher')
  ) then
    raise exception 'invalid_code';
  end if;

  -- Re-asking after a rejection is allowed; anything already decided otherwise
  -- is left untouched (no re-opening an approved link, no duplicate request).
  update public.teacher_students
     set status = 'pending', requested_at = now(), decided_at = null
   where teacher_id = t and student_id = auth.uid() and status = 'rejected';

  insert into public.teacher_students (teacher_id, student_id, status, requested_at)
  values (t, auth.uid(), 'pending', now())
  on conflict do nothing;

  -- Deliberately no assignment rows here: they appear on approval, which is
  -- what stops a pending student from seeing anything.
  return t;
end $$;

-- --------------------------------------------------------------- decisions ---

create or replace function public.decide_enrollment(_student uuid, _approve boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  decided text := case when _approve then 'approved' else 'rejected' end;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not (public.has_role(t,'school_teacher') or public.has_role(t,'tutor') or public.has_role(t,'teacher'))
  then raise exception 'not_teacher'; end if;
  if _student is null or _student = t then raise exception 'invalid_student'; end if;

  -- Approving can also reverse an earlier rejection (the teacher changed
  -- their mind); rejecting only ever applies to something still open.
  update public.teacher_students
     set status = decided, decided_at = now()
   where teacher_id = t and student_id = _student
     and (status = 'pending' or (_approve and status = 'rejected'));
  if not found then raise exception 'no_pending_request'; end if;

  if _approve then
    insert into public.assessment_assignments (assessment_id, student_id)
    select a.id, _student
    from public.assessments a
    where a.teacher_id = t
      and a.status = 'published'
      and a.audience_mode = 'auto_all'
      and (a.due_at is null or a.due_at > now())
    on conflict do nothing;
  else
    -- A rejected student keeps nothing that has no submission attached; exams
    -- they already answered stay for the teacher's records.
    delete from public.assessment_assignments x
    using public.assessments a
    where x.assessment_id = a.id
      and a.teacher_id = t
      and x.student_id = _student
      and not exists (
        select 1 from public.submissions s
        where s.assessment_id = a.id and s.student_id = _student
      );
  end if;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'enrollment_decision', _student, jsonb_build_object('decision', decided));
  return decided;
end $$;

-- One click for the common case: the teacher does not know every name, so
-- approving the whole batch must be as cheap as approving one.
create or replace function public.approve_all_enrollments()
returns integer language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  n integer := 0;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not (public.has_role(t,'school_teacher') or public.has_role(t,'tutor') or public.has_role(t,'teacher'))
  then raise exception 'not_teacher'; end if;

  update public.teacher_students
     set status = 'approved', decided_at = now()
   where teacher_id = t and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then return 0; end if;

  insert into public.assessment_assignments (assessment_id, student_id)
  select a.id, ts.student_id
  from public.assessments a
  join public.teacher_students ts on ts.teacher_id = a.teacher_id and ts.status = 'approved'
  where a.teacher_id = t
    and a.status = 'published'
    and a.audience_mode = 'auto_all'
    and (a.due_at is null or a.due_at > now())
  on conflict do nothing;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'enrollment_approve_all', null, jsonb_build_object('approved', n));
  return n;
end $$;

-- ------------------------------------------------------------- read paths ---

-- The teacher's roster, pending requests first. Security definer: a pending
-- student's profile is not readable through RLS (is_teacher_of is approved
-- only), but the teacher must be able to read the name they are judging.
create or replace function public.my_student_roster()
returns table(
  student_id uuid,
  full_name text,
  status text,
  requested_at timestamptz,
  joined_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select ts.student_id,
         coalesce(p.full_name, ''),
         ts.status,
         ts.requested_at,
         ts.created_at
  from public.teacher_students ts
  left join public.profiles p on p.id = ts.student_id
  where ts.teacher_id = auth.uid()
    and (public.has_role(auth.uid(),'school_teacher')
      or public.has_role(auth.uid(),'tutor')
      or public.has_role(auth.uid(),'teacher'))
  order by (ts.status = 'pending') desc, ts.requested_at desc nulls last, ts.created_at desc
$$;

-- A student's pending requests, with the teacher's name so the wait is not a
-- mystery. Approved links stay out of this list.
create or replace function public.my_pending_enrollments()
returns table(teacher_id uuid, teacher_name text, requested_at timestamptz)
language sql stable security definer set search_path = public as $$
  select ts.teacher_id,
         coalesce(nullif(trim(p.full_name), ''), ''),
         ts.requested_at
  from public.teacher_students ts
  left join public.profiles p on p.id = ts.teacher_id
  where ts.student_id = auth.uid() and ts.status = 'pending'
  order by ts.requested_at desc nulls last
$$;

revoke all on function public.join_teacher(text) from public, anon;
revoke all on function public.decide_enrollment(uuid, boolean) from public, anon;
revoke all on function public.approve_all_enrollments() from public, anon;
revoke all on function public.my_student_roster() from public, anon;
revoke all on function public.my_pending_enrollments() from public, anon;
grant execute on function public.join_teacher(text) to authenticated;
grant execute on function public.decide_enrollment(uuid, boolean) to authenticated;
grant execute on function public.approve_all_enrollments() to authenticated;
grant execute on function public.my_student_roster() to authenticated;
grant execute on function public.my_pending_enrollments() to authenticated;

-- ------------------------------------------------------ audience = approved ---

-- Same function as 20261103090000_audience_by_coverage.sql, with one change:
-- "linked" means approved. A pending request must never be counted as a
-- student who will see the exam.
create or replace function public.set_assessment_status(_a uuid, _status public.assessment_status)
returns void language plpgsql security definer set search_path = public as $$
declare
  cur public.assessment_status;
  n int;
  bad int;
  am text;
  linked int;
  assigned int;
begin
  select status into cur from public.assessments where id=_a and teacher_id=auth.uid();
  if cur is null then raise exception 'not_found'; end if;
  if not ((cur='draft' and _status='published') or (cur='published' and _status in ('closed','draft'))
       or (cur='closed' and _status in ('published','archived')) or (cur='archived' and _status='closed')) then
    raise exception 'invalid_transition';
  end if;
  if _status='draft' and exists(select 1 from public.submissions where assessment_id=_a) then
    raise exception 'has_submissions';
  end if;

  if _status='published' then
    select count(*) into n from public.questions where assessment_id=_a;
    if n=0 then raise exception 'no_questions'; end if;
    select count(*) into bad from public.questions q left join public.question_keys k on k.question_id=q.id
      where q.assessment_id=_a and (length(trim(q.prompt))=0
        or (q.type in ('mcq','true_false','short_answer') and coalesce(trim(k.correct_answer),'')='')
        or (q.type='written' and coalesce(trim(k.rubric),'')='')
        or (q.type='mcq' and jsonb_array_length(q.options) < 2));
    if bad>0 then raise exception 'incomplete_questions'; end if;

    select count(*) into linked from public.teacher_students
      where teacher_id = auth.uid() and status = 'approved';
    if linked = 0 then raise exception 'no_students'; end if;

    select count(*) into assigned
    from public.assessment_assignments aa
    join public.teacher_students ts
      on ts.student_id = aa.student_id and ts.teacher_id = auth.uid() and ts.status = 'approved'
    where aa.assessment_id = _a;

    if assigned = 0 or assigned >= linked then
      am := 'auto_all';
      insert into public.assessment_assignments (assessment_id, student_id)
      select _a, ts.student_id from public.teacher_students ts
      where ts.teacher_id = auth.uid() and ts.status = 'approved'
      on conflict do nothing;
    else
      am := 'explicit';
    end if;
  end if;

  update public.assessments set status=_status, updated_at=now(),
    audience_mode = coalesce(am, audience_mode) where id=_a;
  insert into public.audit_log(actor_id, action, entity_id, details)
    values (auth.uid(),'assessment_status',_a,
            jsonb_build_object('from',cur,'to',_status,'audience',coalesce(am, null)));
end $$;

-- Dashboard counts follow the same rule.
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
    (select count(*) from public.teacher_students ts
       where ts.teacher_id = auth.uid() and ts.status = 'approved'),
    (select count(*) from public.submissions s join public.assessments a on a.id = s.assessment_id
       where a.teacher_id = auth.uid() and s.status = 'released')
  where auth.uid() is not null
    and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'teacher'))
$$;

-- A student only sees a linked teacher's public profile after approval.
drop policy if exists "teacher profile readable by owner and linked students" on public.teacher_profiles;
create policy "teacher profile readable by owner and linked students" on public.teacher_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin')
    or public.is_approved_student(user_id, auth.uid())
    or exists (
      select 1 from public.lesson_enrollments e join public.lessons l on l.id = e.lesson_id
      where l.tutor_id = user_id and e.student_id = auth.uid()
    )
  );
