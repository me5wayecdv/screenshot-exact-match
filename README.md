# Qayyimni · قَيّمني

Arabic-first, RTL assessment and learning platform for teachers and students.

## Stack

- React 19 + TanStack Start (file-based routing) + TanStack Router / Query
- Cloudflare Workers (single Worker entry, `src/worker-entry.ts`) + D1
  (SQLite) + R2 (private buckets) + Durable Objects (one `TakeSession`
  per exam, SQLite state, batched flush to D1)
- Custom auth: PBKDF2 password hashing, hashed sessions, HttpOnly cookies
  (no Supabase at runtime — the Supabase project is kept untouched only
  as a rollback path)
- Tailwind CSS + shadcn UI

## Deploy

Live at https://qemmini.adhamelhansye.workers.dev. Deploy is manual-only
via GitHub Actions (`.github/workflows/qemmini-live-deploy.yml` on
`main`): typecheck + tests + rebind to live + build + `wrangler deploy`.
Merging to `main` alone does not deploy.

## Development

```sh
git clone <this-repository-url>
cd <repository-name>
bun install
bun run dev
```

## Environment variables

> The live system is Cloudflare-only (Workers + D1 + R2 + Durable Objects).
> The four `SUPABASE_*` rows below are **legacy — rollback path only**,
> not used at runtime. The Supabase project is kept untouched only so the
> old code can be redeployed if ever needed.

| Variable                    | Where        | Purpose                                                                   |
| --------------------------- | ------------ | ------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | legacy only  | Supabase project URL — rollback path only, not used at runtime            |
| `VITE_SUPABASE_ANON_KEY`    | legacy only  | Supabase publishable (anon) key — rollback path only, not used at runtime |
| `SUPABASE_URL`              | legacy only  | Supabase project URL for server code — rollback path only                |
| `SUPABASE_SERVICE_ROLE_KEY` | legacy only  | Service-role key — rollback path only; never expose to the client         |
| `DATABASE_URL`              | Drizzle CLI  | Postgres connection string for migrations                                 |
| `CRON_SECRET`               | server       | Shared secret for cron endpoints (`CRON_SECRET_PREVIOUS` during rotation) |
| `AI_BASE_URL`               | server       | OpenAI-compatible AI endpoint; optional until AI features are enabled     |
| `AI_MODEL`                  | server       | Text model used for grading, tutoring, and generation                     |
| `AI_API_KEY`                | server       | Provider credential; never expose through a `VITE_` variable              |
| `AI_VISION_MODEL`           | server       | Optional vision model for OCR and paper matching                          |
| `VISION_PROVIDER`           | server       | Optional vision provider selector; see the AI model runbook               |

AI/provider setup and Cloudflare deployment details are documented in
[`docs/ai-models.md`](docs/ai-models.md) and
[`docs/cloudflare-deploy.md`](docs/cloudflare-deploy.md). Before real student
use, follow [`docs/launch-readiness.md`](docs/launch-readiness.md). Running costs
(provider prices, per-action AI cost, break-even) are in
[`docs/costs.md`](docs/costs.md). Do not copy secrets into client-side variables
or commit them.

## Scripts

- `bun run dev` — dev server
- `bun run typecheck` — strict TypeScript check
- `bun run build` — typecheck followed by the production build
- `bun run preview` — preview the production build
- `bun run test` — test suite (Vitest)
- `bun run db:rehearse` — apply migrations to a data-free PGlite instance and check selected SQL/RPC invariants; not a full Supabase emulator
- `bun run lint` / `bun run format` — lint / format
