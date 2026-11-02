# Backend security and scale rollout

**Current state: NOT applied to Supabase.** The migration at `supabase/migrations/20261031120000_backend_security_and_scale.sql` is a source change only. Do not run it against a live database as part of this audit; an operator must first verify the migration history and explicitly approve any data-affecting rollout.

## Review before any rollout

1. Confirm the target database's migration history and actual schema before any rollout. To review/apply `20261031120000_backend_security_and_scale.sql`, its prerequisite history must include every migration through `20261031044544_add_teacher_assistant_usage_kind.sql`. The current app also depends on every later migration present in the checked-out release; applying only the older prerequisite list does not make the current application/database pair compatible. The school-removal migration drops school tables/functions, so the security/scale migration must not depend on them.
2. Take and verify a recoverable backup. The migration tightens profile/RPC privileges, replaces attempt and review RPC bodies, creates quota/WhatsApp claim tables, adds indexes, hides teacher join codes behind a self-only RPC, and rotates legacy join codes to the required 12-character uppercase-hex format. Code rotation invalidates previously shared short codes.
3. `ai_training_examples` rows are **preserved**, not deleted. The migration removes authenticated access and future inserts. Existing rows remain in the database pending a separately approved retention/disposition decision; this repository change does not inspect or remove live data.
4. Deploy the matching application code in the same approved release. WhatsApp sends use the service-role client to claim/finalize sends; never expose that key to browser code.
5. The repository now has `bun run db:rehearse`, which applies the complete checked-out SQL sequence in a disposable in-memory PGlite database and runs synthetic signup/grading invariants. This is a useful local syntax/logic rehearsal, not a Supabase emulator or substitute for staging. Supabase Branching is unavailable on the connected project plan, so no hosted rehearsal has been done. Production migration history was read-only inspected and is missing `20261101030000_canonical_submission_marks.sql`; the follow-up `20261101040000_fix_signup_join_code_entropy.sql` is also unapplied. Do not run either against the primary project without a separate staging verification and explicit approval.

## Future manual application

Only after the review and explicit approval above: open Supabase Dashboard → **SQL Editor** → **New query**, inspect the complete migration and target state, then apply it once. If the editor reports an error, stop; do not blindly rerun partial statements. Check transaction status and actual database state first. No live migration has been applied by this work.

## Verification required after an approved application

- Confirm the functions exist: `consume_ai_rate_quota`, `review_answer`, `release_submission`, `teacher_dashboard_summary`, `tutor_dashboard_summary`, `teacher_grading_page`, `teacher_analytics_question_stats`, `teacher_analytics_student_page`, `teacher_analytics_group_stats`, `teacher_analytics_overview`, `tutor_lesson_enrollment_counts`, `claim_whatsapp_send`, and `finish_whatsapp_send`.
- Confirm anonymous execution is revoked for privileged RPCs and `authenticated` can call only the user-scoped functions; `claim_whatsapp_send` and `finish_whatsapp_send` must be executable only by `service_role`.
- Confirm authenticated users cannot directly update `submissions` or answer scores/feedback, while the bounded auto-score column permission remains restricted by the unreleased-answer owner policy.
- Confirm `ai_training_examples` is inaccessible to application roles and no authenticated insert privilege remains. Existing rows are intentionally retained until an approved disposition.
- In staging, test teacher/student/tutor role access, attempt start/save/submit, grading inbox paging, quota boundaries, and consent-gated WhatsApp send behavior. Confirm duplicate calls do not create a second provider send and every send outcome has a server-written audit row.
- Verify the effects of join-code rotation with representative users; learners using old short codes will need the current code from their teacher.

The included automated tests are code-level checks only. They are not a substitute for a disposable-database migration rehearsal, staging verification, or a production load test. Do not infer a supported concurrent-user count from them.
