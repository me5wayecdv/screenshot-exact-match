-- Phase 7 — institutional: school-wide READ sharing + grade-review requests.
--
-- Sharing is SELECT-only, by design:
-- - Grading, release, and all writes stay owner-only: release_submission
--   and review_answer enforce owns_assessment(), and there is NO colleague
--   policy on question_keys at all — answer keys are never shared.
-- - WhatsApp sends stay owner-only (the report page hides that section
--   for colleagues; the send path is owner-gated server-side too).
-- - Colleagues see assessments/questions/submissions/answers/classes/
--   class_members of teachers in a school they share (school_teachers).
--   Tutors are not school members, so tutor assessments stay private.

-- 1. Same-school helper (SECURITY DEFINER so it works inside RLS).
create or replace function public.same_school(_teacher uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.school_teachers t1
    join public.school_teachers t2 on t2.school_id = t1.school_id
    where t1.teacher_id = _teacher and t2.teacher_id = auth.uid()
  );
$$;

-- 2. Colleague read policies (permissive SELECT, OR'd with existing policies).
create policy "school colleagues read assessments" on public.assessments for select to authenticated
  using (public.same_school(teacher_id));

create policy "school colleagues read questions" on public.questions for select to authenticated
  using (exists (select 1 from public.assessments a where a.id = assessment_id and public.same_school(a.teacher_id)));

create policy "school colleagues read submissions" on public.submissions for select to authenticated
  using (exists (select 1 from public.assessments a where a.id = assessment_id and public.same_school(a.teacher_id)));

create policy "school colleagues read answers" on public.answers for select to authenticated
  using (exists (
    select 1 from public.submissions s join public.assessments a on a.id = s.assessment_id
    where s.id = submission_id and public.same_school(a.teacher_id)
  ));

create policy "school colleagues read classes" on public.classes for select to authenticated
  using (exists (select 1 from public.school_teachers st where st.school_id = classes.school_id and st.teacher_id = auth.uid()));

create policy "school colleagues read class members" on public.class_members for select to authenticated
  using (exists (
    select 1 from public.classes c join public.school_teachers st on st.school_id = c.school_id
    where c.id = class_id and st.teacher_id = auth.uid()
  ));

-- Colleagues see student NAMES only for students whose work they can
-- already read (shared assessments). Without this, colleague reports
-- would render every student as "—".
create policy "school colleagues read student profiles" on public.profiles for select to authenticated
  using (exists (
    select 1 from public.submissions s join public.assessments a on a.id = s.assessment_id
    where s.student_id = profiles.id and public.same_school(a.teacher_id)
  ));

grant execute on function public.same_school(uuid) to authenticated;

-- 3. Grade-review requests (student -> teacher, per released submission).
create table public.grade_review_requests (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  question_id uuid references public.questions(id) on delete cascade,
  student_id uuid not null,
  teacher_id uuid not null,
  message text not null check (length(trim(message)) > 0),
  status text not null default 'open' check (status in ('open', 'resolved')),
  teacher_response text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
grant select, insert on public.grade_review_requests to authenticated;
grant all on public.grade_review_requests to service_role;
alter table public.grade_review_requests enable row level security;

-- Student inserts only for their own RELEASED submissions; teacher_id must
-- be the assessment's actual owner and an optional question_id must belong
-- to that submission's assessment. The WITH CHECK recomputes all of it —
-- client-supplied teacher_id/question_id are never trusted.
create policy "student creates review requests" on public.grade_review_requests for insert to authenticated
  with check (
    student_id = auth.uid()
    and exists (
      select 1 from public.submissions s join public.assessments a on a.id = s.assessment_id
      where s.id = submission_id and s.student_id = auth.uid() and s.status = 'released' and a.teacher_id = teacher_id
    )
    and (
      question_id is null
      or exists (
        select 1 from public.questions q join public.submissions s2 on s2.assessment_id = q.assessment_id
        where q.id = question_id and s2.id = submission_id
      )
    )
  );

create policy "student reads own review requests" on public.grade_review_requests for select to authenticated
  using (student_id = auth.uid());

create policy "teacher reads own review requests" on public.grade_review_requests for select to authenticated
  using (teacher_id = auth.uid());

-- Resolution goes through a SECURITY DEFINER fn (there is deliberately NO
-- UPDATE policy), so a teacher can change ONLY status/response/resolved_at
-- of their own requests — never student_id, submission_id, or question_id.
create or replace function public.resolve_review_request(_id uuid, _response text)
returns boolean language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.grade_review_requests where id = _id;
  if r.id is null or r.teacher_id <> auth.uid() then return false; end if;
  update public.grade_review_requests
    set status = 'resolved', teacher_response = coalesce(_response, ''), resolved_at = now()
    where id = _id;
  return true;
end $$;

grant execute on function public.resolve_review_request(uuid, text) to authenticated;
