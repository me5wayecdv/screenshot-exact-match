# AI cost controls (2026-11-16)

## Defaults and scope

No commercial plan, subscription price, trial allowance or student cap is enabled.
The existing 30 weighted units/minute and 500/day per-user technical quotas remain.
Grading now explicitly caps output at 1,200 tokens. Other provider paths retain
existing output limits. Provider token usage is measured before validating text
reply content in grading, generation, teacher chat and lesson explanation.

All eight AI modules route provider network attempts through `aiProviderFetch`.
This includes student tutor calls, OCR fallbacks, provider retries and model
agreement requests. This does not merge student product quotas into a teacher
subscription pool. No such commercial pool has been approved.

## Emergency pause

`AI_REQUESTS_ENABLED=false` blocks all AI provider requests before network access.
Unset or `true` preserves the existing service. A misspelled value fails closed.
This is a technical emergency switch, not a per-customer plan control.

## Optional global request budget, NOT a dollar spending cap

`AI_PROVIDER_DAILY_REQUEST_LIMIT` is unset by default. No new request cap is
active until the operator explicitly chooses and configures one. An integer
zero pauses all provider requests. A positive integer reserves one global
attempt before each provider network request, using an atomic conditional
SQLite UPSERT. Each retry/fallback needs another reservation. Failed, timed-out
or malformed attempts are never refunded from this global counter: the
provider may have billed them. Existing per-user product refunds are separate.

Apply `schema/migrations/20261116_ai_provider_budget.sql` to the selected
isolated/staging database before configuring the limit. The additive table
holds only UTC day and request count; it contains no user/student/prompt data.
Without the table/binding or on DB/config errors, an enabled limit fails closed.
No migration is required while the daily limit is unset.

Configuring a value only in Cloudflare dashboard is not durable: deployment
replaces plain vars using `wrangler.jsonc`. Persist an approved value there (or
use the supported deployment-secret route) before activating it. Do not put
credentials into committed configuration. Keep the limit unset until chosen.

Counts do NOT prove exact dollars. Calls vary by model, input and output size;
HTTP/network failures may have unknown billing, vision can omit token counts,
and other Workers/account workloads may incur charges outside this app. No
account-wide dollar cap is claimed. Reconcile actual vendor billing separately
before approving any commercial price or allowance. A per-request ceiling and
a request budget cannot substitute for that reconciliation.

## Validation

Automated checks: atomic SQL reservations, concurrency, UTC rollover, repeated
migration, zero budget, pause switch, invalid config, missing table, permanent
failed-attempt accounting, per-retry reservation, paid unusable replies, and
no direct `fetch` bypass across eight provider modules. The isolated SQLite
journey covers signup approval, teacher join approval, exam publish, draft
resume, submission, cross-user denial, teacher review, release and result read.
These are not substitutes for browser/Cloudflare authenticated flow testing.

No production migration, budget activation, customer price, WhatsApp send,
production data change, or visual redesign is included in this patch.

## Review follow-up

Tutor output is now explicitly capped at 2,400 tokens and tutor usage is measured
before empty-reply validation. A second abort check prevents a request cancelled
while reserving in D1 from reaching fetch. The conservative reservation remains.
The bypass regression now detects every direct `fetch(` in the eight modules,
not only `await fetch(`. Retry-budget tests exercise both 2 and 3 attempts.

An optional `AI_ATTEMPT_LOG_ENABLED=true` ledger records each actual network
attempt after its response/failure, including OCR/fallback, non-OK HTTP,
malformed JSON and unknown token counts. It is OFF by default and requires the
same additive migration first. No production tracking is activated. Rows store
only random attempt ID, UTC start, provider host, model, response/network outcome,
HTTP status, reported input/output tokens, and whether the call was a model
agreement. No user identifier, prompt, reply, image or credential is stored.
A content-free warning signals a failed ledger write. This does not promise
complete accounting or exact dollars; reconciliation and retention policy still
need operator decisions before enabling it for live use.
