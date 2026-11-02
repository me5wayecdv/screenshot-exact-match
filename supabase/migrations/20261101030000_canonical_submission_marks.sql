-- Reconcile grading RPCs with the canonical question set.
--
-- Before 20261030230000_harden_signup_and_exam_rls.sql, the student answer
-- INSERT policy did not require question_id to belong to the submission's
-- assessment and accepted client-supplied score/max_marks fields. Those
-- direct-write paths are now closed, but legacy rows may remain. Never use
-- answers.max_marks or sum every answer row as the authority for a released
-- result: derive marks from questions belonging to the submission instead.
-- This migration preserves existing rows and does not rewrite user data.

create or replace function public.review_answer(
  _answer uuid, _score numeric, _feedback text, _decision text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  an public.answers%rowtype;
  s public.submissions%rowtype;
  v_submission uuid;
  v_max_marks numeric;
begin
  if auth.uid() is null then raise exception 'not_found'; end if;
  select submission_id into v_submission from public.answers where id = _answer;
  if v_submission is null then raise exception 'not_found'; end if;
  select * into s from public.submissions where id = v_submission for update;
  select * into an from public.answers where id = _answer for update;
  if s.id is null or an.id is null or an.submission_id <> s.id
    or not public.owns_assessment(s.assessment_id) then raise exception 'not_found'; end if;
  if s.status not in ('awaiting_review', 'approved') then raise exception 'not_ready_for_review'; end if;
  if _decision is null or _decision not in ('approve', 'reject') then raise exception 'invalid_decision'; end if;
  if length(coalesce(_feedback, '')) > 5000 then raise exception 'feedback_too_long'; end if;

  -- The referenced question must be part of this submission's assessment;
  -- max_marks on a legacy answer row is user-controlled historical data.
  select q.marks into v_max_marks
  from public.questions q
  where q.id = an.question_id and q.assessment_id = s.assessment_id;
  if v_max_marks is null then raise exception 'not_found'; end if;
  if _decision = 'approve' and (_score is null or _score < 0 or _score > v_max_marks) then
    raise exception 'score_out_of_range';
  end if;

  update public.answers set
    max_marks = v_max_marks,
    final_score = case when _decision = 'approve' then _score else null end,
    feedback = coalesce(_feedback, ''),
    review_status = case when _decision = 'approve'
      then 'approved'::public.review_status else 'rejected'::public.review_status end
  where id = _answer;
  -- Ignore legacy answer rows whose question belongs to another assessment;
  -- they are not part of this assessment's grading workflow.
  update public.submissions set status = case
    when exists (
      select 1
      from public.answers valid_answer
      join public.questions q on q.id = valid_answer.question_id
        and q.assessment_id = s.assessment_id
      where valid_answer.submission_id = s.id
        and valid_answer.final_score is null
    ) then 'awaiting_review'::public.submission_status
    else 'approved'::public.submission_status end
  where id = s.id;
  insert into public.audit_log(actor_id, action, entity_id, details)
  values (auth.uid(), 'review_answer', _answer, jsonb_build_object(
    'decision', _decision, 'score', _score, 'previous_final', an.final_score,
    'ai_score', an.ai_suggestion->'suggested_score'
  ));
end $$;

create or replace function public.release_submission(_sub uuid, _feedback text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.submissions%rowtype;
  total numeric;
  possible numeric;
begin
  if auth.uid() is null then raise exception 'not_found'; end if;
  select * into s from public.submissions where id = _sub for update;
  if s.id is null or not public.owns_assessment(s.assessment_id) then raise exception 'not_found'; end if;
  if s.status <> 'approved' then raise exception 'not_approved'; end if;
  if length(coalesce(_feedback, '')) > 5000 then raise exception 'feedback_too_long'; end if;
  if exists (
    select 1 from public.questions q
    left join public.answers an on an.question_id = q.id and an.submission_id = _sub
    where q.assessment_id = s.assessment_id
      and (an.id is null or an.final_score is null or an.final_score < 0 or an.final_score > q.marks)
  ) then raise exception 'not_fully_graded'; end if;

  -- Only questions in this assessment define the released score and maximum.
  -- Orphan/foreign-question legacy answer rows cannot inflate either value.
  select coalesce(sum(an.final_score), 0), coalesce(sum(q.marks), 0)
    into total, possible
  from public.questions q
  left join public.answers an on an.question_id = q.id and an.submission_id = _sub
  where q.assessment_id = s.assessment_id;

  update public.submissions set final_score = total, total_possible = possible,
    teacher_feedback = coalesce(_feedback, ''), status = 'released', released_at = now()
  where id = _sub;
  insert into public.audit_log(actor_id, action, entity_id, details)
  values (auth.uid(), 'release', _sub, jsonb_build_object('score', total));
end $$;
