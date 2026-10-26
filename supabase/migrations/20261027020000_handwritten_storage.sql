-- Handwritten paper storage (supersedes the v1 "photo is not stored"
-- limit in 20261027010000_handwritten_grades.sql).
--
-- PLATFORM RULE: every image or file a user uploads must be persisted
-- server-side. For handwritten papers that means a private Supabase
-- Storage bucket, not browser-only memory:
--   - Bucket 'handwritten-papers' is PRIVATE (public = false).
--   - Objects live under {teacher_id}/{uuid}.jpg, so the folder name
--     itself enforces ownership in the storage policies below.
--   - Teachers read their own papers via time-limited signed URLs
--     (created client-side on demand); nothing is publicly linkable.
--   - handwritten_grades gains image_path so each saved grade links
--     back to its paper. Rows saved before this migration have
--     image_path NULL (no paper on file).
--
-- Apply AFTER supabase/migrations/20261027010000_handwritten_grades.sql.
-- No enum (ALTER TYPE) changes in this file.

alter table public.handwritten_grades
  add column if not exists image_path text;

-- Private bucket (idempotent: re-running this migration is safe).
insert into storage.buckets (id, name, public)
values ('handwritten-papers', 'handwritten-papers', false)
on conflict (id) do nothing;

-- Teachers upload only into their own folder.
create policy "teachers upload own handwritten papers"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'handwritten-papers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Teachers read only their own papers (signed URLs still respect RLS).
create policy "teachers read own handwritten papers"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'handwritten-papers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Teachers delete only their own papers (used when a grade row is deleted).
create policy "teachers delete own handwritten papers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'handwritten-papers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admins may read all handwritten papers (reporting / support).
create policy "admin reads handwritten papers"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'handwritten-papers'
    and public.has_role(auth.uid(), 'admin')
  );
