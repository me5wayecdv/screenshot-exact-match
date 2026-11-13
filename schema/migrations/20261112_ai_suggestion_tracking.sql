-- AI-F4 (Deep Audit Phase 2): make AI grading accuracy measurable from
-- data. ai_usage_events records only token counts today, so there is no
-- way to join a usage event back to the exam/question it graded, or to
-- compare the AI's suggested score with the teacher's final score.
-- These three nullable columns close that gap:
--   * assessment_id / question_id — which exam/question the event graded
--   * suggested_score             — the AI's suggested score (REAL), so
--     override/agreement rates are computable by joining to
--     answers.final_score on (submission, question) via the assessment.
--
-- Additive only; safe to apply on a populated DB. All three columns
-- are nullable, so existing rows stay untouched (NULL = "not recorded",
-- i.e. events logged before this change).
--
-- APPLY TO BOTH DATABASES via the D1 console BEFORE the deploy that
-- carries the AI-F4 code (logAiUsageEvent starts writing these columns
-- and persistAiSuggestion starts writing answers.ai_suggestion; the
-- INSERT fails on an unmigrated database). Order: run the PRECHECK
-- first, then this file, on staging (qemmini-db) AND live
-- (qemmini-live-db). Fresh databases do NOT need this file: the base
-- schema (schema/d1-schema.sql) already carries the columns.
--
-- No data is modified or deleted.

ALTER TABLE ai_usage_events ADD COLUMN assessment_id TEXT;

ALTER TABLE ai_usage_events ADD COLUMN question_id TEXT;

ALTER TABLE ai_usage_events ADD COLUMN suggested_score REAL;
