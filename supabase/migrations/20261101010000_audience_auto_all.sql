-- Finding 3 (exam audience), user-approved option B (2026-11-01):
-- a student who joins a teacher late sees that teacher's currently OPEN
-- general exams, but never exams whose audience the teacher picked
-- explicitly.
--
-- Persisted marker assessments.audience_mode:
--   'explicit' = the teacher selected students (or the row predates this
--                marker). NEVER widened, including on re-publish.
--   'auto_all' = published with no selection: every currently linked
--                student is assigned at publish, and future joiners are
--                assigned while the exam stays open (published and not
--                past due).
--
-- Conservative legacy classification: the column default is 'explicit',
-- so every pre-existing assessment keeps exactly its current audience.
-- No backfill, no widening of old exams (closed, restricted, or
-- unconfigured).

alter table public.assessments
  add column audience_mode text not null default 'explicit'
  check (audience_mode in ('auto_all', 'explicit'));

-- Publish: an unconfigured audience becomes 'auto_all' and is assigned to
-- every currently linked student; an audience with any existing
-- assignment row is the teacher's explicit selection and is marked
-- 'explicit'. All prior checks and transitions are unchanged.
create or replace function public.set_assessment_status(_a uuid, _status public.assessment_status)
returns void language plpgsql security definer set search_path = public as $$
declare cur public.assessment_status; n int; bad int; am text;
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
    -- Audience is decided once, at first publish: any existing assignment
    -- row means the teacher picked a cohort; zero rows means "everyone".
    if cur='draft' then
      if exists (select 1 from public.assessment_assignments where assessment_id=_a) then
        am := 'explicit';
      else
        am := 'auto_all';
        insert into public.assessment_assignments (assessment_id, student_id)
        select _a, ts.student_id from public.teacher_students ts
        where ts.teacher_id = auth.uid()
        on conflict do nothing;
      end if;
    end if;
  end if;
  update public.assessments set status=_status, updated_at=now(),
    audience_mode = coalesce(am, audience_mode) where id=_a;
  insert into public.audit_log(actor_id, action, entity_id, details) values (auth.uid(),'assessment_status',_a, jsonb_build_object('from',cur,'to',_status));
end $$;

-- Join: a late-joining student is assigned the teacher's OPEN 'auto_all'
-- exams (published, not past due). 'explicit' cohorts are never widened.
create or replace function public.join_teacher(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if not public.has_role(auth.uid(),'student') then raise exception 'only_students'; end if;
  select id into t from public.profiles where join_code = upper(trim(_code));
  if t is null then raise exception 'invalid_code'; end if;
  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = t and ur.role in ('school_teacher', 'tutor', 'teacher')
  ) then
    raise exception 'invalid_code';
  end if;
  insert into public.teacher_students(teacher_id, student_id) values (t, auth.uid()) on conflict do nothing;
  insert into public.assessment_assignments (assessment_id, student_id)
  select a.id, auth.uid() from public.assessments a
  where a.teacher_id = t
    and a.status = 'published'
    and a.audience_mode = 'auto_all'
    and (a.due_at is null or a.due_at > now())
  on conflict do nothing;
  return t;
end $$;
