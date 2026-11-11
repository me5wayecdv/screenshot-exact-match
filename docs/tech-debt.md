# Tech debt register

Single source of truth for known technical debt. Sourced from the
2026-11-11 production audit (106 topics). Update this file when a debt
is paid off or a new one is found — do not let debt live only in code
comments.

| Item                                                                                                         | Where                              | Status                                                 |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| TTL-only cache invalidation (a release shows on the take page within 5 min, not instantly)                   | `src/server/take-session-logic.ts` | Open                                                   |
| Release-notify-DO pending (the full fix for the above: release path notifies the DO, no refresh read at all) | `src/server/take-session-logic.ts` | Open                                                   |
| Manual validation, no zod (per-function hand checks, no shared schema)                                       | `src/server/*`                     | Open                                                   |
| No FKs in the D1 schema (relation safety enforced in app code, not the schema)                               | `schema/d1-schema.sql`             | Open                                                   |
| Hard deletes, no soft deletes (no `deleted_at` anywhere)                                                     | `src/server/d1-*.ts`               | Open                                                   |
| No automated E2E (live verification is manual browser probes)                                                | repo-wide                          | Open                                                   |
| No error tracking (no Sentry; errors only in `take_write_failures` + `console.error`)                        | repo-wide                          | Open                                                   |
| No cost monitoring (only "unexpected cost" noted as a risk in launch-readiness)                              | repo-wide                          | Open                                                   |
| No D1 read replication (possible future lever for the pre-DO read path)                                      | D1                                 | Open                                                   |
| No feature flags                                                                                             | `src/lib/`                         | Open — env-based helper being added in parallel        |
| README described the old Supabase stack                                                                      | `README.md`                        | Done (this batch)                                      |
| No Dependabot                                                                                                | `.github/dependabot.yml`           | Done (this batch)                                      |
| No security headers / CSP                                                                                    | `src/worker-entry.ts`              | Done (this batch, added in parallel)                   |
| No health endpoint                                                                                           | `src/worker-entry.ts`              | Done (this batch, added in parallel)                   |
| Unstructured logging                                                                                         | `src/server/`                      | Done (this batch, structured logger added in parallel) |
