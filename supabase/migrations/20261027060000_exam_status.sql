-- §6 exam experience, part 1 of 2 — MUST run alone, before part 2.
-- ALTER TYPE ... ADD VALUE cannot run inside a multi-statement
-- transaction, so this statement lives in its own file/run.
-- 'in_progress' marks a draft attempt: created at attempt start, flipped
-- to 'awaiting_review' at submit. Grading, reports and analytics only
-- ever read awaiting_review/approved/released rows, so drafts never leak
-- into grading or reports.
alter type public.submission_status add value if not exists 'in_progress';
