# Smart tutor (Phase 5)

The `/tutor` page is for students only. It ties tutoring to the
student's REAL released results — nothing else is in context.

## What it does

- **Weak objectives**: per-objective averages from the student's own
  released answers (same definitions as the analytics page), with
  objectives below 50% listed as review topics.
- **Discuss a question**: pick a question from a released assessment.
  The tutor explains step by step why the answer earned its score, or
  gives exactly one hint, using the question prompt, the options, the
  student's own answer, and the teacher's feedback. Follow-up questions
  keep the same question context.
- **Personal practice**: re-attempt a question; the tutor judges the
  new attempt (what is right, what is missing, one hint) without
  printing any key.
- **Review plan**: one generated study tip per weak objective (JSON
  array from the model, validated before display).
- **Free topics**: ask about any concept; the tutor explains it step
  by step with hints, not a ready-made answer.
- **Arabic and English**: the tutor answers in the student's UI
  language.

## The guardrail (read before changing prompts)

- The server NEVER queries `question_keys` — students cannot read that
  table under RLS, and the tutor code does not even ask for it. The
  model therefore has no key to leak.
- A question is discussable only when the student has a RELEASED
  submission for its assessment. Unreleased or ungraded work returns
  UNAUTHORIZED and never reaches the model.
- Prompts (src/lib/tutor-prompts.ts, covered by tests) add the
  behavioral rule: hints first; a direct request for the answer gets a
  hint, not the answer; a guess is never presented as the official
  answer; a fully correct attempt may be praised briefly without
  printing a key.

## What is NOT stored (honest limit)

Chat messages and practice attempts live in browser state only and
vanish on leaving the page. No migration was needed for this phase.
Consequences: no history across sessions, no spaced-repetition
tracking, no teacher view of practice attempts. A future phase could
add a `tutor_practice_attempts` table (student-owned rows, teacher
read via owns_assessment) and a `tutor_chats` table — both need a
migration and a retention decision before they are built.

## Configuration

Same server env as grading: AI_BASE_URL, AI_MODEL, AI_API_KEY. When
unset, the page shows a "not configured" warning and disables the
AI buttons; the weak-objectives and review-topic lists still work
(they need no AI).
