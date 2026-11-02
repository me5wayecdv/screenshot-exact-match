-- AI usage measurement for the pilot (NOT enforcement): one row per AI
-- call, so real unit cost per teacher (and per kind) can be measured
-- before pricing tiers are locked. No quota logic reads this table.
-- teacher_id is the authenticated user the call ran for: the teacher for
-- grade/generate/ocr/match, and the student for tutor hints (kind='tutor').

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null,
  kind text not null check (kind in ('grade', 'generate', 'ocr', 'match', 'tutor')),
  provider text not null,
  model text not null,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
alter table public.ai_usage_events enable row level security;
grant select, insert on public.ai_usage_events to authenticated;

-- Append-only: no update/delete policies, mirroring audit_log.
create policy "teacher reads own usage" on public.ai_usage_events for select to authenticated
  using (teacher_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy "teacher logs own usage" on public.ai_usage_events for insert to authenticated
  with check (teacher_id = auth.uid());
