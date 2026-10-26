
create type public.app_role as enum ('teacher','student');
create type public.assessment_status as enum ('draft','published','closed','archived');
create type public.question_type as enum ('mcq','true_false','short_answer','written');
create type public.submission_status as enum ('submitted','awaiting_review','approved','released');
create type public.review_status as enum ('not_graded','auto_graded','ai_suggested','approved','rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  join_code text unique,
  created_at timestamptz not null default now()
);
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  unique (user_id)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create policy "own role readable" on public.user_roles for select to authenticated using (user_id = auth.uid());

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create table public.teacher_students (
  teacher_id uuid not null,
  student_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (teacher_id, student_id)
);
create index on public.teacher_students(student_id);
grant select, delete on public.teacher_students to authenticated;
grant all on public.teacher_students to service_role;
alter table public.teacher_students enable row level security;
create policy "teacher or student sees link" on public.teacher_students for select to authenticated
  using (teacher_id = auth.uid() or student_id = auth.uid());
create policy "teacher removes link" on public.teacher_students for delete to authenticated
  using (teacher_id = auth.uid());

create or replace function public.is_teacher_of(_teacher uuid, _student uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teacher_students where teacher_id=_teacher and student_id=_student)
$$;

create policy "read own profile" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_teacher_of(auth.uid(), id) or public.is_teacher_of(id, auth.uid()));
create policy "update own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- prevent changing join_code via direct update by non-owner handled by policy; role lives in user_roles only.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.app_role;
begin
  r := case when new.raw_user_meta_data->>'role' = 'teacher' then 'teacher'::public.app_role else 'student'::public.app_role end;
  insert into public.profiles (id, full_name, join_code)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when r='teacher' then upper(substr(md5(random()::text || new.id::text),1,6)) else null end);
  insert into public.user_roles (user_id, role) values (new.id, r);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.subjects to authenticated;
grant all on public.subjects to service_role;
alter table public.subjects enable row level security;
create policy "teacher owns subjects" on public.subjects for all to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid() and public.has_role(auth.uid(),'teacher'));

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid(),
  subject_id uuid references public.subjects(id) on delete set null,
  title text not null check (length(trim(title)) > 0),
  instructions text not null default '',
  grade_level text not null default '',
  status public.assessment_status not null default 'draft',
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.assessments(teacher_id);
grant select, insert, update, delete on public.assessments to authenticated;
grant all on public.assessments to service_role;
alter table public.assessments enable row level security;

create table public.assessment_assignments (
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  student_id uuid not null,
  primary key (assessment_id, student_id)
);
create index on public.assessment_assignments(student_id);
grant select, insert, delete on public.assessment_assignments to authenticated;
grant all on public.assessment_assignments to service_role;
alter table public.assessment_assignments enable row level security;

create or replace function public.owns_assessment(_a uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assessments where id=_a and teacher_id=auth.uid())
$$;
create or replace function public.assigned_published(_a uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assessments a join public.assessment_assignments x on x.assessment_id=a.id
    where a.id=_a and x.student_id=auth.uid() and a.status in ('published','closed'))
$$;

create policy "teacher manages assessments" on public.assessments for all to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid() and public.has_role(auth.uid(),'teacher'));
create policy "student reads assigned" on public.assessments for select to authenticated
  using (public.assigned_published(id));

create policy "teacher manages assignments" on public.assessment_assignments for all to authenticated
  using (public.owns_assessment(assessment_id))
  with check (public.owns_assessment(assessment_id) and public.is_teacher_of(auth.uid(), student_id));
create policy "student sees own assignment" on public.assessment_assignments for select to authenticated
  using (student_id = auth.uid());

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  position int not null default 0,
  type public.question_type not null,
  prompt text not null default '',
  options jsonb not null default '[]'::jsonb,
  marks numeric not null default 1 check (marks > 0),
  objective text not null default '',
  created_at timestamptz not null default now()
);
create index on public.questions(assessment_id);
grant select, insert, update, delete on public.questions to authenticated;
grant all on public.questions to service_role;
alter table public.questions enable row level security;
create policy "teacher manages questions" on public.questions for all to authenticated
  using (public.owns_assessment(assessment_id)) with check (public.owns_assessment(assessment_id));
create policy "student reads assigned questions" on public.questions for select to authenticated
  using (public.assigned_published(assessment_id));

-- Answer keys: teacher-only, never readable by students
create table public.question_keys (
  question_id uuid primary key references public.questions(id) on delete cascade,
  correct_answer text not null default '',
  accepted_alternatives jsonb not null default '[]'::jsonb,
  rubric text not null default '',
  explanation text not null default ''
);
grant select, insert, update, delete on public.question_keys to authenticated;
grant all on public.question_keys to service_role;
alter table public.question_keys enable row level security;
create policy "teacher manages keys" on public.question_keys for all to authenticated
  using (exists (select 1 from public.questions q where q.id=question_id and public.owns_assessment(q.assessment_id)))
  with check (exists (select 1 from public.questions q where q.id=question_id and public.owns_assessment(q.assessment_id)));

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  student_id uuid not null,
  status public.submission_status not null default 'submitted',
  submitted_at timestamptz not null default now(),
  total_possible numeric not null default 0,
  final_score numeric,
  teacher_feedback text not null default '',
  released_at timestamptz,
  unique (assessment_id, student_id)
);
create index on public.submissions(student_id);
grant select on public.submissions to authenticated;
grant all on public.submissions to service_role;
alter table public.submissions enable row level security;
create policy "teacher reads submissions" on public.submissions for select to authenticated using (public.owns_assessment(assessment_id));
create policy "student reads own submission" on public.submissions for select to authenticated using (student_id = auth.uid());

create table public.answers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  response text not null default '',
  max_marks numeric not null,
  auto_score numeric,
  ai_suggestion jsonb,
  final_score numeric,
  feedback text not null default '',
  review_status public.review_status not null default 'not_graded',
  unique (submission_id, question_id)
);
grant select on public.answers to authenticated;
grant all on public.answers to service_role;
alter table public.answers enable row level security;
create policy "teacher reads answers" on public.answers for select to authenticated
  using (exists (select 1 from public.submissions s where s.id=submission_id and public.owns_assessment(s.assessment_id)));
create policy "student reads released answers" on public.answers for select to authenticated
  using (exists (select 1 from public.submissions s where s.id=submission_id and s.student_id=auth.uid() and s.status='released'));

-- Append-only audit log
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid not null,
  action text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
alter table public.audit_log enable row level security;
create policy "actor reads own audit" on public.audit_log for select to authenticated using (actor_id = auth.uid());

-- ===== RPCs =====
create or replace function public.join_teacher(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if not public.has_role(auth.uid(),'student') then raise exception 'only_students'; end if;
  select id into t from public.profiles where join_code = upper(trim(_code));
  if t is null then raise exception 'invalid_code'; end if;
  insert into public.teacher_students(teacher_id, student_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;

create or replace function public.set_assessment_status(_a uuid, _status public.assessment_status)
returns void language plpgsql security definer set search_path = public as $$
declare cur public.assessment_status; n int; bad int;
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
  end if;
  update public.assessments set status=_status, updated_at=now() where id=_a;
  insert into public.audit_log(actor_id, action, entity_id, details) values (auth.uid(),'assessment_status',_a, jsonb_build_object('from',cur,'to',_status));
end $$;

-- Block editing questions/keys once submissions exist
create or replace function public.guard_question_edit()
returns trigger language plpgsql security definer set search_path = public as $$
declare aid uuid;
begin
  if tg_table_name='questions' then aid := coalesce(new.assessment_id, old.assessment_id);
  else select assessment_id into aid from public.questions where id=coalesce(new.question_id, old.question_id); end if;
  if exists(select 1 from public.submissions where assessment_id=aid) then raise exception 'locked_has_submissions'; end if;
  return coalesce(new, old);
end $$;
create trigger guard_q before insert or update or delete on public.questions for each row execute function public.guard_question_edit();
create trigger guard_k before insert or update or delete on public.question_keys for each row execute function public.guard_question_edit();

create or replace function public.normalize_answer(_t text)
returns text language sql immutable set search_path = public as $$
  select lower(regexp_replace(trim(coalesce(_t,'')), '\s+', ' ', 'g'))
$$;

-- Deterministic objective scoring for one question
create or replace function public.score_objective(_type public.question_type, _response text, _correct text, _alts jsonb, _marks numeric)
returns numeric language plpgsql immutable set search_path = public as $$
begin
  if _type in ('mcq','true_false') then
    return case when trim(coalesce(_response,'')) = trim(_correct) then _marks else 0 end;
  elsif _type='short_answer' then
    if public.normalize_answer(_response) = public.normalize_answer(_correct) then return _marks; end if;
    if exists (select 1 from jsonb_array_elements_text(coalesce(_alts,'[]'::jsonb)) a where public.normalize_answer(a)=public.normalize_answer(_response) and public.normalize_answer(a)<>'') then return _marks; end if;
    return 0;
  end if;
  return null;
end $$;

create or replace function public.submit_assessment(_a uuid, _answers jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare a record; sid uuid; q record; resp text; total numeric := 0; has_written boolean := false; sc numeric;
begin
  select * into a from public.assessments where id=_a;
  if a.id is null or not exists(select 1 from public.assessment_assignments where assessment_id=_a and student_id=auth.uid()) then
    raise exception 'not_assigned'; end if;
  if a.status <> 'published' then raise exception 'not_available'; end if;
  if a.due_at is not null and now() > a.due_at then raise exception 'deadline_passed'; end if;
  if exists(select 1 from public.submissions where assessment_id=_a and student_id=auth.uid()) then raise exception 'already_submitted'; end if;
  if jsonb_typeof(_answers) <> 'object' then raise exception 'invalid_answers'; end if;
  if exists (select 1 from jsonb_object_keys(_answers) k where not exists (select 1 from public.questions where assessment_id=_a and id::text=k)) then
    raise exception 'invalid_question'; end if;
  insert into public.submissions(assessment_id, student_id) values (_a, auth.uid()) returning id into sid;
  for q in select qq.*, k.correct_answer, k.accepted_alternatives from public.questions qq left join public.question_keys k on k.question_id=qq.id where qq.assessment_id=_a loop
    resp := coalesce(_answers->>q.id::text, '');
    if length(resp) > 20000 then raise exception 'answer_too_long'; end if;
    total := total + q.marks;
    if q.type='written' then
      has_written := true;
      insert into public.answers(submission_id, question_id, response, max_marks) values (sid, q.id, resp, q.marks);
    else
      sc := public.score_objective(q.type, resp, q.correct_answer, q.accepted_alternatives, q.marks);
      insert into public.answers(submission_id, question_id, response, max_marks, auto_score, final_score, review_status)
        values (sid, q.id, resp, q.marks, sc, sc, 'auto_graded');
    end if;
  end loop;
  update public.submissions set total_possible=total, status = case when has_written then 'awaiting_review'::public.submission_status else 'approved'::public.submission_status end where id=sid;
  return sid;
end $$;

create or replace function public.store_ai_suggestion(_answer uuid, _suggestion jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.answers an join public.submissions s on s.id=an.submission_id
     where an.id=_answer and public.owns_assessment(s.assessment_id) and s.status <> 'released') then raise exception 'not_found'; end if;
  update public.answers set ai_suggestion=_suggestion,
    review_status = case when review_status in ('not_graded','rejected') then 'ai_suggested'::public.review_status else review_status end
    where id=_answer;
  insert into public.audit_log(actor_id, action, entity_id, details) values (auth.uid(),'ai_suggestion',_answer, _suggestion);
end $$;

create or replace function public.review_answer(_answer uuid, _score numeric, _feedback text, _decision text)
returns void language plpgsql security definer set search_path = public as $$
declare an record; s record;
begin
  select * into an from public.answers where id=_answer;
  select * into s from public.submissions where id=an.submission_id;
  if an.id is null or not public.owns_assessment(s.assessment_id) then raise exception 'not_found'; end if;
  if s.status='released' then raise exception 'already_released'; end if;
  if _decision not in ('approve','reject') then raise exception 'invalid_decision'; end if;
  if _decision='approve' and (_score is null or _score < 0 or _score > an.max_marks) then raise exception 'score_out_of_range'; end if;
  update public.answers set final_score = case when _decision='approve' then _score else null end,
    feedback=coalesce(_feedback,''), review_status = case when _decision='approve' then 'approved'::public.review_status else 'rejected'::public.review_status end
    where id=_answer;
  update public.submissions set status = case when exists(select 1 from public.answers where submission_id=s.id and final_score is null) then 'awaiting_review'::public.submission_status else 'approved'::public.submission_status end
    where id=s.id;
  insert into public.audit_log(actor_id, action, entity_id, details) values (auth.uid(),'review_answer',_answer,
    jsonb_build_object('decision',_decision,'score',_score,'previous_final',an.final_score,'ai_score',an.ai_suggestion->'suggested_score'));
end $$;

create or replace function public.release_submission(_sub uuid, _feedback text)
returns void language plpgsql security definer set search_path = public as $$
declare s record; total numeric;
begin
  select * into s from public.submissions where id=_sub;
  if s.id is null or not public.owns_assessment(s.assessment_id) then raise exception 'not_found'; end if;
  if s.status='released' then raise exception 'already_released'; end if;
  if exists(select 1 from public.answers where submission_id=_sub and final_score is null) then raise exception 'not_fully_graded'; end if;
  select coalesce(sum(final_score),0) into total from public.answers where submission_id=_sub;
  update public.submissions set final_score=total, teacher_feedback=coalesce(_feedback,''), status='released', released_at=now() where id=_sub;
  insert into public.audit_log(actor_id, action, entity_id, details) values (auth.uid(),'release',_sub, jsonb_build_object('score',total));
end $$;

-- Teacher-safe student directory
create or replace function public.my_students()
returns table(student_id uuid, full_name text, joined_at timestamptz) language sql stable security definer set search_path = public as $$
  select ts.student_id, p.full_name, ts.created_at from public.teacher_students ts join public.profiles p on p.id=ts.student_id
  where ts.teacher_id=auth.uid() order by p.full_name
$$;

revoke execute on function public.score_objective(public.question_type,text,text,jsonb,numeric) from public, anon;
revoke execute on function public.join_teacher(text), public.set_assessment_status(uuid,public.assessment_status), public.submit_assessment(uuid,jsonb),
  public.store_ai_suggestion(uuid,jsonb), public.review_answer(uuid,numeric,text,text), public.release_submission(uuid,text), public.my_students() from public, anon;
grant execute on function public.join_teacher(text), public.set_assessment_status(uuid,public.assessment_status), public.submit_assessment(uuid,jsonb),
  public.store_ai_suggestion(uuid,jsonb), public.review_answer(uuid,numeric,text,text), public.release_submission(uuid,text), public.my_students(), public.score_objective(public.question_type,text,text,jsonb,numeric) to authenticated;
