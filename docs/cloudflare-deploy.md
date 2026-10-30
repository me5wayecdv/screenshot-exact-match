# Deploying Qayyimni on Cloudflare Workers (pilot)

Target: the TanStack Start app runs as a Cloudflare Worker (SSR + server
functions on the edge); Supabase stays where it is (auth, Postgres, Storage)
and the browser keeps talking to Supabase directly. This is a **pilot**
deployment on `*.workers.dev` — it is not a public launch (see the checklist
at the end).

## Prerequisites

- A Cloudflare account (free is enough to start).
- `wrangler` logged in to that account (`wrangler login`).
- The Cloudflare **account ID** (dashboard, or `wrangler whoami`).
- For the Workers AI path: a Cloudflare API token with
  Account > Workers AI > Read permission.

## Install (on a full checkout, not a partial copy)

```sh
bun add -d @cloudflare/vite-plugin wrangler
```

This updates `package.json` / lockfile with real versions — do not hand-write
version numbers into `package.json` for these two packages.

## Environment: vars vs secrets

`wrangler.jsonc` currently contains the non-secret `[vars]` used by the pilot
(account-specific AI endpoint, model names and Supabase URL/anon key). A
`wrangler deploy` applies these values and can overwrite dashboard-only vars;
keep the checked-in config and dashboard configuration aligned. The Supabase
anon key is a publishable client key, not a service-role secret. With
`nodejs_compat` + `nodejs_compat_populate_process_env`, vars and secrets are
visible to server code via `process.env`. Never put service-role, AI-provider,
Gemini or WhatsApp secrets in `wrangler.jsonc` or any `VITE_` variable.

Vars (dashboard > Worker > Settings > Variables, or `[vars]`):

| Variable | Value (Workers AI path) |
| -------- | ----------------------- |
| `AI_BASE_URL` | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` |
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `AI_VISION_MODEL` | `@cf/meta/llama-3.2-11b-vision-instruct` |
| `VISION_PROVIDER` | `gemini` only when `GEMINI_API_KEY` is configured; otherwise omit/unset it to use the configured Workers AI vision path |
| `SUPABASE_URL` | `https://ugoxxbyvgptvrknuntmc.supabase.co` |
| `SUPABASE_ANON_KEY` | The project's anon public key (dashboard: Project Settings → API) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp phone number id (only when WhatsApp is enabled) |

Secrets (`wrangler secret put <NAME>`, encrypted, never in the repo):

| Secret | Meaning |
| ------ | ------- |
| `AI_API_KEY` | Cloudflare API token (Workers AI Read) for the Workers AI path |
| `WHATSAPP_TOKEN` | Meta WhatsApp token (only when WhatsApp is enabled) |
| `SUPABASE_SERVICE_ROLE_KEY` | Only if a deployed server path needs it; otherwise do not set it |

Client-side Supabase keys (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)
are embedded at build time from the build environment, as before.

## Database migrations (required before the app deploy)

Create/verify the Supabase migration history first: apply the base
`drizzle/migrations/0000_migration.sql`, then **all** files in
`supabase/migrations/` in timestamp order. The current final migration is
`20261030230000_harden_signup_and_exam_rls.sql`; it removes public signup
admin assignment and retires the legacy exam write paths. Verify it is marked
applied in the target project's migration history before enabling real student
accounts. Do not rely on the abbreviated legacy list in older notes.

## Deploy

```sh
bun run build && wrangler deploy
```

The first deploy publishes to `https://qemmini.<subdomain>.workers.dev`.
A custom domain can be attached later from the Cloudflare dashboard.

## Pilot smoke tests (do all of these on the deployed URL before any real user)

1. Sign up a test teacher account, sign out, sign back in.
2. Create an assessment, publish it, take it as a student, submit.
3. Grade it: AI suggestion appears, teacher accepts, release works.
4. Handwritten: upload a real Arabic handwritten photo, OCR returns text,
   teacher corrects it, AI grade saves as final, paper re-opens from history.
5. Generate an assessment from pasted curriculum text; draft appears unpublished.
6. Confirm the failure states: with AI env unset, pages show "AI not
   configured" instead of crashing.
7. WhatsApp: keep it OFF in the pilot until the Meta `result_report`
   template is approved — sends fail visibly until then.
8. With a student session and the Supabase REST API (not just the UI), verify
   the student cannot read `awaiting_review` scores, change an answer after
   submit/expiry, insert a `submissions` row directly, or execute the legacy
   `submit_assessment` RPC. Verify an attempted signup with `role: "admin"`
   creates a student, not an administrator.

## Known follow-ups (do not silently skip these)

- **Custom SSR error page:** `src/server.ts` (the Nitro/h3-era error-page
  wrapper) is NOT on the Workers request path with the current
  `wrangler.jsonc` (`main` points at the framework entry, per Cloudflare's
  TanStack Start guide). Verify what a failed SSR returns on workers.dev;
  only re-wire `main` to the wrapper if the default is unacceptable.
- **Free-plan CPU:** Workers Free allows 10 ms of CPU per invocation (waiting
  on fetch/AI does not count; SSR rendering does). If pages fail under the
  free plan, the fix is the Workers Paid plan (from $5/month), not code
  changes.
- **Workers AI quality is unproven here:** Arabic grading, strict-JSON
  output, and Arabic handwriting OCR on the chosen `@cf/` models must pass
  the smoke tests above before any real classroom use. If OCR quality is
  poor, fall back to an external vision-capable provider (path 1 in
  docs/ai-models.md) — no code change, only env values.
- **Free-tier AI limits:** check the Workers AI neuron/rate limits in the
  Cloudflare dashboard before real usage; add per-teacher usage awareness
  before any paid launch.
- **Before a public launch:** have privacy/terms reviewed for the actual
  jurisdictions and minors' data; define and implement retention/deletion for
  student records and uploaded papers; add rate limits/AI cost controls,
  monitoring and alerts; and complete the restore drill. The contact email is
  present but should be confirmed as the operational privacy contact. Payments,
  school-wide report visibility and tutor access to `/grading` are product
  decisions, not security controls.

## Rollback

Redeploy the previous commit's build (`git checkout <sha>` → build →
`wrangler deploy`). There is no database rollback in this step: migrations
are additive (new tables/columns, new bucket) and old code keeps working
without them.
