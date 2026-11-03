-- Teacher groups: one teacher runs several teaching groups (the Egypt
-- tutoring model: 2-3 groups for the SAME year on different days).
-- A group has a custom name, a school year, attendance days, a time, and an
-- optional note. Each group has its OWN join code. A student joins by code,
-- lands pending, and only the teacher's approval makes them a member — the
-- same approval rule as teacher enrollment (PR #34). Approving a group
-- request also approves the teacher link, so "linked = approved everywhere"
-- keeps holding; rejecting a group request rejects a still-pending teacher
-- link only when the student has no approved group with this teacher.

create table if not exists public.teacher_groups (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  school_year text not null default '',
  days text[] not null default '{}',
  time_text text not null default '',
  notes text not null default '',
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.teacher_groups (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (group_id, student_id)
);

create index if not exists teacher_groups_teacher_idx
  on public.teacher_groups (teacher_id);
create index if not exists group_members_student_idx
  on public.group_members (student_id);

alter table public.teacher_groups enable row level security;
alter table public.group_members enable row level security;

-- Teachers manage only their own groups through the client. Membership rows
-- are RPC-only (no policy): security-definer functions below do the checks,
-- so a student can never read or write another student's membership directly.
drop policy if exists "teacher manages own groups" on public.teacher_groups;
create policy "teacher manages own groups" on public.teacher_groups
  for all using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- --------------------------------------------------------------- helpers ---

-- A teacher-only guard shared by the group functions below.
create or replace function public.is_group_owner(_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.teacher_groups g
    where g.id = _group and g.teacher_id = auth.uid()
  )
$$;

-- ------------------------------------------------------------ teacher CRUD ---

create or replace function public.create_teacher_group(
  _name text, _year text, _days text[], _time text, _notes text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  code text;
  gid uuid;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not (public.has_role(t,'school_teacher') or public.has_role(t,'tutor') or public.has_role(t,'teacher'))
  then raise exception 'not_teacher'; end if;
  if coalesce(trim(_name), '') = '' then raise exception 'invalid_student'; end if;

  -- 12-char uppercase hex, same shape as teacher join codes; loop on clash.
  loop
    code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));
    exit when not exists (select 1 from public.teacher_groups where join_code = code);
  end loop;

  insert into public.teacher_groups (teacher_id, name, school_year, days, time_text, notes, join_code)
  values (t, trim(_name), coalesce(trim(_year), ''), coalesce(_days, '{}'),
          coalesce(trim(_time), ''), coalesce(trim(_notes), ''), code)
  returning id into gid;
  return gid;
end $$;

create or replace function public.update_teacher_group(
  _group uuid, _name text, _year text, _days text[], _time text, _notes text
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_owner(_group) then raise exception 'not_owner'; end if;
  if coalesce(trim(_name), '') = '' then raise exception 'invalid_student'; end if;
  update public.teacher_groups
     set name = trim(_name), school_year = coalesce(trim(_year), ''),
         days = coalesce(_days, '{}'), time_text = coalesce(trim(_time), ''),
         notes = coalesce(trim(_notes), '')
   where id = _group;
  return true;
end $$;

create or replace function public.delete_teacher_group(_group uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_owner(_group) then raise exception 'not_owner'; end if;
  delete from public.teacher_groups where id = _group;
  return true;
end $$;

-- ------------------------------------------------------------------ join -----

create or replace function public.join_group(_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g public.teacher_groups%rowtype;
  n text;
begin
  if not public.has_role(auth.uid(),'student') then raise exception 'only_students'; end if;
  -- A request without a name is a request the teacher cannot judge.
  select trim(coalesce(full_name,'')) into n from public.profiles where id = auth.uid();
  if coalesce(n,'') = '' then raise exception 'name_required'; end if;
  select * into g from public.teacher_groups where join_code = upper(trim(_code));
  if g.id is null then raise exception 'invalid_code'; end if;
  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = g.teacher_id and ur.role in ('school_teacher', 'tutor', 'teacher')
  ) then
    raise exception 'invalid_code';
  end if;

  -- The teacher link starts pending too, so the student sees the same
  -- "waiting for your teacher" state as a direct teacher join.
  update public.teacher_students
     set status = 'pending', requested_at = now(), decided_at = null
   where teacher_id = g.teacher_id and student_id = auth.uid() and status = 'rejected';
  insert into public.teacher_students (teacher_id, student_id, status, requested_at)
  values (g.teacher_id, auth.uid(), 'pending', now())
  on conflict do nothing;

  -- Re-asking after a rejection is allowed; anything already decided
  -- otherwise is left untouched.
  update public.group_members
     set status = 'pending', requested_at = now(), decided_at = null
   where group_id = g.id and student_id = auth.uid() and status = 'rejected';
  insert into public.group_members (group_id, student_id, status, requested_at)
  values (g.id, auth.uid(), 'pending', now())
  on conflict do nothing;

  -- Deliberately no assignment rows here: they appear on approval, which is
  -- what stops a pending student from seeing anything.
  return g.id;
end $$;

-- -------------------------------------------------------------- decisions ---

create or replace function public.decide_group_membership(
  _group uuid, _student uuid, _approve boolean
)
returns text language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  decided text := case when _approve then 'approved' else 'rejected' end;
  link_pending boolean := false;
  has_approved_group boolean := false;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not public.is_group_owner(_group) then raise exception 'not_owner'; end if;
  if _student is null or _student = t then raise exception 'invalid_student'; end if;

  update public.group_members
     set status = decided, decided_at = now()
   where group_id = _group and student_id = _student
     and (status = 'pending' or (_approve and status = 'rejected'));
  if not found then raise exception 'no_pending_request'; end if;

  if _approve then
    -- One approval covers both: the teacher link becomes approved, and the
    -- student picks up the teacher's open published everyone-exams.
    update public.teacher_students
       set status = 'approved', decided_at = now()
     where teacher_id = t and student_id = _student and status = 'pending';
    insert into public.teacher_students (teacher_id, student_id, status, requested_at)
    values (t, _student, 'approved', now())
    on conflict do nothing;
    insert into public.assessment_assignments (assessment_id, student_id)
    select a.id, _student
    from public.assessments a
    where a.teacher_id = t
      and a.status = 'published'
      and a.audience_mode = 'auto_all'
      and (a.due_at is null or a.due_at > now())
    on conflict do nothing;
  else
    -- Rejecting the group ends a still-pending teacher link too, but only
    -- when the student has no approved group left with this teacher — a
    -- rejection must never silently unlink an approved student.
    select exists (
      select 1 from public.group_members gm
      join public.teacher_groups g on g.id = gm.group_id
      where g.teacher_id = t and gm.student_id = _student and gm.status = 'approved'
    ) into has_approved_group;
    select exists (
      select 1 from public.teacher_students
      where teacher_id = t and student_id = _student and status = 'pending'
    ) into link_pending;
    if link_pending and not has_approved_group then
      update public.teacher_students
         set status = 'rejected', decided_at = now()
       where teacher_id = t and student_id = _student and status = 'pending';
    end if;
  end if;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'group_membership_decision', _student,
          jsonb_build_object('decision', decided, 'group_id', _group));
  return decided;
end $$;

create or replace function public.approve_all_group_members(_group uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  n integer := 0;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not public.is_group_owner(_group) then raise exception 'not_owner'; end if;

  update public.group_members
     set status = 'approved', decided_at = now()
   where group_id = _group and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then return 0; end if;

  update public.teacher_students
     set status = 'approved', decided_at = now()
   where teacher_id = t and status = 'pending'
     and student_id in (select student_id from public.group_members
                        where group_id = _group and status = 'approved');
  insert into public.teacher_students (teacher_id, student_id, status, requested_at)
  select t, gm.student_id, 'approved', now()
  from public.group_members gm
  where gm.group_id = _group and gm.status = 'approved'
  on conflict do nothing;

  insert into public.assessment_assignments (assessment_id, student_id)
  select a.id, gm.student_id
  from public.assessments a
  join public.group_members gm on gm.status = 'approved' and gm.group_id = _group
  where a.teacher_id = t
    and a.status = 'published'
    and a.audience_mode = 'auto_all'
    and (a.due_at is null or a.due_at > now())
  on conflict do nothing;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'group_membership_approve_all', null,
          jsonb_build_object('approved', n, 'group_id', _group));
  return n;
end $$;

-- -------------------------------------------------------------- read paths ---

create or replace function public.my_teacher_groups()
returns table(
  group_id uuid,
  name text,
  school_year text,
  days text[],
  time_text text,
  notes text,
  join_code text,
  approved_count bigint,
  pending_count bigint,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.school_year, g.days, g.time_text, g.notes, g.join_code,
         count(*) filter (where gm.status = 'approved'),
         count(*) filter (where gm.status = 'pending'),
         g.created_at
  from public.teacher_groups g
  left join public.group_members gm on gm.group_id = g.id
  where g.teacher_id = auth.uid()
    and (public.has_role(auth.uid(),'school_teacher')
      or public.has_role(auth.uid(),'tutor')
      or public.has_role(auth.uid(),'teacher'))
  group by g.id
  order by g.created_at desc
$$;

-- The teacher's per-group roster, pending requests first. Security definer:
-- a pending student's profile is not readable through RLS, but the teacher
-- must be able to read the name they are judging.
create or replace function public.my_group_roster(_group uuid)
returns table(
  student_id uuid,
  full_name text,
  status text,
  requested_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select gm.student_id,
         coalesce(p.full_name, ''),
         gm.status,
         gm.requested_at
  from public.group_members gm
  left join public.profiles p on p.id = gm.student_id
  where gm.group_id = _group
    and public.is_group_owner(_group)
  order by (gm.status = 'pending') desc, gm.requested_at desc nulls last
$$;

-- A student's approved groups, with the teacher's name.
create or replace function public.my_groups()
returns table(
  group_id uuid,
  group_name text,
  school_year text,
  days text[],
  time_text text,
  teacher_id uuid,
  teacher_name text
)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.school_year, g.days, g.time_text,
         g.teacher_id, coalesce(nullif(trim(p.full_name), ''), '')
  from public.group_members gm
  join public.teacher_groups g on g.id = gm.group_id
  left join public.profiles p on p.id = g.teacher_id
  where gm.student_id = auth.uid() and gm.status = 'approved'
  order by g.created_at desc
$$;

-- A student's pending group requests, with the group and teacher names so
-- the wait is not a mystery.
create or replace function public.my_pending_group_requests()
returns table(
  group_id uuid,
  group_name text,
  teacher_id uuid,
  teacher_name text,
  requested_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.teacher_id,
         coalesce(nullif(trim(p.full_name), ''), ''),
         gm.requested_at
  from public.group_members gm
  join public.teacher_groups g on g.id = gm.group_id
  left join public.profiles p on p.id = g.teacher_id
  where gm.student_id = auth.uid() and gm.status = 'pending'
  order by gm.requested_at desc nulls last
$$;

revoke all on function public.is_group_owner(uuid) from public, anon;
revoke all on function public.create_teacher_group(text, text, text[], text, text) from public, anon;
revoke all on function public.update_teacher_group(uuid, text, text, text[], text, text) from public, anon;
revoke all on function public.delete_teacher_group(uuid) from public, anon;
revoke all on function public.join_group(text) from public, anon;
revoke all on function public.decide_group_membership(uuid, uuid, boolean) from public, anon;
revoke all on function public.approve_all_group_members(uuid) from public, anon;
revoke all on function public.my_teacher_groups() from public, anon;
revoke all on function public.my_group_roster(uuid) from public, anon;
revoke all on function public.my_groups() from public, anon;
revoke all on function public.my_pending_group_requests() from public, anon;
grant execute on function public.is_group_owner(uuid) to authenticated;
grant execute on function public.create_teacher_group(text, text, text[], text, text) to authenticated;
grant execute on function public.update_teacher_group(uuid, text, text, text[], text, text) to authenticated;
grant execute on function public.delete_teacher_group(uuid) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.decide_group_membership(uuid, uuid, boolean) to authenticated;
grant execute on function public.approve_all_group_members(uuid) to authenticated;
grant execute on function public.my_teacher_groups() to authenticated;
grant execute on function public.my_group_roster(uuid) to authenticated;
grant execute on function public.my_groups() to authenticated;
grant execute on function public.my_pending_group_requests() to authenticated;
