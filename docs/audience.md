# Who can see an exam (audience)

A student only ever receives an assessment that is **published** *and* **assigned**
to them — the RLS policy `student reads assigned` is built on `assigned_published(id)`,
which requires a row in `assessment_assignments` and `status in ('published','closed')`.
Everything else (draft, published-but-unassigned, unlinked student) is invisible,
which is exactly the "the teacher made an exam and the student can't find it"
report.

## The rule at publish time

`src/lib/audience.ts` (`planPublishAudience`, unit-tested) decides before the
status flips, and the builder (`src/routes/_authenticated/assessments/$id.tsx`)
enforces it:

| State | Publish result |
| ----- | -------------- |
| Teacher has **no linked students** | **Blocked** with an explanatory message. Publishing to nobody is not a reachable state. |
| No student selected | **Everyone**: assign every linked student, mark `audience_mode = 'auto_all'` so later joiners are included too. |
| A strict subset selected | Keep exactly that subset, mark `audience_mode = 'explicit'`, and warn how many students will *not* see it. |

After publishing, the teacher sees "Published — N student(s) can see it now."

## If the database is behind

The app does not depend on the migration being applied:

- the missing assignment rows are inserted by the builder (allowed by the
  existing "teacher manages assignments" policy) right after the transition;
- if the `audience_mode` column does not exist, that one update is ignored and
  everything else still works;
- a student who joined **after** publish shows up in the builder as
  "new students are not assigned" with a one-click **Add the new students**
  button (`syncAudience`).

The database-side twin of this rule is
`supabase/migrations/20261101010000_audience_auto_all.sql` (publish-time
auto-assignment + `join_teacher` back-filling open `auto_all` exams). Applying
it is still the right end state; the app floor above means an unapplied
migration degrades to "one extra click", never to "invisible exam".

## Student-side empty state

`/dashboard` distinguishes the two possible reasons an exam list is empty by
counting the student's `teacher_students` links:

- **0 links** → "you are not linked to a teacher yet: ask for the join code".
- **1+ links** → "linked to N teacher(s), but nothing is published *and*
  assigned to you yet".

A failed read is a separate, visible error — never an empty list.
