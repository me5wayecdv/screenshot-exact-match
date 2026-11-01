# Backend security and scale rollout

**This migration has not been applied to Supabase.** It is a local change at `supabase/migrations/20261031120000_backend_security_and_scale.sql` and must be reviewed and applied manually.

## Before deploying

1. Confirm the project has applied every migration through `20261031044544_add_teacher_assistant_usage_kind.sql`.
2. Take a recoverable database backup and schedule a short maintenance window. This migration tightens profile/RPC privileges, replaces attempt and review RPC bodies, creates quota/WhatsApp claim tables, adds indexes, hides teacher join codes behind a self-only RPC, and rotates legacy codes that do not match the required 12-character uppercase-hex format.
3. **Data impact:** the migration deletes every row in `public.ai_training_examples`, since the current schema has no consent/retention record that can prove those records were collected with consent.
4. Deploy the matching application code in the same release. WhatsApp automatic and manual sends now require the service-role client to claim/finalize sends; do not expose that key to browser code.

## Apply manually

1. Open the Supabase project dashboard → **SQL Editor** → **New query**.
2. Copy the complete contents of `supabase/migrations/20261031120000_backend_security_and_scale.sql` into the editor.
3. Review the destructive/data-changing items above one last time, then run the script once. Do not run it against production until a backup is available.
4. If the editor reports an error, stop and resolve it before deploying the application; do not rerun partial statements blindly. Check the editor's transaction status and database state first.

## Verify after application

- Confirm the new functions exist: `consume_ai_rate_quota`, `teacher_dashboard_summary`, `tutor_dashboard_summary`, `teacher_grading_page`, `teacher_analytics_question_stats`, `teacher_analytics_student_page`, `teacher_analytics_group_stats`, `teacher_analytics_overview`, `tutor_lesson_enrollment_counts`, `claim_whatsapp_send`, and `finish_whatsapp_send`.
- Confirm anonymous execution is revoked for privileged RPCs and `authenticated` can call only the user-scoped functions; `claim_whatsapp_send` and `finish_whatsapp_send` must be executable only by `service_role`.
- Confirm `ai_training_examples` is empty and no authenticated `INSERT` privilege remains.
- In staging, test teacher/student/tutor role access, attempt start/save/submit, grading inbox paging, quota boundaries, and consent-gated WhatsApp send behavior. Confirm duplicate calls do not create a second provider send and each send attempt has a server-written audit row.
- Re-check any distributed join codes after rotation; learners using old short codes will need the current code from their teacher.

The included automated tests are code-level checks, not a substitute for staging database verification or a production load test. Do not infer a supported concurrent-user count from them.
