-- Track teacher-assistant calls separately from student tutor usage.
-- The event table stores model/provider/token counts only, never chat text.
alter table public.ai_usage_events
  drop constraint if exists ai_usage_events_kind_check;

alter table public.ai_usage_events
  add constraint ai_usage_events_kind_check
  check (kind in ('grade', 'generate', 'ocr', 'match', 'tutor', 'assistant'));
