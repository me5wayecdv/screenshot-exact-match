# Institutional features (Phase 7)

## School-wide read sharing

Teachers in the same school (`school_teachers`) can now READ each
other's assessments, questions, submissions, answers, classes, and
class members — via the `same_school()` helper and colleague SELECT
policies in migration `20261027050000_phase7_institutional.sql`.

What colleagues can do: open a colleague's report from the school
workspace (assessments link to their report pages), see stats,
per-question breakdowns, integrity summaries, and export CSVs.
Colleagues also see student names, but only for students whose work
they can already read (separate profile policy).

What colleagues CANNOT do (deliberate, unchanged):
- Read `question_keys` — no colleague policy exists on that table.
- Grade, release, edit, or change status — `review_answer` and
  `release_submission` enforce `owns_assessment()`.
- Send WhatsApp parent reports — the report page hides that section
  for non-owners.
- Tutors are not school members, so tutor assessments stay private.

Discovery: the school workspace (`/school`) lists the school's
assessments with links to their reports; the list page
(`/assessments`) still shows only the teacher's own assessments.

## Grade-review requests

New table `grade_review_requests` + page `/reviews` (students,
school teachers, tutors):
- A student picks one of their RELEASED submissions, optionally one
  of its questions, and writes a reason. The insert policy recomputes
  ownership (released submission, the assessment's real owner, the
  question belonging to that assessment) — client input is not
  trusted.
- A teacher lists requests for their own assessments and resolves
  them through the SECURITY DEFINER function `resolve_review_request`
  — there is deliberately NO direct UPDATE policy, so resolution can
  change only status, response, and resolved_at.

## LMS export (report page)

Two CSV downloads, both fetched through RLS:
- Questions CSV: prompt, type, options, objective, marks, difficulty
  — never answer keys.
- Grades CSV: student, assessment, score, total, percentage, status.
Both are BOM-prefixed RFC 4180, so Excel opens Arabic correctly.

## Explicitly NOT built (with reasons)

- **SSO for schools**: Supabase SAML SSO requires a Pro plan; this
  project is on the Free plan. OAuth (Google etc.) exists in the
  stack but per-school SSO configuration is unproven and cannot be
  completed on Free. Revisit after a plan upgrade.
- **Email invites / CSV import of NEW students**: creating auth
  users requires the Supabase Admin API (service_role key), which
  this codebase deliberately never uses from the app. Students join
  today via self-signup + class/school join codes. A service-role
  backend (or Supabase Auth admin via a trusted server function with
  a stored service key) is a separate security decision, not a UI
  addition.
- **Google Classroom / Teams / Moodle**: listed as future work in the
  original list; no integration is built.
- **Exam experience (§6 of the list — timer, autosave, multiple
  attempts)**: not part of this phase. These touch the take/submit
  core (including the single-submission unique constraint) and need
  their own phase with end-to-end testing; they were not rushed into
  the institutional phase. See the plan file's remaining items.
