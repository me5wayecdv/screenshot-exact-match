# Who can see an exam (audience)

A student only ever receives an assessment that is **published** _and_ **assigned**
to them — the RLS policy `student reads assigned` is built on `assigned_published(id)`,
which requires a row in `assessment_assignments` and `status in ('published','closed')`.
Everything else (draft, published-but-unassigned, unlinked student) is invisible,
which is exactly the "the teacher made an exam and the student can't find it"
report.

## The rule at publish time

`src/lib/audience.ts` (`planPublishAudience`, unit-tested) derives the audience
from the **rows that exist**, never from `assessments.audience_mode` — that
column defaults to `'explicit'`, and trusting the default was a real bug
(2026-11-03): a first publish with one linked student was classified
`explicit`, so students who joined later were never assigned, and the toast
reported "0 students".

**"Linked" now means approved** (`teacher_students.status = 'approved'`,
2026-11-03). A student who typed the code is a _request_ until the teacher
approves it; pending requests are never counted, never assigned, and never in
the roster. See `docs/enrollment.md`.

| Coverage at publish                   | Audience   | Effect                                                  |
| ------------------------------------- | ---------- | ------------------------------------------------------- |
| No linked students                    | —          | **Blocked** ("nobody could see it").                    |
| Nothing selected                      | `auto_all` | Every linked student assigned; later joiners included.  |
| Selection covers every linked student | `auto_all` | Same — selecting everyone _is_ "everyone".              |
| A strict subset selected              | `explicit` | Exactly that subset; never widened (teacher is warned). |

The marker is **written** from that decision, and the success toast reports a
number read back from `assessment_assignments` after the write — not from the
pre-publish selection.

For an already-published exam, the builder shows, when some linked students
are unassigned:

- audience `auto_all` → "**Add the new students**" (safe top-up);
- audience `explicit` → a note plus "**Audience: all my students**", because a
  subset that covered everyone at publish time cannot be told apart from
  "everyone" once somebody new joins. Nothing is widened without that click.

## If the database is behind

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
`supabase/migrations/20261103090000_audience_by_coverage.sql`: publish
classifies by **coverage** (not by "any row exists"), refuses to publish with
no linked students, and `join_teacher` keeps back-filling open `auto_all`
exams (from `20261101010000_audience_auto_all.sql`). The migration also
carries a commented, opt-in repair query for rows the old logic mislabelled —
it only matches assessments whose assignments already cover every linked
student.

The app does not depend on either migration: it writes the assignment rows and
the marker itself, so an unapplied migration degrades to "one extra click",
never to an invisible exam.

## Student-side empty state

`/dashboard` distinguishes the two possible reasons an exam list is empty by
counting the student's `teacher_students` links:

- **0 links** → "you are not linked to a teacher yet: ask for the join code".
- **1+ links** → "linked to N teacher(s), but nothing is published _and_
  assigned to you yet".

A failed read is a separate, visible error — never an empty list.
