# Qemmini · قِمّيني

Arabic-first, RTL assessment and learning platform for teachers and students.

## Stack

- React 19 + TanStack Start (file-based routing) + TanStack Router / Query
- Supabase (Auth + Postgres) via `@supabase/supabase-js`
- Tailwind CSS + shadcn UI

## Development

```sh
git clone <this-repository-url>
cd <repository-name>
bun install
bun run dev
```

## Environment variables

| Variable                    | Where        | Purpose                                                                   |
| --------------------------- | ------------ | ------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | client / SSR | Supabase project URL                                                      |
| `VITE_SUPABASE_ANON_KEY`    | client / SSR | Supabase publishable (anon) key                                           |
| `SUPABASE_URL`              | server       | Supabase project URL for server code                                      |
| `SUPABASE_SERVICE_ROLE_KEY` | server only  | Service-role key — never expose to the client                             |
| `DATABASE_URL`              | Drizzle CLI  | Postgres connection string for migrations                                 |
| `CRON_SECRET`               | server       | Shared secret for cron endpoints (`CRON_SECRET_PREVIOUS` during rotation) |

## Scripts

- `bun run dev` — dev server
- `bun run typecheck` — strict TypeScript check
- `bun run build` — typecheck followed by the production build
- `bun run preview` — preview the production build
- `bun run test` — test suite (Vitest)
- `bun run lint` / `bun run format` — lint / format
