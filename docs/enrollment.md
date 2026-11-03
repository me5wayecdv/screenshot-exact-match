# Enrollment: a join code is a request, not a membership

A code proves a student has the code. It does not prove the teacher knows them.
Every link therefore starts **pending**, and only a teacher decision makes it
**approved**.

## The states

| `teacher_students.status` | Means              | Consequence                                                                                                 |
| ------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `pending`                 | The student asked. | No exam visible, no assignment row, not in the roster counts, teacher sees the name under **طلبات انضمام**. |
| `approved`                | Teacher accepted.  | Full student experience: assigned exams, grading, reports.                                                  |
| `rejected`                | Teacher declined.  | Nothing assigned (except exams already answered); the student may ask again.                                |

Existing rows were grandfathered as `approved` by the column default, so the
deploy changed nothing for links that already worked.

## Why batch approval, not only one-by-one

A teacher does not know every name in advance — that was the reason for this
change. So the request list shows the names and offers:

- **قبول / رفض** per student, and
- **قبول كل الطلبات** — one click for "this is my whole class this term".

Approving stays a real decision: nothing joins without the teacher seeing the
name first, and the name is required before a request can be sent
(`join_teacher` raises `name_required`; the student home asks for it and saves
it to `profiles.full_name`).

## Where the rule lives

- `supabase/migrations/20261103180000_enrollment_approval.sql` — the column,
  `join_teacher` (pending only), `decide_enrollment`, `approve_all_enrollments`,
  `my_student_roster`, `my_pending_enrollments`, `is_approved_student`, and the
  redefinition of `set_assessment_status` / `teacher_dashboard_summary` /
  `is_teacher_of` / the teacher-profile policy so all of them mean _approved_.
- `src/lib/enrollment.ts` — the same rule as pure functions (`splitRoster`,
  `approvedIds`, `pendingCount`), unit-tested in
  `src/test/enrollment.test.ts`, so the UI cannot drift from the database.
- Students see **"مستني موافقة المعلم"** with the teacher's name, never an empty
  exam list that looks like a bug.

## Deploy order

**Apply the migration before deploying the app.** The new client calls
`my_student_roster` / `my_pending_enrollments`; on a database without them the
students page fails rather than showing the old behaviour.

## Not in this change

- Tutor lesson enrollment (`enroll_lesson`) keeps its own flow.
- Removing an approved student still deletes the link outright (unchanged).
- No notification (email/WhatsApp) is sent when a request arrives — pending
  requests surface on the teacher's students page.
