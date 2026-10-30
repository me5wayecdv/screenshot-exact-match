-- Security hardening after the production-readiness review.
--
-- 1. Signup metadata is user-controlled. Never allow a public signup to
--    create an administrator; roles above the public teacher/student choices
--    must be provisioned through a trusted administrative path.
-- 2. Retire legacy direct-write / submit paths. Exam lifecycle writes now go
--    through start_attempt, save_draft and submit_attempt, which are
--    SECURITY DEFINER functions with server-side state checks.

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
      then upper(substr(md5(random()::text || new.id::text), 1, 6))
      else null
    end
  );
  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type)
    values (new.id, r::text)
    on conflict do nothing;
  end if;
  return new;
end $$;

-- Prevent direct student submission creation. The current take flow uses
-- start_attempt(), a SECURITY DEFINER function that enforces availability,
-- timing and attempt limits.
drop policy if exists "student creates own submission" on public.submissions;
revoke insert on public.submissions from authenticated;

-- Disable the pre-timer RPC as well. It remains in the historical schema,
-- but no current client uses it and it does not enforce exam-attempt rules.
revoke execute on function public.submit_assessment(uuid, jsonb)
  from public, anon, authenticated;

-- Students may read their own in-progress draft (needed to resume) and
-- released answers, but not answers or scores awaiting teacher review.
drop policy if exists "student reads own answers" on public.answers;
create policy "student reads own draft or released answers" on public.answers
  for select to authenticated
  using (exists (
    select 1 from public.submissions s
    where s.id = submission_id
      and s.student_id = auth.uid()
      and s.status in ('in_progress', 'released')
  ));

-- Draft writes go through save_draft(), which verifies ownership, attempt
-- state and expiry. Direct student INSERT/UPDATE could otherwise bypass
-- those checks, including changing submitted or expired answers.
drop policy if exists "student inserts own answers" on public.answers;
drop policy if exists "student updates own unreleased answers" on public.answers;
revoke insert on public.answers from authenticated;
