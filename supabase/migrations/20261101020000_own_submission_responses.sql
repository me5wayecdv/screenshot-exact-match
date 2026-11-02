-- Pre-release history view fix: the student's OWN response text is not
-- secret from the student; only grading (scores, feedback) stays hidden
-- until release under the policy "student reads own draft or released
-- answers". That row hiding made the submitted-review view render
-- "بدون إجابة" for answered questions. This function returns ONLY the
-- response text (never scores or feedback) for the caller's own
-- submission, in any status.
create or replace function public.own_submission_responses(_submission uuid)
returns table(question_id uuid, response text)
language sql stable security definer set search_path = public as $$
  select a.question_id, a.response
  from public.answers a
  join public.submissions s on s.id = a.submission_id
  where a.submission_id = _submission
    and s.student_id = auth.uid()
$$;
revoke all on function public.own_submission_responses(uuid) from public, anon;
grant execute on function public.own_submission_responses(uuid) to authenticated;
