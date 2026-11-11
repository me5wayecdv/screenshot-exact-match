# API versioning

## The rule

- The TakeSession Durable Object RPC carries a version: every call
  sends `{ v: API_VERSION, ...body }`, with `API_VERSION` from
  `src/lib/api-version.ts` (currently **1**). Never write a literal
  version number at a call site.
- TanStack server functions are **unversioned for now**: they are
  deployed together with the frontend in one Worker, so client and
  server always move in lockstep. If a server function's contract
  ever has to change while old clients are still live, that function
  must gain an explicit version before the change lands — do not
  silently change a live contract.

## How to bump the DO version

1. Bump `API_VERSION` in `src/lib/api-version.ts`.
2. In the same change, add the version check on the DO side
   (`src/server/take-session.ts`): the DO must accept the new
   version and either accept or explicitly reject the old one
   (reject with a `TAKE_*` error the client already translates —
   never silently serve the wrong shape).
3. Deploy Worker + DO together (one `wrangler deploy` covers both —
   the DO class ships in the same Worker). There is no separate DO
   deploy, so a version skew between caller and DO cannot survive a
   deploy; the version exists to catch stale clients and mixed
   deploys, not to support two live versions.
4. Record the change here: version, date, what changed, and when the
   old version stops being accepted (if ever).

## History

- **v1** — Phase 4 (2026-11-10): DO RPC introduced (`/start`,
  `/draft`, `/submit`, `/status`, `/data`). The DO ignores `v` so
  far; enforcement is added with the first real bump.
