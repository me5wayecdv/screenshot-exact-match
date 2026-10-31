-- Security fixes approved 2026-10-31 (review findings 1 + 2).
--
-- FIX 1: Students could SELECT exam questions before the exam window
-- opened. "student reads assigned questions" used assigned_published(),
-- which checks only status in ('published','closed') — never starts_at;
-- the window was enforced only when STARTING an attempt. A student could
-- read (and share) every question of a published exam days early.
-- Fix: a dedicated helper keeps the old read for closed exams (review)
-- and for published exams only once starts_at has passed; assessments
-- themselves stay listable so the dashboard can show upcoming exams.
create or replace function public.assigned_question_readable(_a uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.assessments a
    join public.assessment_assignments x on x.assessment_id = a.id
    where a.id = _a
      and x.student_id = auth.uid()
      and (
        a.status = 'closed'
        or (a.status = 'published' and (a.starts_at is null or now() >= a.starts_at))
      )
  );
$$;

drop policy if exists "student reads assigned questions" on public.questions;
create policy "student reads assigned questions" on public.questions
  for select to authenticated
  using (public.assigned_question_readable(assessment_id));

-- FIX 2a: Any user (including students) could set their own
-- profiles.join_code and mint a "teacher" code; join_teacher only
-- checked the JOINER's role, never the code owner's. A student could
-- become "teacher" of other students, then read their profile and edit
-- parent_phone / whatsapp_consent through the linked-teacher policy.
-- Client code only ever updates full_name (profile page) and
-- parent_phone / whatsapp_consent (parent contact form), so column
-- privileges are narrowed to exactly those columns; join_code becomes
-- unwritable from every client path while RLS policies stay as they are.
revoke update on public.profiles from authenticated;
grant update (full_name, parent_phone, whatsapp_consent) on public.profiles to authenticated;

-- FIX 2b: join_teacher must only accept codes that belong to accounts
-- with a real teacher role ('teacher' kept for pre-segmentation rows).
-- NOTE: this join_teacher adds the owner-role check only. The
-- audience-backfill stays frozen in 20261031220000 pending the user's
-- late-joiner decision; when that migration lands, its own join_teacher
-- (which carries this same guard) replaces this definition.
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
  return t;
end $$;

-- Teacher scope guard: the column grant above lets any authenticated role
-- write full_name/parent_phone/whatsapp_consent, and the teacher RLS policy
-- covers linked students' rows. A teacher may only maintain CONTACT fields
-- on a linked student; renaming another user's profile is not part of any
-- real workflow. Self-service profile edits stay unrestricted within the
-- granted columns. Runs with the caller's identity: service/migration
-- contexts (auth.uid() is null) are untouched, so admin tooling and
-- backfills keep working.
create or replace function public.profiles_teacher_scope_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() <> new.id then
    if new.full_name is distinct from old.full_name
       or new.join_code is distinct from old.join_code then
      raise exception 'forbidden_profile_field';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_teacher_scope on public.profiles;
create trigger profiles_teacher_scope
  before update on public.profiles
  for each row execute function public.profiles_teacher_scope_guard();
