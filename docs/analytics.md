# Analytics (Phase 4)

The `/analytics` page (teachers only: school teachers and tutors) reads
existing tables only. No migration was needed for this phase.

## Definitions (shared with the report page)

- Effective score per answer = `final_score ?? auto_score`.
- "Answered" = answer rows present; "graded" = non-null effective
  score. Question averages use graded answers only — ungraded answers
  never count as failures.
- Full credit = graded answers with effective score >= the question's
  marks.
- Released submission = `status = 'released'` AND `final_score` is not
  null AND `total_possible > 0`. Assessment and student averages use
  released submissions only.
- Objective average = graded-weighted mean of its questions'
  averages; questions with no graded answers are excluded.
- Group average: released submissions of the group's students. A
  student enrolled in two groups counts in both (classes and lessons
  overlap in practice); the page states this.

## Sections

- **Overview**: per-subject averages (mean of that subject's
  assessments' averages) and a table of all the teacher's assessments
  with released counts and averages — the cross-exam comparison.
- **Question analysis** (selected assessment): every question with
  answered/graded counts, average %, and full-credit %, sorted worst
  first; averages below 50% are highlighted.
- **By objective**: questions grouped by their exact `objective`
  text (empty objectives group under "no objective"), with the top-3
  strengths and bottom-3 weaknesses.
- **Students**: released average per student (alphabetical).
- **Groups**: for the selected assessment, average per class (school
  teachers) or per lesson (tutors), from class memberships /
  lesson enrollments.
- **Reteach + practice**: objectives below 50% are listed as reteach
  topics. "Create practice" builds a NEW unpublished draft assessment
  from the 5 most-missed questions (copies of the questions + keys,
  same pattern as the builder's question-bank copy — edits to the
  practice copy never affect the original) and opens it in the
  builder for review before publishing.
- **Export**: per-question and per-student CSV downloads (BOM-prefixed
  RFC 4180, so Excel opens Arabic correctly) and a print button
  (browser print dialog can save the page as PDF).

## Known limits

- School-wide visibility is still owner-only: a teacher sees only
  their own assessments (same RLS boundary as the report page).
- Objective grouping is by exact text — "الخلية" and "الخلية " (with
  a trailing space) are different groups; teachers should keep
  objective wording consistent.
- Practice drafts copy questions only (no assignments, no
  submissions); the teacher assigns students from the builder.
