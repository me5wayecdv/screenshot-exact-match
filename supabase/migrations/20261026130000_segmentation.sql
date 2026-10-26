-- Qemmini segmentation: school teachers AND tutor (lesson) teachers, everything divided.
-- Conventions follow drizzle/migrations/0000_migration.sql: RLS enabled, grants to
-- authenticated/service_role, security-definer helpers for policy checks (avoids recursion).
-- ORDER MATTERS: language-sql helpers are validated at creation time, so all tables are
-- created BEFORE the helpers, and all policies AFTER the helpers.

-- 1. Extend the role enum. The old 'teacher' value is kept (unused by the app) because
-- Postgres cannot drop an enum value; existing rows are migrated to 'school_teacher' below.
alter type public.app_role add value if not exists 'school_teacher';
alter type public.app_role add value if not exists 'tutor';
alter type public.app_role add value if not exists 'admin';

update public.user_roles set role = 'school_teacher' where role = 'teacher';

-- Existing teacher-gated policies must accept the new teacher roles, or school
-- teachers would lose subjects/assessments the moment their role value changes.
drop policy if exists "teacher owns subjects" on public.subjects;
create policy "teacher owns subjects" on public.subjects for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid() and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'tutor')));

drop policy if exists "teacher manages assessments" on public.assessments;
create policy "teacher manages assessments" on public.assessments for all to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid() and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'tutor')));

-- Admin needs to read roles for counts/overview (user_roles was own-row readable only).
create policy "admin reads roles" on public.user_roles for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- 2. Tables (no policies yet — helpers come first).
create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  join_code text unique not null default upper(substr(md5(random()::text), 1, 6)),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.schools to authenticated;
grant all on public.schools to service_role;
alter table public.schools enable row level security;

create table public.school_teachers (
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null,
  joined_at timestamptz not null default now(),
  primary key (school_id, teacher_id)
);
create index on public.school_teachers(teacher_id);
grant select, insert, delete on public.school_teachers to authenticated;
grant all on public.school_teachers to service_role;
alter table public.school_teachers enable row level security;

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null default auth.uid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);
create index on public.classes(school_id);
grant select, insert, update, delete on public.classes to authenticated;
grant all on public.classes to service_role;
alter table public.classes enable row level security;

create table public.class_members (
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null,
  joined_at timestamptz not null default now(),
  primary key (class_id, student_id)
);
create index on public.class_members(student_id);
grant select, insert, delete on public.class_members to authenticated;
grant all on public.class_members to service_role;
alter table public.class_members enable row level security;

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  tutor_id uuid not null default auth.uid(),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  subject_id uuid references public.subjects(id) on delete set null,
  join_code text unique not null default upper(substr(md5(random()::text), 1, 6)),
  created_at timestamptz not null default now()
);
create index on public.lessons(tutor_id);
grant select, insert, update, delete on public.lessons to authenticated;
grant all on public.lessons to service_role;
alter table public.lessons enable row level security;

create table public.lesson_enrollments (
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  student_id uuid not null,
  enrolled_at timestamptz not null default now(),
  primary key (lesson_id, student_id)
);
create index on public.lesson_enrollments(student_id);
grant select, insert, delete on public.lesson_enrollments to authenticated;
grant all on public.lesson_enrollments to service_role;
alter table public.lesson_enrollments enable row level security;

create table public.teacher_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  type text not null check (type in ('school_teacher', 'tutor')),
  bio text not null default '',
  subjects_text text not null default ''
);
grant select, insert, update on public.teacher_profiles to authenticated;
grant all on public.teacher_profiles to service_role;
alter table public.teacher_profiles enable row level security;

-- 3. Helpers (security definer, like is_teacher_of / owns_assessment in the base migration).
create or replace function public.is_school_member(_school uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.school_teachers where school_id = _school and teacher_id = auth.uid())
    or exists (select 1 from public.schools where id = _school and created_by = auth.uid())
    or exists (select 1 from public.classes c join public.class_members m on m.class_id = c.id
                where c.school_id = _school and m.student_id = auth.uid())
    or public.has_role(auth.uid(), 'admin')
$$;

create or replace function public.is_school_teacher(_school uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.school_teachers where school_id = _school and teacher_id = auth.uid())
    or exists (select 1 from public.schools where id = _school and created_by = auth.uid())
    or public.has_role(auth.uid(), 'admin')
$$;

create or replace function public.is_lesson_member(_lesson uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lessons where id = _lesson and tutor_id = auth.uid())
    or exists (select 1 from public.lesson_enrollments where lesson_id = _lesson and student_id = auth.uid())
    or public.has_role(auth.uid(), 'admin')
$$;

-- 4. Policies.
create policy "school members read school" on public.schools for select to authenticated
  using (public.is_school_member(id));
create policy "school teacher creates school" on public.schools for insert to authenticated
  with check (created_by = auth.uid() and (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'admin')));
create policy "school creator or admin manages school" on public.schools for update to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "school creator or admin deletes school" on public.schools for delete to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy "school members read teachers" on public.school_teachers for select to authenticated
  using (public.is_school_member(school_id) or teacher_id = auth.uid());
create policy "school creator adds teacher" on public.school_teachers for insert to authenticated
  with check (teacher_id = auth.uid() and exists (select 1 from public.schools where id = school_id and created_by = auth.uid()));
create policy "school teacher or admin removes teacher" on public.school_teachers for delete to authenticated
  using (public.is_school_teacher(school_id) or teacher_id = auth.uid());

create policy "school members read classes" on public.classes for select to authenticated
  using (public.is_school_member(school_id));
create policy "school teachers manage classes" on public.classes for all to authenticated
  using (public.is_school_teacher(school_id))
  with check (public.is_school_teacher(school_id) and teacher_id = auth.uid());

create policy "school members read class members" on public.class_members for select to authenticated
  using (student_id = auth.uid() or exists (select 1 from public.classes c where c.id = class_id and public.is_school_member(c.school_id)));
create policy "school teachers manage class members" on public.class_members for all to authenticated
  using (exists (select 1 from public.classes c where c.id = class_id and public.is_school_teacher(c.school_id)))
  with check (exists (select 1 from public.classes c where c.id = class_id and public.is_school_teacher(c.school_id)));

create policy "lesson members read lesson" on public.lessons for select to authenticated
  using (public.is_lesson_member(id));
create policy "tutor manages own lessons" on public.lessons for all to authenticated
  using (tutor_id = auth.uid())
  with check (tutor_id = auth.uid() and public.has_role(auth.uid(), 'tutor'));

create policy "lesson members read enrollments" on public.lesson_enrollments for select to authenticated
  using (student_id = auth.uid() or public.is_lesson_member(lesson_id));
create policy "tutor or admin removes enrollment" on public.lesson_enrollments for delete to authenticated
  using (exists (select 1 from public.lessons where id = lesson_id and tutor_id = auth.uid()) or public.has_role(auth.uid(), 'admin'));
-- lesson_enrollments inserts go through enroll_lesson() (security definer, bypasses RLS) by design.

create policy "teacher profile readable by owner and linked students" on public.teacher_profiles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin')
    or exists (select 1 from public.teacher_students where teacher_id = user_id and student_id = auth.uid())
    or exists (select 1 from public.lesson_enrollments e join public.lessons l on l.id = e.lesson_id
                where l.tutor_id = user_id and e.student_id = auth.uid()));
create policy "owner manages own teacher profile" on public.teacher_profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 5. Signup trigger + backfill. Join codes stay a school-teacher thing
-- (tutor lessons carry their own join_code).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.app_role;
begin
  r := case
    when new.raw_user_meta_data->>'role' in ('school_teacher', 'teacher') then 'school_teacher'::public.app_role
    when new.raw_user_meta_data->>'role' = 'tutor' then 'tutor'::public.app_role
    when new.raw_user_meta_data->>'role' = 'admin' then 'admin'::public.app_role
    else 'student'::public.app_role end;
  insert into public.profiles (id, full_name, join_code)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when r = 'school_teacher' then upper(substr(md5(random()::text || new.id::text), 1, 6)) else null end);
  insert into public.user_roles (user_id, role) values (new.id, r);
  if r in ('school_teacher', 'tutor') then
    insert into public.teacher_profiles (user_id, type) values (new.id, r::text) on conflict do nothing;
  end if;
  return new;
end $$;

insert into public.teacher_profiles (user_id, type)
select user_id, 'school_teacher' from public.user_roles where role = 'school_teacher'
on conflict do nothing;

-- 6. RPCs mirroring join_teacher.
create or replace function public.join_school(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if not (public.has_role(auth.uid(), 'school_teacher') or public.has_role(auth.uid(), 'admin')) then raise exception 'only_school_teachers'; end if;
  select id into s from public.schools where join_code = upper(trim(_code));
  if s is null then raise exception 'invalid_code'; end if;
  insert into public.school_teachers(school_id, teacher_id) values (s, auth.uid()) on conflict do nothing;
  return s;
end $$;

create or replace function public.enroll_lesson(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare l uuid;
begin
  if not public.has_role(auth.uid(), 'student') then raise exception 'only_students'; end if;
  select id into l from public.lessons where join_code = upper(trim(_code));
  if l is null then raise exception 'invalid_code'; end if;
  insert into public.lesson_enrollments(lesson_id, student_id) values (l, auth.uid()) on conflict do nothing;
  return l;
end $$;
