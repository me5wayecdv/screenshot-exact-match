-- Group exams: the SAME exam may be assigned to MORE THAN ONE group.
-- Each assignment is group-scoped: only APPROVED members of an assigned
-- group get assessment_assignments rows for that exam, so a student outside
-- the group — even one linked to the same teacher — cannot take it. The
-- take page already gates on (assignment row + published), so no take-page
-- change is needed. Unassign is deliberately OUT of scope for v1.
--
-- group_exams is RPC-only (no direct policies), like group_members:
-- security-definer functions below do the checks, so a student can never
-- read another group's exam links directly.

create table if not exists public.group_exams (
  group_id uuid not null references public.teacher_groups (id) on delete cascade,
  assessment_id uuid not null references public.assessments (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, assessment_id)
);

create index if not exists group_exams_assessment_idx
  on public.group_exams (assessment_id);

alter table public.group_exams enable row level security;

-- ------------------------------------------------------------ assignment ---

-- Link an exam to a group and assign it to that group's APPROVED members
-- only. The caller must own both the group and the assessment. The link is
-- idempotent (re-assigning returns 0 new members) and never touches
-- students outside the group, whatever the exam's audience_mode says.
create or replace function public.assign_group_exam(_group uuid, _assessment uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  t uuid := auth.uid();
  n integer := 0;
begin
  if t is null then raise exception 'not_authenticated'; end if;
  if not public.is_group_owner(_group) then raise exception 'not_owner'; end if;
  if not exists (
    select 1 from public.assessments a
    where a.id = _assessment and a.teacher_id = t
  ) then raise exception 'not_owner'; end if;

  insert into public.group_exams (group_id, assessment_id)
  values (_group, _assessment)
  on conflict do nothing;

  insert into public.assessment_assignments (assessment_id, student_id)
  select _assessment, gm.student_id
  from public.group_members gm
  where gm.group_id = _group and gm.status = 'approved'
  on conflict do nothing;
  get diagnostics n = row_count;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'group_exam_assigned', _assessment,
          jsonb_build_object('group_id', _group, 'assigned', n));
  return n;
end $$;

-- -------------------------------------------------------------- read path ---

-- Exams linked to a group. The owning teacher sees every linked exam
-- (draft or published); an approved member sees only PUBLISHED linked
-- exams; anyone else — pending, rejected, or outside the group — gets no
-- rows at all, so titles never leak to non-members.
create or replace function public.my_group_exams(_group uuid)
returns table(
  assessment_id uuid,
  title text,
  published boolean
)
language sql stable security definer set search_path = public as $$
  select ge.assessment_id, a.title, (a.status = 'published')
  from public.group_exams ge
  join public.assessments a on a.id = ge.assessment_id
  where ge.group_id = _group
    and (
      public.is_group_owner(_group)
      or (
        exists (
          select 1 from public.group_members gm
          where gm.group_id = _group
            and gm.student_id = auth.uid()
            and gm.status = 'approved'
        )
        and a.status = 'published'
      )
    )
  order by ge.created_at desc
$$;

-- ------------------------------------------------- approval paths (v2) -----
-- decide_group_membership and approve_all_group_members are redefined here
-- with their 20261103210000 bodies intact, plus one insert each: a newly
-- approved member also picks up this group's PUBLISHED linked exams. The
-- auto_all behaviour for other exams is untouched.

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
    -- Group-scoped: this group's published linked exams, nothing else.
    insert into public.assessment_assignments (assessment_id, student_id)
    select ge.assessment_id, _student
    from public.group_exams ge
    join public.assessments a on a.id = ge.assessment_id
    where ge.group_id = _group
      and a.status = 'published'
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

  -- Group-scoped: this group's published linked exams for every approved
  -- member (on conflict keeps it idempotent for members approved earlier).
  insert into public.assessment_assignments (assessment_id, student_id)
  select ge.assessment_id, gm.student_id
  from public.group_exams ge
  join public.assessments a on a.id = ge.assessment_id
  join public.group_members gm on gm.group_id = _group and gm.status = 'approved'
  where a.status = 'published'
  on conflict do nothing;

  insert into public.audit_log (actor_id, action, entity_id, details)
  values (t, 'group_membership_approve_all', null,
          jsonb_build_object('approved', n, 'group_id', _group));
  return n;
end $$;

revoke all on function public.assign_group_exam(uuid, uuid) from public, anon;
revoke all on function public.my_group_exams(uuid) from public, anon;
grant execute on function public.assign_group_exam(uuid, uuid) to authenticated;
grant execute on function public.my_group_exams(uuid) to authenticated;
