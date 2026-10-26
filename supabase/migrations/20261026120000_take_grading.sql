-- Qemmini: take + grading loop over the EXISTING answers table.
--
-- The take page (src/routes/_authenticated/assessments.take.$id.tsx) inserts
-- a submissions row and one answers row per question; the grading page
-- (src/routes/_authenticated/grading.tsx) auto-grades objective answers,
-- lets the teacher set final_score + feedback, and releases the submission.
-- No new table is created: answers already exist in the base migration
-- (response, max_marks, auto_score, final_score, feedback, review_status).
--
-- The base migration granted only SELECT on submissions and answers to
-- authenticated, so the grants/policies below are REQUIRED for the direct
-- client-side flow. Existing policies are untouched (teacher reads answers,
-- student reads released answers, teacher reads submissions, student reads
-- own submission all still apply).
--
-- Apply AFTER the base migration, BEFORE the segmentation migration
-- (20261026130000). Apply via the Supabase SQL editor or CLI; it cannot be
-- applied to the user's Supabase project from the repo alone.

-- Submissions: the take page inserts its own row (awaiting_review) and the
-- grading page releases it.
grant insert, update on public.submissions to authenticated;
create policy "student creates own submission" on public.submissions for insert to authenticated
  with check (
    student_id = auth.uid()
    and status = 'awaiting_review'
    and exists (
      select 1 from public.assessments a
      join public.assessment_assignments x on x.assessment_id = a.id
      where a.id = assessment_id and a.status = 'published' and x.student_id = auth.uid()
    )
  );
create policy "teacher updates own submissions" on public.submissions for update to authenticated
  using (public.owns_assessment(assessment_id))
  with check (public.owns_assessment(assessment_id));

-- Answers: student writes own answers; teacher writes final scores.
grant select, insert, update on public.answers to authenticated;
create policy "student reads own answers" on public.answers for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id and s.student_id = auth.uid()));
create policy "student inserts own answers" on public.answers for insert to authenticated
  with check (exists (
    select 1 from public.submissions s
    join public.assessments a on a.id = s.assessment_id
    join public.assessment_assignments x on x.assessment_id = s.assessment_id and x.student_id = s.student_id
    where s.id = submission_id and s.student_id = auth.uid() and a.status = 'published' and s.status <> 'released'
  ));
create policy "student updates own unreleased answers" on public.answers for update to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id and s.student_id = auth.uid() and s.status <> 'released'))
  with check (exists (select 1 from public.submissions s where s.id = submission_id and s.student_id = auth.uid() and s.status <> 'released'));
create policy "teacher updates answers" on public.answers for update to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id and public.owns_assessment(s.assessment_id)))
  with check (exists (select 1 from public.submissions s where s.id = submission_id and public.owns_assessment(s.assessment_id)));
