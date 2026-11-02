-- Audience classification by COVERAGE, not by "any assignment row exists".
--
-- Live bug (2026-11-03): publish classified the audience as 'explicit'
-- whenever at least one assignment row existed, while the app created those
-- rows itself. A first publish with one linked student therefore became
-- audience_mode='explicit' — and an explicit audience is never widened, so
-- the next student who joined the teacher never received the exam. The
-- publish toast also reported "0 students" from a stale pre-publish count.
--
-- New rule, identical to src/lib/audience.ts (the app decides and writes the
-- marker; this function keeps the database consistent when it publishes):
--   no linked student at all                     -> refuse (nobody could see it)
--   no selection / selection covers every linked -> 'auto_all' (+ assign all)
--   a strict subset of the linked students       -> 'explicit' (never widened)
--
-- Also relaxes nothing else: same transition table, same question checks,
-- same submissions guard. Applying is idempotent.

create or replace function public.set_assessment_status(_a uuid, _status public.assessment_status)
returns void language plpgsql security definer set search_path = public as $$
declare
  cur public.assessment_status;
  n int;
  bad int;
  am text;
  linked int;
  assigned int;
begin
  select status into cur from public.assessments where id=_a and teacher_id=auth.uid();
  if cur is null then raise exception 'not_found'; end if;
  if not ((cur='draft' and _status='published') or (cur='published' and _status in ('closed','draft'))
       or (cur='closed' and _status in ('published','archived')) or (cur='archived' and _status='closed')) then
    raise exception 'invalid_transition';
  end if;
  if _status='draft' and exists(select 1 from public.submissions where assessment_id=_a) then
    raise exception 'has_submissions';
  end if;

  if _status='published' then
    select count(*) into n from public.questions where assessment_id=_a;
    if n=0 then raise exception 'no_questions'; end if;
    select count(*) into bad from public.questions q left join public.question_keys k on k.question_id=q.id
      where q.assessment_id=_a and (length(trim(q.prompt))=0
        or (q.type in ('mcq','true_false','short_answer') and coalesce(trim(k.correct_answer),'')='')
        or (q.type='written' and coalesce(trim(k.rubric),'')='')
        or (q.type='mcq' and jsonb_array_length(q.options) < 2));
    if bad>0 then raise exception 'incomplete_questions'; end if;

    select count(*) into linked from public.teacher_students where teacher_id = auth.uid();
    if linked = 0 then raise exception 'no_students'; end if;

    select count(*) into assigned
    from public.assessment_assignments aa
    join public.teacher_students ts
      on ts.student_id = aa.student_id and ts.teacher_id = auth.uid()
    where aa.assessment_id = _a;

    -- Coverage decides: nothing selected, or everyone linked is selected.
    if assigned = 0 or assigned >= linked then
      am := 'auto_all';
      insert into public.assessment_assignments (assessment_id, student_id)
      select _a, ts.student_id from public.teacher_students ts
      where ts.teacher_id = auth.uid()
      on conflict do nothing;
    else
      am := 'explicit';
    end if;
  end if;

  update public.assessments set status=_status, updated_at=now(),
    audience_mode = coalesce(am, audience_mode) where id=_a;
  insert into public.audit_log(actor_id, action, entity_id, details)
    values (auth.uid(),'assessment_status',_a,
            jsonb_build_object('from',cur,'to',_status,'audience',coalesce(am, null)));
end $$;

-- OPTIONAL, manual, NOT part of the automatic path: repair rows that the bug
-- mislabelled. It only touches assessments whose assignment rows already
-- cover every student currently linked to that teacher, which is exactly the
-- "everyone" case; a genuine subset never matches. Run it by hand, once,
-- after checking the row counts:
--
--   select a.id, a.title, a.status, a.audience_mode,
--          (select count(*) from public.assessment_assignments aa where aa.assessment_id=a.id) as assigned,
--          (select count(*) from public.teacher_students ts where ts.teacher_id=a.teacher_id) as linked
--   from public.assessments a order by a.created_at desc;
--
--   update public.assessments a set audience_mode='auto_all'
--   where a.audience_mode='explicit'
--     and a.status in ('published','closed')
--     and (select count(*) from public.assessment_assignments aa where aa.assessment_id=a.id)
--         >= (select count(*) from public.teacher_students ts where ts.teacher_id=a.teacher_id)
--     and (select count(*) from public.teacher_students ts where ts.teacher_id=a.teacher_id) > 0;
