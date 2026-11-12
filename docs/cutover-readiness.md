# Cutover readiness: email, passwordless accounts, parity

This note closes the three code gaps that blocked cutover after the
Phase 2c code migration. Nothing here is deployed or provisioned yet —
every item under "Still needs a human" below is a real, open step.

## 1. Email delivery (was: tokens issued but undeliverable)

Implementation: `src/server/d1-email.ts`, single entry point
`sendEmail()` / `sendAuthEmail()`, used by `requestPasswordResetD1`
and by the admin invitation below.

Providers (in order of precedence):

1. `EMAIL_PROVIDER` set to `resend` or `cloudflare` — explicit wins (`mailchannels` is a deprecated alias for `cloudflare`).
2. Unset/empty: auto-detect — Resend key present → Resend; else a
   `SEB` binding present → Cloudflare Email Service; else nothing.
3. An unknown `EMAIL_PROVIDER` value, or a named provider missing its
   key/binding/`EMAIL_FROM`, resolves to "not configured" (fail
   closed, never a silent fallback to another sender).

Setup — Resend (recommended first path):

```sh
wrangler secret put RESEND_API_KEY   # never committed, never logged
```

plus, in `wrangler.jsonc` vars (a deploy replaces Worker vars with
that block, so dashboard-only vars get wiped):

```jsonc
"EMAIL_PROVIDER": "resend",
"EMAIL_FROM": "Qemmini <noreply@<your-verified-domain>>"
```

`EMAIL_FROM` must be a sender on a Resend-verified domain.

Setup — Cloudflare Email Service (alternative, no third-party key):

- Onboard the Worker's domain to Email Service in the Cloudflare
  dashboard (SPF/DKIM records), keep the `send_email` binding (`SEB`)
  in `wrangler.jsonc`, and set `EMAIL_PROVIDER` to `cloudflare`
  (or leave it unset with no Resend key) plus `EMAIL_FROM` on the
  onboarded domain. (The old MailChannels free integration ended in
  August 2024 — the same binding now speaks Email Service.)

Failure contract (tested, do not weaken):

- No provider configured → the flow throws `EMAIL_NOT_CONFIGURED`.
  The check runs BEFORE a token is issued, so the error is identical
  for known and unknown emails (no account-enumeration signal) and no
  orphan token is created.
- The raw token appears ONLY inside the email body sent to the
  account's own address. It is never returned in a response, never
  logged, and never included in an error message. There is NO
  fallback that prints or returns the token.
- A provider failure throws `EMAIL_SEND_FAILED` with provider name +
  HTTP status only. A token already issued before a send failure stays
  valid for its 1 hour; the user/admin simply requests a new one.

## 2. Google-linked accounts: set-password invitations (no OAuth)

Chosen cutover solution: the invitation path, NOT Google OAuth.

- `issueSetPasswordInvitation()` (`src/lib/cloudflare-security.ts`):
  admin-only; requires the account to exist AND to have
  `password_hash IS NULL` (passworded accounts fail with
  `NOT_PASSWORDLESS` — inviting one would be a back-door reset).
  Issues the same hashed 1-hour single-use token mechanism as reset.
- `/set-password` page: accepts the invitation token and sets the
  account's first password through the same consume path as
  `/reset-password` (new password + revoke all sessions). The forgot-
  password flow also routes passwordless users to `/set-password`
  automatically (token purpose decides the link).
- `listPasswordlessAccounts()` (`src/server/d1-admin.ts`, admin-only,
  surfaced on `/admin` with a per-account "Send invitation" button):
  returns id + email + created date ONLY — the query selects exactly
  those three columns.
- Admin invitation server function: provider check first (no orphan
  token), then issue, then email; returns `{ ok: true }` only.

Future option (not implemented, deliberately): Google OAuth on the
Cloudflare stack (Cloudflare Access / a custom OAuth client against
Google's endpoints, with the same cookie-session store). It is a
genuine product improvement for returning Google users, but it is NOT
needed for cutover: every migrated Google account can set a password
through an invitation, and building OAuth now would add an identity
provider integration to a cutover that is supposed to shrink risk.

## 3. Parity harness (was: no way to compare D1 vs live Supabase)

- Script: `scripts/parity-check.mjs` — row counts per table, D1 via
  `wrangler d1 execute --command "SELECT COUNT(*) …"` (allowlisted
  tables only; no user-supplied SQL, no writes) and Supabase via
  read-only PostgREST count requests. Keys come only from the
  operator's environment (`SUPABASE_URL`, `SUPABASE_KEY`); the script
  contains no credentials and never prints any.
- Checklist: `scripts/parity-check.md` — the script plus manual steps
  for group-exam take (member / non-member / stale assignment),
  publish loop, grading loop, handwritten round-trip, and quota under
  concurrency, with a sign-off table. Hard blockers: an unexplained
  row-count DIFF, a stale-assignment bypass, or an unreceived auth
  email.

## Still needs a human (not code, not done here)

- [ ] D1 provisioning: `wrangler d1 create qemmini-db`, then replace
      the `REPLACE_WITH_D1_DATABASE_ID` placeholder in
      `wrangler.jsonc`. Do NOT deploy with the placeholder.
- [ ] Deploy token re-sent by the user (values are never stored, so
      any deploy needs a fresh token from the user).
- [ ] Email provider key/setup: `RESEND_API_KEY` secret and a verified
      `EMAIL_FROM`, OR Email Service SPF/DKIM enablement.
- [ ] Live-dump schema comparison (D1 schema vs the live Supabase
      dump) — the parity script compares row counts, not schemas.
- [ ] First admin creation directly in D1 (there is deliberately no
      bootstrap endpoint) and set-password invitations sent to
      migrated Google accounts before those users are asked to sign in.
- [ ] The publish-guard edge and "no unassign" limits from Phase 2
      are preserved as-is; they are product decisions, not cutover
      blockers.
