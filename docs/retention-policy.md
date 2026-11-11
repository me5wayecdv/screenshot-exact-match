# Data retention & deletion policy — DRAFT

> **Status: DRAFT — not approved, not enforced.** Nothing here is a
> commitment until the user approves it. Every `[DECISION NEEDED]` is
> undecided. Date: 2026-11-11.
>
> - Data controller: [DECISION NEEDED: Qemmini under O2 vs a new entity]
> - Governing law: [DECISION NEEDED]
> - Privacy contact: adhamelhansye@gmail.com — [DECISION NEEDED: keep or replace]

## 1. Scope

Applies to all personal data on the Cloudflare stack: D1 `qemmini-live-db`,
R2 buckets `qemmini-handwritten-papers` and `qemmini-generation-sources`,
and Durable Object take-session state. The live /privacy page states only
a broad principle ("kept only as long as needed") — no periods, and no
account-deletion or retention job exists yet.

## 2. Principles

- **Minors first:** students may be minors. Their papers get the
  shortest retention of any category, and are never used for AI training.
- **Teacher has the last word:** a teacher's content belongs to the
  teacher; deletion of teacher content follows §4, not §3.
- **Deletion means gone:** there are no soft deletes in the codebase.
  Deleting a row is a hard `DELETE`; deleting a paper also deletes its R2
  object. Nothing is kept in a recycle bin.
- **No silent copies:** data sent to Gemini is governed by the provider's
  terms, not this policy — see §5.

## 3. Retention by category

| Data                                                                   | Where it lives                                                                                   | Proposed retention                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student submissions + answers (incl. AI suggestions, scores, feedback) | D1 `submissions`, `answers`                                                                      | Until the end of the school year in which the result was released, then delete — [DECISION NEEDED: confirm period; alternatives: end of term / 12 months after release] |
| Handwritten papers: photos + OCR/corrected text + grades               | R2 `qemmini-handwritten-papers` (`handwritten_grades.image_path`); D1 `handwritten_grades`       | Same as submissions — [DECISION NEEDED: confirm, or shorter]                                                                                                            |
| Submission-linked records (integrity signals, grade reviews)           | D1 `integrity_events`, `grade_review_requests`                                                   | Same as its submission — [DECISION NEEDED]                                                                                                                              |
| Teacher content: exams, questions, answer keys, lessons, groups        | D1 `assessments`, `questions`, `question_keys`, `lessons`, `teacher_groups`, `group_exams`       | While the teacher account is active; on teacher deletion see §4 — [DECISION NEEDED]                                                                                     |
| Accounts + profiles (name, email, phone, parent phone)                 | D1 `auth_users`, `profiles`, `user_roles`, `teacher_profiles`                                    | While the account is active; deleted on request (§4). Dormant accounts: delete after [DECISION NEEDED: inactivity period, e.g. 24 months]                               |
| Sessions                                                               | D1 `auth_sessions` (30-day TTL, revoked on sign-out/reset)                                       | Delete expired/revoked rows after [DECISION NEEDED: e.g. 7 days]                                                                                                        |
| Security bookkeeping (login attempts, password-reset tokens)           | D1 `login_attempts`, `password_reset_tokens` (tokens: 1-hour expiry, single-use)                 | Prune used/expired rows after [DECISION NEEDED: e.g. 30 days]                                                                                                           |
| WhatsApp parent-report records                                         | D1 `whatsapp_sends`, `whatsapp_send_claims`; parent phone in `profiles`                          | [DECISION NEEDED: e.g. 90 days after sending]                                                                                                                           |
| Operational records (AI usage/quota, failed take-writes)               | D1 `ai_usage_events`, `ai_rate_limits`, `take_write_failures` (ids + reason only, never answers) | [DECISION NEEDED: e.g. 12 months for usage; 30 days for failures]                                                                                                       |
| Audit log (append-only grade/action history)                           | D1 `audit_log`                                                                                   | [DECISION NEEDED: retention vs right-to-erasure — see §4]                                                                                                               |
| AI training examples (legacy, write-frozen)                            | D1 `ai_training_examples`                                                                        | Writes are disabled until a consent/minimisation workflow exists. Existing rows: [DECISION NEEDED: delete, or keep with explicit consent]                               |
| Exam generation sources (teacher-uploaded curriculum text)             | R2 `qemmini-generation-sources`                                                                  | Same as teacher content — [DECISION NEEDED]                                                                                                                             |
| In-flight take state                                                   | TakeSession DO SQLite (flushed to D1 every 10s)                                                  | Transient only; no separate retention — rows live in D1 once flushed                                                                                                    |

## 4. Deletion — what it means in code

- **Today, deletion is hard only.** `DELETE FROM …` in D1 plus an R2
  object delete by key. There is no soft-delete column, no trash, no
  undelete. Code that deletes must delete the R2 object in the same
  operation; a DB row without its object (or vice versa) is a bug.
- **Cascade is declared, not assumed.** The schema declares
  `REFERENCES … ON DELETE CASCADE`, but D1 enforces foreign keys only
  when the `foreign_keys` pragma is on for the connection — purge code
  must delete child rows explicitly and verify, never rely on cascade.
- **No account-deletion flow exists yet.** No user can delete their own
  account from the product today, and no admin deletion function exists.
  Until it is built, deletion requests arrive by email to the privacy
  contact and are handled manually by an admin (see "Still to build").
- **Teacher account deletion is the hard case.** Deleting a teacher's
  `auth_users` row cascades (per schema) to their assessments, and from
  there to every student's submissions and answers in those exams.
  [DECISION NEEDED: cascade-delete everything, anonymise the students'
  work, or transfer the exams to another teacher?]
- **Audit log vs erasure.** `audit_log` is append-only by design and its
  rows cascade on `auth_users` deletion. [DECISION NEEDED: on erasure,
  delete the user's audit rows, or keep them with the actor anonymised?]
- **Backups keep deleted data until they rotate.** The backup script
  (`scripts/backup-d1.mjs`) exports the database; a deleted row survives
  in backups until the backup retention expires. [DECISION NEEDED:
  backup retention period, and whether erasure requests must purge
  backups too.]

## 5. Minors' data

- The product collects **no date of birth and no age** (`profiles` has
  name, email, join code, parent phone, WhatsApp consent only), so age is
  not verified anywhere. [DECISION NEEDED: consent model — parent/guardian
  consent at signup, teacher-as-guardian, or an age threshold?]
- Student answers and grades are visible only to their teacher, and a
  result reaches the student only after the teacher releases it
  (already enforced; see /privacy).
- AI grading sends only images + text to Gemini. On the free tier Google
  may use content to improve its products. [DECISION NEEDED: move to the
  paid tier before real student papers are processed.]
- No student data is sold, and no student data is used for AI training
  (`ai_training_examples` writes are frozen).

## 6. Still to build (this policy states the requirement; it builds nothing)

- [ ] A scheduled purge job (no cron exists today) that deletes expired
      rows + orphaned R2 objects and logs what it deleted.
- [ ] A self-serve account-deletion flow (request → confirm → revoke all
      sessions → delete account + R2 objects → confirmation email).
- [ ] An admin deletion path for handling emailed requests until the
      self-serve flow exists.
- [ ] Backup retention + rotation, and a restore drill (see docs/backup.md).
- [ ] Update /privacy with the final periods once the decisions below are
      made, in Arabic and English.

## 7. Decisions needed before this policy can be finalised

1. Legal entity + governing law / jurisdiction.
2. Retention period for student submissions, answers, and handwritten
   papers after the result is released.
3. Retention after account deletion (immediate vs grace period).
4. Teacher deletion: cascade, anonymise, or transfer.
5. `audit_log`: delete on erasure or keep anonymised.
6. Legacy `ai_training_examples` rows: delete or keep with consent.
7. Backup retention period, and whether erasure purges backups.
8. Minors' consent model (parent consent? age threshold?).
9. Dormant-account inactivity period.
10. Prune windows for sessions, login attempts, reset tokens, and
    operational tables.
11. Gemini tier (free vs paid) before real student papers are processed.
12. Privacy contact: keep the personal Gmail or set up a dedicated address.
