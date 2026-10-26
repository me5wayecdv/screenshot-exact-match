-- Handwritten paper grading (teacher uploads a photo of a handwritten
-- answer, OCR extracts the text, the teacher corrects it, AI suggests a
-- grade, the teacher sets the final score).
--
-- Apply AFTER supabase/migrations/20261026140000_usp_features.sql.
-- No enum (ALTER TYPE) changes in this file.
--
-- DELIBERATE V1 LIMIT: the photo itself is NOT stored. Only the
-- extracted text, the teacher-corrected text, the AI suggestion, and
-- the teacher's final score/feedback are saved. Storing paper photos
-- (Supabase Storage bucket + object policies) is a follow-up, not
-- silently implied by this table.

create table public.handwritten_grades (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null,
  assessment_id uuid references public.assessments(id) on delete set null,
  question_id uuid references public.questions(id) on delete set null,
  student_name text not null default '',
  extracted_text text not null default '',
  corrected_text text not null,
  ai_suggested_score numeric,
  ai_feedback text,
  ai_model text,
  final_score numeric not null check (final_score >= 0),
  max_marks numeric not null check (max_marks > 0),
  teacher_feedback text not null default '',
  created_at timestamptz not null default now()
);
create index on public.handwritten_grades(teacher_id);
create index on public.handwritten_grades(assessment_id);
grant select, insert, update, delete on public.handwritten_grades to authenticated;
grant all on public.handwritten_grades to service_role;
alter table public.handwritten_grades enable row level security;

-- Teachers manage only their own handwritten grades. The client always
-- inserts with teacher_id = auth.uid(); the check clause enforces it.
create policy "teacher manages own handwritten grades" on public.handwritten_grades for all to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- Admins may read all handwritten grades (reporting / support).
create policy "admin reads handwritten grades" on public.handwritten_grades for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));
