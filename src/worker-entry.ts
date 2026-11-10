/**
 * Cloudflare Worker entry (Phase 3, 2026-11-10).
 *
 * The default export is the TanStack Start server entry, untouched —
 * fetch handling is exactly what it was. The named `queue` export is
 * the take-writes Queue consumer (src/server/take-queue.ts): it drains
 * start/draft/submit messages into D1 at a throttled rate so a
 * same-second burst cannot overload the single-writer database.
 *
 * Verified 2026-11-10: `bun run build` succeeds and the built
 * dist/server/index.js exports BOTH `default` and `queue`. If this
 * wrapper ever breaks the build, the fallback is a separate consumer
 * worker (see ports-queues/DESIGN.md §1) — the consumer logic moves
 * unchanged.
 */
import serverEntry from "@tanstack/react-start/server-entry";
import { handleTakeQueueBatch } from "./server/take-queue";

export default serverEntry;

// The runtime calls queue(batch, env, ctx); the handler computes its
// own timestamp, so ctx is intentionally not forwarded (the third
// parameter of handleTakeQueueBatch is a test-only clock override).
export const queue: (
  batch: Parameters<typeof handleTakeQueueBatch>[0],
  env: Parameters<typeof handleTakeQueueBatch>[1],
) => Promise<void> = (batch, env) => handleTakeQueueBatch(batch, env);
