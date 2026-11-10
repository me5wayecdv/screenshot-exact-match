/**
 * Cloudflare Worker entry (Phase 3, 2026-11-10).
 *
 * The default export is an ExportedHandler-style object: `fetch` is the
 * TanStack Start server entry, untouched — fetch handling is exactly
 * what it was. `queue` is the take-writes Queue consumer
 * (src/server/take-queue.ts): it drains start/draft/submit messages
 * into D1 at a throttled rate so a same-second burst cannot overload
 * the single-writer database.
 *
 * WHY THE OBJECT FORM (fixed 2026-11-10): the first version exported
 * the queue handler as a NAMED export (`export const queue = ...`)
 * alongside `export default serverEntry`. The bundle was correct
 * (verified: wrangler's uploaded index.js exported `{ default, queue }`)
 * and the Phase 3 version was live and serving, yet Cloudflare's
 * consumer attach failed twice with "Queue handler is missing
 * [code: 11001]" — the Queues API reads the handler from the DEFAULT
 * export object (the form the Queues docs show), not from a named
 * export. So `queue` now lives on the default object AND stays a named
 * export (tests/build checks reference the named one).
 *
 * Verified 2026-11-10: `bun run build` succeeds and the built
 * dist/server/index.js exports BOTH `default` and `queue`. If this
 * wrapper ever breaks the build, the fallback is a separate consumer
 * worker (see ports-queues/DESIGN.md §1) — the consumer logic moves
 * unchanged.
 */
import serverEntry from "@tanstack/react-start/server-entry";
import { handleTakeQueueBatch } from "./server/take-queue";

// The runtime calls queue(batch, env, ctx); the handler computes its
// own timestamp, so ctx is intentionally not forwarded (the third
// parameter of handleTakeQueueBatch is a test-only clock override).
export const queue: (
  batch: Parameters<typeof handleTakeQueueBatch>[0],
  env: Parameters<typeof handleTakeQueueBatch>[1],
) => Promise<void> = (batch, env) => handleTakeQueueBatch(batch, env);

export default {
  fetch: (...args: Parameters<typeof serverEntry.fetch>) => serverEntry.fetch(...args),
  queue,
};
