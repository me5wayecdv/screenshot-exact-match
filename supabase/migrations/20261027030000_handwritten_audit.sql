-- Phase 1 (grade history): audit trail for handwritten grades.
--
-- Handwritten grade rows are written client-side, so a plain trigger could
-- not insert into audit_log (authenticated users hold only a SELECT grant
-- there). The trigger function is SECURITY DEFINER, following the same
-- pattern as the other audit-writing functions (review_answer, release).
-- The audit_log SELECT policy ("actor reads own audit") already covers
-- reading these rows: a teacher sees their own handwritten-grade history
-- on the /audit page. No student name is stored in the audit details —
-- only scores and ids.
create or replace function public.log_handwritten_grade()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.audit_log(actor_id, action, entity_id, details)
    values (auth.uid(), 'handwritten_grade_deleted', old.id,
      jsonb_build_object(
        'final_score', old.final_score,
        'max_marks', old.max_marks,
        'assessment_id', old.assessment_id));
    return old;
  end if;
  insert into public.audit_log(actor_id, action, entity_id, details)
  values (auth.uid(), 'handwritten_grade', new.id,
    jsonb_build_object(
      'final_score', new.final_score,
      'max_marks', new.max_marks,
      'assessment_id', new.assessment_id,
      'question_id', new.question_id));
  return new;
end $$;

drop trigger if exists handwritten_grades_audit on public.handwritten_grades;
create trigger handwritten_grades_audit
  after insert or delete on public.handwritten_grades
  for each row execute function public.log_handwritten_grade();
