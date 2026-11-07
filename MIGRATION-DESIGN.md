# Qemmini — Cloudflare-only migration: design note (Phase 1)

Status: Phase 1 only. Nothing in this copy is live, nothing has been
pushed or deployed, and the Supabase site is untouched. The routes in
this copy STILL read from Supabase (see §1) — do not deploy this copy
expecting a Cloudflare-only app. Phase 2 is where routes switch over,
one at a time, with a live-verify loop per route.

## 1. Target architecture

```
Browser (React, TanStack Start)
  -> TanStack Start server function (runs in the Worker)
       -> session check (cookie -> D1 auth_sessions, see §3)
       -> ownership / membership check IN CODE (see §2)
       -> D1 (via the Worker binding env.DB)  /  R2 (files)
       -> Gemini / Workers AI (unchanged, via Worker secrets)
```

Rules that must never be broken during Phase 2:

1. The browser NEVER talks to D1 or R2 directly. D1 has no
   authentication of its own and no row-level security; a binding is
   only reachable from Worker code, and that is the whole security
   boundary. Any route that queries D1 from client code is a bug.
2. No server function may accept a user id, teacher id, or actor id
   from the client. The acting user is always the session's user.
   (Supabase enforced this with auth.uid(); here the session is the
   equivalent, and it must be resolved server-side on every call.)
3. The Supabase client must be removed route by route, not in one
   big-bang delete. Each migrated route keeps its old behaviour and
   gets its old live-verify loop re-run against D1 before the next
   route moves.
4. The live Supabase project stays up until the Cloudflare version
   passes the full live-verify set (groups, group exams, enrollment,
   take/grade/release, handwritten, generation). Cutover is a user
   decision, not a Phase 2 default. Deleting Supabase before cutover
   verification would be unrecoverable.

## 2. How each Supabase check maps to a code check

Supabase enforced access with RLS policies + security-definer RPCs.
D1 enforces nothing, so every row below is a check that Phase 2
server functions MUST implement and test. "Owner" = session user is
the teacher who owns the row; "member" = approved group membership;
"linked" = teacher_students.status = 'approved'.

| Area (Supabase) | D1 code check (Phase 2 must implement) |
|---|---|
| profiles read | Own row only. A teacher additionally reads full_name of their approved students (roster) — nothing else about them. |
| user_roles | Server-only. Never returned to the client except the caller's own role. Legacy 'teacher' maps to 'school_teacher' on read. |
| assessments CRUD | Owner only (teacher_id = session user). Drafts are invisible to students entirely. |
| questions | Owner only. Student take-page queries must select questions WITHOUT question_keys (see below). |
| question_keys | Owner or admin ONLY. This is the single most sensitive table: a student-facing query that joins it leaks answer keys. Phase 2 must grep for it in every student path. |
| assessment_assignments | Take gate: row exists AND assessment.status = 'published' AND window open. Group exams additionally require the group link (group_exams) — the assignment row alone is necessary, not sufficient, once a group link exists for that exam in a group the student is not a member of. (Phase 1 PoC covers group visibility; the take-gate group check is a Phase 2 item — see §6.) |
| submissions / answers | Owning student (own responses, own history) OR owning teacher (grade, release). Pre-release, scores/feedback stay teacher-only; the student's own response text is not secret from them (same rule as the Supabase own_submission_responses function). |
| teacher_students | "Linked" means status = 'approved' EVERYWHERE (roster, publish audience, profile visibility). Pending/rejected rows grant nothing. |
| teacher_groups / group_members | Owner creates/edits/deletes; students join by code -> pending -> owner approves/rejects. group_members is never directly readable by students; membership is exposed only through the my_groups / my_group_roster equivalents. |
| group_exams | Owner links an exam to a group; assignment rows are created ONLY for approved members of that group. my_group_exams equivalent: owner sees all linked exams; approved member sees only published linked exams; anyone else sees nothing, not even titles. |
| lessons / lesson_enrollments | Tutor owns the lesson; enrollment is by lesson join code; only enrolled students see the lesson. |
| grading (/grading) | school_teacher only (pre-existing gate; tutors stay barred until a product decision changes it). Release blocked until every question has a teacher score (handwritten exception: AI grade is final on save — that rule is product behaviour, not a security rule, and must be preserved verbatim). |
| analytics / dashboards | Teacher's own data only; student pages show the student's own data only. |
| ai_usage_events / ai_rate_limits | Teacher's own rows; quota (30 units/min, 500/day) must be enforced atomically in D1 (single-row update with a WHERE on the window, or a transaction) — a check-then-write in two statements races under concurrent calls. |
| audit_log | Append-only from server code, actor_id = session user always. No client-supplied actor, no updates, no deletes from app code. |
| integrity_events | Owning student (their own submission) or owning teacher. |
| grade_review_requests | Student who filed it + owning teacher only. |
| handwritten_grades | Owning teacher only; image_path is an R2 key (see §4). |
| whatsapp_sends / claims | Server-only bookkeeping; claim/finish logic (15-minute re-claim window) must be ported as a transaction, not as two separate statements. |
| ai_training_examples | Write-frozen (see schema note). Do not re-enable writes without a consent/minimisation workflow and an explicit product decision. |

RPC map (38 distinct RPCs found in the audit; each becomes a server
function with the check above, not a 1:1 SQL translation):
join_teacher, decide_enrollment, approve_all_enrollments,
my_student_roster, my_pending_enrollments, my_join_code,
create_teacher_group, update_teacher_group, delete_teacher_group,
join_group, decide_group_membership, approve_all_group_members,
my_teacher_groups, my_group_roster, my_groups,
my_pending_group_requests, assign_group_exam, my_group_exams,
is_group_owner (helper, not an endpoint), enroll_lesson,
set_assessment_status, start_attempt, save_draft, submit_attempt,
submit_assessment, release_submission, review_answer,
resolve_review_request, own_submission_responses,
teacher_dashboard_summary, tutor_dashboard_summary,
tutor_lesson_enrollment_counts, teacher_analytics_overview,
teacher_analytics_group_stats, teacher_analytics_question_stats,
teacher_analytics_student_page, teacher_grading_page,
consume_ai_rate_quota, claim_whatsapp_send, finish_whatsapp_send,
has_role / is_approved_student / is_teacher_of / owns_assessment /
normalize_answer / score_objective / store_ai_suggestion (helpers).

## 3. Custom auth (implemented in Phase 1)

See src/lib/cloudflare-auth.ts and schema/d1-auth.sql.

- Accounts: auth_users (id, lowercased unique email, PBKDF2 hash,
  provider) + profiles + user_roles, created atomically (D1 batch).
- Passwords: PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte salt,
  format `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url).
  100,000 is the Cloudflare Workers WebCrypto PBKDF2 cap (higher
  counts throw at sign-up/sign-in); rate limiting + per-user salts
  are the compensating layers, and verification reads the iteration
  count from the stored hash, so older hashes still verify.
- Sessions: 32-byte random token, SHA-256 hash stored, 30-day expiry,
  revoked_at for logout. Cookie: HttpOnly, Secure, SameSite=Lax,
  Path=/, name `qemmini_session`. The raw token is never in JS,
  localStorage, URLs, or logs.
- Sign-up allowlist excludes 'admin'. Sign-in errors are generic.
- Session check: exists AND not revoked AND not expired, then role
  lookup; requireRole() gates teacher/student/admin paths.
- What is NOT in Phase 1: password reset, email verification,
  login-attempt rate limiting, session rotation. All four are Phase 2
  hardening items (see §6) — shipping Phase 1 auth to real users
  without at least rate limiting would be unsafe.

## 4. Files: Supabase Storage -> R2

- Two private buckets, no public access:
  `qemmini-handwritten-papers` (replaces handwritten-papers) and
  `qemmini-generation-sources` (replaces generation-sources).
- Object keys: `{teacher_id}/{uuid}/{original-name}` — the teacher
  folder is part of the security model, exactly as in Supabase.
- Uploads and downloads go THROUGH Worker endpoints that check the
  session and ownership first, then stream to/from R2. Do not hand
  out long-lived public R2 URLs for student papers.
- `handwritten_grades.image_path` and any stored source paths are
  R2 keys after migration, not Supabase paths. The data import must
  re-map old paths (or re-upload the files) — a path left pointing
  at Supabase Storage silently breaks after Supabase is deleted.
- The platform rule survives unchanged: a file is persisted first
  (R2 put confirmed) before any record referencing it is saved.

## 5. Google OAuth sign-in under custom auth

Options, in order of preference:

- (A) Password-only, with a set-password invitation for existing
  Google users. Simplest and fully Cloudflare-only. Cost: every
  Google-linked account must set a password via an emailed token
  before it can sign in again. Acceptable ONLY if the count of real
  Google-linked accounts is tiny — Phase 2 must count them in the
  live database (read-only) before choosing.
- (B) Implement Google OAuth in the Worker: authorization URL ->
  code exchange -> ID-token verification against Google's JWKS ->
  link by verified email to an existing account or create a new
  one (provider='google', password_hash NULL). Keeps the current UX
  and is a contained build, but it is new security-sensitive code
  (state/nonce, redirect validation, token verification) that must
  be reviewed before launch.
- (C) Keep Supabase Auth just for Google sign-in. REJECTED: it
  defeats the entire Cloudflare-only goal and keeps the dependency
  the migration exists to remove.

Recommendation: count Google-linked accounts first. If zero (or
only test accounts), do (A). Otherwise do (B). Do not pick (C).

## 6. What remains for Phase 2 (in order)

1. Wire env.DB (and the R2 bindings) into TanStack Start server
   functions. This is the open plumbing question in src/server/d1.ts:
   confirm how the installed @tanstack/react-start version exposes
   the Worker env to server functions, and prove it with one migrated
   route before migrating the rest. Until this is solved, NO route
   may claim to read from D1 in production.
2. Auth hardening: login-attempt rate limiting, password reset via
   emailed single-use tokens (hashed, expiring), email verification
   if the product wants it, session rotation on sign-in, and an
   admin-creation path owned by an existing admin.
3. Migrate routes one at a time (suggested order: auth pages ->
   /groups (+ group exams) -> dashboard -> assessments/take ->
   grading/release -> handwritten -> generation -> assistant/tutor
   -> analytics -> admin/audit), re-running each route's old
   live-verify loop against D1.
4. Take-gate group check: once an exam has group links, a student
   who is not a member of any linked group must be blocked even if
   a stale assignment row exists (defence in depth over the
   assignment row alone).
5. Port the 38 RPCs as server functions with the §2 checks, plus
   atomic quota and WhatsApp-claim transactions.
6. R2 upload/download endpoints + path remapping on import.
7. Google OAuth decision (see §5) and, if (B), its implementation.
8. Data import: export from Supabase, transform types (uuid as
   text, timestamptz to UTC ISO, jsonb to JSON text, text[] to JSON
   array, booleans to 0/1), import via wrangler d1 in batches,
   verify row counts per table and spot-check joins, then re-run
   the full live-verify set on the Cloudflare copy.
9. Cutover decision by the user (DNS/Worker switch), then — only
   after a verified cutover and an explicit user approval — delete
   the Supabase project. Never before.
10. Backups: D1 Time Travel (7 days free, 30 days paid) is NOT a
    backup strategy on its own; Phase 2 must add a scheduled export
    (the user already wants daily backups once the site grows).

## 7. Known Phase 1 limitations (do not paper over these)

- The D1 binding is NOT wired (src/server/d1.ts throws
  D1_NOT_WIRED). The PoC proves SQL + logic, not Worker plumbing.
- The PoC server function is not routed: /groups still reads from
  Supabase in this copy.
- wrangler.jsonc in this copy is still the Supabase configuration
  (SUPABASE_URL/ANON_KEY vars). Phase 2 must replace it with D1 +
  R2 bindings and remove Supabase vars/secrets.
- Base-table columns are derived from generated types + migration
  ALTERs (see schema header), not from a live database dump. A
  live-dump comparison is a mandatory Phase 2 step before import.
- No rate limiting, no password reset, no session rotation yet.
- The copy's node_modules was a dev-only symlink to the preview
  copy's node_modules for running tests/builds; it has been removed.
  Phase 2 must run a fresh install in this copy.
