-- Phase 2 (generation from files/images + difficulty + question bank).
--
-- 1) questions.difficulty: per-question difficulty assigned by the
--    generator (easy/medium/hard, default medium) and editable in the
--    builder. Existing questions get 'medium' via the column default.
--    The question bank needs NO schema change: it copies existing
--    questions + keys into another assessment through the existing
--    teacher-managed RLS policies (owns_assessment), so no new grants.
--
-- 2) Storage bucket 'generation-sources' for the PLATFORM RULE (every
--    uploaded image/file must be persisted server-side): source files
--    for generation (PDF, Word, curriculum photos) are uploaded to this
--    PRIVATE bucket under {teacher_id}/{uuid}.{ext} before any text
--    extraction or OCR runs. Nothing is browser-only.
--
-- Apply AFTER supabase/migrations/20261027030000_handwritten_audit.sql.
-- No enum (ALTER TYPE) changes in this file.

alter table public.questions
  add column if not exists difficulty text not null default 'medium'
    check (difficulty in ('easy', 'medium', 'hard'));

-- Private bucket (idempotent: re-running this migration is safe).
insert into storage.buckets (id, name, public)
values ('generation-sources', 'generation-sources', false)
on conflict (id) do nothing;

-- Teachers upload only into their own folder.
create policy "teachers upload own generation sources"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'generation-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Teachers read only their own sources.
create policy "teachers read own generation sources"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generation-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Teachers delete only their own sources.
create policy "teachers delete own generation sources"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'generation-sources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admins may read all generation sources (reporting / support).
create policy "admin reads generation sources"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'generation-sources'
    and public.has_role(auth.uid(), 'admin')
  );
