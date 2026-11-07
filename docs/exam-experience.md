# Exam experience (§6)

Server-controlled exam timer, autosave + resume, availability windows,
multiple attempts, and session-interruption events.

## Lifecycle

- A student opening a published, assigned assessment starts an attempt
  via `start_attempt` (auto-start on page load). The function enforces,
  server-side: assignment, published status, `starts_at` / `due_at`
  window, and `max_attempts`. It resumes an existing `in_progress`
  attempt instead of creating a second one (plus a partial unique index
  guarantees at most one draft per student + assessment).
- While answering, the take page autosaves (debounced ~1.5s) via
  `save_draft`, which upserts answers into the draft. `max_marks` is
  always taken from the question, never from the client.
- `submit_attempt` flips the draft to `awaiting_review`. Grading,
  release, reports, analytics and the tutor all read only
  awaiting_review / approved / released rows, so drafts never leak
  anywhere else. Each submitted attempt is graded and released
  independently; the report page counts each student once, on their
  latest submitted attempt (see `latestSubmittedPerStudent`).

## Timer and windows (the decisions that matter)

- `expires_at` is computed **server-side** at start (`started_at` +
  `duration_minutes`). The client countdown shows the earlier of
  `expires_at` and `due_at`, and auto-submits at zero.
- `save_draft` refuses edits after expiry or after `due_at`, but
  `submit_attempt` stays allowed afterwards: edits are already frozen
  by then, so rejecting the submit would only destroy frozen work on a
  slow network.
- `due_at` blocks **new** starts but never retro-cancels a started
  attempt. A teacher who wants a hard stop should set a duration.
- There is no server cron: an expired attempt whose student never
  returns stays `in_progress` (visible nowhere except the take page)
  until the student returns and submits the frozen answers.
- The take page does not live-refresh the window: a student waiting
  for `starts_at` needs a manual refresh when the window opens.

## Session interruption

Resuming an `in_progress` draft flushes the previous session's
buffered integrity events into that draft and records one
`session_interrupted` event (a distinct `integrity_events` type).
The recorder's `flushEvents` is repeat-safe: it flushes on resume, on
every autosave, and at submit.

## Teacher settings

The assessment builder exposes `starts_at`, `duration_minutes`
(empty = untimed) and `max_attempts` (default 1). `max_attempts = 1`
preserves the old single-submission behaviour exactly.

## Known follow-ups

- Analytics averages **all** released attempts per student (a
  performance-over-time view), while the report counts only the
  latest. This is deliberate for now; unify only if teachers find it
  confusing.
- The old direct client-side submission insert is retired; the
  take/grading INSERT policy (`status = 'awaiting_review'`) remains
  as a backstop but is no longer on the take-page path.

## Pilot checks (add to the Cloudflare smoke tests)

1. Timed exam: timer counts down from the server expiry, auto-submits
   at zero, and answers after expiry cannot change.
2. Reload mid-exam: answers + question order + timer survive, and one
   `session_interrupted` event appears for the attempt.
3. Window: before `starts_at` the page refuses; after `due_at` no new
   attempt starts, but a started attempt still submits.
4. Two attempts with `max_attempts = 2`: second attempt starts after
   the first submits, report counts the student once (latest attempt).
