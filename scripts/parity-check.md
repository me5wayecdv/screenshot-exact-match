# Parity checklist: D1 deployment vs live Supabase

Run this AFTER D1 is provisioned and the Cloudflare Worker is deployed,
BEFORE any cutover. Nothing in this checklist writes to either live
system: the script only counts rows, and every behavioural step below
uses throwaway test accounts (the same style as the live verifications
before it) on data that may be deleted afterwards.

## 0. Prerequisites (human steps, not code)

- [ ] D1 database provisioned; the real `database_id` is in
      `wrangler.jsonc` (the placeholder must be gone).
- [ ] Worker deployed from this copy with `DB`, `PAPERS_BUCKET`,
      `SOURCES_BUCKET` (and `SEB` if Cloudflare Email Service is the email path).
- [ ] Email provider configured (see `docs/cutover-readiness.md`):
      Resend secret + `EMAIL_FROM`, or Email Service SPF/DKIM + `SEB`.
- [ ] Operator shell has `wrangler` logged in and, for the Supabase
      column, `SUPABASE_URL` + `SUPABASE_KEY` exported (read-only
      key the operator provides; values are never written into any
      file, and this script never prints them).

## 1. Row counts (script)

```sh
# Print the commands without running them:
node scripts/parity-check.mjs --dry-run

# Compare live D1 (--remote) against live Supabase:
node scripts/parity-check.mjs

# A subset, e.g. only the group-exam tables:
node scripts/parity-check.mjs --tables teacher_groups,group_members,group_exams
```

Expected: every comparable table `MATCH`. `MANUAL` rows (Supabase auth
tables, D1-only tables) and `UNAVAILABLE` rows (e.g. an anon key blocked
by RLS) are NOT a pass — resolve each one by hand:

- [ ] `auth_users` vs Supabase Auth users count (dashboard).
- [ ] `auth_sessions` vs Supabase Auth sessions (dashboard).
- [ ] `question_keys`: do NOT count via PostgREST (answer keys need a
      privileged read). Admin-only dashboard check that the count is
      plausible, and that no student path can read the table (already
      asserted by tests; re-verify on the deployed Worker, not here).
- [ ] Any `DIFF` row: explain it before proceeding. A diff in
      `login_attempts` / `password_reset_tokens` is expected (D1-only
      tables) and is not a cutover blocker; a diff in `profiles`,
      `assessments`, `submissions`, `answers`, or `group_members` is.

## 2. Group-exam take: member vs non-member vs stale assignment

Use one teacher + two students + one group + one published exam, all
test accounts, on the D1 deployment:

- [ ] Teacher assigns the exam to the group.
- [ ] Approved member sees the exam inside the group card and the take
      page loads (Question 1, no "not assigned" block).
- [ ] A linked-but-non-member student sees no group, no group exam,
      and the direct take URL is blocked ("isn't assigned to you").
- [ ] Stale assignment: a student who was a member when assigned but
      is no longer a member (membership removed/expired) must be
      BLOCKED at the take gate — the old assignment row alone must not
      admit them. (This is the stale-row block in `d1-take-gate.ts`.)
- [ ] A student who joins the group and is approved afterwards sees
      the group exam automatically, with no re-assignment.

## 3. Publish loop

- [ ] Teacher creates an exam, publishes it, and the publish toast
      counts students exactly once (no duplicate-key error, no raw
      database text).
- [ ] A student who joins after publishing and is approved sees the
      exam (late-joiner gap closed).

## 4. Grading loop

- [ ] Student submits answers; teacher grades, including a
      handwritten-style answer if the pilot uses it; teacher releases.
- [ ] Student sees the released score; a grade-review request round
      trip works (request → teacher decision → student sees result).
- [ ] The release gate still requires a teacher score on EVERY
      question, including auto-scored MCQ (by design, not a bug).

## 5. Handwritten round-trip

- [ ] Teacher uploads one photo per question; the paper persists to
      the private R2 `PAPERS_BUCKET` before grading is allowed
      (saving is blocked if the upload failed).
- [ ] OCR text is shown for teacher review/correction, then the AI
      grade is final on save; a wrong record can be deleted and
      re-graded.
- [ ] No student can fetch another student's paper (Worker-mediated
      R2 only, key = `{teacher}/{uuid}/{name}`).

## 6. Quota under concurrency

- [ ] Fire several AI requests in parallel for one teacher (test
      account) up to and past the quota: the quota must fail CLOSED
      (requests over quota are refused, never silently free), and the
      usage counter must match the number of actually-served requests
      — no double-counting, no lost counts from the race.

## 7. Sign-off

| Check                                           | Result            | Notes |
| ----------------------------------------------- | ----------------- | ----- |
| Row counts (script)                             | MATCH / explained |       |
| Group-exam take (member / non-member / stale)   | pass              |       |
| Publish loop                                    | pass              |       |
| Grading loop                                    | pass              |       |
| Handwritten round-trip                          | pass              |       |
| Quota under concurrency                         | pass              |       |
| Email: reset + set-password invitation received | pass              |       |

Do not cut over with an unexplained DIFF, a stale-assignment bypass,
or an unreceived auth email. Those three are hard blockers.
