# Security review — source evidence and rollout status

**Status: PARTIALLY VERIFIED (source, CI, local PGlite, read-only hosted metadata).**
The CI workflow passed typecheck, tests, lint, and build on PR #16. A local,
data-free PGlite rehearsal applied the Drizzle baseline and all repository
migrations, then passed synthetic signup and grading-RPC checks. PGlite is not
Supabase: it does not validate hosted Auth/Storage behavior, actual RLS request
contexts, or the target project's migration runner.

A read-only Supabase check on 2026-11-02 reported Auth, DB, Storage, and REST as
healthy. It found the canonical-marks migration absent and the deployed
`review_answer` and `release_submission` definitions lacking the expected logic.
The project was not empty: counts included 38 Auth users, 32 assessments, 11
submissions, 17 answers, and 68 Storage objects. After the user confirmed a
current backup and explicitly approved production application, two
function-only migrations were applied through the Supabase migration tool:
`20261102050438_canonical_submission_marks.sql` and
`20261102050446_fix_signup_join_code_entropy.sql`. Read-only postchecks
confirmed the key function logic and unchanged counts for Auth users,
assessments, submissions, answers, and Storage objects. No staging rehearsal,
restore drill, or application deployment was performed; production behavior
still requires smoke testing.

## What holds

| List requirement                               | Mechanism                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Students cannot read unreleased results        | `answers`: teachers read via `owns_assessment`; students can read only their own `in_progress` draft (for resume) or `released` answers. The old broad own-answer SELECT policy is dropped by `20261030230000`.                                                                                                                                            |
| No access to answer keys or unreleased results | `question_keys`: teacher-only policy via `owns_assessment`; there is no student policy at all, so students cannot SELECT keys. A student's own submission row is visible before release, but its `final_score` stays NULL until `release_submission` sets it.                                                                                              |
| No self-promotion to teacher                   | `profiles` has **no role column** (id, full_name, join_code, created_at). Roles live in `user_roles`, where `authenticated` holds only a SELECT grant and only SELECT policies exist — there is no INSERT/UPDATE path for a user to change their own role. Roles are set by the `handle_new_user` trigger at signup and otherwise only via `service_role`. |
| Teacher ownership everywhere it matters        | `owns_assessment(assessment_id)` gates teacher policies on assessments, assignments, questions, keys, submissions, and answers. The segmentation migration replaced the legacy `has_role('teacher')` checks with `school_teacher`/`tutor` variants.                                                                                                        |
| Secrets stay server-side                       | AI keys, WhatsApp tokens, and the service-role key are read from server env only (never `VITE_`-prefixed, never committed). `.env` is gitignored. The only keys ever committed belong to the abandoned Lovable-managed project — never reuse them.                                                                                                         |
| Grade history is append-only                   | `audit_log` grants `authenticated` SELECT only. Writes happen inside SECURITY DEFINER functions (`review_answer` with old/new/AI scores, `release`, `assessment_status`, `ai_suggestion`) and, since Phase 1, a SECURITY DEFINER trigger on `handwritten_grades` (insert + delete). Teachers read their own rows on the `/audit` page.                     |

## Explicit scope boundary: institutions and SaaS tenancy

The school-removal migration records a product decision to keep individual
teacher/student links and tutor lessons, not school organizations. The current
schema has no `organization_id`/tenant boundary and no organization-level
membership or administration. RLS ownership is per teacher/assessment and
student link, not per SaaS institution. Do not advertise institutional
tenancy or cross-institution isolation as implemented. Billing/subscription
plans were not found in the application source during this review.

## Design note (not a vulnerability)

Teacher and tutor self-registration remains an explicit open-registration
product choice. The latest `handle_new_user` trigger treats signup metadata as
untrusted: `admin` is never accepted from `raw_user_meta_data.role` and
unrecognized roles become students. Provision administrators only through a
trusted administrative path (for example, a reviewed service-role operation),
never through public signup metadata.

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

- This source review is not a live verification. Confirm the migration history
  includes the full current sequence, then test with real student, teacher and
  administrator sessions: a student must not read pending grades, alter a
  submitted/expired answer, directly insert a submission, or call the legacy
  `submit_assessment` RPC.
- If the pre-hardening signup trigger was ever deployed, review existing
  `user_roles.role = 'admin'` rows against a trusted administrator roster.
  The migration prevents future self-assignment but intentionally does not
  demote existing administrators automatically.
- The grading UI now calls `review_answer` and `release_submission`, and the
  hardening migration revokes direct authenticated updates to scores and
  submissions. Deploy these source changes only together with the reviewed
  migration; the migration has not been applied or rehearsed here.
- Existing `ai_training_examples` rows are preserved but revoked from
  application roles. Their retention/deletion decision remains open and must
  be explicitly approved; no live rows were inspected.
- Verify AI quota enforcement for every call path in staging. Source review
  found and closed a missing quota check in lesson explanation, but no
  provider call or database quota behavior was exercised.
- No organization-level tenancy or billing/subscription module is present.
- Advanced proctoring (webcam/keylogging) is deliberately out of scope:
  the list defers it to a separate privacy/law study, and this codebase
  records only neutral integrity signals (tab switches, timing, order).
