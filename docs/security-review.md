# Security review (list §9) — verified against the migrations on main

This is the documented RLS + function review the feature list requires before
launch. It was checked against the migration files, not assumed from the UI:
base `drizzle/migrations/0000_migration.sql`, then
`20261026120000_take_grading.sql`, `20261026130000_segmentation.sql`,
`20261026140000_usp_features.sql`, `20261027010000_handwritten_grades.sql`,
`20261027020000_handwritten_storage.sql`, and
`20261027030000_handwritten_audit.sql`.

## What holds

| List requirement | Mechanism |
| ---------------- | --------- |
| Students cannot read other students' answers | `answers`: teacher reads via `owns_assessment`; student reads only own rows **and** only when the submission is `released`. No other SELECT policy exists. |
| No access to answer keys or unreleased results | `question_keys`: teacher-only policy via `owns_assessment`; there is no student policy at all, so students cannot SELECT keys. A student's own submission row is visible before release, but its `final_score` stays NULL until `release_submission` sets it. |
| No self-promotion to teacher | `profiles` has **no role column** (id, full_name, join_code, created_at). Roles live in `user_roles`, where `authenticated` holds only a SELECT grant and only SELECT policies exist — there is no INSERT/UPDATE path for a user to change their own role. Roles are set by the `handle_new_user` trigger at signup and otherwise only via `service_role`. |
| Teacher ownership everywhere it matters | `owns_assessment(assessment_id)` gates teacher policies on assessments, assignments, questions, keys, submissions, and answers. The segmentation migration replaced the legacy `has_role('teacher')` checks with `school_teacher`/`tutor` variants. |
| Secrets stay server-side | AI keys, WhatsApp tokens, and the service-role key are read from server env only (never `VITE_`-prefixed, never committed). `.env` is gitignored. The only keys ever committed belong to the abandoned Lovable-managed project — never reuse them. |
| Grade history is append-only | `audit_log` grants `authenticated` SELECT only. Writes happen inside SECURITY DEFINER functions (`review_answer` with old/new/AI scores, `release`, `assessment_status`, `ai_suggestion`) and, since Phase 1, a SECURITY DEFINER trigger on `handwritten_grades` (insert + delete). Teachers read their own rows on the `/audit` page. |

## Design note (not a vulnerability)

A user's initial role comes from signup metadata (`raw_user_meta_data.role`
in `handle_new_user`): anyone can register as a teacher. That is the
current open-registration model, not an escalation of an existing account.
If teachers must be invite-only, that is a product decision (list §7),
not a patch to these policies.

## Verify it live (read-only SQL, run in the Supabase SQL Editor)

```sql
-- Every policy on the sensitive tables (look for unexpected INSERT/UPDATE
-- policies for authenticated, especially on user_roles).
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('user_roles', 'profiles', 'answers', 'question_keys',
                    'submissions', 'audit_log')
order by tablename, policyname;

-- profiles must have no role column.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles';
```

## Residual items

- Live RLS verification with real student/teacher sessions (not just policy
  reading) is still owed — it needs the deployed app, see
  `docs/cloudflare-deploy.md` pilot smoke tests.
- The `service_role` key must never ship in client code or a `VITE_` variable.
- Advanced proctoring (webcam/keylogging) is deliberately out of scope:
  the list defers it to a separate privacy/law study, and this codebase
  records only neutral integrity signals (tab switches, timing, order).
